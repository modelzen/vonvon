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
from urllib.parse import urlparse

from app.config import HERMES_HOME

logger = logging.getLogger(__name__)

STATE_VERSION = 1
PACKAGE_NAME = "@larksuite/cli"
OFFICIAL_SKILL_SOURCE = "larksuite/cli"
FLOW_TTL_SECONDS = 30 * 60
FLOW_OUTPUT_LIMIT = 3200
DEFAULT_COMMAND_TIMEOUT = 45
LINK_PREVIEW_VERIFY_TTL_SECONDS = 60

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
_LARK_DOC_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,}$")

_FLOW_KINDS = {"config_init", "auth_login"}

_DEFAULT_SKILLS: List[tuple[str, str]] = [
    ("lark-shared", "应用配置、鉴权状态和基础守则。"),
    ("lark-calendar", "日历、日程、空闲忙碌查询。"),
    ("lark-im", "飞书会话、消息、线程和附件。"),
    ("lark-doc", "飞书文档创建、读取、更新。"),
    ("lark-drive", "云文档、文件上传下载和权限。"),
    ("lark-sheets", "电子表格读写、追加和导出。"),
    ("lark-slides", "幻灯片创建、读取和改写。"),
    ("lark-base", "多维表格、字段、记录和视图。"),
    ("lark-task", "任务、提醒、成员和子任务。"),
    ("lark-mail", "邮箱搜索、收发和草稿。"),
    ("lark-contact", "联系人与用户查询。"),
    ("lark-wiki", "知识库空间、节点和文档。"),
    ("lark-event", "实时事件订阅与路由。"),
    ("lark-vc", "会议纪要、录制与摘要。"),
    ("lark-whiteboard", "白板与图表 DSL。"),
    ("lark-minutes", "会议纪要结构化结果。"),
    ("lark-openapi-explorer", "官方 OpenAPI 探索能力。"),
    ("lark-skill-maker", "自定义 Lark skill 框架。"),
    ("lark-attendance", "考勤打卡记录查询。"),
    ("lark-approval", "审批查询、审批和转交。"),
    ("lark-workflow-meeting-summary", "会议总结 workflow。"),
    ("lark-workflow-standup-report", "站会/agenda 汇总 workflow。"),
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


def _wrapper_dir(skill_name: str) -> Path:
    return SKILL_BRIDGE_ROOT / skill_name


def _write_skill_wrapper(skill_name: str, description: str) -> None:
    wrapper_dir = _wrapper_dir(skill_name)
    wrapper_dir.mkdir(parents=True, exist_ok=True)
    skill_md = wrapper_dir / "SKILL.md"
    cli_path = _current_cli_path()
    extra_guidance = ""
    if skill_name == "lark-im":
        extra_guidance = f"""

High-signal command recipes for this domain:
- 检查登录态：`{cli_path} auth status`
- 按聊天名搜索会话：`{cli_path} im +chat-search --query '<聊天名>' --format json`
- 读取群/会话信息：`{cli_path} im chats get --params '{{"chat_id":"<chat_id>"}}' --format json`
- 读取群成员：`{cli_path} im chat.members get --params '{{"chat_id":"<chat_id>"}}' --format json`
- 搜索消息：`{cli_path} im +messages-search --query '<关键词>' --format json`

Important constraints:
- 在 auto-inspect 场景里，优先直接使用上面的命令模板，而不是先从 `--help` / `schema` 开始探索。
- 直接用上面的命令模板，不要优先试错 `--keyword`、`--chat-id` 这类参数；这里统一优先 `--query` 和 `--params`。
- `+messages-search` 需要 `search:message` scope。若缺权限，只说明限制并回退到截图可见信息，不要继续多轮重试。
- inspect 场景下，默认最多做一次定向会话查询；不要为了“更完整”扫全量聊天列表。
"""
    elif skill_name == "lark-contact":
        extra_guidance = f"""

High-signal command recipes for this domain:
- 检查登录态：`{cli_path} auth status`
- 按姓名搜索用户：`{cli_path} contact +search-user --query '<姓名>' --format json`
- 需要更多字段时，再结合 `--page-size` / `--page-token` 做定向翻页

Important constraints:
- 在 auto-inspect 场景里，优先直接用 `+search-user --query`，不要先把时间花在 `--help` / `schema` 上。
- inspect 场景下，不要因为联系人没精确命中就继续做多轮模糊搜索；一次失败后应回退到截图可见信息。
"""

    body = f"""---
name: {skill_name}
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
5. In auto-inspect turns, do not explore the CLI surface area. Use direct
   commands only, keep calls minimal, and stop once you can provide useful help.

This managed copy keeps the official skill name `{skill_name}` while letting
Vonvon gate Lark abilities separately from the normal Skills settings surface.
{extra_guidance}"""
    skill_md.write_text(body, encoding="utf-8")


def _write_vonvon_inspect_skill() -> None:
    wrapper_dir = _wrapper_dir("vonvon-inspect")
    wrapper_dir.mkdir(parents=True, exist_ok=True)
    skill_md = wrapper_dir / "SKILL.md"
    body = """---
name: vonvon-inspect
description: 根据当前截图识别用户正在关注的协同应用上下文，调用相关 skills 获取更完整的实时信息，并主动提供帮助。
platform: darwin
---

# vonvon-inspect

这是 vonvon 内部自动触发的隐藏编排 skill。

典型触发条件：
- 用户双击 vonvon
- vonvon 已经吸附在协同应用侧边
- 当前 turn 自动附带了一张截图
- 当前 turn 自动激活了 `vonvon-inspect`

当前 turn 可能只有截图和 `vonvon-inspect` 激活信号，不一定有额外文字指令。
不要期待用户再补一大段 prompt。

## 你的目标

基于当前截图，完成 4 件事：

1. 判断用户当前正在关注哪个协同应用上下文
2. 决定是否需要调用相关 skills 拉取更完整、更新的实时上下文
3. 推断用户此刻最可能要推进的事
4. 直接给出主动帮助，而不只是描述截图

## 输入原则

截图是第一信号源。

- 必须先看图，再判断上下文
- 不要先假设当前对象是什么
- 不要把窗口标题、历史记忆或模糊猜测当成主依据
- 如果截图已经足够支撑一个高价值回复，就直接回答
- 只有当截图缺少一个“高价值、会明显提升帮助质量”的关键信息时，才去调用相关 suite skills

## 前置校验与证据纪律

在任何尝试拉取飞书实时上下文之前，必须先确认飞书集成登录状态正常。

- 这是 inspect 的默认前置步骤，不要把它写成“我顺手做了一个最小补充”或额外贡献。
- 如果飞书未登录、登录过期、只有 bot/tenant 身份、或 auth status 明确表明当前用户态不可用，就不要继续声称能拉取实时上下文。
- 遇到上面的情况时，应直接提醒用户去登录飞书集成，或刷新/重新完成登录。
- 只有在 tool / skill 实际返回了聊天、文档、日历等实时内容后，才能说“已拉到”“已获取”“我看了最近上下文”。
- 如果你只是做了对象搜索、尝试了定向拉取、或看了截图，但没有拿到真实返回结果，就必须明确说“本回答当前仅基于截图可见内容”。

## 角色定位

你是“选路与编排” skill，不是底层 CLI 探索 skill。

- 先识别截图里的协同场景
- 选择最相关的 domain skill
- 把问题交给那个 skill 去完成
- 最后把结果组织成一条自然、主动、有帮助的回复

默认不要在 `vonvon-inspect` 里直接展开一串底层 CLI 探索。

## 默认效率策略

这是一个快速 inspect 技能，不是 CLI 探索任务。

默认遵守下面 5 条：

1. 先看图，再决定是否真的需要额外 tool。
2. 默认先激活 1 个最相关的 domain skill，不要无差别把所有 `lark-*` skills 全部调用一遍。
3. 默认不要把时间花在 `--help`、`schema`、宽范围 `list --page-all`、或连续试错上。
4. 如果第一次定向调用已经暴露出权限不足、对象无法精确定位、或参数模式不匹配，就停止扩张，退回到截图可见信息。
5. 如果截图里已经清晰可见最近消息、文档段落、时间安排或待办线索，就不要再为了复读这些可见内容调用额外 API。

## 当前支持的协同套件

当前优先支持：
- Lark / 飞书，对应 `lark-*` skills

后续可能支持：
- DingTalk / 钉钉，对应 `dingtalk-*` skills

因此你不应该把自己写死为“只支持飞书”，而应该先识别当前是哪类协同套件，再决定调用哪一组 skills。

## 你要识别的上下文类型

优先判断用户当前关注的是：

- chat：聊天、群聊、私聊、话题
- doc：文档、知识库页面、wiki 页面
- calendar：日历、日程、排期
- meeting：会议、视频会议、会议纪要
- sheet：表格、电子表格、多维表格
- slide：幻灯片、演示文稿
- drive：文件、云盘、目录
- task：任务、待办、项目项
- mail：邮件
- approval：审批
- contact：联系人、人员页
- unknown：暂时无法可靠判断

如果不能高置信度判断，就明确说不确定，不要编造。

## 选路规则

如果识别为 Lark，优先这样选：

- chat：`lark-im`
- doc/wiki：`lark-doc`、`lark-wiki`
- calendar/meeting：`lark-calendar`、`lark-vc`、`lark-minutes`
- sheet/base：`lark-sheets`、`lark-base`
- drive/file：`lark-drive`
- task：`lark-task`
- mail：`lark-mail`
- approval：`lark-approval`
- contact：`lark-contact`

`vonvon-inspect` 负责选路，domain skill 负责走路。

## 文档场景补充规则

如果截图显示的是 doc / wiki / 知识库页面，需要额外遵守下面 4 条：

1. 先判断当前文档是否能被稳定定位。
2. 如果能稳定定位，优先调用 `lark-doc` / `lark-wiki` 去看文档详细内容，再回答。
3. 如果不能稳定定位，就不要假装已经看过文档正文；必须明确说明“目前还没有成功打开这份文档的详细内容，本回答当前仅基于截图可见内容”。
4. 当你没有查看文档详细内容时，可以补一句：是否要继续查看这份文档的详细内容。

## 优先提供的帮助

优先给用户能直接继续做事的输出，例如：

- 总结当前讨论重点
- 提炼待办事项
- 梳理分歧点
- 起草回复
- 概括文档内容
- 提炼行动项
- 整理会议议程
- 提示风险、遗漏和下一步建议

## 回答风格

你的第一条回复应该像是 vonvon 在用户双击后主动接话。

- 先给判断，再给重点，再给下一步建议
- 不要只做冷冰冰的识别报告
- 不要先汇报你内部做了哪些“小补充”或“顺手检查了什么”
- 如果实时拉取没有成功，要直接、诚实地说明限制

如果截图本身已经足够支撑一个高价值回复，优先直接给：
- 当前对象判断
- 你从截图里提炼出的核心信息
- 一条可以直接采取的下一步建议

## 安全边界

- 不要假装看到了截图里没有的东西
- 不要假装拿到了 skill 没返回的信息
- 识别不清楚时，要明确说不确定
- 需要实时信息时，优先先选对 domain skill，再按那个 skill 的路径执行
- 不要把弱信号包装成高置信度结论
- 不要在这个回合里顺手修 skill、写 memory、或做额外维护动作
"""
    skill_md.write_text(body, encoding="utf-8")


def _sync_hidden_wrappers() -> int:
    count = 0
    manifest = []
    _write_vonvon_inspect_skill()
    count += 1
    manifest.append(
        {
            "name": "vonvon-inspect",
            "official_skill": None,
            "description": "根据当前截图识别协同应用上下文并主动提供帮助。",
        }
    )
    for skill_name, description in _DEFAULT_SKILLS:
        _write_skill_wrapper(skill_name, description)
        count += 1
        manifest.append(
            {
                "name": skill_name,
                "official_skill": skill_name,
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


def _ensure_runtime_ready_for_link_preview() -> Dict[str, Any]:
    state = _read_state()
    last_verified_at = float(state.get("last_verified_at") or 0)
    recently_verified = (_now() - last_verified_at) < LINK_PREVIEW_VERIFY_TTL_SECONDS
    if (
        recently_verified
        and state.get("runtime_status") == "ready"
        and state.get("authenticated")
        and _is_runtime_installed()
    ):
        return state

    state = verify_runtime()
    if state.get("runtime_status") != "ready" or not state.get("authenticated"):
        raise RuntimeError("请先在 vonvon 设置里完成飞书登录，再使用链接标题预览")
    return state


def _extract_lark_url_token(raw_url: str, marker: str) -> Optional[str]:
    index = raw_url.find(marker)
    if index < 0:
        return None
    token = raw_url[index + len(marker) :]
    for delimiter in "/?#":
        split_at = token.find(delimiter)
        if split_at >= 0:
            token = token[:split_at]
    token = token.strip()
    if not token or not _LARK_DOC_TOKEN_RE.match(token):
        return None
    return token


def _parse_feishu_doc_url(raw_url: str) -> Dict[str, str]:
    url = (raw_url or "").strip()
    if not url:
        raise ValueError("飞书链接不能为空")

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("请输入有效的飞书文档链接")

    host = parsed.netloc.lower()
    if not (
        host.endswith(".feishu.cn")
        or host.endswith(".larksuite.com")
        or host == "feishu.cn"
        or host == "larksuite.com"
    ):
        raise ValueError("当前只支持飞书 / Lark 文档链接")

    markers = [
        ("/wiki/", "wiki"),
        ("/docx/", "docx"),
        ("/docs/", "doc"),
        ("/doc/", "doc"),
        ("/sheets/", "sheet"),
        ("/sheet/", "sheet"),
        ("/base/", "bitable"),
        ("/bitable/", "bitable"),
        ("/slides/", "slides"),
        ("/drive/folder/", "folder"),
    ]
    for marker, doc_type in markers:
        token = _extract_lark_url_token(url, marker)
        if token:
            return {
                "url": url,
                "doc_type": doc_type,
                "doc_token": token,
            }

    raise ValueError("暂时无法从这个飞书链接中识别文档类型")


def _run_lark_json(command: List[str], *, timeout: int = DEFAULT_COMMAND_TIMEOUT) -> Dict[str, Any]:
    result = _run(command, timeout=timeout)
    combined_output = _trim_output("\n".join([result.stdout or "", result.stderr or ""]))
    if result.returncode != 0:
        raise RuntimeError(combined_output or "读取飞书数据失败")
    payload = _safe_json_loads(result.stdout or "")
    if not payload:
        raise RuntimeError(combined_output or "飞书返回不是有效 JSON")
    return payload


def _query_drive_meta(cli: Path, doc_token: str, doc_type: str) -> Dict[str, str]:
    payload = {
        "request_docs": [
            {
                "doc_token": doc_token,
                "doc_type": doc_type,
            }
        ],
        "with_url": True,
    }
    response = _run_lark_json(
        [
            str(cli),
            "drive",
            "metas",
            "batch_query",
            "--as",
            "user",
            "--data",
            json.dumps(payload, ensure_ascii=False),
            "--format",
            "json",
        ],
        timeout=15,
    )
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    metas = data.get("metas") if isinstance(data.get("metas"), list) else []
    if metas and isinstance(metas[0], dict):
        meta = metas[0]
        title = str(meta.get("title") or "").strip()
        resolved_url = str(meta.get("url") or "").strip()
        if title:
            return {
                "title": title,
                "url": resolved_url,
                "doc_type": doc_type,
                "doc_token": doc_token,
            }

    failed = data.get("failed_list") if isinstance(data.get("failed_list"), list) else []
    failure_code = failed[0].get("code") if failed and isinstance(failed[0], dict) else None
    if failure_code == 970005:
        raise RuntimeError("当前账号无权读取这个飞书文档，或文档已不存在")
    if failure_code == 970003:
        raise RuntimeError("这个飞书文档类型暂不支持标题预览")
    if failure_code == 970002:
        raise RuntimeError("飞书文档 token 无效，无法生成标题预览")
    raise RuntimeError("没能从飞书返回中解析出文档标题")


def _resolve_wiki_doc_meta(cli: Path, wiki_token: str, fallback_url: str) -> Dict[str, str]:
    response = _run_lark_json(
        [
            str(cli),
            "wiki",
            "spaces",
            "get_node",
            "--as",
            "user",
            "--params",
            json.dumps({"token": wiki_token}, ensure_ascii=False),
            "--format",
            "json",
        ],
        timeout=15,
    )
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    node = data.get("node") if isinstance(data.get("node"), dict) else {}
    obj_type = str(node.get("obj_type") or "").strip()
    obj_token = str(node.get("obj_token") or "").strip()
    title = str(node.get("title") or "").strip()
    if not obj_type or not obj_token:
        raise RuntimeError("wiki 节点解析成功了，但没有返回实际文档 token")

    try:
        meta = _query_drive_meta(cli, obj_token, obj_type)
        if not meta.get("title") and title:
            meta["title"] = title
        if not meta.get("url"):
            meta["url"] = fallback_url
        return meta
    except RuntimeError:
        if title:
            return {
                "title": title,
                "url": fallback_url,
                "doc_type": obj_type,
                "doc_token": obj_token,
            }
        raise


def _fetch_doc_title_via_docs_shortcut(cli: Path, raw_url: str) -> Optional[Dict[str, str]]:
    try:
        response = _run_lark_json(
            [
                str(cli),
                "docs",
                "+fetch",
                "--as",
                "user",
                "--doc",
                raw_url,
                "--limit",
                "1",
                "--format",
                "json",
            ],
            timeout=20,
        )
    except RuntimeError:
        return None

    title = str(response.get("title") or "").strip()
    if not title:
        return None
    parsed = _parse_feishu_doc_url(raw_url)
    return {
        "title": title,
        "url": raw_url,
        "doc_type": parsed["doc_type"],
        "doc_token": parsed["doc_token"],
    }


def resolve_link_preview(raw_url: str) -> Dict[str, str]:
    state = verify_runtime()
    if state.get("runtime_status") != "ready" or not state.get("authenticated"):
        raise RuntimeError("请先在 vonvon 设置里完成飞书登录，再使用链接标题预览")

    parsed = _parse_feishu_doc_url(raw_url)
    cli = _ensure_cli_ready_for_commands()
    if parsed["doc_type"] == "wiki":
        return _resolve_wiki_doc_meta(cli, parsed["doc_token"], parsed["url"])

    try:
        meta = _query_drive_meta(cli, parsed["doc_token"], parsed["doc_type"])
        if not meta.get("url"):
            meta["url"] = parsed["url"]
        return meta
    except RuntimeError:
        shortcut = _fetch_doc_title_via_docs_shortcut(cli, parsed["url"])
        if shortcut:
            return shortcut
        raise


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
