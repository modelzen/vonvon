"""Tests for skill prompt cache invalidation (AC-S12/S13 / CF-2).

Verifies that install, uninstall, and toggle all call
clear_skills_system_prompt_cache(clear_snapshot=True).
"""
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

from app.services import skills_service


@pytest.fixture(autouse=True)
def reset_jobs():
    skills_service._jobs.clear()
    yield
    skills_service._jobs.clear()


FAKE_SKILLS = [
    {"name": "pptx", "category": "office", "description": "",
     "install_path": "/x", "version": None, "source": "official"},
]


# ── AC-S13: toggle_skill calls cache clear ─────────────────────────────────────

def test_toggle_skill_calls_cache_clear_once():
    """AC-S13: toggling a skill calls clear_skills_system_prompt_cache once."""
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch("hermes_cli.config.load_config", return_value={}), \
         patch("hermes_cli.skills_config.get_disabled_skills", return_value=set()), \
         patch("hermes_cli.skills_config.save_disabled_skills"), \
         patch("hermes_cli.config_lock.config_store_lock") as mock_lock, \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache") as mock_clear:

        mock_lock.return_value.__enter__ = MagicMock(return_value=None)
        mock_lock.return_value.__exit__ = MagicMock(return_value=False)

        skills_service.toggle_skill(name="pptx", enabled=False, scope="vonvon")

    mock_clear.assert_called_once_with(clear_snapshot=True)


def test_toggle_skill_global_scope_also_clears_cache():
    """Cache clear happens for global scope too."""
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch("hermes_cli.config.load_config", return_value={}), \
         patch("hermes_cli.skills_config.get_disabled_skills", return_value=set()), \
         patch("hermes_cli.skills_config.save_disabled_skills"), \
         patch("hermes_cli.config_lock.config_store_lock") as mock_lock, \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache") as mock_clear:

        mock_lock.return_value.__enter__ = MagicMock(return_value=None)
        mock_lock.return_value.__exit__ = MagicMock(return_value=False)

        skills_service.toggle_skill(name="pptx", enabled=True, scope="global")

    mock_clear.assert_called_once_with(clear_snapshot=True)


def test_toggle_skill_cache_clear_failure_is_non_fatal():
    """If clear_skills_system_prompt_cache raises, toggle still returns normally."""
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch("hermes_cli.config.load_config", return_value={}), \
         patch("hermes_cli.skills_config.get_disabled_skills", return_value=set()), \
         patch("hermes_cli.skills_config.save_disabled_skills"), \
         patch("hermes_cli.config_lock.config_store_lock") as mock_lock, \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache",
               side_effect=RuntimeError("unavailable")):

        mock_lock.return_value.__enter__ = MagicMock(return_value=None)
        mock_lock.return_value.__exit__ = MagicMock(return_value=False)

        # Must not raise
        result = skills_service.toggle_skill(name="pptx", enabled=False, scope="vonvon")

    assert result["name"] == "pptx"


# ── AC-S12: uninstall clears cache ────────────────────────────────────────────

def test_do_uninstall_calls_cache_clear():
    """_do_uninstall calls clear_skills_system_prompt_cache after success."""
    with patch("tools.skills_hub.uninstall_skill", return_value=(True, "ok")), \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache") as mock_clear:
        skills_service._do_uninstall("pptx")

    mock_clear.assert_called_once_with(clear_snapshot=True)


def test_do_uninstall_raises_on_failure_no_cache_clear():
    """_do_uninstall raises RuntimeError and skips cache clear on failure."""
    with patch("tools.skills_hub.uninstall_skill", return_value=(False, "not found")), \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache") as mock_clear:
        with pytest.raises(RuntimeError, match="not found"):
            skills_service._do_uninstall("nonexistent")

    mock_clear.assert_not_called()


def test_do_uninstall_cache_clear_failure_non_fatal():
    """Cache clear failure during uninstall is non-fatal — result still returned."""
    with patch("tools.skills_hub.uninstall_skill", return_value=(True, "ok")), \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache",
               side_effect=RuntimeError("prompt builder not available")):
        result = skills_service._do_uninstall("pptx")

    assert result["name"] == "pptx"


# ── AC-S12: install calls cache clear (install_bundle_silent handles it) ───────

def test_do_install_calls_install_bundle_silent():
    """_do_install calls install_bundle_silent; cache clear is done inside that function."""
    mock_result = {
        "name": "pptx", "category": "office", "description": "",
        "install_path": "/skills/pptx", "source": "official",
    }
    with patch("tools.skills_hub.install_bundle_silent", return_value=mock_result) as mock_ibs:
        result = skills_service._do_install("official/pptx")

    mock_ibs.assert_called_once_with("official/pptx", force=False)
    assert result["name"] == "pptx"
