"""AIAgent encapsulation for vonvon backend.

Pre-requisite: pip install -e /path/to/hermes-agent (editable install)
Do NOT use sys.path.insert — rely on editable install for imports.
"""
import asyncio
from contextlib import suppress
from typing import Any, Optional

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

# NOTE (v1.1): _api_key / _base_url REMOVED — credential resolution is
# delegated entirely to hermes credential_pool via per-request lookups.


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
    if not _current_provider:
        log.info("peek_creds: _current_provider is empty, returning (None, None)")
        return (None, None)
    try:
        from agent.credential_pool import load_pool
        pool = load_pool(_current_provider)
        cred = pool.peek()
    except Exception as exc:
        log.warning("credential_pool.peek(%s) failed: %s", _current_provider, exc)
        return (None, None)
    if cred is None:
        log.info("peek_creds: pool.peek(%s) returned None", _current_provider)
        return (None, None)
    base_url = getattr(cred, "base_url", None) or None
    token = getattr(cred, "access_token", None) or None
    log.info(
        "peek_creds: provider=%s base_url=%s token_len=%d",
        _current_provider, base_url or "<none>", len(token) if token else 0,
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


def _switch_model_sync(model: str, persist: bool,
                       provider: str | None,
                       base_url: str | None):
    """Sync core of switch_model — runs inside asyncio.to_thread (DELTA-7)."""
    global _current_model, _current_provider
    from hermes_cli.model_switch import switch_model as hermes_switch_model

    try:
        from agent.credential_pool import load_pool
        cur_cred = load_pool(_current_provider or "openai").peek() if _current_provider else None
    except Exception:
        cur_cred = None

    result = hermes_switch_model(
        raw_input=model,
        current_provider=_current_provider or "",
        current_model=_current_model,
        current_base_url=cur_cred.base_url if cur_cred else "",
        current_api_key=cur_cred.access_token if cur_cred else "",
        is_global=persist,
        explicit_provider=provider or "",
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
        _current_provider = result.target_provider

    if persist:
        from hermes_cli.config import load_config, save_config
        from hermes_cli.config_lock import config_store_lock
        with config_store_lock():
            cfg = load_config()
            # hermes DEFAULT_CONFIG stores `model` as "" (str) on fresh
            # installs, and _normalize_root_model_keys only migrates str→dict
            # when a stale root-level provider/base_url also exists. So on a
            # clean HERMES_HOME cfg["model"] is the empty string and setdefault
            # won't replace it — we must normalize explicitly before any item
            # assignment, otherwise `cfg["model"]["provider"] = …` raises
            # TypeError: 'str' object does not support item assignment.
            model_cfg = cfg.get("model")
            if not isinstance(model_cfg, dict):
                legacy_name = model_cfg if isinstance(model_cfg, str) and model_cfg else None
                cfg["model"] = {"name": legacy_name} if legacy_name else {}
            cfg["model"]["provider"] = result.target_provider
            cfg["model"]["name"] = result.new_model
            if base_url:
                cfg["model"]["base_url"] = base_url
            save_config(cfg)
    return result


async def switch_model(model: str, *, persist: bool = False,
                       provider: str | None = None,
                       base_url: str | None = None):
    """Async wrapper: disk I/O runs in a thread (DELTA-7 event loop hygiene)."""
    return await asyncio.to_thread(_switch_model_sync, model, persist, provider, base_url)


def get_current_model() -> str:
    return _current_model


def get_current_provider() -> str:
    return _current_provider


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
            _current_provider = provider
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Failed to load hermes config: %s", exc)
