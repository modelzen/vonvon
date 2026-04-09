"""Session CRUD routes."""
from fastapi import APIRouter, HTTPException

import os

from app.schemas import SessionRequest
from app.services import session_service, workspace_service

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
