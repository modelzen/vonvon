"""Integration tests for managed Feishu integration routes."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app

BASE_STATE = {
    "state_version": 1,
    "provider": "feishu",
    "feature_enabled": False,
    "runtime_status": "installed_needs_config",
    "config_initialized": False,
    "authenticated": False,
    "current_version": "1.0.12",
    "latest_available_version": "1.0.13",
    "upgrade_available": True,
    "last_checked_at": 1700000000.0,
    "last_verified_at": 1700000000.0,
    "last_good_version": "1.0.11",
    "last_error": None,
    "internal_skills_synced": False,
    "internal_skill_count": 0,
    "permissions": {
        "screen_recording": "unknown",
        "accessibility": "unknown",
    },
    "managed_paths": {
        "home": "/tmp/feishu",
        "runtime_root": "/tmp/feishu/runtime",
        "current_runtime": "/tmp/feishu/runtime/current",
        "cli_path": "/tmp/feishu/runtime/current/node_modules/.bin/lark-cli",
        "skill_bridge_root": "/tmp/.hermes/skills/.vonvon-integrations/feishu",
    },
}

BASE_FLOW = {
    "flow_id": "flow-123",
    "kind": "config_init",
    "status": "waiting_user",
    "started_at": 1700000000.0,
    "updated_at": 1700000001.0,
    "verification_url": "https://example.com/auth",
    "device_code": None,
    "error": None,
    "output_excerpt": "Open browser",
    "pid": 1234,
    "command": ["lark-cli", "config", "init", "--new"],
}


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


def test_get_feishu_state(client):
    with patch("app.routes.integrations.feishu_integration_service") as svc:
        svc.get_state.return_value = BASE_STATE
        resp = client.get("/api/integrations/feishu")
    assert resp.status_code == 200
    assert resp.json()["provider"] == "feishu"
    assert resp.json()["managed_paths"]["cli_path"].endswith("lark-cli")


def test_install_feishu_runtime(client):
    installed = {**BASE_STATE, "runtime_status": "installed_needs_config"}
    with patch("app.routes.integrations.feishu_integration_service") as svc:
        svc.install_runtime.return_value = installed
        resp = client.post("/api/integrations/feishu/install", json={"version": "1.0.12"})
    assert resp.status_code == 200
    assert resp.json()["current_version"] == "1.0.12"
    svc.install_runtime.assert_called_once_with("1.0.12")


def test_start_config_flow(client):
    with patch("app.routes.integrations.feishu_integration_service") as svc:
        svc.start_config_flow.return_value = BASE_FLOW
        resp = client.post("/api/integrations/feishu/config/start")
    assert resp.status_code == 200
    assert resp.json()["verification_url"] == "https://example.com/auth"


def test_set_feature_400_on_service_error(client):
    with patch("app.routes.integrations.feishu_integration_service") as svc:
        svc.set_feature_enabled.side_effect = RuntimeError("not ready")
        resp = client.post("/api/integrations/feishu/feature", json={"enabled": True})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "not ready"


def test_preview_feishu_link(client):
    preview = {
        "title": "乌鲁木齐十天九日",
        "url": "https://foo.feishu.cn/docx/AbCdEf123456",
        "doc_type": "docx",
        "doc_token": "AbCdEf123456",
    }
    with patch("app.routes.integrations.feishu_integration_service") as svc:
        svc.resolve_link_preview.return_value = preview
        resp = client.post(
            "/api/integrations/feishu/link-preview",
            json={"url": "https://foo.feishu.cn/docx/AbCdEf123456"},
        )
    assert resp.status_code == 200
    assert resp.json()["title"] == "乌鲁木齐十天九日"
    svc.resolve_link_preview.assert_called_once_with("https://foo.feishu.cn/docx/AbCdEf123456")
