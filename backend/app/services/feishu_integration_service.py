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

这是一个由 vonvon 内部自动触发的编排 skill。

它的触发场景是：
- 用户点击 vonvon 粉球
- vonvon 已经吸附在协同应用侧边
- 当前 turn 自动附带了一张截图
- 当前 turn 自动激活了 `vonvon-inspect`

这个 skill 不面向用户手动选择，也不应该出现在普通技能列表里。

## 你的目标

基于当前 turn 中的截图，完成下面 4 件事：

1. 判断用户当前正在关注哪个协同应用上下文
2. 判断应该调用哪些相关 skills 去获取更完整、更新的实时上下文
3. 推断用户此刻最可能想做什么
4. 主动提供帮助，而不只是描述你看到了什么

## 输入原则

截图是第一信号源。

必须先看图，再判断上下文。
不要先假设当前对象是什么。
不要把窗口标题、历史记忆或模糊猜测当成主依据。

如果截图信息不够，再把其他弱信号当辅助参考。

默认先基于截图直接给出帮助。
只有当截图里缺少一个“高价值、会明显提升帮助质量”的关键信息时，才去调用相关 suite skills 补充实时上下文。

## 你的角色定位

你是一个“路由与编排” skill，不是一个直接操作 Lark CLI 的底层 skill。

你的职责是：
- 先识别截图里的协同场景
- 决定最应该加载哪个 `lark-*` skill
- 把问题交给那个最相关的 domain skill 去完成
- 最后把结果组织成一条主动、有帮助的回复

因此，在默认情况下：
- 不要在 `vonvon-inspect` 里直接开始一串底层 CLI 探索
- 应该先加载最相关的 `lark-*` skill，再按照那个 skill 的路径去做
- 只有当某个 domain skill 明显不够用时，再升级到第二个相关 skill

## 默认效率策略

这是一个“快速 inspect”技能，不是 CLI 探索任务。

默认遵守下面 6 条：

1. 先看图，再决定是否真的需要额外 tool。
2. 如果截图已经足够让你总结重点、判断对象、起草回复，就直接回答，不要为了追求“更全”而继续拉取。
3. 默认先激活 **1 个** 最相关的 `lark-*` domain skill，让它带路。
4. 在识图之后，默认最多再做 **3 次** 外部工具调用。
5. 默认不要把时间花在 `--help`、`schema`、宽范围 `list --page-all`、或为了摸索参数而连续试错上；优先走相关 domain skill 已知的快路径。
6. 如果第一次定向调用已经暴露出权限不足、对象无法精确定位、或参数模式不匹配，就应停止扩张，回退到截图可见信息并说明限制。

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

## 工作流程

### 第一步：看图识别当前对象

先从截图中提取尽可能多的可见线索，例如：

- 当前套件品牌
- 页面类型
- 聊天标题
- 文档标题
- 日程标题
- 参与人
- 时间
- 日期
- 文件名
- 空间名
- 团队名
- 标签
- 页面结构
- 当前是否在讨论、阅读、安排会议、查看任务、审批等

### 第二步：选择最小必要 skill 集合

识别出对象后，优先加载最相关的 `lark-*` skill，让它负责执行。

如果是 Lark：
- chat：优先 `lark-im`
- doc/wiki：优先 `lark-doc`、`lark-wiki`
- calendar/meeting：优先 `lark-calendar`、`lark-vc`、`lark-minutes`
- sheet/base：优先 `lark-sheets`、`lark-base`
- drive/file：优先 `lark-drive`
- task：优先 `lark-task`
- mail：优先 `lark-mail`
- approval：优先 `lark-approval`
- contact：优先 `lark-contact`

只调用当前问题真正需要的 skill。
不要无差别把所有 `lark-*` skills 全部调用一遍。
不要在默认情况下同时加载 `lark-im` 和 `lark-contact` 等多个相邻 skill，除非第一个 skill 明确证据不足。

你可以把这一步理解成：
- `vonvon-inspect` 负责“选路”
- `lark-*` domain skill 负责“走路”

### 第三步：拉取更完整的实时上下文

调用相关 `lark-*` domain skill 后，你的目标不是重复截图里已经能看到的内容，而是补全截图无法稳定提供的信息，例如：

- 最近几条消息
- 更完整的文档内容
- 文档结构
- 会议信息
- 参与者
- 议程
- 时间安排
- 任务详情
- 审批状态
- 文件元信息
- 联系人信息

如果 domain skill 调用失败，就明确说哪一步失败了，并退回到“基于截图的帮助”。

如果截图里已经清晰可见最近消息、文档段落、时间安排或待办线索，就不要再为了复读这些可见内容调用额外 API。

### 第四步：主动提供帮助

你不应该只回答：
- “我看到你现在在看某个聊天”
- “我看到你在一个文档里”
- “我看到这是一个会议页面”

你应该进一步思考：
- 用户现在最可能想做什么？
- 我能不能先帮他做第一步？
- 我能不能主动给一个高价值输出？

优先提供的帮助包括：

- 总结当前讨论重点
- 提炼待办事项
- 梳理分歧点
- 起草回复
- 概括文档内容
- 提炼行动项
- 整理会议议程
- 提示风险、遗漏和下一步建议
- 帮用户继续“刚才那个对象”的工作

## 回答风格

你的第一条回复应该像是 vonvon 在用户点击粉球后主动接话。

风格要像：
- “我看到你现在在看这个聊天，我先帮你理了一下最近讨论……”
- “我看到你现在打开的是这份文档，我先抓了更完整的上下文，重点是……”
- “我看到你在看这个日程，我先帮你整理了时间、参与人和待确认事项……”

不要只做冷冰冰的识别报告。

如果截图本身已经足够支撑一个高价值回复，优先直接给：
- 当前对象判断
- 你从截图里提炼出的核心信息
- 一条可以直接采取的下一步建议
- 如有必要，再补一句“如果你要，我可以继续去拉更完整的实时上下文”

而不是默认先进入长链路工具调用。

## 安全边界

- 不要假装看到了截图里没有的东西
- 不要假装拿到了 skill 没返回的信息
- 识别不清楚时，要明确说不确定
- 需要实时信息时，优先先选对 `lark-*` domain skill，再按那个 skill 的路径执行
- 不要把弱信号包装成高置信度结论
- 不要在这个回合里顺手修 skill、写 memory、或做额外维护动作

## 失败回退

如果你无法可靠识别：
1. 先简要说明截图里看到了什么
2. 说明目前不确定的部分
3. 如果可能，提出一个最小澄清
4. 或者先提供截图层面的初步帮助

## 这一 skill 的本质

这不是一个“描述截图”的 skill。
这是一个“从截图出发，连接 suite skills，主动帮助用户推进当前协同任务”的 skill。
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
