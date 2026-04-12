"""Session CRUD routes."""
from fastapi import APIRouter, HTTPException

import os

from app.schemas import SessionRequest
from app.services import session_service, workspace_service
from pydantic import BaseModel


class RenameRequest(BaseModel):
    name: str


class SummarizeRequest(BaseModel):
    model: str | None = None
    provider: str | None = None

router = APIRouter()


@router.get("/api/sessions")
async def list_sessions():
    return session_service.list_sessions()


@router.post("/api/sessions", status_code=201)
async def create_session(req: SessionRequest):
    # DELTA-5: defensive TERMINAL_CWD reset before session creation
    os.environ["TERMINAL_CWD"] = workspace_service.current_state()["path"]
    return session_service.create_session(req.name)


@router.delete("/api/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str):
    ok = session_service.delete_session(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Session not found")


@router.post("/api/sessions/{session_id}/reset")
async def reset_session(session_id: str):
    session_service.reset_session(session_id)
    return {"reset": True, "session_id": session_id}


@router.get("/api/sessions/{session_id}/usage")
async def get_usage(session_id: str):
    return session_service.get_usage(session_id)


@router.patch("/api/sessions/{session_id}")
async def rename_session(session_id: str, req: RenameRequest):
    session_service.rename_session(session_id, req.name)
    return {"id": session_id, "name": req.name}


@router.post("/api/sessions/{session_id}/summarize")
async def summarize_session_title(session_id: str, req: SummarizeRequest = SummarizeRequest()):
    title = await session_service.summarize_title(
        session_id, model=req.model, provider=req.provider
    )
    if not title:
        raise HTTPException(status_code=422, detail="Could not generate title")
    return {"id": session_id, "name": title}


@router.get("/api/sessions/{session_id}/messages")
async def get_session_messages(session_id: str) -> list[dict]:
    """Return the full conversation history for a session.

    Used by the frontend when switching between sessions so the chat view
    can rehydrate without waiting for the next send. Format comes straight
    from SessionDB.get_messages_as_conversation via session_service.
    """
    try:
        return session_service.get_messages(session_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
