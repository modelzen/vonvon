"""AC-C9: read-only HERMES_HOME causes graceful failure on workspace config persist."""
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


async def test_workspace_set_propagates_permission_error(tmp_path):
    """If save_config raises PermissionError, set_workspace lets it propagate."""
    import app.services.workspace_service as ws

    project = tmp_path / "project"
    project.mkdir()

    with patch("app.services.workspace_service.load_config", return_value={}), \
         patch("app.services.workspace_service.save_config",
               side_effect=PermissionError("read-only filesystem")), \
         patch("app.services.workspace_service.config_store_lock") as mock_lock:
        mock_lock.return_value.__enter__ = lambda s: s
        mock_lock.return_value.__exit__ = lambda s, *a: False
        with pytest.raises(PermissionError):
            await ws.set_workspace(str(project))


def test_init_from_hermes_config_tolerates_load_error(tmp_path):
    """init_from_hermes_config must not crash if load_config raises."""
    import app.services.workspace_service as ws
    sandbox = tmp_path / "workdir"

    with patch("app.services.workspace_service.load_config",
               side_effect=PermissionError("no access")), \
         patch.object(ws, "SANDBOX_PATH", sandbox):
        ws.init_from_hermes_config()

    assert ws._current_path == sandbox.resolve()
