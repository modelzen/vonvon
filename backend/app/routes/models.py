"""Model listing, switching, and health check routes."""
import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from app.schemas import ModelSwitchRequest, HealthResponse
from app.services import agent_service, auth_service
from app.config import HERMES_HOME

router = APIRouter()
logger = logging.getLogger(__name__)

_PROVIDERS_CACHE_TTL_SECONDS = 60.0
_providers_cache: list[dict[str, Any]] = []
_providers_cache_time = 0.0
_providers_cache_lock = asyncio.Lock()

_MANAGED_PROVIDER_LABELS = {
    "openai": "OpenAI",
    "openai-codex": "OpenAI Codex",
    "anthropic": "Anthropic",
}

_MANAGED_PROVIDER_IDS = set(_MANAGED_PROVIDER_LABELS)

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
    from hermes_cli.config import load_config

    user_providers: dict[str, Any] | None = None
    try:
        cfg = load_config()
        providers_cfg = cfg.get("providers") if isinstance(cfg, dict) else None
        if isinstance(providers_cfg, dict):
            user_providers = providers_cfg
    except Exception as exc:
        logger.debug("load_config for user providers failed: %s", exc)

    try:
        providers = list_authenticated_providers(
            current_provider=current_provider,
            user_providers=user_providers,
        )
        if not isinstance(providers, list):
            return []
        return [provider for provider in providers if isinstance(provider, dict)]
    except Exception as exc:
        logger.warning("list_authenticated_providers failed: %s", exc)
        return []


def _provider_has_credentials_sync(provider_id: str) -> bool:
    normalized = auth_service.canonicalize_provider(provider_id)
    if not normalized:
        return False
    if normalized not in _MANAGED_PROVIDER_IDS:
        # Leave third-party Hermes providers alone; we only normalize the
        # providers that this settings screen manages directly.
        return True

    try:
        from agent.credential_pool import load_pool

        pool = load_pool(normalized)
        entries = pool.entries() if pool is not None else []
    except Exception as exc:
        logger.warning("credential pool lookup failed for %s: %s", normalized, exc)
        return False

    return isinstance(entries, list) and len(entries) > 0


def _resolve_effective_current_provider_sync(current_provider: str) -> str:
    normalized = auth_service.canonicalize_provider(current_provider)
    if not normalized:
        return ""
    return normalized if _provider_has_credentials_sync(normalized) else ""

def _filter_unmanaged_providers_sync(providers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for provider in providers:
        slug = auth_service.canonicalize_provider(str(provider.get("slug", "")))
        if slug in _MANAGED_PROVIDER_IDS:
            continue
        filtered.append(provider)
    return filtered


def _probe_overridden_provider_sync(provider_id: str) -> dict[str, Any] | None:
    from agent.credential_pool import load_pool

    try:
        from hermes_cli.models import probe_api_models
    except Exception:
        return None

    normalized_provider = auth_service.canonicalize_provider(provider_id)
    if normalized_provider not in {"openai", "anthropic"}:
        return None

    try:
        pool = load_pool(normalized_provider)
        entries = pool.entries()
    except Exception as exc:
        logger.warning("provider pool load failed for %s: %s", normalized_provider, exc)
        return {
            "slug": normalized_provider,
            "name": _MANAGED_PROVIDER_LABELS[normalized_provider],
            "models": [],
            "total_models": 0,
            "source": "override-endpoint",
            "usable": False,
            "error": f"读取凭据失败: {exc}",
        }

    if not isinstance(entries, list) or not entries:
        return None

    current = pool.peek()
    base_url = str(getattr(current, "base_url", "") or "").strip().rstrip("/")
    api_key = str(getattr(current, "access_token", "") or "")
    default_base_url = auth_service._provider_default_base_url(normalized_provider)

    if not current or not base_url or not default_base_url or base_url == default_base_url:
        return None

    try:
        probe = probe_api_models(api_key, base_url, timeout=5.0)
    except Exception as exc:
        logger.warning("override provider probe failed for %s: %s", normalized_provider, exc)
        return {
            "slug": normalized_provider,
            "name": _MANAGED_PROVIDER_LABELS[normalized_provider],
            "models": [],
            "total_models": 0,
            "source": "override-endpoint",
            "usable": False,
            "error": f"探测模型接口失败: {exc}",
        }

    raw_models = probe.get("models")
    models: list[str] = []
    if isinstance(raw_models, list):
        seen: set[str] = set()
        for model in raw_models:
            model_id = str(model or "").strip()
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            models.append(model_id)

    if models:
        return {
            "slug": normalized_provider,
            "name": _MANAGED_PROVIDER_LABELS[normalized_provider],
            "models": models,
            "total_models": len(models),
            "source": "override-endpoint",
            "usable": True,
            "error": None,
        }

    suggested_base = str(probe.get("suggested_base_url") or "").strip()
    probed_url = str(probe.get("probed_url") or f"{base_url}/models").strip()
    if raw_models == []:
        error = f"模型发现接口可访问，但没有返回任何模型: {probed_url}"
    else:
        error = f"无法从模型发现接口获取模型列表: {probed_url}"
    if suggested_base:
        error += f"；如果这个服务要求 /v1，可以尝试 Base URL: {suggested_base}"

    return {
        "slug": normalized_provider,
        "name": _MANAGED_PROVIDER_LABELS[normalized_provider],
        "models": [],
        "total_models": 0,
        "source": "override-endpoint",
        "usable": False,
        "error": error,
    }


def _default_models_for_provider_sync(provider_id: str) -> list[str]:
    try:
        from hermes_cli.models import _PROVIDER_MODELS
        models = _PROVIDER_MODELS.get(provider_id, [])
        return list(models) if isinstance(models, list) else []
    except Exception as exc:
        logger.warning("default provider catalog failed for %s: %s", provider_id, exc)
        return []


def _build_managed_provider_sync(provider_id: str) -> dict[str, Any] | None:
    normalized_provider = auth_service.canonicalize_provider(provider_id)
    if normalized_provider not in _MANAGED_PROVIDER_IDS:
        return None
    if not _provider_has_credentials_sync(normalized_provider):
        return None

    if normalized_provider == "openai-codex":
        provider = {
            "slug": "openai-codex",
            "name": _MANAGED_PROVIDER_LABELS["openai-codex"],
            "models": [],
            "total_models": 0,
            "source": "codex-cache",
            "usable": True,
            "error": None,
        }
        try:
            from hermes_cli.codex_models import get_codex_model_ids

            cached_models = get_codex_model_ids()
            if cached_models:
                provider["models"] = cached_models
                provider["total_models"] = len(cached_models)
        except Exception as exc:
            logger.warning("openai-codex cached discovery failed: %s", exc)
        return provider

    probed = _probe_overridden_provider_sync(normalized_provider)
    if probed is not None:
        return probed

    models = _default_models_for_provider_sync(normalized_provider)
    return {
        "slug": normalized_provider,
        "name": _MANAGED_PROVIDER_LABELS[normalized_provider],
        "models": models,
        "total_models": len(models),
        "source": "built-in",
        "usable": True,
        "error": None,
    }


def _merge_managed_providers_sync(providers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = list(providers)
    for provider_id in ("openai", "openai-codex", "anthropic"):
        provider = _build_managed_provider_sync(provider_id)
        if provider is not None:
            merged.append(provider)
    return merged


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
        providers = await asyncio.to_thread(_filter_unmanaged_providers_sync, providers)
        providers = await asyncio.to_thread(_merge_managed_providers_sync, providers)
        _providers_cache = _clone_providers(providers)
        _providers_cache_time = time.monotonic()
        return _mark_current_provider(_clone_providers(_providers_cache), current_provider)


@router.get("/api/models")
async def list_models():
    current_provider = await asyncio.to_thread(
        _resolve_effective_current_provider_sync,
        agent_service.get_current_provider(),
    )
    providers = await _get_cached_providers(current_provider)

    return {
        "providers": providers,
        "current": agent_service.get_current_model() if current_provider else "",
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
