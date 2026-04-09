"""Pydantic request/response models for vonvon backend API."""
from typing import Optional
from pydantic import BaseModel


class ChatRequest(BaseModel):
    session_id: str
    message: str


class CompressRequest(BaseModel):
    session_id: str


class SessionRequest(BaseModel):
    name: str


class ModelSwitchRequest(BaseModel):
    model: str


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
