"""AIAgent encapsulation for vonvon backend.

Pre-requisite: pip install -e /path/to/hermes-agent (editable install)
Do NOT use sys.path.insert — rely on editable install for imports.
"""
import asyncio
from typing import Optional

from run_agent import AIAgent
from hermes_state import SessionDB
from app.config import DEFAULT_MODEL, HERMES_HOME

# ── Global state ──────────────────────────────────────────────────────────────

_session_db: Optional[SessionDB] = None
_current_model: str = DEFAULT_MODEL
_base_url: Optional[str] = None
_api_key: Optional[str] = None

# AIAgent is NOT thread-safe. Serialize all run_conversation calls via this lock.
_agent_lock = asyncio.Lock()


# ── Session DB singleton ──────────────────────────────────────────────────────

def get_session_db() -> SessionDB:
    """Lazy-load SessionDB singleton using hermes default db path."""
    global _session_db
    if _session_db is None:
        _session_db = SessionDB()
    return _session_db


# ── Agent factory ─────────────────────────────────────────────────────────────

def create_agent(session_id: str, **callbacks) -> AIAgent:
    """Create a new AIAgent instance per request (lightweight), serialized via _agent_lock."""
    return AIAgent(
        model=_current_model,
        base_url=_base_url,
        api_key=_api_key,
        session_id=session_id,
        session_db=get_session_db(),
        platform="vonvon",
        quiet_mode=True,
        **callbacks,
    )


# ── Model utilities ───────────────────────────────────────────────────────────

def get_model_context_size() -> int:
    """Return the context window size for the current model."""
    from agent.model_metadata import get_model_context_length
    return get_model_context_length(
        _current_model,
        base_url=_base_url or "",
        api_key=_api_key or "",
    )


def switch_model(model: str) -> None:
    global _current_model
    _current_model = model


def get_current_model() -> str:
    return _current_model


# ── Config loader ─────────────────────────────────────────────────────────────

def init_from_hermes_config() -> None:
    """Read model/base_url/api_key from ~/.hermes/config.yaml on startup."""
    global _current_model, _base_url, _api_key
    try:
        from hermes_cli.config import load_config
        cfg = load_config()

        # Model: top-level "model" key or nested under "agent"
        model = cfg.get("model") or cfg.get("agent", {}).get("model")
        if model:
            _current_model = model

        # base_url / api_key: top-level or under "provider"
        base_url = cfg.get("base_url") or cfg.get("provider", {}).get("base_url")
        if base_url:
            _base_url = base_url

        api_key = cfg.get("api_key") or cfg.get("provider", {}).get("api_key")
        if api_key:
            _api_key = api_key

    except Exception as exc:
        # Non-fatal: fall back to env vars / defaults already loaded by hermes
        import logging
        logging.getLogger(__name__).warning("Failed to load hermes config: %s", exc)
