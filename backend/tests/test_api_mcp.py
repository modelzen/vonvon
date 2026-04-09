"""Integration tests for MCP API routes: GET/POST/DELETE /api/mcp/servers."""
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Stub hermes mcp modules before app import (conftest stubs the rest)
sys.modules.setdefault("hermes_cli.mcp_config", MagicMock())
sys.modules.setdefault("hermes_cli.config_lock", MagicMock())
sys.modules.setdefault("app.services.mcp_service", MagicMock())

from app.main import app  # noqa: E402
from app.services import mcp_service  # noqa: E402


@pytest.fixture
def mcp_client():
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture(autouse=True)
def _mock_mcp_service():
    """Patch all mcp_service functions for every test in this module."""
    with (
        patch.object(mcp_service, "list_servers", return_value=[]),
        patch.object(mcp_service, "add_server", new_callable=AsyncMock),
        patch.object(mcp_service, "remove_server", new_callable=AsyncMock),
        patch.object(mcp_service, "probe_server", new_callable=AsyncMock),
    ):
        yield


def test_list_servers_empty(mcp_client):
    mcp_service.list_servers.return_value = []
    resp = mcp_client.get("/api/mcp/servers")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_servers_returns_entries(mcp_client):
    mcp_service.list_servers.return_value = [
        {"name": "fs", "command": "npx", "enabled": True,
         "url": None, "args": None, "headers": None, "env": None,
         "tools_count": 3, "last_probed_at": 1000.0, "last_error": None}
    ]
    resp = mcp_client.get("/api/mcp/servers")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["name"] == "fs"


def test_add_server_success(mcp_client):
    mcp_service.add_server.return_value = {
        "name": "fs", "command": "npx", "enabled": True,
        "url": None, "args": ["@mcp/fs"], "headers": None, "env": None,
        "tools_count": 2, "last_probed_at": 1000.0, "last_error": None,
    }
    resp = mcp_client.post("/api/mcp/servers", json={
        "name": "fs", "command": "npx", "args": ["@mcp/fs"]
    })
    assert resp.status_code == 200
    assert resp.json()["name"] == "fs"
    assert resp.json()["tools_count"] == 2


def test_add_server_invalid_name(mcp_client):
    resp = mcp_client.post("/api/mcp/servers", json={
        "name": "bad name with spaces", "url": "http://x"
    })
    assert resp.status_code == 422


def test_add_server_service_value_error(mcp_client):
    mcp_service.add_server.side_effect = ValueError("url or command is required")
    resp = mcp_client.post("/api/mcp/servers", json={"name": "bad", "enabled": True})
    assert resp.status_code in (400, 422)
    mcp_service.add_server.side_effect = None


def test_remove_server_success(mcp_client):
    mcp_service.remove_server.return_value = True
    resp = mcp_client.delete("/api/mcp/servers/fs")
    assert resp.status_code == 200
    assert resp.json() == {"removed": True}


def test_remove_server_not_found(mcp_client):
    mcp_service.remove_server.return_value = False
    resp = mcp_client.delete("/api/mcp/servers/ghost")
    assert resp.status_code == 404


def test_test_server_success(mcp_client):
    mcp_service.probe_server.return_value = {
        "ok": True, "latency_ms": 42,
        "tools": [{"name": "read_file", "description": "Read"}],
        "error": None,
    }
    resp = mcp_client.post("/api/mcp/servers/fs/test")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["latency_ms"] == 42
    assert len(data["tools"]) == 1


def test_test_server_probe_failure(mcp_client):
    mcp_service.probe_server.return_value = {
        "ok": False, "latency_ms": 50, "tools": [], "error": "connection refused",
    }
    resp = mcp_client.post("/api/mcp/servers/bad/test")
    assert resp.status_code == 200
    assert resp.json()["ok"] is False
