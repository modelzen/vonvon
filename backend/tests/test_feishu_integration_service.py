"""Tests for managed Lark auth status parsing."""

import os
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
    node = Path("/usr/local/bin/node")
    captured_envs: list[dict[str, str] | None] = []

    monkeypatch.setattr(feishu_integration_service, "_current_cli_path", lambda: fake_cli)
    monkeypatch.setattr(feishu_integration_service, "_detect_current_version", lambda _cli=None: "1.0.12")
    monkeypatch.setattr(feishu_integration_service, "_resolve_node_path", lambda: node)
    monkeypatch.setattr(
        feishu_integration_service,
        "_read_state",
        lambda: feishu_integration_service._default_state(),
    )
    monkeypatch.setattr(feishu_integration_service, "_write_state", lambda state: state)
    monkeypatch.setattr(feishu_integration_service, "_refresh_skill_bridge", lambda state: state)
    monkeypatch.setattr(Path, "exists", lambda self: self == fake_cli)

    def fake_run(command, **kwargs):
        captured_envs.append(kwargs.get("env"))
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
    assert len(captured_envs) == 3
    assert all(env is not None for env in captured_envs)
    assert all(env["PATH"].split(os.pathsep)[0] == str(node.parent) for env in captured_envs if env)


def test_verify_runtime_auto_enables_feature_when_runtime_becomes_ready(monkeypatch):
    fake_cli = Path("/tmp/fake-lark-cli")
    node = Path("/usr/local/bin/node")

    monkeypatch.setattr(feishu_integration_service, "_current_cli_path", lambda: fake_cli)
    monkeypatch.setattr(feishu_integration_service, "_detect_current_version", lambda _cli=None: "1.0.12")
    monkeypatch.setattr(feishu_integration_service, "_resolve_node_path", lambda: node)
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
                  "defaultAs": "user",
                  "identity": "user",
                  "userName": "Clay",
                  "email": "clay@example.com"
                }""",
                stderr="",
            )
        if command[-2:] == ["auth", "list"]:
            return SimpleNamespace(
                returncode=0,
                stdout="clay@example.com\n",
                stderr="",
            )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(feishu_integration_service, "_run", fake_run)

    state = feishu_integration_service.verify_runtime()

    assert state["runtime_status"] == "ready"
    assert state["authenticated"] is True
    assert state["feature_enabled"] is True
    assert state["skills_enabled"] is True
    assert state["orb_inspect_enabled"] is True
    assert state["feature_toggle_initialized"] is True


def test_verify_runtime_respects_manual_feature_disable_after_ready(monkeypatch):
    fake_cli = Path("/tmp/fake-lark-cli")
    node = Path("/usr/local/bin/node")

    def initial_state():
        state = feishu_integration_service._default_state()
        state["feature_toggle_initialized"] = True
        return state

    monkeypatch.setattr(feishu_integration_service, "_current_cli_path", lambda: fake_cli)
    monkeypatch.setattr(feishu_integration_service, "_detect_current_version", lambda _cli=None: "1.0.12")
    monkeypatch.setattr(feishu_integration_service, "_resolve_node_path", lambda: node)
    monkeypatch.setattr(feishu_integration_service, "_read_state", initial_state)
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
                  "defaultAs": "user",
                  "identity": "user",
                  "userName": "Clay",
                  "email": "clay@example.com"
                }""",
                stderr="",
            )
        if command[-2:] == ["auth", "list"]:
            return SimpleNamespace(
                returncode=0,
                stdout="clay@example.com\n",
                stderr="",
            )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(feishu_integration_service, "_run", fake_run)

    state = feishu_integration_service.verify_runtime()

    assert state["runtime_status"] == "ready"
    assert state["authenticated"] is True
    assert state["feature_enabled"] is False
    assert state["skills_enabled"] is False
    assert state["orb_inspect_enabled"] is False
    assert state["feature_toggle_initialized"] is True


def test_missing_npm_install_message_contains_vonvon_help_prompt():
    message = feishu_integration_service._missing_npm_install_message()

    assert "Node.js / npm" in message
    assert "<<<VONVON_HELP_PROMPT" in message
    assert "VONVON_HELP_PROMPT" in message
    assert "重新点击“安装并初始化飞书”" in message


def test_fetch_latest_version_uses_resolved_npm_and_prepends_bin_to_path(monkeypatch):
    npm = Path("/opt/homebrew/bin/npm")
    node = Path("/Users/test/.fnm/current/bin/node")
    captured: dict[str, object] = {}

    monkeypatch.setattr(feishu_integration_service, "_resolve_npm_path", lambda: npm)
    monkeypatch.setattr(feishu_integration_service, "_resolve_node_path", lambda: node)

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs.get("env")
        return SimpleNamespace(returncode=0, stdout='"1.0.13"', stderr="")

    monkeypatch.setattr(feishu_integration_service, "_run", fake_run)

    latest = feishu_integration_service._fetch_latest_version()

    assert latest == "1.0.13"
    assert captured["command"] == [str(npm), "view", feishu_integration_service.PACKAGE_NAME, "version", "--json"]
    assert captured["env"]["PATH"].split(os.pathsep)[:2] == [str(npm.parent), str(node.parent)]


def test_detect_current_version_prepends_resolved_node_dir(monkeypatch):
    fake_cli = Path("/tmp/fake-lark-cli")
    node = Path("/usr/local/bin/node")
    captured: dict[str, object] = {}

    monkeypatch.setattr(Path, "exists", lambda self: self == fake_cli)
    monkeypatch.setattr(feishu_integration_service, "_resolve_node_path", lambda: node)

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs.get("env")
        return SimpleNamespace(returncode=0, stdout="1.0.14\n", stderr="")

    monkeypatch.setattr(feishu_integration_service, "_run", fake_run)

    version = feishu_integration_service._detect_current_version(fake_cli)

    assert version == "1.0.14"
    assert captured["command"] == [str(fake_cli), "--version"]
    assert captured["env"]["PATH"].split(os.pathsep)[0] == str(node.parent)


def test_spawn_flow_prepends_resolved_node_dir(monkeypatch):
    fake_cli = Path("/tmp/fake-lark-cli")
    node = Path("/usr/local/bin/node")
    captured: dict[str, object] = {}

    feishu_integration_service._flows.clear()
    monkeypatch.setattr(feishu_integration_service, "_resolve_node_path", lambda: node)

    class FakeProcess:
        pid = 12345
        stdout = None

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs.get("env")
        return FakeProcess()

    class FakeThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            return None

    monkeypatch.setattr(feishu_integration_service.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(feishu_integration_service.threading, "Thread", FakeThread)

    flow = feishu_integration_service._spawn_flow(
        "config_init",
        [str(fake_cli), "config", "init", "--new"],
    )

    assert flow.command == [str(fake_cli), "config", "init", "--new"]
    assert captured["command"] == [str(fake_cli), "config", "init", "--new"]
    assert captured["env"]["PATH"].split(os.pathsep)[0] == str(node.parent)


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
    assert "当前 turn 可能只有截图和 `vonvon-inspect` 激活信号" in skill_text


def test_parse_feishu_doc_url_supports_docx_link():
    parsed = feishu_integration_service._parse_feishu_doc_url(
        "https://foo.feishu.cn/docx/AbCdEf123456?from=copy"
    )

    assert parsed["doc_type"] == "docx"
    assert parsed["doc_token"] == "AbCdEf123456"


def test_parse_feishu_doc_url_supports_wiki_link():
    parsed = feishu_integration_service._parse_feishu_doc_url(
        "https://foo.feishu.cn/wiki/WikToken123456"
    )

    assert parsed["doc_type"] == "wiki"
    assert parsed["doc_token"] == "WikToken123456"
