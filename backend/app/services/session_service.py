"""Session management via hermes SessionDB."""
import uuid
from typing import List, Dict, Any

from app.services import agent_service


def get_session_db():
    return agent_service.get_session_db()


def list_sessions() -> List[Dict[str, Any]]:
    db = get_session_db()
    return db.list_sessions_rich(source="vonvon")


def create_session(name: str) -> Dict[str, Any]:
    db = get_session_db()
    session_id = str(uuid.uuid4())
    db.create_session(session_id, source="vonvon", model=agent_service._current_model)
    db.set_session_title(session_id, name)
    return {"id": session_id, "name": name}


def get_messages(session_id: str) -> List[Dict[str, Any]]:
    """Return full conversation history (user/assistant/tool) from SessionDB."""
    db = get_session_db()
    return db.get_messages_as_conversation(session_id)


def reset_session(session_id: str) -> None:
    """Clear all messages but keep the session record."""
    db = get_session_db()
    db.clear_messages(session_id)


def delete_session(session_id: str) -> bool:
    db = get_session_db()
    return db.delete_session(session_id)


def get_usage(session_id: str) -> Dict[str, Any]:
    """Estimate context usage for a session using rough token counting."""
    db = get_session_db()
    messages = db.get_messages_as_conversation(session_id)
    from agent.model_metadata import estimate_tokens_rough
    total_tokens = sum(
        estimate_tokens_rough(m.get("content", "") or "")
        for m in messages
        if isinstance(m.get("content"), str)
    )
    ctx_size = agent_service.get_model_context_size()
    return {
        "usage_percent": round(total_tokens / ctx_size * 100) if ctx_size else 0,
        "total_tokens": total_tokens,
        "context_size": ctx_size,
    }


def replace_messages(session_id: str, messages: List[Dict[str, Any]]) -> None:
    """Replace all messages in a session (used after compression).

    Delegates to SessionDB.replace_messages which is added by WP4 (hermes 二次开发).
    Falls back to clear + re-insert via agent persistence if method not yet available.
    """
    db = get_session_db()
    if hasattr(db, "replace_messages"):
        db.replace_messages(session_id, messages)
    else:
        # Fallback: clear and note that full re-insert requires WP4
        db.clear_messages(session_id)
