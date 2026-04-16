"""Tests for managed Lark auth status parsing."""

from pathlib import Path
from types import SimpleNamespace

from app.services import feishu_integration_service


def test_extract_auth_context_marks_bot_only_status_as_not_authenticated():
    context = feishu_integration_service._extract_auth_context(
        """{
          "appId": "cli_xxx",
          "brand": "feishu",
          "defaultAs": "auto",
          "identity": "bot",
          "note": "No user logged in. Only bot (tenant) identity is available for API calls. Run `lark-cli auth login` to log in."
        }""",
        "No logged-in users. Run `lark-cli auth login` to log in.\n",
    )

    assert context["authenticated"] is False
    assert context["auth_identity"] == "bot"
    assert "No user logged in" in context["auth_note"]
    assert context["logged_in_accounts"] == []


def test_extract_flow_hints_preserves_full_device_code_from_json_line():
    text = """{"device_code":"0_qnJo34GymCT_E2KPKf_d2atJ0y5L0RGW0000000000W9vRGW000000t.cDeK2FoAg9IeIVlCVna97BGukQy-SULTIwxJ5zzcTTE","verification_url":"https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=H9D5-AJBK"}"""

    hints = feishu_integration_service._extract_flow_hints(text)

    assert (
        hints["device_code"]
        == "0_qnJo34GymCT_E2KPKf_d2atJ0y5L0RGW0000000000W9vRGW000000t.cDeK2FoAg9IeIVlCVna97BGukQy-SULTIwxJ5zzcTTE"
    )
    assert (
        hints["verification_url"]
        == "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=H9D5-AJBK"
    )


def test_verify_runtime_uses_parsed_auth_context_instead_of_exit_code(monkeypatch):
    fake_cli = Path("/tmp/fake-lark-cli")

    monkeypatch.setattr(feishu_integration_service, "_current_cli_path", lambda: fake_cli)
    monkeypatch.setattr(feishu_integration_service, "_detect_current_version", lambda _cli=None: "1.0.12")
    monkeypatch.setattr(
        feishu_integration_service,
        "_read_state",
        lambda: feishu_integration_service._default_state(),
    )
    monkeypatch.setattr(feishu_integration_service, "_write_state", lambda state: state)
    monkeypatch.setattr(feishu_integration_service, "_refresh_skill_bridge", lambda state: state)
    monkeypatch.setattr(Path, "exists", lambda self: self == fake_cli)

    def fake_run(command, **_kwargs):
        if command[-2:] == ["auth", "status"]:
            return SimpleNamespace(
                returncode=0,
                stdout="""{
                  "appId": "cli_xxx",
                  "brand": "feishu",
                  "defaultAs": "auto",
                  "identity": "bot",
                  "note": "No user logged in. Only bot (tenant) identity is available for API calls. Run `lark-cli auth login` to log in."
                }""",
                stderr="",
            )
        if command[-2:] == ["auth", "list"]:
            return SimpleNamespace(
                returncode=0,
                stdout="No logged-in users. Run `lark-cli auth login` to log in.\n",
                stderr="",
            )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(feishu_integration_service, "_run", fake_run)

    state = feishu_integration_service.verify_runtime()

    assert state["authenticated"] is False
    assert state["runtime_status"] == "configured_needs_auth"
    assert state["auth_identity"] == "bot"


def test_sync_hidden_wrappers_keeps_official_lark_skill_names(tmp_path, monkeypatch):
    monkeypatch.setattr(feishu_integration_service, "SKILL_BRIDGE_ROOT", tmp_path / "skills")
    monkeypatch.setattr(feishu_integration_service, "PACK_ROOT", tmp_path / "pack")
    monkeypatch.setattr(
        feishu_integration_service,
        "_current_cli_path",
        lambda: Path("/tmp/fake-lark-cli"),
    )

    count = feishu_integration_service._sync_hidden_wrappers()
    manifest = (tmp_path / "pack" / "skill-manifest.json").read_text(encoding="utf-8")

    assert count > 0
    assert (tmp_path / "skills" / "vonvon-inspect" / "SKILL.md").exists()
    assert (tmp_path / "skills" / "lark-calendar" / "SKILL.md").exists()
    assert "feishu-calendar" not in manifest
    assert '"name": "vonvon-inspect"' in manifest
    assert '"name": "lark-calendar"' in manifest


def test_vonvon_inspect_wrapper_includes_auth_and_degradation_constraints(tmp_path, monkeypatch):
    monkeypatch.setattr(feishu_integration_service, "SKILL_BRIDGE_ROOT", tmp_path / "skills")
    monkeypatch.setattr(feishu_integration_service, "PACK_ROOT", tmp_path / "pack")
    monkeypatch.setattr(
        feishu_integration_service,
        "_current_cli_path",
        lambda: Path("/tmp/fake-lark-cli"),
    )

    feishu_integration_service._sync_hidden_wrappers()
    skill_text = (tmp_path / "skills" / "vonvon-inspect" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "必须先确认飞书集成登录状态正常" in skill_text
    assert "不要把它写成“我顺手做了一个最小补充”或额外贡献" in skill_text
    assert "本回答当前仅基于截图可见内容" in skill_text
    assert "是否要继续查看这份文档的详细内容" in skill_text
