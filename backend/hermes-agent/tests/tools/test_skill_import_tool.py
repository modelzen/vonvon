"""Tests for tools/skill_import_tool.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.skill_import_tool import import_skill_silent, skill_import
from tools.skills_guard import ScanResult


VALID_SKILL = """---
name: sample-skill
description: Sample imported skill
---

# Sample Skill

Use this skill when needed.
"""


@pytest.fixture
def isolated_skill_import(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    skills_dir = hermes_home / "skills"
    hub_dir = skills_dir / ".hub"

    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    import tools.skill_import_tool as import_tool
    import tools.skills_hub as skills_hub

    monkeypatch.setattr(import_tool, "HERMES_HOME", hermes_home)
    monkeypatch.setattr(import_tool, "SKILLS_DIR", skills_dir)

    monkeypatch.setattr(skills_hub, "HERMES_HOME", hermes_home)
    monkeypatch.setattr(skills_hub, "SKILLS_DIR", skills_dir)
    monkeypatch.setattr(skills_hub, "HUB_DIR", hub_dir)
    monkeypatch.setattr(skills_hub, "LOCK_FILE", hub_dir / "lock.json")
    monkeypatch.setattr(skills_hub, "QUARANTINE_DIR", hub_dir / "quarantine")
    monkeypatch.setattr(skills_hub, "AUDIT_LOG", hub_dir / "audit.log")
    monkeypatch.setattr(skills_hub, "TAPS_FILE", hub_dir / "taps.json")
    monkeypatch.setattr(skills_hub, "INDEX_CACHE_DIR", hub_dir / "index-cache")

    monkeypatch.setattr(
        import_tool,
        "scan_skill",
        lambda path, source="": ScanResult(
            skill_name=Path(path).name,
            source=source,
            trust_level="community",
            verdict="safe",
        ),
    )
    monkeypatch.setattr(import_tool, "should_allow_install", lambda result, force=False: (True, "ok"))

    return hermes_home, skills_dir


def test_import_skill_silent_imports_local_skill_dir(isolated_skill_import, tmp_path):
    _, skills_dir = isolated_skill_import
    source_dir = tmp_path / "source-skill"
    source_dir.mkdir()
    (source_dir / "SKILL.md").write_text(VALID_SKILL, encoding="utf-8")
    (source_dir / "references").mkdir()
    (source_dir / "references" / "guide.md").write_text("guide", encoding="utf-8")

    result = import_skill_silent(str(source_dir))

    installed_dir = skills_dir / "imports" / "sample-skill"
    assert result["name"] == "sample-skill"
    assert installed_dir.exists()
    skill_md = (installed_dir / "SKILL.md").read_text(encoding="utf-8")
    assert "imported_from:" in skill_md
    assert "source_identifier" not in skill_md
    assert (installed_dir / "references" / "guide.md").read_text(encoding="utf-8") == "guide"


def test_import_skill_silent_renames_on_conflict(isolated_skill_import, tmp_path):
    _, skills_dir = isolated_skill_import
    existing_dir = skills_dir / "imports" / "sample-skill"
    existing_dir.mkdir(parents=True)
    (existing_dir / "SKILL.md").write_text(VALID_SKILL, encoding="utf-8")

    source_dir = tmp_path / "incoming"
    source_dir.mkdir()
    (source_dir / "SKILL.md").write_text(VALID_SKILL, encoding="utf-8")

    result = import_skill_silent(str(source_dir), conflict_strategy="rename")

    assert result["name"] == "sample-skill-imported"
    assert (skills_dir / "imports" / "sample-skill-imported" / "SKILL.md").exists()


def test_skill_import_returns_json_error_for_missing_source(isolated_skill_import):
    result = json.loads(skill_import(source="/definitely/missing"))
    assert result["success"] is False
    assert "unsupported" in result["error"] or "no SKILL.md" in result["error"]
