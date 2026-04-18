"""AIAgent encapsulation for vonvon backend.

Pre-requisite: pip install -e /path/to/hermes-agent (editable install)
Do NOT use sys.path.insert — rely on editable install for imports.
"""
import asyncio
from contextlib import suppress
from types import SimpleNamespace
from typing import Any, Optional
import logging

from run_agent import AIAgent
from hermes_state import SessionDB
from app.config import DEFAULT_MODEL, HERMES_HOME

# ── Global state (slimmed in v1.1) ────────────────────────────────────────────

_session_db: Optional[SessionDB] = None
_current_model: str = DEFAULT_MODEL
_current_provider: str = ""       # NEW in v1.1

# AIAgent is NOT thread-safe. Serialize all run_conversation calls via this lock.
_agent_lock = asyncio.Lock()
_running_agent: Optional[AIAgent] = None
_running_task: Optional[asyncio.Task[Any]] = None
_running_session_id: Optional[str] = None
_lock_owner_task: Optional[asyncio.Task[Any]] = None

log = logging.getLogger(__name__)

# NOTE (v1.1): _api_key / _base_url REMOVED — credential resolution is
# delegated entirely to hermes credential_pool via per-request lookups.


def _canonicalize_provider(provider: str | None) -> str:
    return (provider or "").strip().lower()


# ── Session DB singleton ──────────────────────────────────────────────────────

def get_session_db() -> SessionDB:
    """Eager-friendly SessionDB singleton — MUST be pre-warmed in main.lifespan
    AFTER workspace_service.init_from_hermes_config() to avoid any relative
    path fallback inside SessionDB initialization picking up a user-switched
    cwd."""
    global _session_db
    if _session_db is None:
        _session_db = SessionDB()
    return _session_db


def close_session_db() -> None:
    """Close the shared SessionDB so shutdown flushes cleanly."""
    global _session_db
    db = _session_db
    _session_db = None
    if db is None:
        return
    try:
        db.close()
    except Exception as exc:
        log.warning("Failed to close SessionDB cleanly: %s", exc)


# ── Credential resolution ─────────────────────────────────────────────────────

def _peek_current_credentials() -> tuple[Optional[str], Optional[str]]:
    """Return (base_url, access_token) for _current_provider or (None, None).

    DELTA-4 removed the _api_key/_base_url global caches, but hermes AIAgent
    does NOT auto-resolve OAuth credentials from credential_pool when
    api_key/base_url are omitted — it falls back to env vars like
    OPENAI_API_KEY. For openai-codex (ChatGPT OAuth) the tokens live in
    HERMES_HOME/auth.json credential_pool only, not in any env var. So we
    MUST peek the pool explicitly per request and pass the resolved values
    into AIAgent(), otherwise the agent hits the default OpenAI endpoint
    with an empty key and gets 403.
    """
    import logging
    log = logging.getLogger(__name__)
    current_provider = _canonicalize_provider(_current_provider)
    if not current_provider:
        log.info("peek_creds: _current_provider is empty, returning (None, None)")
        return (None, None)
    try:
        from agent.credential_pool import load_pool
        pool = load_pool(current_provider)
        cred = pool.peek()
    except Exception as exc:
        log.warning("credential_pool.peek(%s) failed: %s", current_provider, exc)
        return (None, None)
    if cred is None:
        log.info("peek_creds: pool.peek(%s) returned None", current_provider)
        return (None, None)
    base_url = getattr(cred, "base_url", None) or None
    token = getattr(cred, "access_token", None) or None
    log.info(
        "peek_creds: provider=%s base_url=%s token_len=%d",
        current_provider, base_url or "<none>", len(token) if token else 0,
    )
    return (base_url, token)


# ── Agent factory ─────────────────────────────────────────────────────────────

def create_agent(session_id: str, **callbacks) -> AIAgent:
    """Create a new AIAgent per request. Explicitly resolves credentials from
    credential_pool for the current provider so OAuth tokens (e.g.
    openai-codex) reach the hermes HTTP layer.
    """
    base_url, api_key = _peek_current_credentials()
    return AIAgent(
        model=_current_model,
        base_url=base_url,
        api_key=api_key,
        session_id=session_id,
        session_db=get_session_db(),
        platform="vonvon",
        quiet_mode=True,
        **callbacks,
    )


def register_running_task(session_id: str, task: asyncio.Task[Any]) -> None:
    """Track the current in-flight chat task so /stop can await its exit."""
    global _running_task, _running_session_id, _running_agent
    _running_task = task
    _running_session_id = session_id
    _running_agent = None


def attach_running_agent(session_id: str, agent: AIAgent) -> None:
    """Attach the live agent instance to the tracked run."""
    global _running_agent
    if _running_session_id == session_id:
        _running_agent = agent


def clear_running_task(task: asyncio.Task[Any]) -> None:
    """Clear tracked run state once the task exits."""
    global _running_agent, _running_task, _running_session_id
    if _running_task is task:
        _running_agent = None
        _running_task = None
        _running_session_id = None


def claim_agent_lock(task: asyncio.Task[Any]) -> None:
    """Mark which run currently owns the serialized agent lock."""
    global _lock_owner_task
    _lock_owner_task = task


def owns_agent_lock(task: asyncio.Task[Any]) -> bool:
    """Return whether the given run still owns the serialized agent lock."""
    return _lock_owner_task is task


def release_agent_lock(task: asyncio.Task[Any]) -> bool:
    """Release the serialized agent lock iff the given run still owns it."""
    global _lock_owner_task
    if _lock_owner_task is not task:
        return False
    _lock_owner_task = None
    if _agent_lock.locked():
        _agent_lock.release()
    return True


def is_current_task(task: asyncio.Task[Any]) -> bool:
    """Return whether the given task is still the active chat run."""
    return _running_task is task


def force_clear_running_task(task: asyncio.Task[Any]) -> bool:
    """Drop the tracked run state even if the task never exits cleanly."""
    global _running_agent, _running_task, _running_session_id
    if _running_task is not task:
        return False
    _running_agent = None
    _running_task = None
    _running_session_id = None
    return True


async def request_stop(
    session_id: str | None = None,
    *,
    reason: str = "Stop requested",
    timeout: float = 8.0,
) -> dict[str, Any]:
    """Interrupt the active run and wait for its task to exit.

    Returns whether there was an active run and whether it stopped before
    the timeout expired.
    """
    agent = _running_agent
    task = _running_task
    running_session_id = _running_session_id

    if task is None or task.done():
        return {
            "had_active_run": False,
            "stopped": True,
            "session_id": running_session_id,
        }

    if session_id and running_session_id and running_session_id != session_id:
        return {
            "had_active_run": False,
            "stopped": True,
            "session_id": running_session_id,
        }

    if agent is not None:
        try:
            agent.interrupt(reason)
        except Exception:
            pass

    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        return {
            "had_active_run": True,
            "stopped": True,
            "session_id": running_session_id,
        }
    except asyncio.TimeoutError:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError, asyncio.TimeoutError, Exception):
                await asyncio.wait_for(task, timeout=0.2)
        force_clear_running_task(task)
        release_agent_lock(task)
        return {
            "had_active_run": True,
            "stopped": True,
            "hard_stopped": True,
            "session_id": running_session_id,
        }
    except asyncio.CancelledError:
        raise
    except Exception:
        return {
            "had_active_run": True,
            "stopped": True,
            "session_id": running_session_id,
        }


# ── Model utilities ───────────────────────────────────────────────────────────

def get_model_context_size() -> int:
    """Return the context window size for the current model (credentials
    resolved via credential_pool, not cached globals)."""
    from agent.model_metadata import get_model_context_length
    try:
        from agent.credential_pool import load_pool
        cur_cred = load_pool(_current_provider or "openai").peek() if _current_provider else None
    except Exception:
        cur_cred = None
    return get_model_context_length(
        _current_model,
        base_url=cur_cred.base_url if cur_cred else "",
        api_key=cur_cred.access_token if cur_cred else "",
    )


def _persist_model_selection(
    *,
    provider: str,
    model: str,
    base_url: str,
) -> None:
    from hermes_cli.config import load_config, save_config
    from hermes_cli.config_lock import config_store_lock

    with config_store_lock():
        cfg = load_config()
        model_cfg = cfg.get("model")
        if not isinstance(model_cfg, dict):
            legacy_name = model_cfg if isinstance(model_cfg, str) and model_cfg else None
            cfg["model"] = {"name": legacy_name} if legacy_name else {}
        cfg["model"]["provider"] = _canonicalize_provider(provider)
        cfg["model"]["name"] = model
        if base_url:
            cfg["model"]["base_url"] = base_url
        else:
            cfg["model"].pop("base_url", None)
        save_config(cfg)


def _direct_provider_api_mode(provider: str, base_url: str | None) -> str:
    normalized_provider = _canonicalize_provider(provider)
    normalized_base_url = str(base_url or "").strip().rstrip("/").lower()
    if normalized_provider == "anthropic":
        return "anthropic_messages"
    if normalized_provider == "openai" and "api.openai.com" in normalized_base_url:
        return "codex_responses"
    return "chat_completions"


def _switch_managed_provider_sync(
    *,
    model: str,
    persist: bool,
    provider: str,
) -> Any:
    """Switch OpenAI/Anthropic-style providers without Hermes alias rewriting.

    Hermes keeps a CLI-oriented alias where bare ``openai`` resolves to
    ``openrouter``. That is useful in the standalone CLI, but it is wrong for
    vonvon's managed OpenAI credential flow where ``provider=openai`` means the
    user's configured direct/compatible OpenAI endpoint from credential_pool.
    """
    global _current_model, _current_provider

    normalized_provider = _canonicalize_provider(provider)
    requested_model = str(model or "").strip()
    if not requested_model:
        return SimpleNamespace(
            success=False,
            target_provider=normalized_provider,
            provider_label=normalized_provider,
            is_global=persist,
            error_message="Model is required.",
        )

    try:
        from agent.credential_pool import load_pool

        pool = load_pool(normalized_provider)
        cred = pool.peek()
    except Exception as exc:
        return SimpleNamespace(
            success=False,
            target_provider=normalized_provider,
            provider_label=normalized_provider,
            is_global=persist,
            error_message=f"Could not load credentials for provider '{normalized_provider}': {exc}",
        )

    if cred is None:
        return SimpleNamespace(
            success=False,
            target_provider=normalized_provider,
            provider_label=normalized_provider,
            is_global=persist,
            error_message=f"No configured credentials for provider '{normalized_provider}'.",
        )

    resolved_base_url = str(getattr(cred, "base_url", "") or "").strip()
    previous_provider = _canonicalize_provider(_current_provider)
    _current_model = requested_model
    _current_provider = normalized_provider

    if persist:
        _persist_model_selection(
            provider=normalized_provider,
            model=requested_model,
            base_url=resolved_base_url,
        )

    return SimpleNamespace(
        success=True,
        new_model=requested_model,
        target_provider=normalized_provider,
        provider_changed=normalized_provider != previous_provider,
        api_key=str(getattr(cred, "access_token", "") or ""),
        base_url=resolved_base_url,
        api_mode=_direct_provider_api_mode(normalized_provider, resolved_base_url),
        provider_label=normalized_provider,
        warning_message="",
        error_message="",
        capabilities=None,
        model_info=None,
        is_global=persist,
    )

def _switch_model_sync(model: str, persist: bool,
                       provider: str | None,
                       base_url: str | None):
    """Sync core of switch_model — runs inside asyncio.to_thread (DELTA-7)."""
    global _current_model, _current_provider
    from hermes_cli.model_switch import switch_model as hermes_switch_model

    current_provider = _canonicalize_provider(_current_provider)
    explicit_provider = _canonicalize_provider(provider)

    if explicit_provider in {"openai", "anthropic"}:
        return _switch_managed_provider_sync(
            model=model,
            persist=persist,
            provider=explicit_provider,
        )

    try:
        from agent.credential_pool import load_pool
        cur_cred = load_pool(current_provider or "openai").peek() if current_provider else None
    except Exception:
        cur_cred = None

    result = hermes_switch_model(
        raw_input=model,
        current_provider=current_provider or "",
        current_model=_current_model,
        current_base_url=cur_cred.base_url if cur_cred else "",
        current_api_key=cur_cred.access_token if cur_cred else "",
        is_global=persist,
        explicit_provider=explicit_provider or "",
    )
    if not result.success:
        return result

    # Critic MF-6: ModelSwitchResult may return success=True with empty
    # target_provider / new_model in edge cases (alias resolved on current
    # provider, no change). NEVER overwrite with empty values — that would
    # drop DELTA-4's credential_pool provider key and break subsequent
    # AIAgent creation.
    if result.new_model:
        _current_model = result.new_model
    if result.target_provider:
        _current_provider = _canonicalize_provider(result.target_provider)

    if persist:
        _persist_model_selection(
            provider=_canonicalize_provider(result.target_provider),
            model=result.new_model,
            base_url=result.base_url or base_url or "",
        )
    return result


async def switch_model(model: str, *, persist: bool = False,
                       provider: str | None = None,
                       base_url: str | None = None):
    """Async wrapper: disk I/O runs in a thread (DELTA-7 event loop hygiene)."""
    return await asyncio.to_thread(_switch_model_sync, model, persist, provider, base_url)


def get_current_model() -> str:
    return _current_model


def get_current_provider() -> str:
    return _canonicalize_provider(_current_provider)


# ── Config loader ─────────────────────────────────────────────────────────────

def init_from_hermes_config() -> None:
    """Read model/provider from HERMES_HOME/config.yaml on startup.

    DELTA-4: no longer reads or caches api_key or base_url — credential
    resolution is delegated to hermes credential_pool per request.
    """
    global _current_model, _current_provider
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
        model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else None
        model = (model_cfg or {}).get("name") or (cfg.get("model") if isinstance(cfg.get("model"), str) else None)
        if isinstance(model, str):
            _current_model = model
        provider = (model_cfg or {}).get("provider")
        if isinstance(provider, str):
            _current_provider = _canonicalize_provider(provider)
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Failed to load hermes config: %s", exc)
