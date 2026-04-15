"""Tests for skills_service: list, toggle, search, check_updates, job API."""
import asyncio
import json
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
    assert all(r["enabled"] is True for r in result)


def test_list_skills_marks_disabled():
    def _disabled(cfg, platform=None):
        return {"pptx"} if platform == "vonvon" else set()

    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch.object(skills_service, "load_config", return_value={}), \
         patch.object(skills_service, "get_disabled_skills", side_effect=_disabled):
        result = skills_service.list_skills()

    pptx = next(r for r in result if r["name"] == "pptx")
    assert pptx["enabled"] is False
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


def test_build_skill_turn_message_skips_disabled_vonvon_skill():
    fake_skill_commands = types.SimpleNamespace()
    fake_skill_commands._load_skill_payload = MagicMock(
        return_value=({"content": "browse body"}, None, "Browse")
    )
    fake_skill_commands._build_skill_message = MagicMock(
        side_effect=lambda loaded_skill, _skill_dir, activation_note, runtime_note="": (
            f"{activation_note}\n{loaded_skill['content']}\n{runtime_note}"
        ).strip()
    )

    with patch.dict(sys.modules, {"agent.skill_commands": fake_skill_commands}), \
         patch.object(
             skills_service,
             "_get_vonvon_disabled_skill_names",
             return_value={"checkpoint"},
         ):
        prompt, loaded, missing = skills_service.build_skill_turn_message(
            ["checkpoint", "browse"],
            user_instruction="save current state",
            task_id="session-1",
        )

    assert loaded == ["Browse"]
    assert missing == ["checkpoint"]
    assert "browse body" in prompt
    fake_skill_commands._load_skill_payload.assert_called_once_with("browse", task_id="session-1")


# ── toggle_skill ───────────────────────────────────────────────────────────────

def test_toggle_skill_invalid_scope():
    with pytest.raises(ValueError, match="scope must be"):
        skills_service.toggle_skill(name="pptx", enabled=False, scope="invalid")


def test_toggle_skill_calls_cache_clear():
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch.object(skills_service, "load_config", return_value={}), \
         patch.object(skills_service, "get_disabled_skills", return_value=set()), \
         patch.object(skills_service, "save_disabled_skills"), \
         patch.object(skills_service, "config_store_lock") as mock_lock, \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache") as mock_clear:

        mock_lock.return_value.__enter__ = MagicMock(return_value=None)
        mock_lock.return_value.__exit__ = MagicMock(return_value=False)
        skills_service.toggle_skill(name="pptx", enabled=False, scope="vonvon")

    mock_clear.assert_called_once_with(clear_snapshot=True)


def test_toggle_skill_returns_updated_view():
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch.object(skills_service, "load_config", return_value={}), \
         patch.object(skills_service, "get_disabled_skills", return_value=set()), \
         patch.object(skills_service, "save_disabled_skills"), \
         patch.object(skills_service, "config_store_lock") as mock_lock, \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache"):

        mock_lock.return_value.__enter__ = MagicMock(return_value=None)
        mock_lock.return_value.__exit__ = MagicMock(return_value=False)
        result = skills_service.toggle_skill(name="pptx", enabled=False, scope="vonvon")

    assert result["name"] == "pptx"


def test_toggle_skill_both_updates_global_and_vonvon_lists():
    with patch.object(skills_service, "_find_installed_skills", return_value=FAKE_SKILLS), \
         patch.object(skills_service, "load_config", return_value={}), \
         patch.object(
             skills_service,
             "get_disabled_skills",
             side_effect=[set(), set(), {"pptx"}, {"pptx"}],
         ), \
         patch.object(skills_service, "save_disabled_skills") as mock_save, \
         patch.object(skills_service, "config_store_lock") as mock_lock, \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache"):

        mock_lock.return_value.__enter__ = MagicMock(return_value=None)
        mock_lock.return_value.__exit__ = MagicMock(return_value=False)
        result = skills_service.toggle_skill(name="pptx", enabled=False, scope="both")

    assert result["enabled"] is False
    assert mock_save.call_count == 2
    assert mock_save.call_args_list[0].kwargs["platform"] is None
    assert mock_save.call_args_list[1].kwargs["platform"] == "vonvon"


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


# ── discover catalog ──────────────────────────────────────────────────────────

def test_list_discoverable_skills_reads_local_cache_and_filters(tmp_path):
    cache_file = tmp_path / "discover-catalog.json"
    cache_file.write_text(
        json.dumps(
            {
                "version": 1,
                "updated_at": 1700000000.0,
                "items": [
                    {
                        "identifier": "official/security/1password",
                        "name": "1password",
                        "description": "Vault access",
                        "source": "optional",
                        "category": "security",
                        "tags": ["security"],
                    },
                    {
                        "identifier": "anthropics/skills/skills/frontend-design",
                        "name": "frontend-design",
                        "description": "UI polish",
                        "source": "anthropic",
                        "category": "creative",
                        "tags": ["design"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    builtin = [{
        "identifier": "builtin:creative/p5js",
        "name": "p5js",
        "description": "Creative coding",
        "source": "built-in",
        "source_label": "Built-in",
        "trust_level": "builtin",
        "category": "creative",
        "category_label": "Creative",
        "tags": ["art"],
        "install_kind": "template",
        "installed": False,
    }]

    with patch.object(skills_service, "_installed_skill_names", return_value={"p5js"}), \
         patch.object(skills_service, "_DISCOVER_CACHE_FILE", cache_file), \
         patch.object(skills_service, "_discover_builtin_items", return_value=builtin), \
         patch.object(skills_service, "_discover_official_hub_page_items") as remote_fetch:
        result = skills_service.list_discoverable_skills(query="design", source="all", limit=20)

    assert [item["identifier"] for item in result["items"]] == ["anthropics/skills/skills/frontend-design"]
    assert result["total"] == 1
    remote_fetch.assert_not_called()


def test_list_discoverable_skills_applies_source_filter(tmp_path):
    cache_file = tmp_path / "discover-catalog.json"
    cache_file.write_text(
        json.dumps(
            {
                "version": 1,
                "updated_at": 1700000000.0,
                "items": [
                    {
                        "identifier": "lobehub/deep-thinker",
                        "name": "deep-thinker",
                        "description": "Thinking tool",
                        "source": "lobehub",
                        "category": "research",
                        "tags": ["reasoning"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    builtin = [{
        "identifier": "builtin:creative/p5js",
        "name": "p5js",
        "description": "Creative coding",
        "source": "built-in",
        "source_label": "Built-in",
        "trust_level": "builtin",
        "category": "creative",
        "category_label": "Creative",
        "tags": [],
        "install_kind": "template",
        "installed": False,
    }]

    with patch.object(skills_service, "_installed_skill_names", return_value=set()), \
         patch.object(skills_service, "_DISCOVER_CACHE_FILE", cache_file), \
         patch.object(skills_service, "_discover_builtin_items", return_value=builtin), \
         patch.object(skills_service, "_discover_official_hub_page_items") as remote_fetch:
        result = skills_service.list_discoverable_skills(source="lobehub", limit=20)

    assert [item["source"] for item in result["items"]] == ["lobehub"]
    remote_fetch.assert_not_called()


def test_list_discoverable_skills_applies_offset(tmp_path):
    cache_file = tmp_path / "discover-catalog.json"
    cache_file.write_text(
        json.dumps(
            {
                "version": 1,
                "updated_at": 1700000000.0,
                "items": [
                    {
                        "identifier": f"lobehub/skill-{idx}",
                        "name": f"skill-{idx}",
                        "description": f"desc-{idx}",
                        "source": "lobehub",
                        "category": "research",
                        "tags": [],
                    }
                    for idx in range(6)
                ],
            }
        ),
        encoding="utf-8",
    )

    with patch.object(skills_service, "_installed_skill_names", return_value=set()), \
         patch.object(skills_service, "_DISCOVER_CACHE_FILE", cache_file), \
         patch.object(skills_service, "_discover_builtin_items", return_value=[]):
        result = skills_service.list_discoverable_skills(source="lobehub", limit=2, offset=2)

    assert [item["identifier"] for item in result["items"]] == [
        "lobehub/skill-2",
        "lobehub/skill-3",
    ]
    assert result["total"] == 6
    assert result["has_more"] is True


def test_refresh_discoverable_skills_cache_writes_remote_catalog(tmp_path):
    cache_file = tmp_path / "discover-catalog.json"
    remote_items = [{
        "identifier": "anthropics/skills/skills/frontend-design",
        "name": "frontend-design",
        "description": "UI polish",
        "source": "anthropic",
        "source_label": "Anthropic",
        "trust_level": "trusted",
        "category": "creative",
        "category_label": "Creative",
        "tags": ["design"],
        "install_kind": "hub",
        "installed": False,
    }]

    with patch.object(skills_service, "_DISCOVER_CACHE_FILE", cache_file), \
         patch.object(skills_service, "_discover_official_hub_page_items", return_value=remote_items):
        result = skills_service.refresh_discoverable_skills_cache()

    payload = json.loads(cache_file.read_text(encoding="utf-8"))
    assert payload["items"][0]["identifier"] == "anthropics/skills/skills/frontend-design"
    assert result["count"] == 1
    assert result["sources"] == {"anthropic": 1}


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


def test_do_import_maps_import_result():
    fake_module = types.SimpleNamespace(
        import_skill_silent=lambda *args, **kwargs: {
            "name": "flyai",
            "category": "imports",
            "description": "FlyAI helpers",
            "install_path": "/tmp/flyai",
            "source": "github",
        }
    )
    tools_pkg = sys.modules.get("tools")
    setattr(tools_pkg, "__path__", [])
    with patch.dict(sys.modules, {"tools.skill_import_tool": fake_module}):
        result = skills_service._do_import("https://github.com/alibaba-flyai/flyai-skill")

    assert result["name"] == "flyai"
    assert result["category"] == "imports"
    assert result["source"] == "github"


@pytest.mark.asyncio
async def test_start_import_job_creates_job():
    with patch.object(skills_service, "_do_import", return_value={
        "name": "flyai", "category": "imports", "description": "",
        "install_path": "/x", "version": None, "source": "github",
    }):
        status = await skills_service.start_import_job("https://github.com/alibaba-flyai/flyai-skill")

    assert status["kind"] == "import"
    assert "flyai-skill" in status["identifier"]
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
