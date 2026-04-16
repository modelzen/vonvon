"""Managed first-party integrations routes."""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import feishu_integration_service

router = APIRouter()


class FeishuPermissionState(BaseModel):
    screen_recording: str
    accessibility: str


class FeishuManagedPaths(BaseModel):
    home: str
    runtime_root: str
    current_runtime: str
    cli_path: str
    skill_bridge_root: str


class FeishuIntegrationState(BaseModel):
    state_version: int
    provider: str
    feature_enabled: bool
    skills_enabled: bool
    orb_inspect_enabled: bool
    runtime_status: str
    config_initialized: bool
    authenticated: bool
    auth_identity: Optional[str] = None
    auth_default_as: Optional[str] = None
    auth_note: Optional[str] = None
    account_display_name: Optional[str] = None
    account_identifier: Optional[str] = None
    logged_in_accounts: list[str] = []
    current_version: Optional[str] = None
    latest_available_version: Optional[str] = None
    upgrade_available: bool = False
    last_checked_at: Optional[float] = None
    last_verified_at: Optional[float] = None
    last_good_version: Optional[str] = None
    last_error: Optional[str] = None
    internal_skills_synced: bool = False
    internal_skill_count: int = 0
    permissions: FeishuPermissionState
    managed_paths: FeishuManagedPaths


class FeishuVersionRequest(BaseModel):
    version: Optional[str] = None


class FeishuToggleRequest(BaseModel):
    enabled: bool


class FeishuFlowView(BaseModel):
    flow_id: str
    kind: str
    status: str
    started_at: float
    updated_at: float
    verification_url: Optional[str] = None
    device_code: Optional[str] = None
    error: Optional[str] = None
    output_excerpt: str = ""
    pid: Optional[int] = None
    command: list[str] = []


def _handle_runtime_error(exc: Exception) -> HTTPException:
    return HTTPException(400, str(exc))


@router.get("/api/integrations/feishu")
async def get_feishu_state() -> FeishuIntegrationState:
    return feishu_integration_service.get_state()


@router.post("/api/integrations/feishu/install")
async def install_feishu_runtime(
    req: Optional[FeishuVersionRequest] = None,
) -> FeishuIntegrationState:
    try:
        return feishu_integration_service.install_runtime(req.version if req else None)
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/verify")
async def verify_feishu_runtime() -> FeishuIntegrationState:
    try:
        return feishu_integration_service.verify_runtime()
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/updates/check")
async def check_feishu_updates() -> FeishuIntegrationState:
    try:
        return feishu_integration_service.check_for_updates()
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/upgrade")
async def upgrade_feishu_runtime(
    req: Optional[FeishuVersionRequest] = None,
) -> FeishuIntegrationState:
    try:
        return feishu_integration_service.upgrade_runtime(req.version if req else None)
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/config/start")
async def start_feishu_config_flow() -> FeishuFlowView:
    try:
        return feishu_integration_service.start_config_flow()
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/auth/start")
async def start_feishu_auth_flow() -> FeishuFlowView:
    try:
        return feishu_integration_service.start_auth_flow()
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/auth/complete/{flow_id}")
async def complete_feishu_auth_flow(flow_id: str) -> FeishuFlowView:
    try:
        return feishu_integration_service.complete_auth_flow(flow_id)
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.get("/api/integrations/feishu/flows/{flow_id}")
async def get_feishu_flow(flow_id: str) -> FeishuFlowView:
    try:
        return feishu_integration_service.get_flow_status(flow_id)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(404, str(exc))


@router.post("/api/integrations/feishu/feature")
async def set_feishu_feature(req: FeishuToggleRequest) -> FeishuIntegrationState:
    try:
        return feishu_integration_service.set_feature_enabled(req.enabled)
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/skills")
async def set_feishu_skills(req: FeishuToggleRequest) -> FeishuIntegrationState:
    try:
        return feishu_integration_service.set_skills_enabled(req.enabled)
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/orb-inspect")
async def set_feishu_orb_inspect(req: FeishuToggleRequest) -> FeishuIntegrationState:
    try:
        return feishu_integration_service.set_orb_inspect_enabled(req.enabled)
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)


@router.post("/api/integrations/feishu/uninstall")
async def uninstall_feishu_runtime() -> FeishuIntegrationState:
    try:
        return feishu_integration_service.uninstall_runtime()
    except (RuntimeError, ValueError) as exc:
        raise _handle_runtime_error(exc)
