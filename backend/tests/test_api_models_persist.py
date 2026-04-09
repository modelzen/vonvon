"""Tests for models API: GET /api/models and POST /api/models/current.

Covers AC-M1..M3, including persist flag and list_authenticated_providers fallback.
"""
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import agent_service


@pytest.fixture
def models_client(mock_session_db):
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


# ── GET /api/models ───────────────────────────────────────────────────────────

def test_list_models_uses_authenticated_providers(models_client):
    """AC-M1: GET /api/models returns providers from list_authenticated_providers."""
    fake_providers = [
        {"slug": "openai", "name": "OpenAI", "models": ["gpt-4o"], "total_models": 1, "is_current": True}
    ]
    # list_authenticated_providers is a lazy import in the route handler;
    # patch the module attribute it's imported from.
    import sys
    sys.modules["hermes_cli.model_switch"].list_authenticated_providers = MagicMock(
        return_value=fake_providers
    )
    try:
        resp = models_client.get("/api/models")
    finally:
        sys.modules["hermes_cli.model_switch"].list_authenticated_providers = MagicMock()

    assert resp.status_code == 200
    data = resp.json()
    assert data["providers"] == fake_providers
    assert "current" in data
    assert "current_provider" in data


def test_list_models_fallback_on_error(models_client):
    """GET /api/models falls back to empty providers if list_authenticated_providers raises."""
    sys.modules["hermes_cli.model_switch"].list_authenticated_providers = MagicMock(
        side_effect=Exception("network error")
    )
    try:
        resp = models_client.get("/api/models")
    finally:
        sys.modules["hermes_cli.model_switch"].list_authenticated_providers = MagicMock()

    assert resp.status_code == 200
    data = resp.json()
    assert data["providers"] == []
    assert "current" in data


def test_list_models_reflects_current_model(models_client):
    """GET /api/models returns the current model from agent_service."""
    agent_service._current_model = "openai/gpt-4o"
    agent_service._current_provider = "openai"
    sys.modules["hermes_cli.model_switch"].list_authenticated_providers = MagicMock(return_value=[])
    try:
        resp = models_client.get("/api/models")
    finally:
        sys.modules["hermes_cli.model_switch"].list_authenticated_providers = MagicMock()

    assert resp.json()["current"] == "openai/gpt-4o"
    assert resp.json()["current_provider"] == "openai"


# ── POST /api/models/current ──────────────────────────────────────────────────

def _make_switch_result(success=True, new_model="openai/gpt-4o",
                        target_provider="openai", error_message=None):
    r = MagicMock()
    r.success = success
    r.new_model = new_model
    r.target_provider = target_provider
    r.base_url = ""
    r.api_mode = "api_key"
    r.warning_message = None
    r.error_message = error_message
    return r


def test_set_model_runtime_only(models_client):
    """AC-M2: POST with persist=false does not write to disk."""
    result = _make_switch_result()
    mock_switch = AsyncMock(return_value=result)
    with patch.object(agent_service, "switch_model", mock_switch):
        resp = models_client.post("/api/models/current", json={"model": "openai/gpt-4o"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["model"] == "openai/gpt-4o"
    assert data["persisted"] is False


def test_set_model_persist_flag(models_client):
    """AC-M3: POST with persist=true passes persist=True to switch_model."""
    result = _make_switch_result()
    mock_switch = AsyncMock(return_value=result)
    with patch.object(agent_service, "switch_model", mock_switch):
        resp = models_client.post("/api/models/current", json={
            "model": "openai/gpt-4o", "persist": True
        })
    assert resp.status_code == 200
    assert resp.json()["persisted"] is True
    mock_switch.assert_called_once()
    assert mock_switch.call_args.kwargs.get("persist") is True


def test_set_model_with_provider(models_client):
    """POST with explicit provider passes it through to switch_model."""
    result = _make_switch_result(target_provider="anthropic")
    mock_switch = AsyncMock(return_value=result)
    with patch.object(agent_service, "switch_model", mock_switch):
        resp = models_client.post("/api/models/current", json={
            "model": "claude-sonnet", "provider": "anthropic"
        })
    assert resp.status_code == 200
    assert mock_switch.call_args.kwargs.get("provider") == "anthropic"


def test_set_model_failure_returns_400(models_client):
    """POST /api/models/current returns 400 when switch fails."""
    result = _make_switch_result(success=False, error_message="model not found")
    mock_switch = AsyncMock(return_value=result)
    with patch.object(agent_service, "switch_model", mock_switch):
        resp = models_client.post("/api/models/current", json={"model": "bad-model"})
    assert resp.status_code == 400


def test_set_model_invalid_request(models_client):
    """POST /api/models/current requires model field."""
    resp = models_client.post("/api/models/current", json={})
    assert resp.status_code == 422


# ── DELTA-7: async switch_model ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_switch_model_is_async():
    """switch_model must be a coroutine function (DELTA-7)."""
    import inspect
    assert inspect.iscoroutinefunction(agent_service.switch_model)
