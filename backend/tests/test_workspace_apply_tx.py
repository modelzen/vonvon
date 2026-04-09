"""AC-W2b: Verify _apply is fully transactional (Critic MF-2)."""
import os
from pathlib import Path
from unittest.mock import patch

import pytest


def test_chdir_failure_leaves_env_unchanged(tmp_path):
    import app.services.workspace_service as ws
    original_env = os.environ.get("TERMINAL_CWD", "UNSET")
    original_path = ws._current_path

    with patch("os.chdir", side_effect=OSError("no permission")):
        with pytest.raises(ValueError, match="chdir"):
            ws._apply(tmp_path)

    assert os.environ.get("TERMINAL_CWD", "UNSET") == original_env
    assert ws._current_path == original_path


def test_successful_apply_updates_both(tmp_path):
    import app.services.workspace_service as ws
    ws._apply(tmp_path)
    assert os.environ["TERMINAL_CWD"] == str(tmp_path.resolve())
    assert ws._current_path == tmp_path.resolve()


def test_apply_rejects_file_path(tmp_path):
    import app.services.workspace_service as ws
    f = tmp_path / "notadir.txt"
    f.write_text("x")
    original_path = ws._current_path

    with pytest.raises(ValueError, match="not a directory"):
        ws._apply(f)

    assert ws._current_path == original_path


async def test_set_workspace_skips_config_persist_on_invalid_path(tmp_path):
    """set_workspace must not call save_config if _apply raises."""
    import app.services.workspace_service as ws

    with patch("app.services.workspace_service.save_config") as mock_save:
        with pytest.raises(ValueError):
            await ws.set_workspace(str(tmp_path / "nonexistent"))
    mock_save.assert_not_called()
