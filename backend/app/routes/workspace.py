"""Workspace routes — GET/POST /api/workspace, POST /api/workspace/reset."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import workspace_service

router = APIRouter()


class WorkspaceState(BaseModel):
    path: str
    exists: bool
    is_dir: bool
    is_sandbox: bool


class WorkspaceSetRequest(BaseModel):
    path: str = Field(..., min_length=1)


@router.get("/api/workspace")
async def get_workspace() -> WorkspaceState:
    return workspace_service.current_state()


@router.post("/api/workspace")
async def set_workspace(req: WorkspaceSetRequest) -> WorkspaceState:
    try:
        return await workspace_service.set_workspace(req.path)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/api/workspace/reset")
async def reset_workspace() -> WorkspaceState:
    """Reset workspace to ~/.vonvon/workdir/ sandbox (clears vonvon.workspace)."""
    return await workspace_service.reset_to_sandbox()
