"""Model listing, switching, and health check routes."""
import logging

from fastapi import APIRouter, HTTPException

from app.schemas import ModelSwitchRequest, HealthResponse
from app.services import agent_service
from app.config import HERMES_HOME

router = APIRouter()
logger = logging.getLogger(__name__)

# Fallback list used when list_authenticated_providers raises (R7 mitigation).
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
    from hermes_cli.model_switch import list_authenticated_providers
    try:
        providers = list_authenticated_providers(
            current_provider=agent_service.get_current_provider(),
        )
        if not isinstance(providers, list):
            providers = []
    except Exception as exc:
        logger.warning("list_authenticated_providers failed: %s", exc)
        providers = []
    return {
        "providers": providers,
        "current": agent_service.get_current_model(),
        "current_provider": agent_service.get_current_provider(),
    }


@router.post("/api/models/current")
async def set_current_model(req: ModelSwitchRequest):
    result = await agent_service.switch_model(
        req.model,
        persist=req.persist,
        provider=req.provider,
        base_url=req.base_url,
    )
    if not result.success:
        raise HTTPException(400, result.error_message)
    return {
        "model": result.new_model,
        "provider": result.target_provider,
        "base_url": result.base_url,
        "api_mode": result.api_mode,
        "persisted": req.persist,
        "warning": result.warning_message or None,
    }


@router.get("/api/health")
async def health():
    return {
        "status": "ok",
        "model": agent_service.get_current_model(),
        "hermes_home": str(HERMES_HOME),
    }
