"""Model listing, switching, and health check routes."""
from fastapi import APIRouter

from app.schemas import ModelSwitchRequest, HealthResponse
from app.services import agent_service
from app.config import HERMES_HOME

router = APIRouter()

# Curated list of commonly used models; can be extended or made dynamic.
AVAILABLE_MODELS = [
    "anthropic/claude-opus-4-20250514",
    "anthropic/claude-sonnet-4-20250514",
    "anthropic/claude-haiku-4-20250514",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-pro",
]


@router.get("/api/models")
async def list_models():
    return {
        "models": AVAILABLE_MODELS,
        "current": agent_service.get_current_model(),
    }


@router.post("/api/models/current")
async def set_current_model(req: ModelSwitchRequest):
    agent_service.switch_model(req.model)
    return {"model": req.model}


@router.get("/api/health")
async def health():
    return {
        "status": "ok",
        "model": agent_service.get_current_model(),
        "hermes_home": str(HERMES_HOME),
    }
