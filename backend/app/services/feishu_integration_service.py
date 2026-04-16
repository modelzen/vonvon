"""Managed Feishu CLI integration service for Vonvon.

Phase 1 focuses on four things:
1. Managed installation / upgrade / uninstall of the official ``@larksuite/cli``.
2. Interactive onboarding state for ``config init`` and ``auth login``.
3. A hidden internal skill bridge so Feishu abilities stay out of the normal
   user-installed Skills panel.
4. Persistent feature flags for the future orb-inspect workflow.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import HERMES_HOME

logger = logging.getLogger(__name__)

STATE_VERSION = 1
PACKAGE_NAME = "@larksuite/cli"
OFFICIAL_SKILL_SOURCE = "larksuite/cli"
FLOW_TTL_SECONDS = 30 * 60
FLOW_OUTPUT_LIMIT = 3200
DEFAULT_COMMAND_TIMEOUT = 45

VONVON_HOME = HERMES_HOME.parent
INTEGRATIONS_HOME = VONVON_HOME / "integrations"
FEISHU_HOME = INTEGRATIONS_HOME / "feishu"
RUNTIME_ROOT = FEISHU_HOME / "runtime"
VERSIONS_ROOT = RUNTIME_ROOT / "versions"
CURRENT_LINK = RUNTIME_ROOT / "current"
PACK_ROOT = FEISHU_HOME / "pack"
MARKERS_ROOT = FEISHU_HOME / "markers"
STATE_FILE = FEISHU_HOME / "state.json"
SKILL_BRIDGE_ROOT = HERMES_HOME / "skills" / ".vonvon-integrations" / "feishu"

_VERSION_RE = re.compile(r"(?<!\d)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?!\d)")
_URL_RE = re.compile(r"https?://[^\s)]+")
_DEVICE_CODE_RE = re.compile(
    r"(?i)(?:device[_ -]?code|deviceCode)[^A-Za-z0-9]+([A-Za-z0-9:._-]{6,})"
)

_FLOW_KINDS = {"config_init", "auth_login"}

_DEFAULT_SKILLS: List[tuple[str, str]] = [
    ("shared", "应用配置、鉴权状态和基础守则。"),
    ("calendar", "日历、日程、空闲忙碌查询。"),
    ("im", "飞书会话、消息、线程和附件。"),
    ("doc", "飞书文档创建、读取、更新。"),
    ("drive", "云文档、文件上传下载和权限。"),
    ("sheets", "电子表格读写、追加和导出。"),
    ("slides", "幻灯片创建、读取和改写。"),
    ("base", "多维表格、字段、记录和视图。"),
    ("task", "任务、提醒、成员和子任务。"),
    ("mail", "邮箱搜索、收发和草稿。"),
    ("contact", "联系人与用户查询。"),
    ("wiki", "知识库空间、节点和文档。"),
    ("event", "实时事件订阅与路由。"),
    ("vc", "会议纪要、录制与摘要。"),
    ("whiteboard", "白板与图表 DSL。"),
    ("minutes", "会议纪要结构化结果。"),
    ("openapi-explorer", "官方 OpenAPI 探索能力。"),
    ("skill-maker", "自定义 Feishu skill 框架。"),
    ("attendance", "考勤打卡记录查询。"),
    ("approval", "审批查询、审批和转交。"),
    ("workflow-meeting-summary", "会议总结 workflow。"),
    ("workflow-standup-report", "站会/agenda 汇总 workflow。"),
]

_flows: Dict[str, "FeishuFlow"] = {}
_flows_lock = threading.Lock()


@dataclass
class FeishuFlow:
    flow_id: str
    kind: str
    status: str
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    verification_url: Optional[str] = None
    device_code: Optional[str] = None
    error: Optional[str] = None
    output_excerpt: str = ""
    pid: Optional[int] = None
    command: List[str] = field(default_factory=list)


def _now() -> float:
    return time.time()


def _default_state() -> Dict[str, Any]:
    return {
        "state_version": STATE_VERSION,
        "provider": "feishu",
        "feature_enabled": False,
        "skills_enabled": False,
        "orb_inspect_enabled": False,
        "runtime_status": "not_installed",
        "config_initialized": False,
        "authenticated": False,
        "auth_identity": None,
        "auth_default_as": None,
        "auth_note": None,
        "account_display_name": None,
        "account_identifier": None,
        "logged_in_accounts": [],
        "current_version": None,
        "latest_available_version": None,
        "upgrade_available": False,
        "last_checked_at": None,
        "last_verified_at": None,
        "last_good_version": None,
        "last_error": None,
        "internal_skills_synced": False,
        "internal_skill_count": 0,
        "permissions": {
            "screen_recording": "unknown",
            "accessibility": "unknown",
        },
        "managed_paths": {
            "home": str(FEISHU_HOME),
            "runtime_root": str(RUNTIME_ROOT),
            "current_runtime": str(CURRENT_LINK),
            "cli_path": str(_current_cli_path()),
            "skill_bridge_root": str(SKILL_BRIDGE_ROOT),
        },
    }


def _ensure_layout() -> None:
    for path in (FEISHU_HOME, RUNTIME_ROOT, VERSIONS_ROOT, PACK_ROOT, MARKERS_ROOT):
        path.mkdir(parents=True, exist_ok=True)


def _read_state() -> Dict[str, Any]:
    if not STATE_FILE.exists():
        return _default_state()
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("feishu state read failed: %s", exc)
        state = _default_state()
        state["runtime_status"] = "error"
        state["last_error"] = f"Failed to read integration state: {exc}"
        return state
    state = _default_state()
    state.update(raw if isinstance(raw, dict) else {})
    if not isinstance(state.get("permissions"), dict):
        state["permissions"] = _default_state()["permissions"]
    return state


def _write_state(state: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_layout()
    serializable = dict(state)
    serializable["state_version"] = STATE_VERSION
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(serializable, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    tmp.replace(STATE_FILE)
    return serializable


def _update_state(**patch: Any) -> Dict[str, Any]:
    state = _read_state()
    state.update(patch)
    return _write_state(state)


def _bin_name() -> str:
    return "lark-cli.cmd" if os.name == "nt" else "lark-cli"


def _cli_path_for(version_dir: Path) -> Path:
    return version_dir / "node_modules" / ".bin" / _bin_name()


def _current_cli_path() -> Path:
    return CURRENT_LINK / "node_modules" / ".bin" / _bin_name()


def _marker_path(name: str) -> Path:
    return MARKERS_ROOT / f"{name}.json"


def _is_runtime_installed() -> bool:
    return _current_cli_path().exists()


def _atomic_switch_current(version_dir: Path) -> None:
    _ensure_layout()
    tmp = RUNTIME_ROOT / ".current.tmp"
    if tmp.exists() or tmp.is_symlink():
        tmp.unlink()
    tmp.symlink_to(version_dir, target_is_directory=True)
    tmp.replace(CURRENT_LINK)


def _run(
    command: List[str],
    *,
    cwd: Optional[Path] = None,
    timeout: int = DEFAULT_COMMAND_TIMEOUT,
) -> subprocess.CompletedProcess[str]:
    logger.info("feishu command: %s", " ".join(command))
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _trim_output(text: str) -> str:
    cleaned = (text or "").strip()
    if len(cleaned) <= FLOW_OUTPUT_LIMIT:
        return cleaned
    return cleaned[-FLOW_OUTPUT_LIMIT:]


def _safe_json_loads(text: str) -> Dict[str, Any]:
    payload = (text or "").strip()
    if not payload:
        return {}
    try:
        data = json.loads(payload)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _find_first_value(payload: Any, keys: set[str]) -> Optional[Any]:
    normalized = {key.casefold() for key in keys}
    if isinstance(payload, dict):
        for key, value in payload.items():
            if str(key).casefold() in normalized and value not in (None, ""):
                return value
        for value in payload.values():
            found = _find_first_value(value, keys)
            if found not in (None, ""):
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_first_value(item, keys)
            if found not in (None, ""):
                return found
    return None


def _parse_auth_list_output(text: str) -> List[str]:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return [line for line in lines if "No logged-in users" not in line]


def _extract_auth_context(status_text: str, auth_list_text: str = "") -> Dict[str, Any]:
    payload = _safe_json_loads(status_text)
    app_id = _find_first_value(payload, {"appId", "app_id"})
    note = _find_first_value(payload, {"note", "message"})
    identity = _find_first_value(payload, {"identity"})
    default_as = _find_first_value(payload, {"defaultAs", "default_as"})
    display_name = _find_first_value(payload, {"userName", "user_name", "name"})
    identifier = _find_first_value(payload, {"email", "openId", "open_id", "userId", "user_id"})
    accounts = _parse_auth_list_output(auth_list_text)

    note_text = str(note).strip() if note else None
    identity_text = str(identity).strip() if identity else None
    display_text = str(display_name).strip() if display_name else None
    identifier_text = str(identifier).strip() if identifier else None

    no_user_logged_in = "no user logged in" in (note_text or "").casefold()
    authenticated = bool(accounts or display_text or identifier_text or identity_text == "user")
    if no_user_logged_in:
        authenticated = False

    if not display_text and accounts:
        display_text = accounts[0]

    return {
        "authenticated": authenticated,
        "config_initialized_hint": bool(app_id),
        "auth_identity": identity_text,
        "auth_default_as": str(default_as).strip() if default_as else None,
        "auth_note": note_text,
        "account_display_name": display_text,
        "account_identifier": identifier_text,
        "logged_in_accounts": accounts,
    }


def _extract_first(pattern: re.Pattern[str], text: str) -> Optional[str]:
    match = pattern.search(text or "")
    if not match:
        return None
    if match.lastindex:
        return (match.group(1) or "").strip() or None
    return match.group(0).strip() or None


def _extract_flow_hints(text: str) -> Dict[str, Optional[str]]:
    payload = _safe_json_loads(text)

    verification_url = _find_first_value(
        payload,
        {"verification_url", "verificationUrl", "verify_url", "verifyUrl"},
    )
    device_code = _find_first_value(payload, {"device_code", "deviceCode"})

    verification_text = str(verification_url).strip() if verification_url else None
    device_text = str(device_code).strip() if device_code else None

    return {
        "verification_url": verification_text or _extract_first(_URL_RE, text),
        "device_code": device_text or _extract_first(_DEVICE_CODE_RE, text),
    }


def _safe_version_key(version: Optional[str]) -> tuple:
    if not version:
        return ()
    core = re.split(r"[-+]", version, maxsplit=1)[0]
    parts = []
    for item in core.split("."):
        try:
            parts.append(int(item))
        except ValueError:
            parts.append(item)
    return tuple(parts)


def _detect_current_version(cli_path: Optional[Path] = None) -> Optional[str]:
    target = cli_path or _current_cli_path()
    if not target.exists():
        return None
    try:
        result = _run([str(target), "--version"], timeout=10)
    except Exception as exc:
        logger.warning("feishu version detection failed: %s", exc)
        return None
    combined = "\n".join([result.stdout or "", result.stderr or ""])
    return _extract_first(_VERSION_RE, combined)


def _fetch_latest_version() -> Optional[str]:
    npm = shutil.which("npm")
    if not npm:
        return None
    try:
        result = _run([npm, "view", PACKAGE_NAME, "version", "--json"], timeout=20)
    except Exception as exc:
        logger.warning("feishu latest version lookup failed: %s", exc)
        return None
    if result.returncode != 0:
        logger.warning("feishu latest version lookup non-zero: %s", result.stderr.strip())
        return None
    payload = (result.stdout or "").strip()
    if not payload:
        return None
    try:
        data = json.loads(payload)
    except Exception:
        data = payload.strip('"')
    if isinstance(data, str):
        return data.strip() or None
    return None


def _managed_paths() -> Dict[str, str]:
    return {
        "home": str(FEISHU_HOME),
        "runtime_root": str(RUNTIME_ROOT),
        "current_runtime": str(CURRENT_LINK),
        "cli_path": str(_current_cli_path()),
        "skill_bridge_root": str(SKILL_BRIDGE_ROOT),
    }


def _compute_runtime_status(state: Dict[str, Any]) -> str:
    if not _is_runtime_installed():
        return "not_installed"
    if state.get("authenticated"):
        return "ready"
    if state.get("config_initialized"):
        return "configured_needs_auth"
    return "installed_needs_config"


def _wrapper_dir(kind: str) -> Path:
    return SKILL_BRIDGE_ROOT / f"feishu-{kind}"


def _write_skill_wrapper(kind: str, description: str) -> None:
    wrapper_dir = _wrapper_dir(kind)
    wrapper_dir.mkdir(parents=True, exist_ok=True)
    skill_md = wrapper_dir / "SKILL.md"
    cli_path = _current_cli_path()
    body = f"""---
name: feishu-{kind}
description: {description}
platform: darwin
---

This is a Vonvon-managed wrapper around the official Feishu CLI skill set.
It is intentionally hidden from the normal Skills center and should only be
activated by Vonvon's Feishu integration flow.

Use the managed runtime at:
- CLI: `{cli_path}`
- Official skill source: `{OFFICIAL_SKILL_SOURCE}`

Workflow:
1. Confirm the runtime is installed and authenticated with `{cli_path} auth status`.
2. Prefer the official Feishu CLI shortcuts for this domain.
3. If auth is missing or the runtime is unavailable, tell the user to open
   Vonvon Settings > Feishu 集成 and finish install / config / login first.
4. Do not assume context. Only operate on chats/docs/calendar items that the
   user explicitly references or that Vonvon has already injected into the turn.

This wrapper maps to the official skill family `{kind}` and exists so Vonvon can
gate Feishu abilities separately from user-installed marketplace skills.
"""
    skill_md.write_text(body, encoding="utf-8")


def _sync_hidden_wrappers() -> int:
    count = 0
    manifest = []
    for kind, description in _DEFAULT_SKILLS:
        _write_skill_wrapper(kind, description)
        count += 1
        manifest.append(
            {
                "name": f"feishu-{kind}",
                "official_skill": f"lark-{kind}",
                "description": description,
            }
        )
    PACK_ROOT.mkdir(parents=True, exist_ok=True)
    (PACK_ROOT / "skill-manifest.json").write_text(
        json.dumps({"skills": manifest}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return count


def _remove_hidden_wrappers() -> None:
    if SKILL_BRIDGE_ROOT.exists():
        shutil.rmtree(SKILL_BRIDGE_ROOT)


def _refresh_skill_bridge(state: Dict[str, Any]) -> Dict[str, Any]:
    if (
        state.get("feature_enabled")
        and state.get("skills_enabled")
        and state.get("runtime_status") == "ready"
        and _is_runtime_installed()
    ):
        count = _sync_hidden_wrappers()
        state["internal_skills_synced"] = True
        state["internal_skill_count"] = count
    else:
        _remove_hidden_wrappers()
        state["internal_skills_synced"] = False
        state["internal_skill_count"] = 0
    return state


def _public_flow(flow: FeishuFlow) -> Dict[str, Any]:
    return {
        "flow_id": flow.flow_id,
        "kind": flow.kind,
        "status": flow.status,
        "started_at": flow.started_at,
        "updated_at": flow.updated_at,
        "verification_url": flow.verification_url,
        "device_code": flow.device_code,
        "error": flow.error,
        "output_excerpt": flow.output_excerpt,
        "pid": flow.pid,
        "command": flow.command,
    }


def _cleanup_flows() -> None:
    cutoff = _now() - FLOW_TTL_SECONDS
    with _flows_lock:
        stale = [fid for fid, flow in _flows.items() if flow.updated_at < cutoff]
        for fid in stale:
            _flows.pop(fid, None)


def _put_flow(flow: FeishuFlow) -> FeishuFlow:
    _cleanup_flows()
    with _flows_lock:
        _flows[flow.flow_id] = flow
    return flow


def _get_flow(flow_id: str) -> FeishuFlow:
    _cleanup_flows()
    with _flows_lock:
        flow = _flows.get(flow_id)
    if not flow:
        raise ValueError("未知的飞书引导流程")
    return flow


def _update_flow(flow_id: str, **patch: Any) -> FeishuFlow:
    with _flows_lock:
        flow = _flows.get(flow_id)
        if not flow:
            raise ValueError("未知的飞书引导流程")
        for key, value in patch.items():
            setattr(flow, key, value)
        flow.updated_at = _now()
    return flow


def _spawn_flow(kind: str, command: List[str], *, auth_resume: bool = False) -> FeishuFlow:
    if kind not in _FLOW_KINDS:
        raise ValueError(f"Unsupported flow kind: {kind}")

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    flow = _put_flow(
        FeishuFlow(
            flow_id=str(uuid.uuid4()),
            kind=kind,
            status="starting",
            pid=process.pid,
            command=command,
        )
    )

    def watch() -> None:
        lines: List[str] = []
        verification_url: Optional[str] = None
        device_code: Optional[str] = None
        stdout = process.stdout
        try:
            if stdout is not None:
                for raw_line in iter(stdout.readline, ""):
                    line = raw_line.rstrip()
                    if not line and process.poll() is not None:
                        break
                    if not line:
                        continue
                    lines.append(line)
                    excerpt = _trim_output("\n".join(lines))
                    hints = _extract_flow_hints(line)
                    verification_url = verification_url or hints["verification_url"]
                    device_code = device_code or hints["device_code"]
                    next_status = "running"
                    if verification_url:
                        next_status = "waiting_user"
                    _update_flow(
                        flow.flow_id,
                        output_excerpt=excerpt,
                        verification_url=verification_url,
                        device_code=device_code,
                        status=next_status,
                    )
            return_code = process.wait()
        except Exception as exc:
            _update_flow(flow.flow_id, status="error", error=str(exc))
            return

        combined = _trim_output("\n".join(lines))
        if return_code != 0:
            err = combined or f"{kind} exited with status {return_code}"
            _update_flow(flow.flow_id, status="error", error=err, output_excerpt=combined)
            state = _read_state()
            state["last_error"] = err
            state["runtime_status"] = "error"
            _write_state(state)
            return

        if kind == "auth_login" and not auth_resume:
            state = verify_runtime()
            if state.get("authenticated"):
                _update_flow(flow.flow_id, status="success", output_excerpt=combined)
                return
            _update_flow(
                flow.flow_id,
                status="waiting_user",
                verification_url=verification_url,
                device_code=device_code,
                output_excerpt=combined,
            )
            return

        if kind == "config_init":
            state = _read_state()
            state["config_initialized"] = True
            state["last_error"] = None
            state["runtime_status"] = "configured_needs_auth"
            _write_state(state)
        elif kind == "auth_login":
            state = verify_runtime()
            if not state.get("authenticated"):
                _update_flow(
                    flow.flow_id,
                    status="error",
                    error=state.get("auth_note") or "飞书账号未登录成功",
                    output_excerpt=combined,
                )
                return

        _update_flow(flow.flow_id, status="success", output_excerpt=combined)

    thread = threading.Thread(target=watch, daemon=True, name=f"feishu-flow-{flow.flow_id}")
    thread.start()
    return flow


def _ensure_cli_ready_for_commands() -> Path:
    cli = _current_cli_path()
    if not cli.exists():
        raise RuntimeError("vonvon 托管的 Lark CLI 还没有安装")
    return cli


def get_state() -> Dict[str, Any]:
    state = _read_state()
    state["current_version"] = _detect_current_version() or state.get("current_version")
    if not _is_runtime_installed():
        state["current_version"] = None
        state["authenticated"] = False
        state["auth_identity"] = None
        state["auth_default_as"] = None
        state["auth_note"] = None
        state["account_display_name"] = None
        state["account_identifier"] = None
        state["logged_in_accounts"] = []
        state["config_initialized"] = False
        state["feature_enabled"] = False
        state["skills_enabled"] = False
        state["orb_inspect_enabled"] = False
    state["runtime_status"] = _compute_runtime_status(state)
    state = _refresh_skill_bridge(state)
    state["managed_paths"] = _managed_paths()
    return _write_state(state)


def install_runtime(version: Optional[str] = None) -> Dict[str, Any]:
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("安装 vonvon 托管的 Lark CLI 需要先具备 npm")

    _ensure_layout()
    state = _read_state()
    target_version = (version or _fetch_latest_version() or "latest").strip()
    version_dir = VERSIONS_ROOT / target_version
    if not _cli_path_for(version_dir).exists():
        version_dir.mkdir(parents=True, exist_ok=True)
        package_spec = PACKAGE_NAME if target_version == "latest" else f"{PACKAGE_NAME}@{target_version}"
        result = _run(
            [npm, "install", "--prefix", str(version_dir), package_spec],
            timeout=180,
        )
        if result.returncode != 0:
            err = _trim_output("\n".join([result.stdout or "", result.stderr or ""]))
            raise RuntimeError(err or "安装 vonvon 托管的 Lark CLI 失败")

    _atomic_switch_current(version_dir)
    detected_version = _detect_current_version(_cli_path_for(version_dir)) or target_version
    state.update(
        {
            "current_version": detected_version,
            "runtime_status": "installed_needs_config",
            "config_initialized": False,
            "authenticated": False,
            "auth_identity": None,
            "auth_default_as": None,
            "auth_note": None,
            "account_display_name": None,
            "account_identifier": None,
            "logged_in_accounts": [],
            "last_error": None,
        }
    )
    if state.get("feature_enabled") and not state.get("skills_enabled"):
        state["skills_enabled"] = True
    state = _refresh_skill_bridge(state)
    return _write_state(state)


def check_for_updates() -> Dict[str, Any]:
    state = _read_state()
    latest = _fetch_latest_version()
    current = _detect_current_version() or state.get("current_version")
    state["current_version"] = current
    state["latest_available_version"] = latest
    state["last_checked_at"] = _now()
    state["upgrade_available"] = bool(
        current and latest and _safe_version_key(latest) > _safe_version_key(current)
    )
    state["managed_paths"] = _managed_paths()
    return _write_state(state)


def verify_runtime() -> Dict[str, Any]:
    state = _read_state()
    cli = _current_cli_path()
    if not cli.exists():
        state.update(
            {
                "current_version": None,
                "config_initialized": False,
                "authenticated": False,
                "auth_identity": None,
                "auth_default_as": None,
                "auth_note": None,
                "account_display_name": None,
                "account_identifier": None,
                "logged_in_accounts": [],
                "runtime_status": "not_installed",
                "last_error": None,
            }
        )
        return _write_state(state)

    state["current_version"] = _detect_current_version(cli) or state.get("current_version")
    state["config_initialized"] = state.get("config_initialized", False)
    auth_result = _run([str(cli), "auth", "status"], timeout=15)
    auth_list_result = _run([str(cli), "auth", "list"], timeout=15)
    doctor_result = _run([str(cli), "doctor"], timeout=30)
    auth_context = _extract_auth_context(
        auth_result.stdout or "",
        auth_list_result.stdout or "",
    )
    state.update({key: value for key, value in auth_context.items() if key in state})
    state["config_initialized"] = bool(
        state.get("config_initialized")
        or state["authenticated"]
        or auth_context.get("config_initialized_hint")
    )
    state["last_verified_at"] = _now()
    if state["authenticated"]:
        state["last_good_version"] = state.get("current_version")
    if doctor_result.returncode != 0 and not state["authenticated"]:
        state["last_error"] = _trim_output(
            "\n".join([doctor_result.stdout or "", doctor_result.stderr or ""])
        )
    elif auth_result.returncode != 0 and state.get("config_initialized"):
        state["last_error"] = _trim_output(
            "\n".join([auth_result.stdout or "", auth_result.stderr or ""])
        )
    else:
        state["last_error"] = None
    state["runtime_status"] = _compute_runtime_status(state)
    state = _refresh_skill_bridge(state)
    state["managed_paths"] = _managed_paths()
    return _write_state(state)


def upgrade_runtime(version: Optional[str] = None) -> Dict[str, Any]:
    state = _read_state()
    previous_version = state.get("current_version")
    installed_state = install_runtime(version)
    try:
        verified = verify_runtime()
    except Exception as exc:
        if previous_version:
            previous_dir = VERSIONS_ROOT / previous_version
            if _cli_path_for(previous_dir).exists():
                _atomic_switch_current(previous_dir)
        rollback_state = _read_state()
        rollback_state["current_version"] = previous_version
        rollback_state["runtime_status"] = _compute_runtime_status(rollback_state)
        rollback_state["last_error"] = f"Upgrade failed and was rolled back: {exc}"
        rollback_state["managed_paths"] = _managed_paths()
        return _write_state(rollback_state)
    verified["latest_available_version"] = installed_state.get("latest_available_version")
    verified["upgrade_available"] = False
    verified["last_error"] = None
    return _write_state(verified)


def start_config_flow() -> Dict[str, Any]:
    cli = _ensure_cli_ready_for_commands()
    flow = _spawn_flow("config_init", [str(cli), "config", "init", "--new"])
    return _public_flow(flow)


def start_auth_flow() -> Dict[str, Any]:
    state = _read_state()
    if not state.get("config_initialized"):
        raise RuntimeError("请先完成飞书应用配置，再继续登录")
    cli = _ensure_cli_ready_for_commands()
    flow = _spawn_flow(
        "auth_login",
        [str(cli), "auth", "login", "--recommend", "--no-wait"],
        auth_resume=False,
    )
    return _public_flow(flow)


def complete_auth_flow(flow_id: str) -> Dict[str, Any]:
    flow = _get_flow(flow_id)
    if flow.kind != "auth_login":
        raise RuntimeError("当前流程不是飞书登录流程")
    if flow.status == "success":
        return _public_flow(flow)

    state = verify_runtime()
    if state.get("authenticated"):
        return _public_flow(_update_flow(flow_id, status="success", error=None))

    if not flow.device_code:
        raise RuntimeError("当前登录流程没有拿到可继续的 device_code")
    cli = _ensure_cli_ready_for_commands()
    resumed = _spawn_flow(
        "auth_login",
        [str(cli), "auth", "login", "--device-code", flow.device_code],
        auth_resume=True,
    )
    return _public_flow(resumed)


def get_flow_status(flow_id: str) -> Dict[str, Any]:
    return _public_flow(_get_flow(flow_id))


def set_feature_enabled(enabled: bool) -> Dict[str, Any]:
    state = verify_runtime()
    if enabled and state.get("runtime_status") != "ready":
        raise RuntimeError("请先完成 Lark CLI 安装、飞书应用配置和账号登录")

    state["feature_enabled"] = enabled
    if enabled:
        state["skills_enabled"] = True
        state["orb_inspect_enabled"] = True
    else:
        state["skills_enabled"] = False
        state["orb_inspect_enabled"] = False
    state["last_error"] = None
    state = _refresh_skill_bridge(state)
    return _write_state(state)


def set_skills_enabled(enabled: bool) -> Dict[str, Any]:
    state = verify_runtime()
    if enabled and state.get("runtime_status") != "ready":
        raise RuntimeError("请先让 Lark CLI 进入就绪状态，再启用飞书内部 Skills")
    if enabled and not state.get("feature_enabled"):
        raise RuntimeError("请先打开飞书深度集成总开关")

    state["skills_enabled"] = enabled
    state = _refresh_skill_bridge(state)
    return _write_state(state)


def set_orb_inspect_enabled(enabled: bool) -> Dict[str, Any]:
    state = _read_state()
    if enabled and not state.get("feature_enabled"):
        raise RuntimeError("请先打开飞书深度集成总开关")
    state["orb_inspect_enabled"] = enabled
    return _write_state(state)


def uninstall_runtime() -> Dict[str, Any]:
    _remove_hidden_wrappers()
    if FEISHU_HOME.exists():
        for child in FEISHU_HOME.iterdir():
            if child == STATE_FILE:
                continue
            if child.is_symlink() or child.is_file():
                child.unlink()
            else:
                shutil.rmtree(child)

    state = _default_state()
    state["managed_paths"] = _managed_paths()
    return _write_state(state)
