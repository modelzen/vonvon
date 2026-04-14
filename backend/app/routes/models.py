"""Model listing, switching, and health check routes."""
import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from app.schemas import ModelSwitchRequest, HealthResponse
from app.services import agent_service
from app.config import HERMES_HOME

router = APIRouter()
logger = logging.getLogger(__name__)

_PROVIDERS_CACHE_TTL_SECONDS = 60.0
_providers_cache: list[dict[str, Any]] = []
_providers_cache_time = 0.0
_providers_cache_lock = asyncio.Lock()

# Fallback list used when list_authenticated_providers raises (R7 mitigation).
AVAILABLE_MODELS = [
    "anthropic/claude-opus-4-20250514",
    "anthropic/claude-sonnet-4-20250514",
    "anthropic/claude-haiku-4-20250514",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-pro",
]


def clear_models_cache() -> None:
    global _providers_cache, _providers_cache_time
    _providers_cache = []
    _providers_cache_time = 0.0


def _clone_providers(providers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cloned: list[dict[str, Any]] = []
    for provider in providers:
        item = dict(provider)
        models = item.get("models")
        if isinstance(models, list):
            item["models"] = list(models)
        cloned.append(item)
    return cloned


def _mark_current_provider(
    providers: list[dict[str, Any]], current_provider: str
) -> list[dict[str, Any]]:
    marked = []
    for provider in providers:
        item = dict(provider)
        item["is_current"] = item.get("slug") == current_provider
        marked.append(item)
    marked.sort(key=lambda provider: (not provider.get("is_current", False), -int(provider.get("total_models", 0))))
    return marked


def _load_providers_sync(current_provider: str) -> list[dict[str, Any]]:
    from hermes_cli.model_switch import list_authenticated_providers

    try:
        providers = list_authenticated_providers(current_provider=current_provider)
        if not isinstance(providers, list):
            return []
        return [provider for provider in providers if isinstance(provider, dict)]
    except Exception as exc:
        logger.warning("list_authenticated_providers failed: %s", exc)
        return []


def _hydrate_codex_models_sync(providers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for provider in providers:
        if provider.get("slug") != "openai-codex":
            continue
        try:
            from hermes_cli.codex_models import get_codex_model_ids

            # Settings/chat only need a stable local catalog. Avoid blocking the
            # renderer on live ChatGPT model discovery here.
            cached_models = get_codex_model_ids()
            if cached_models:
                provider["models"] = cached_models
                provider["total_models"] = len(cached_models)
                provider["source"] = "codex-cache"
        except Exception as exc:
            logger.warning("openai-codex cached discovery failed: %s", exc)
        break
    return providers


async def _get_cached_providers(current_provider: str) -> list[dict[str, Any]]:
    global _providers_cache, _providers_cache_time

    now = time.monotonic()
    if _providers_cache and (now - _providers_cache_time) < _PROVIDERS_CACHE_TTL_SECONDS:
        return _mark_current_provider(_clone_providers(_providers_cache), current_provider)

    async with _providers_cache_lock:
        now = time.monotonic()
        if _providers_cache and (now - _providers_cache_time) < _PROVIDERS_CACHE_TTL_SECONDS:
            return _mark_current_provider(_clone_providers(_providers_cache), current_provider)

        providers = await asyncio.to_thread(_load_providers_sync, current_provider)
        providers = await asyncio.to_thread(_hydrate_codex_models_sync, providers)
        _providers_cache = _clone_providers(providers)
        _providers_cache_time = time.monotonic()
        return _mark_current_provider(_clone_providers(_providers_cache), current_provider)


@router.get("/api/models")
async def list_models():
    current_provider = agent_service.get_current_provider()
    providers = await _get_cached_providers(current_provider)

    return {
        "providers": providers,
        "current": agent_service.get_current_model(),
        "current_provider": current_provider,
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
    clear_models_cache()
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
