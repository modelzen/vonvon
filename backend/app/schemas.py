"""Pydantic request/response models for vonvon backend API."""
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ChatAttachment(BaseModel):
    type: str = "image"      # currently only image is supported
    data_url: str            # e.g. "data:image/png;base64,...."
    name: Optional[str] = None


class ChatRequest(BaseModel):
    session_id: str
    message: str
    attachments: List[ChatAttachment] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)


class CompressRequest(BaseModel):
    session_id: str


class SessionRequest(BaseModel):
    name: str


class ModelSwitchRequest(BaseModel):
    model: str
    persist: bool = False
    provider: Optional[str] = None
    base_url: Optional[str] = None


class SessionResponse(BaseModel):
    id: str
    name: Optional[str] = None
    source: Optional[str] = None
    model: Optional[str] = None
    message_count: Optional[int] = None
    last_active: Optional[float] = None


class UsageResponse(BaseModel):
    usage_percent: int
    total_tokens: int
    context_size: int


class HealthResponse(BaseModel):
    status: str
    model: str
    hermes_home: str


# ── Auth schemas ──────────────────────────────────────────────────────────────

class CredentialCreateRequest(BaseModel):
    provider: str
    auth_type: str = "api_key"
    api_key: Optional[str] = None
    label: Optional[str] = None
    base_url: Optional[str] = None


class CredentialView(BaseModel):
    id: str
    provider: str
    label: str
    auth_type: str
    last4: str
    source: str
    status: Optional[str] = None
    is_current: bool


class OAuthStartResponse(BaseModel):
    flow_id: str
    provider: str
    user_code: str
    verification_url: str
    interval: int
    expires_in_seconds: int


class OAuthPollResponse(BaseModel):
    status: str
    credential: Optional[CredentialView] = None
    error: Optional[str] = None


# ── Workspace schemas ─────────────────────────────────────────────────────────

class WorkspaceState(BaseModel):
    path: str
    exists: bool
    is_dir: bool
    is_sandbox: bool


class WorkspaceSetRequest(BaseModel):
    path: str = Field(..., min_length=1)


# ── MCP schemas ───────────────────────────────────────────────────────────────

class McpServerConfig(BaseModel):
    name: str = Field(..., pattern=r"^[a-zA-Z0-9_-]{1,32}$")
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    headers: Optional[Dict[str, str]] = None
    env: Optional[Dict[str, str]] = None
    enabled: bool = True


class McpServerView(McpServerConfig):
    tools_count: Optional[int] = None
    last_probed_at: Optional[float] = None
    last_error: Optional[str] = None


class McpProbeResult(BaseModel):
    ok: bool
    latency_ms: int
    tools: List[Dict[str, Any]]
    error: Optional[str] = None


# ── Skills schemas ────────────────────────────────────────────────────────────

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
    scope: str = "vonvon"


class SkillSearchResult(BaseModel):
    identifier: str
    name: str
    description: str
    source: str
    trust_level: str


class SkillJobStatus(BaseModel):
    job_id: str
    kind: str
    identifier: str
    status: str
    error: Optional[str] = None
    skill: Optional[SkillView] = None
    started_at: float
    updated_at: float
