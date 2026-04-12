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

    # For openai-codex, prefer live-discovered model IDs over the curated subset.
    for provider in providers:
        if not isinstance(provider, dict) or provider.get("slug") != "openai-codex":
            continue
        try:
            from agent.credential_pool import load_pool
            from hermes_cli.codex_models import get_codex_model_ids

            cred = load_pool("openai-codex").peek()
            access_token = getattr(cred, "access_token", None) if cred else None
            live_models = get_codex_model_ids(access_token=access_token)
            if live_models:
                provider["models"] = live_models
                provider["total_models"] = len(live_models)
                provider["source"] = "codex-live"
        except Exception as exc:
            logger.warning("openai-codex live discovery failed: %s", exc)
        break

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
