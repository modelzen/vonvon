"""Integration tests for auth API endpoints via FastAPI TestClient."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch, AsyncMock

import pytest
from fastapi.testclient import TestClient

# ── Stub hermes modules before app import ────────────────────────────────────
_credential_pool_mock = MagicMock()
_credential_pool_mock.AUTH_TYPE_API_KEY = "api_key"
_credential_pool_mock.AUTH_TYPE_OAUTH = "oauth"
_credential_pool_mock.SOURCE_MANUAL = "manual"

sys.modules.setdefault("agent", MagicMock())
sys.modules.setdefault("agent.credential_pool", _credential_pool_mock)
sys.modules.setdefault("agent.codex_device_flow", MagicMock())
sys.modules.setdefault("hermes_cli", MagicMock())
sys.modules.setdefault("hermes_cli.auth", MagicMock())
sys.modules.setdefault("run_agent", MagicMock())
sys.modules.setdefault("hermes_state", MagicMock())
sys.modules.setdefault("sse_starlette", MagicMock())
sys.modules.setdefault("sse_starlette.sse", MagicMock())

_hermes_cli_config = MagicMock()
_hermes_cli_config.load_config = MagicMock(return_value={})
sys.modules.setdefault("hermes_cli.config", _hermes_cli_config)

_model_meta = MagicMock()
_model_meta.get_model_context_length = MagicMock(return_value=200_000)
_model_meta.estimate_tokens_rough = MagicMock(side_effect=lambda t: max(1, len(t) // 4))
sys.modules.setdefault("agent.model_metadata", _model_meta)
sys.modules.setdefault("agent.context_compressor", MagicMock())

from app.main import app  # noqa: E402
from app.services import auth_service  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_flows():
    auth_service._active_flows.clear()
    yield
    auth_service._active_flows.clear()


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


_sample_cred_view = {
    "id": "abc123",
    "provider": "openai",
    "label": "my-key",
    "auth_type": "api_key",
    "last4": "...1234",
    "source": "manual",
    "status": "ok",
    "is_current": False,
}


# ── GET /api/auth/credentials ─────────────────────────────────────────────────

def test_list_credentials_ok(client):
    with patch.object(auth_service, "list_all_credentials", return_value=[_sample_cred_view]):
        resp = client.get("/api/auth/credentials")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["id"] == "abc123"
    assert "sk-" not in str(data)  # no plaintext token


# ── POST /api/auth/credentials ────────────────────────────────────────────────

def test_add_api_key_credential_ok(client):
    with patch.object(auth_service, "add_api_key_credential", return_value=_sample_cred_view):
        resp = client.post("/api/auth/credentials", json={
            "provider": "openai",
            "auth_type": "api_key",
            "api_key": "sk-secret",
        })
    assert resp.status_code == 200
    assert resp.json()["id"] == "abc123"


def test_add_api_key_credential_validation_error(client):
    with patch.object(
        auth_service,
        "add_api_key_credential",
        side_effect=ValueError("unsupported provider 'openrouter'"),
    ):
        resp = client.post("/api/auth/credentials", json={
            "provider": "openrouter",
            "auth_type": "api_key",
            "api_key": "sk-secret",
        })
    assert resp.status_code == 400
    assert "unsupported provider" in resp.json()["detail"]


def test_add_credential_missing_api_key(client):
    resp = client.post("/api/auth/credentials", json={
        "provider": "openai",
        "auth_type": "api_key",
    })
    assert resp.status_code == 400


def test_add_credential_oauth_rejected(client):
    resp = client.post("/api/auth/credentials", json={
        "provider": "openai-codex",
        "auth_type": "oauth",
    })
    assert resp.status_code == 400


# ── DELETE /api/auth/credentials/{provider}/{cred_id} ────────────────────────

def test_remove_credential_ok(client):
    with patch.object(auth_service, "remove_credential", return_value=True):
        resp = client.delete("/api/auth/credentials/openai/abc123")
    assert resp.status_code == 200
    assert resp.json()["removed"] is True


def test_remove_credential_not_found(client):
    with patch.object(auth_service, "remove_credential", return_value=False):
        resp = client.delete("/api/auth/credentials/openai/nope")
    assert resp.status_code == 404


def test_set_current_credential_ok(client):
    updated_cred = {**_sample_cred_view, "is_current": True}
    with patch.object(auth_service, "set_current_credential", return_value=updated_cred):
        resp = client.post("/api/auth/credentials/openai/abc123/current")
    assert resp.status_code == 200
    assert resp.json()["is_current"] is True


def test_set_current_credential_not_found(client):
    with patch.object(auth_service, "set_current_credential", return_value=None):
        resp = client.post("/api/auth/credentials/openai/nope/current")
    assert resp.status_code == 404


# ── POST /api/auth/oauth/start ────────────────────────────────────────────────

def test_oauth_start_ok(client):
    flow_resp = {
        "flow_id": "flow-abc",
        "provider": "openai-codex",
        "user_code": "ABCD-EFGH",
        "verification_url": "https://auth.openai.com/codex/device",
        "interval": 5,
        "expires_in_seconds": 900,
    }
    with patch.object(auth_service, "start_codex_oauth_flow", return_value=flow_resp) as start_mock:
        resp = client.post("/api/auth/oauth/start?provider=openai-codex&label=work")
    assert resp.status_code == 200
    data = resp.json()
    assert data["flow_id"] == "flow-abc"
    assert data["user_code"] == "ABCD-EFGH"
    start_mock.assert_called_once_with(label="work")


def test_oauth_start_unsupported_provider(client):
    resp = client.post("/api/auth/oauth/start?provider=github")
    assert resp.status_code == 400


# ── GET /api/auth/oauth/poll ──────────────────────────────────────────────────

def test_oauth_poll_pending(client):
    with patch.object(auth_service, "poll_codex_oauth_flow", return_value={"status": "pending"}):
        resp = client.get("/api/auth/oauth/poll?flow_id=flow-abc")
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"


def test_oauth_poll_success(client):
    success = {"status": "success", "credential": _sample_cred_view, "error": None}
    with patch.object(auth_service, "poll_codex_oauth_flow", return_value=success):
        resp = client.get("/api/auth/oauth/poll?flow_id=flow-abc")
    assert resp.status_code == 200
    assert resp.json()["status"] == "success"


# ── DELETE /api/auth/oauth/flows/{flow_id} ────────────────────────────────────

def test_oauth_cancel(client):
    with patch.object(auth_service, "cancel_codex_oauth_flow", return_value=None):
        resp = client.delete("/api/auth/oauth/flows/flow-abc")
    assert resp.status_code == 200
    assert resp.json()["cancelled"] is True
