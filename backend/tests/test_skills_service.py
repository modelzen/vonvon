"""Tests for skills_service: list, toggle, search, check_updates, job API."""
import asyncio
import sys
import time
import types
from unittest.mock import MagicMock, patch

import pytest

from app.services import skills_service


@pytest.fixture(autouse=True)
def reset_jobs():
    skills_service._jobs.clear()
    yield
    skills_service._jobs.clear()


FAKE_SKILLS = [
    {
        "name": "pptx",
        "category": "office",
        "description": "PowerPoint generator",
        "install_path": "/skills/pptx",
        "version": "1.0",
        "source": "official",
    },
    {
        "name": "git-tools",
        "category": "dev",
        "description": "Git utilities",
        "install_path": "/skills/git-tools",
        "version": None,
        "source": "community",
    },
]


# ── list_skills ────────────────────────────────────────────────────────────────

def test_list_skills_returns_all():
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch.object(skills_service, "load_config", return_value={}), \
         patch.object(skills_service, "get_disabled_skills", return_value=set()):
        result = skills_service.list_skills()
    assert len(result) == 2
    assert {r["name"] for r in result} == {"pptx", "git-tools"}


def test_list_skills_marks_disabled():
    def _disabled(cfg, platform=None):
        return {"pptx"} if platform == "vonvon" else set()

    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch.object(skills_service, "load_config", return_value={}), \
         patch.object(skills_service, "get_disabled_skills", side_effect=_disabled):
        result = skills_service.list_skills()

    pptx = next(r for r in result if r["name"] == "pptx")
    assert pptx["enabled_vonvon"] is False
    assert pptx["enabled_global"] is True


def test_list_skills_returns_empty_on_exception():
    """_find_installed_skills returns [] on exception (AC-S1 guarantee)."""
    with patch("tools.skills_tool._find_all_skills",
               side_effect=RuntimeError("disk error")):
        result = skills_service._find_installed_skills()
    assert result == []


def test_find_installed_skills_catches_exception():
    with patch("tools.skills_tool._find_all_skills", side_effect=RuntimeError("disk")):
        result = skills_service._find_installed_skills()
    assert result == []


def test_extract_inline_skills_strips_tokens_and_dedupes():
    skills, stripped = skills_service.extract_inline_skills(
        'before @skill:"Checkpoint" after @skill:checkpoint'
    )
    assert skills == ["Checkpoint"]
    assert stripped == "before after"


def test_build_skill_turn_message_combines_loaded_skills():
    fake_skill_commands = types.SimpleNamespace()
    fake_skill_commands._load_skill_payload = MagicMock(
        side_effect=[
            ({"content": "checkpoint body"}, None, "Checkpoint"),
            ({"content": "browse body"}, None, "Browse"),
        ]
    )
    fake_skill_commands._build_skill_message = MagicMock(
        side_effect=lambda loaded_skill, _skill_dir, activation_note, runtime_note="": (
            f"{activation_note}\n{loaded_skill['content']}\n{runtime_note}"
        ).strip()
    )

    with patch.dict(sys.modules, {"agent.skill_commands": fake_skill_commands}):
        prompt, loaded, missing = skills_service.build_skill_turn_message(
            ["checkpoint", "browse"],
            user_instruction="save current state",
            task_id="session-1",
            runtime_note="Selected from composer.",
        )

    assert loaded == ["Checkpoint", "Browse"]
    assert missing == []
    assert "Checkpoint" in prompt
    assert "browse body" in prompt
    assert "save current state" in prompt
    assert "Selected from composer." in prompt


# ── toggle_skill ───────────────────────────────────────────────────────────────

def test_toggle_skill_invalid_scope():
    with pytest.raises(ValueError, match="scope must be"):
        skills_service.toggle_skill(name="pptx", enabled=False, scope="invalid")


def test_toggle_skill_calls_cache_clear():
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


def test_toggle_skill_returns_updated_view():
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch("hermes_cli.config.load_config", return_value={}), \
         patch("hermes_cli.skills_config.get_disabled_skills", return_value=set()), \
         patch("hermes_cli.skills_config.save_disabled_skills"), \
         patch("hermes_cli.config_lock.config_store_lock") as mock_lock, \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache"):

        mock_lock.return_value.__enter__ = MagicMock(return_value=None)
        mock_lock.return_value.__exit__ = MagicMock(return_value=False)
        result = skills_service.toggle_skill(name="pptx", enabled=False, scope="vonvon")

    assert result["name"] == "pptx"


# ── search_hub ─────────────────────────────────────────────────────────────────

def test_search_hub_returns_results():
    mock_result = MagicMock()
    mock_result.identifier = "official/pptx"
    mock_result.name = "pptx"
    mock_result.description = "Make PPT"
    mock_result.source = "official"
    mock_result.trust_level = "trusted"

    with patch("tools.skills_hub.GitHubAuth"), \
         patch("tools.skills_hub.create_source_router", return_value=[]), \
         patch("tools.skills_hub.unified_search", return_value=[mock_result]):
        result = skills_service.search_hub("pptx", limit=10)

    assert len(result) == 1
    assert result[0]["identifier"] == "official/pptx"


def test_search_hub_returns_empty_on_error():
    with patch("tools.skills_hub.unified_search", side_effect=RuntimeError("network")):
        result = skills_service.search_hub("anything", limit=5)
    assert result == []


# ── check_updates ──────────────────────────────────────────────────────────────

def test_check_updates_returns_updates():
    with patch("tools.skills_hub.check_for_skill_updates", return_value=[{"name": "pptx"}]):
        result = skills_service.check_updates()
    assert result["updates"] == [{"name": "pptx"}]
    assert result["error"] is None


def test_check_updates_graceful_on_error():
    with patch("tools.skills_hub.check_for_skill_updates",
               side_effect=RuntimeError("timeout")):
        result = skills_service.check_updates()
    assert result["updates"] == []
    assert "timeout" in result["error"]


# ── job API ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_start_install_job_creates_job():
    with patch.object(skills_service, "_do_install", return_value={
        "name": "pptx", "category": "office", "description": "",
        "install_path": "/x", "version": None, "source": "official",
    }):
        status = await skills_service.start_install_job("official/pptx")

    assert status["kind"] == "install"
    assert status["identifier"] == "official/pptx"
    assert status["status"] in ("pending", "running", "success")


def test_get_job_status_returns_none_for_unknown():
    result = skills_service.get_job_status("nonexistent-job-id")
    assert result is None


def test_job_expiry_cleanup():
    """AC-S11: get_job_status triggers lazy cleanup of expired jobs."""
    old_job = skills_service.SkillJob(
        job_id="old-job-123",
        kind="install",
        identifier="official/old",
        status="success",
        updated_at=time.time() - (skills_service.FLOW_TTL_SECONDS + 60),
    )
    skills_service._jobs["old-job-123"] = old_job

    # Polling a different job triggers cleanup
    skills_service.get_job_status("some-other-id")

    assert "old-job-123" not in skills_service._jobs


@pytest.mark.asyncio
async def test_too_many_concurrent_jobs():
    for i in range(4):
        jid = f"active-job-{i}"
        skills_service._jobs[jid] = skills_service.SkillJob(
            job_id=jid, kind="install", identifier=f"pkg/{i}", status="running"
        )

    with pytest.raises(ValueError, match="too many"):
        await skills_service.start_install_job("extra/pkg")
