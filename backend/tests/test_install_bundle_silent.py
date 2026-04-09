"""Tests for install_bundle_silent (AC-S12 / CF-1).

Signature gate: verifies real hermes function signatures via AST source inspection
(avoids import-chain issues in the test environment where deps are stubbed).
Behavior tests: mock create_source_router to avoid network calls.
"""
import ast
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

HERMES_AGENT_DIR = Path(__file__).parent.parent / "hermes-agent"


# ── AST-based signature inspection ────────────────────────────────────────────

def _get_func_params(filepath: Path, funcname: str):
    """Parse Python source and return list of parameter names for funcname."""
    src = filepath.read_text()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == funcname:
            params = {}
            for arg in node.args.posonlyargs + node.args.args:
                params[arg.arg] = "pos"
            for arg in node.args.kwonlyargs:
                params[arg.arg] = "kw"
            return params
    return None


def _get_class_methods(filepath: Path, classname: str):
    src = filepath.read_text()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == classname:
            return {
                n.name for n in ast.walk(node)
                if isinstance(n, ast.FunctionDef)
            }
    return set()


# ── Signature Gate (AC-S12 CF-1) ──────────────────────────────────────────────

SKILLS_HUB = HERMES_AGENT_DIR / "tools" / "skills_hub.py"
SKILLS_GUARD = HERMES_AGENT_DIR / "tools" / "skills_guard.py"


def test_signature_quarantine_bundle():
    """quarantine_bundle(bundle) — 1 positional arg only."""
    params = _get_func_params(SKILLS_HUB, "quarantine_bundle")
    assert params is not None, "quarantine_bundle not found in skills_hub.py"
    pos_params = [k for k, v in params.items() if v == "pos" and k != "self"]
    assert pos_params == ["bundle"], f"Expected ['bundle'], got {pos_params}"


def test_signature_scan_skill():
    """scan_skill(skill_path, source=...) from tools/skills_guard.py."""
    params = _get_func_params(SKILLS_GUARD, "scan_skill")
    assert params is not None, "scan_skill not found in skills_guard.py"
    assert "skill_path" in params, f"Missing skill_path in {params}"
    assert "source" in params, f"Missing source in {params}"


def test_signature_should_allow_install():
    """should_allow_install(result, force=...) — NO assume_yes."""
    params = _get_func_params(SKILLS_GUARD, "should_allow_install")
    assert params is not None, "should_allow_install not found in skills_guard.py"
    assert "result" in params
    assert "force" in params
    assert "assume_yes" not in params, "should_allow_install must NOT have assume_yes"


def test_signature_install_from_quarantine():
    """install_from_quarantine(quarantine_path, skill_name, category, bundle, scan_result)."""
    params = _get_func_params(SKILLS_HUB, "install_from_quarantine")
    assert params is not None, "install_from_quarantine not found in skills_hub.py"
    pos_params = [k for k, v in params.items() if v == "pos" and k != "self"]
    assert pos_params == [
        "quarantine_path", "skill_name", "category", "bundle", "scan_result"
    ], f"Unexpected params: {pos_params}"


def test_hub_lock_file_not_context_manager():
    """HubLockFile must NOT define __enter__ (not a context manager)."""
    methods = _get_class_methods(SKILLS_HUB, "HubLockFile")
    assert "__enter__" not in methods, \
        "HubLockFile must NOT be a context manager"


def test_install_bundle_silent_in_source():
    """install_bundle_silent is defined in skills_hub.py (WP1-D-fork-2)."""
    params = _get_func_params(SKILLS_HUB, "install_bundle_silent")
    assert params is not None, "install_bundle_silent not found — WP1-D-fork-2 not applied"


def test_install_bundle_silent_no_assume_yes():
    """install_bundle_silent must NOT have assume_yes parameter."""
    params = _get_func_params(SKILLS_HUB, "install_bundle_silent")
    assert params is not None
    assert "identifier" in params
    assert "force" in params
    assert "assume_yes" not in params, "install_bundle_silent must NOT have assume_yes"


# ── Behavior tests (mocked, via skills_service._do_install) ───────────────────

from app.services import skills_service  # noqa: E402


def test_do_install_calls_install_bundle_silent():
    """_do_install calls install_bundle_silent(identifier, force=False)."""
    mock_result = {
        "name": "pptx", "category": "office", "description": "PPT",
        "install_path": "/skills/pptx", "source": "official",
    }
    with patch("tools.skills_hub.install_bundle_silent", return_value=mock_result) as mock_ibs:
        result = skills_service._do_install("official/pptx")

    mock_ibs.assert_called_once_with("official/pptx", force=False)
    assert result["name"] == "pptx"
    assert result["install_path"] == "/skills/pptx"


def test_do_install_raises_on_install_failure():
    """_do_install propagates RuntimeError from install_bundle_silent."""
    with patch("tools.skills_hub.install_bundle_silent",
               side_effect=RuntimeError("bundle not found")):
        with pytest.raises(RuntimeError, match="bundle not found"):
            skills_service._do_install("official/missing")


def test_do_install_raises_when_none_returned():
    """_do_install raises RuntimeError if install_bundle_silent returns None."""
    with patch("tools.skills_hub.install_bundle_silent", return_value=None):
        with pytest.raises(RuntimeError, match="returned None"):
            skills_service._do_install("official/pptx")


def test_do_uninstall_success():
    """_do_uninstall returns metadata dict on success."""
    with patch("tools.skills_hub.uninstall_skill", return_value=(True, "ok")), \
         patch("agent.prompt_builder.clear_skills_system_prompt_cache"):
        result = skills_service._do_uninstall("pptx")
    assert result["name"] == "pptx"


def test_do_uninstall_raises_on_failure():
    """_do_uninstall raises RuntimeError when uninstall_skill returns ok=False."""
    with patch("tools.skills_hub.uninstall_skill", return_value=(False, "not found")):
        with pytest.raises(RuntimeError, match="not found"):
            skills_service._do_uninstall("nonexistent")
