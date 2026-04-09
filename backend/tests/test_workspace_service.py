"""Unit tests for workspace_service — AC-W1..W6, MF-2 transactional _apply."""
import os
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


@pytest.fixture(autouse=True)
def reset_workspace_module(tmp_path):
    """Reset workspace_service module state before each test."""
    import importlib
    import app.services.workspace_service as ws
    # Reset _current_path to a known state
    ws._current_path = ws.SANDBOX_PATH
    yield ws
    # Restore cwd if tests changed it
    try:
        os.chdir(Path.home())
    except Exception:
        pass


class TestEnsureSandbox:
    def test_creates_directory(self, tmp_path):
        import app.services.workspace_service as ws
        sandbox = tmp_path / "workdir"
        with patch.object(ws, "SANDBOX_PATH", sandbox):
            result = ws._ensure_sandbox()
        assert result == sandbox
        assert sandbox.is_dir()

    def test_seeds_readme(self, tmp_path):
        import app.services.workspace_service as ws
        sandbox = tmp_path / "workdir"
        with patch.object(ws, "SANDBOX_PATH", sandbox):
            ws._ensure_sandbox()
        assert (sandbox / "README.md").exists()

    def test_idempotent(self, tmp_path):
        import app.services.workspace_service as ws
        sandbox = tmp_path / "workdir"
        with patch.object(ws, "SANDBOX_PATH", sandbox):
            ws._ensure_sandbox()
            ws._ensure_sandbox()  # second call should not raise
        assert sandbox.is_dir()


class TestApplyTransactional:
    """AC-W2 / Critic MF-2: _apply must be fully transactional."""

    def test_apply_valid_path(self, tmp_path):
        import app.services.workspace_service as ws
        ws._apply(tmp_path)
        assert str(tmp_path) == os.environ.get("TERMINAL_CWD")
        assert ws._current_path == tmp_path

    def test_apply_missing_path_raises(self, tmp_path):
        import app.services.workspace_service as ws
        missing = tmp_path / "does_not_exist"
        with pytest.raises(ValueError, match="does not exist"):
            ws._apply(missing)

    def test_apply_file_not_dir_raises(self, tmp_path):
        import app.services.workspace_service as ws
        f = tmp_path / "file.txt"
        f.write_text("x")
        with pytest.raises(ValueError, match="not a directory"):
            ws._apply(f)

    def test_apply_rollback_on_chdir_failure(self, tmp_path):
        """If chdir fails, TERMINAL_CWD must NOT be changed (MF-2)."""
        import app.services.workspace_service as ws
        original_path = ws._current_path
        original_env = os.environ.get("TERMINAL_CWD", "")

        with patch("os.chdir", side_effect=OSError("permission denied")):
            with pytest.raises(ValueError):
                ws._apply(tmp_path)

        # env must not have changed
        assert os.environ.get("TERMINAL_CWD", "") == original_env
        assert ws._current_path == original_path


class TestSetWorkspace:
    async def test_sets_path_and_env(self, tmp_path):
        import app.services.workspace_service as ws
        with patch("app.services.workspace_service.load_config", return_value={}), \
             patch("app.services.workspace_service.save_config"), \
             patch("app.services.workspace_service.config_store_lock") as mock_lock:
            mock_lock.return_value.__enter__ = lambda s: s
            mock_lock.return_value.__exit__ = MagicMock(return_value=False)
            result = await ws.set_workspace(str(tmp_path))
        assert result["path"] == str(tmp_path.resolve())
        assert result["exists"] is True
        assert result["is_dir"] is True

    async def test_rejects_nonexistent_path(self, tmp_path):
        import app.services.workspace_service as ws
        with pytest.raises(ValueError):
            await ws.set_workspace(str(tmp_path / "missing"))


class TestResetToSandbox:
    async def test_resets_to_sandbox(self, tmp_path):
        import app.services.workspace_service as ws
        sandbox = tmp_path / "workdir"
        sandbox.mkdir()
        with patch.object(ws, "SANDBOX_PATH", sandbox), \
             patch("app.services.workspace_service.load_config",
                   return_value={"vonvon": {"workspace": "/old"}}), \
             patch("app.services.workspace_service.save_config"), \
             patch("app.services.workspace_service.config_store_lock") as mock_lock:
            mock_lock.return_value.__enter__ = lambda s: s
            mock_lock.return_value.__exit__ = MagicMock(return_value=False)
            result = await ws.reset_to_sandbox()
        assert result["is_sandbox"] is True


class TestCurrentState:
    def test_returns_current_path_info(self, tmp_path):
        import app.services.workspace_service as ws
        ws._current_path = tmp_path
        state = ws.current_state()
        assert state["path"] == str(tmp_path)
        assert state["exists"] is True
        assert state["is_dir"] is True


class TestInitFromHermesConfig:
    def test_uses_persisted_workspace(self, tmp_path):
        import app.services.workspace_service as ws
        with patch("app.services.workspace_service.load_config",
                   return_value={"vonvon": {"workspace": str(tmp_path)}}):
            ws.init_from_hermes_config()
        assert ws._current_path == tmp_path.resolve()

    def test_falls_back_to_sandbox_on_invalid_persisted(self, tmp_path):
        import app.services.workspace_service as ws
        sandbox = tmp_path / "workdir"
        sandbox.mkdir()
        with patch("hermes_cli.config.load_config",
                   return_value={"vonvon": {"workspace": "/nonexistent/path/xyz"}}), \
             patch.object(ws, "SANDBOX_PATH", sandbox):
            ws.init_from_hermes_config()
        assert ws._current_path == sandbox.resolve()

    def test_falls_back_to_sandbox_on_no_config(self, tmp_path):
        import app.services.workspace_service as ws
        sandbox = tmp_path / "workdir"
        with patch("hermes_cli.config.load_config", return_value={}), \
             patch.object(ws, "SANDBOX_PATH", sandbox):
            ws.init_from_hermes_config()
        assert ws._current_path == sandbox.resolve()
