"""Skills management routes."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import skills_service

router = APIRouter()


class SkillView(BaseModel):
    name: str
    category: Optional[str] = None
    description: str = ""
    install_path: str = ""
    version: Optional[str] = None
    source: Optional[str] = None
    enabled_global: bool = True
    enabled_vonvon: bool = True


class SkillToggleRequest(BaseModel):
    name: str
    enabled: bool
    scope: str = Field("vonvon", pattern="^(vonvon|global)$")


class SkillSearchResult(BaseModel):
    identifier: str
    name: str
    description: str
    source: str
    trust_level: str


class SkillInstallStartRequest(BaseModel):
    identifier: str


class SkillJobStatus(BaseModel):
    job_id: str
    kind: str
    identifier: str
    status: str
    error: Optional[str] = None
    skill: Optional[SkillView] = None
    started_at: float
    updated_at: float


@router.get("/api/skills")
async def list_skills() -> list[SkillView]:
    return skills_service.list_skills()


@router.post("/api/skills/toggle")
async def toggle_skill(req: SkillToggleRequest) -> SkillView:
    try:
        return skills_service.toggle_skill(
            name=req.name, enabled=req.enabled, scope=req.scope
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get("/api/skills/search")
async def search_skills(q: str, limit: int = 10) -> list[SkillSearchResult]:
    if not q.strip():
        return []
    return skills_service.search_hub(q, limit=limit)


@router.post("/api/skills/install")
async def start_install(req: SkillInstallStartRequest) -> SkillJobStatus:
    try:
        return await skills_service.start_install_job(req.identifier)
    except ValueError as exc:
        raise HTTPException(429, str(exc))


@router.post("/api/skills/uninstall")
async def start_uninstall(name: str) -> SkillJobStatus:
    try:
        return await skills_service.start_uninstall_job(name)
    except ValueError as exc:
        raise HTTPException(429, str(exc))


@router.get("/api/skills/jobs/{job_id}")
async def poll_job(job_id: str) -> SkillJobStatus:
    status = skills_service.get_job_status(job_id)
    if status is None:
        raise HTTPException(404, "unknown job")
    return status


@router.get("/api/skills/updates")
async def check_updates() -> dict:
    return skills_service.check_updates()
