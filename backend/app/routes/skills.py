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
    enabled: bool = True
    enabled_global: bool = True
    enabled_vonvon: bool = True


class SkillToggleRequest(BaseModel):
    name: str
    enabled: bool
    scope: str = Field("vonvon", pattern="^(vonvon|global|both)$")


class SkillSearchResult(BaseModel):
    identifier: str
    name: str
    description: str
    source: str
    trust_level: str


class SkillDiscoverItem(BaseModel):
    identifier: str
    name: str
    description: str
    source: str
    source_label: str
    trust_level: str
    category: str
    category_label: str
    tags: list[str] = []
    install_kind: str
    installed: bool = False


class SkillDiscoverPage(BaseModel):
    items: list[SkillDiscoverItem] = Field(default_factory=list)
    total: int
    offset: int
    limit: int
    has_more: bool


class SkillDiscoverRefreshResponse(BaseModel):
    count: int
    updated_at: float
    sources: dict[str, int] = Field(default_factory=dict)


class SkillInstallStartRequest(BaseModel):
    identifier: str


class SkillImportStartRequest(BaseModel):
    source: str
    name: Optional[str] = None
    category: Optional[str] = None
    conflict_strategy: str = Field("error", pattern="^(error|overwrite|rename)$")


class SkillJobStatus(BaseModel):
    job_id: str
    kind: str
    identifier: str
    status: str
    error: Optional[str] = None
    skill: Optional[SkillView] = None
    started_at: float
    updated_at: float


class SkillTemplate(BaseModel):
    name: str
    category: str
    description: str = ""
    identifier: str
    installed: bool = False


class SkillTemplateInstallRequest(BaseModel):
    identifier: str


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


@router.get("/api/skills/discover")
async def discover_skills(
    q: str = "",
    limit: int = 60,
    offset: int = 0,
    source: str = "all",
) -> SkillDiscoverPage:
    return skills_service.list_discoverable_skills(
        query=q,
        limit=limit,
        offset=offset,
        source=source,
    )


@router.post("/api/skills/discover/refresh")
async def refresh_discover_skills() -> SkillDiscoverRefreshResponse:
    try:
        return skills_service.refresh_discoverable_skills_cache()
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))


@router.post("/api/skills/install")
async def start_install(req: SkillInstallStartRequest) -> SkillJobStatus:
    try:
        return await skills_service.start_install_job(req.identifier)
    except ValueError as exc:
        raise HTTPException(429, str(exc))


@router.post("/api/skills/import")
async def start_import(req: SkillImportStartRequest) -> SkillJobStatus:
    try:
        return await skills_service.start_import_job(
            req.source,
            name=req.name,
            category=req.category,
            conflict_strategy=req.conflict_strategy,
        )
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


@router.get("/api/skills/templates")
async def list_templates() -> list[SkillTemplate]:
    return skills_service.list_templates()


@router.post("/api/skills/templates/install")
async def install_template(req: SkillTemplateInstallRequest) -> SkillView:
    try:
        return skills_service.install_template(req.identifier)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except FileExistsError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
