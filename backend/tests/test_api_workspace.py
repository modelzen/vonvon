"""HTTP API tests for /api/workspace endpoints."""
import os
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path):
    """TestClient with workspace_service patched to use tmp_path as sandbox."""
    import app.services.workspace_service as ws
    ws._current_path = tmp_path

    from app.main import app
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c, tmp_path


class TestGetWorkspace:
    def test_returns_current_state(self, client):
        c, tmp_path = client
        with patch("app.services.workspace_service._current_path", tmp_path):
            resp = c.get("/api/workspace")
        assert resp.status_code == 200
        data = resp.json()
        assert "path" in data
        assert "exists" in data
        assert "is_sandbox" in data


class TestSetWorkspace:
    def test_valid_path(self, client, tmp_path):
        c, _ = client
        new_dir = tmp_path / "project"
        new_dir.mkdir()
        with patch("hermes_cli.config.load_config", return_value={}), \
             patch("hermes_cli.config.save_config"), \
             patch("hermes_cli.config_lock.config_store_lock") as mock_lock:
            mock_lock.return_value.__enter__ = lambda s: s
            mock_lock.return_value.__exit__ = MagicMock(return_value=False)
            resp = c.post("/api/workspace", json={"path": str(new_dir)})
        assert resp.status_code == 200
        assert resp.json()["path"] == str(new_dir.resolve())

    def test_nonexistent_path_returns_400(self, client, tmp_path):
        c, _ = client
        resp = c.post("/api/workspace", json={"path": str(tmp_path / "missing_dir")})
        assert resp.status_code == 400

    def test_empty_path_returns_422(self, client):
        c, _ = client
        resp = c.post("/api/workspace", json={"path": ""})
        assert resp.status_code == 422


class TestResetWorkspace:
    def test_reset_returns_sandbox(self, client, tmp_path):
        c, _ = client
        sandbox = tmp_path / "workdir"
        sandbox.mkdir()
        import app.services.workspace_service as ws
        with patch.object(ws, "SANDBOX_PATH", sandbox), \
             patch("hermes_cli.config.load_config", return_value={}), \
             patch("hermes_cli.config.save_config"), \
             patch("hermes_cli.config_lock.config_store_lock") as mock_lock:
            mock_lock.return_value.__enter__ = lambda s: s
            mock_lock.return_value.__exit__ = MagicMock(return_value=False)
            resp = c.post("/api/workspace/reset")
        assert resp.status_code == 200
        assert resp.json()["is_sandbox"] is True
