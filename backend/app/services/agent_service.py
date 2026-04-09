"""AIAgent encapsulation for vonvon backend.

Pre-requisite: pip install -e /path/to/hermes-agent (editable install)
Do NOT use sys.path.insert — rely on editable install for imports.
"""
import asyncio
from typing import Optional

from run_agent import AIAgent
from hermes_state import SessionDB
from app.config import DEFAULT_MODEL, HERMES_HOME

# ── Global state (slimmed in v1.1) ────────────────────────────────────────────

_session_db: Optional[SessionDB] = None
_current_model: str = DEFAULT_MODEL
_current_provider: str = ""       # NEW in v1.1

# AIAgent is NOT thread-safe. Serialize all run_conversation calls via this lock.
_agent_lock = asyncio.Lock()

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


# ── Agent factory ─────────────────────────────────────────────────────────────

def create_agent(session_id: str, **callbacks) -> AIAgent:
    """Create a new AIAgent per request. AIAgent resolves credentials from
    hermes credential_pool internally when api_key/base_url are not passed."""
    return AIAgent(
        model=_current_model,
        session_id=session_id,
        session_db=get_session_db(),
        platform="vonvon",
        quiet_mode=True,
        **callbacks,
    )


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
            cfg.setdefault("model", {})
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
    """Read model/provider from ~/.hermes/config.yaml on startup.

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
