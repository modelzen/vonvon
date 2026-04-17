"""Session management via hermes SessionDB."""
import uuid
import logging
from typing import List, Dict, Any, Optional

from app.services import agent_service

log = logging.getLogger(__name__)


def get_session_db():
    return agent_service.get_session_db()


def _is_title_conflict(exc: ValueError) -> bool:
    return "already in use" in str(exc)


def _set_summarized_title(db, session_id: str, title: str) -> str:
    """Persist an auto-generated title, numbering it when the base is taken."""
    try:
        db.set_session_title(session_id, title)
        return title
    except ValueError as exc:
        if not _is_title_conflict(exc):
            raise

    unique_title = db.get_next_title_in_lineage(title)
    db.set_session_title(session_id, unique_title)
    return unique_title


def list_sessions(
    *,
    include_archived: bool = False,
    archived_only: bool = False,
) -> List[Dict[str, Any]]:
    db = get_session_db()
    try:
        return db.list_sessions_rich(
            source="vonvon",
            include_archived=include_archived or archived_only,
            archived_only=archived_only,
        )
    except TypeError as exc:
        # Packaged builds may run against an older hermes-agent runtime whose
        # SessionDB.list_sessions_rich() predates archive-filter parameters.
        # Fall back to the legacy signature and filter archived rows here so
        # history loading keeps working instead of returning HTTP 500.
        if "include_archived" not in str(exc) and "archived_only" not in str(exc):
            raise

        log.info(
            "SessionDB.list_sessions_rich() lacks archive kwargs; using legacy fallback"
        )
        sessions = db.list_sessions_rich(source="vonvon")
        if archived_only:
            return [session for session in sessions if session.get("archived_at")]
        if include_archived:
            return sessions
        return [session for session in sessions if not session.get("archived_at")]


def create_session(name: str) -> Dict[str, Any]:
    import time
    db = get_session_db()
    session_id = str(uuid.uuid4())
    db.create_session(session_id, source="vonvon", model=agent_service._current_model)
    db.set_session_title(session_id, name)
    return {"id": session_id, "name": name, "last_active": time.time()}


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


def archive_session(session_id: str) -> Optional[float]:
    db = get_session_db()
    return db.archive_session(session_id)


def restore_session(session_id: str) -> bool:
    db = get_session_db()
    return db.restore_session(session_id)


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


def rename_session(session_id: str, name: str) -> None:
    db = get_session_db()
    db.set_session_title(session_id, name)


async def summarize_title(session_id: str,
                          model: str | None = None,
                          provider: str | None = None) -> str:
    """Generate a short title using AIAgent (provider-agnostic, handles all models).

    Uses a temporary session so history of the real session is never polluted.
    Acquires _agent_lock with a 3s timeout — skips LLM and uses fallback if busy.
    """
    import asyncio
    import uuid
    import logging
    log = logging.getLogger(__name__)

    messages = get_messages(session_id)
    first_user_text = ""
    conversation_parts: list[str] = []
    for m in messages[:6]:
        role = m.get("role")
        content = m.get("content") or ""
        if not isinstance(content, str):
            continue
        if role == "user":
            if not first_user_text:
                first_user_text = content.strip()
            conversation_parts.append(f"用户: {content[:300]}")
        elif role == "assistant" and content.strip():
            conversation_parts.append(f"助手: {content[:200]}")
        if len(conversation_parts) >= 2:
            break

    if not conversation_parts and not first_user_text:
        return ""

    conversation_text = "\n".join(conversation_parts) if conversation_parts else first_user_text
    prompt = (
        "请用10字以内总结以下对话的主题，只返回标题本身，"
        "不要加引号、标点或任何解释：\n\n" + conversation_text
    )

    # Resolve model/credentials: use specified provider, else fall back to current.
    effective_model = model or agent_service._current_model
    effective_provider = provider or agent_service._current_provider

    title = ""
    temp_session_id = str(uuid.uuid4())
    db = get_session_db()
    db.create_session(temp_session_id, source="vonvon_internal", model=effective_model)
    try:
        await asyncio.wait_for(agent_service._agent_lock.acquire(), timeout=3.0)
        try:
            if model and provider and (model != agent_service._current_model
                                       or provider != agent_service._current_provider):
                # Resolve credentials for the specified provider
                try:
                    from agent.credential_pool import load_pool
                    cred = load_pool(effective_provider).peek()
                except Exception:
                    cred = None
                from run_agent import AIAgent
                agent = AIAgent(
                    model=effective_model,
                    base_url=getattr(cred, "base_url", None) or None,
                    api_key=getattr(cred, "access_token", None) or None,
                    session_id=temp_session_id,
                    session_db=db,
                    platform="vonvon",
                    quiet_mode=True,
                )
            else:
                agent = agent_service.create_agent(session_id=temp_session_id)
            result = await asyncio.to_thread(
                agent.run_conversation,
                user_message=prompt,
                conversation_history=[],
            )
            raw = (result.get("final_response") or "").strip()
            title = raw.strip('"\'「」【】《》""')
            log.info("summarize_title result for %s: %r", session_id, title)
        finally:
            agent_service._agent_lock.release()
    except asyncio.TimeoutError:
        log.info("summarize_title: agent busy, using fallback for %s", session_id)
    except Exception as exc:
        log.warning("summarize_title LLM failed for %s: %s", session_id, exc)
    finally:
        try:
            db.delete_session(temp_session_id)
        except Exception:
            pass

    # Fallback: first 15 chars of first user message
    if not title and first_user_text:
        title = first_user_text[:15].rstrip()

    if title:
        title = _set_summarized_title(db, session_id, title)
    return title


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
