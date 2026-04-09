# Implementation Plan: vonvon v1.1 — Hermes 配置面板

## Spec & Context Reference
- `.omc/specs/deep-interview-vonvon-agent.md` (v1 spec)
- `.omc/plans/vonvon-agent.md` (v1 plan, already delivered)
- v1 status: FastAPI backend shipped (`backend/app/routes/{chat,models,sessions}.py`), hermes-agent git-subtree at `backend/hermes-agent/`, Electron frontend with `SettingsPanel`/`ModelSettings`/`BackendSettings` scaffold, `useAgentChat`/`useBackend` hooks working.

## Scope (v1.1)

Eliminate the "必须先用 CLI `hermes model` / `hermes auth add` / `hermes mcp add`" split-brain experience. Let the user complete all hermes-backend configuration from the Electron Settings panel whenever `backendEnabled === true`.

**In scope:**
1. **模型选择 (runtime)** — hook the existing `GET /api/models` / `POST /api/models/current` into the UI so the user can switch the *currently active* backend model at runtime; also surface the list of authenticated providers read from hermes's own auth store.
2. **认证配置** — add an "凭据" panel with two flows:
   - **API Key**: user pastes a key for `openai`/`anthropic`/`openrouter`/`nous`/custom → backend writes it into hermes's `credential_pool` via `agent.credential_pool.load_pool(provider).add_entry(PooledCredential(...))`.
   - **ChatGPT OAuth (device code)**: wraps `_codex_device_code_login` with a non-blocking two-step protocol (`POST /api/auth/oauth/start` → `GET /api/auth/oauth/poll?flow_id=…`). Frontend modal shows `user_code` + `verification_url`, polls until success/timeout.
3. **MCP server 管理** — CRUD against `~/.hermes/config.yaml:mcp_servers` via thin wrappers over `hermes_cli/mcp_config.py` helpers. Includes a "测试连接" button that invokes the existing `_probe_single_server` probe.
4. **Skill 管理** — UI panel to:
   - 列出已安装 skill（`tools/skills_tool.py:_find_all_skills`）
   - 针对 **vonvon 平台**（新注册的 platform key）逐项 enable/disable（`hermes_cli/skills_config.py:get_disabled_skills`/`save_disabled_skills`，`platform="vonvon"`）
   - 搜索 hub（`tools/skills_hub.py:unified_search`）
   - 安装（`hermes_cli/skills_hub.py:do_install` 的无 Console 版本）/ 卸载（`tools/skills_hub.py:uninstall_skill`）
   - 检查更新（`tools/skills_hub.py:check_for_skill_updates`）
   安装是长耗时操作（git clone/HTTP 下载），采用与 OAuth 同构的 `start/poll` 异步 job 模式。
5. **项目工作区 (Project Workspace)** — 修复 v1 遗漏：hermes agent 的文件/终端/git 工具全部走 `TERMINAL_CWD` env（fallback `os.getcwd()`），v1 backend 从未设置过它，导致 agent 在 `backend/` 目录里乱读写。v1.1 必须：
   - **澄清概念边界**：Skills 永远走 `~/.hermes/skills/`（全局，与 workspace 无关）；Workspace 只影响 agent tool 执行时的 cwd（file read/write、terminal、git、AGENTS.md discovery）。两者独立配置。
   - UI `SettingsPanel` 顶部新增 "工作区" 区块：显示当前路径 + "选择目录..." 按钮 + "使用默认沙箱" 按钮
   - "选择..." 按钮走 Electron IPC → main process 调 `dialog.showOpenDialog({properties: ['openDirectory', 'createDirectory']})` → POST 到后端
   - 后端 `POST /api/workspace {path: "…"}` 校验目录存在且可读 → 在 `config_store_lock()` 保护下写入 `~/.hermes/config.yaml:vonvon.workspace` → 设置进程级 `os.environ["TERMINAL_CWD"] = path` + `os.chdir(path)`
   - **Fallback 策略**：未配置时，后端启动用 `~/.vonvon/workdir/`（不存在时自动创建）作为安全沙箱，**不**用 `$HOME`；沙箱里放一个 `README.md` 解释用途
   - 启动时 `workspace_service.init_from_hermes_config()` 顺序：(1) 读 `config.yaml:vonvon.workspace`，若存在且有效则使用；(2) 否则 ensure `~/.vonvon/workdir/` 存在并使用；(3) 日志打 INFO 告知用户使用的是沙箱
   - **UI 提示**：当前 workspace 是沙箱时，在 Chat 区域顶部显示 "⚠️ 当前使用默认沙箱 `~/.vonvon/workdir/`，选择一个项目目录以获得更好体验" 横幅
   - 每个会话独立 workspace 留到 v1.2（本期仅做 backend 全局单目录）
6. **Base URL (可选)** — per-model `base_url` override, persisted into hermes config under an UI-only `ui_overrides.base_url` key so CLI config is never silently rewritten.

**Out of scope (explicit):**
- Hermes `memory` configuration (v1.2+).
- Skill 的 per-category 批量 toggle / per-其他平台 toggle（仅提供 global + vonvon 两级）。
- Skill 的 security audit / trust policy 编辑。
- Skill hub 的 GitHub auth 配置（继续依赖 `gh` CLI 或 env 变量）。
- Cron job / gateway settings.
- Editing `SOUL.md` / system prompt.
- OAuth for providers other than `openai-codex` (Anthropic PKCE, Nous device code exist in hermes but their flows block on `httpx.Client(…)` streaming; we keep CLI-only for v1.1).
- Secret storage in Electron safeStorage — v1.1 keeps `~/.hermes/auth.json` as the single source of truth; safeStorage only stores the backend URL (already the case).
- Multi-user / remote backend.

---

## RALPLAN-DR Summary (Deliberate Mode)

### Principles

1. **Hermes 是唯一凭据存储** — 永远走 `~/.hermes/auth.json` + `config.yaml`，不在 backend 或 Electron 另造副本。这样 `hermes` CLI 和 vonvon UI 共享同一份状态，互不覆盖。
2. **薄封装，不重写** — 所有认证/MCP/模型逻辑只做 "CLI 函数 → HTTP adapter" 转换，不复制业务规则。二次开发 hermes 时首选新增回调/拆分而非 fork。
3. **敏感数据只上不下** — API key / refresh token 只接受 POST，从不在任何 GET 响应里返回明文；前端展示只显示 label + 最后 4 位。
4. **不回退 v1** — 直连 OpenAI/Anthropic 旧聊天模式在 `backendEnabled === false` 时 UI/代码路径完全不变。所有 v1.1 新 UI 挂在 "hermes 模式" 分支后。
5. **阻塞操作必须异步化** — hermes 原生 device code flow 是同步 `sleep/poll`；后端必须把它拆成 start/poll 两步并跑在 asyncio background task 里，HTTP handler 永不阻塞超过单次轮询间隔。
6. **Workspace 显式且隔离** — hermes 的 `TERMINAL_CWD` 必须由 vonvon 明确设置，绝不依赖 `os.getcwd()` 隐式行为；未配置项目目录时用 `~/.vonvon/workdir/` 沙箱，绝不用 `$HOME`。每次聊天请求进入前做一次防御性 `TERMINAL_CWD` 重置。

### Decision Drivers (Top 3)

1. **消除 CLI/UI 割裂**：用户今天 onboarding 失败点集中在 "打开 vonvon 却看到空 Settings"，优先补齐模型/认证/MCP 三大配置面。
2. **复用 hermes 内部函数**：`_codex_device_code_login`、`_probe_single_server`、`load_pool().add_entry()` 已存在且测试过，自写一遍只会引入漂移。
3. **并发/并存安全**：用户可能同时开 CLI 和 UI；`auth.json` 已有 `_auth_store_lock`（安全），`config.yaml` 没有（危险），必须补锁。

### Options Evaluated

| | **Option A: 后端 adapter (chosen)** | Option B: Electron 主进程直接 import hermes | Option C: 纯前端本地 config 文件 |
|---|---|---|---|
| Approach | FastAPI 新增 `/api/auth`、`/api/mcp`、`/api/config` 路由，薄封装 `hermes_cli/*.py` | Electron 主进程生成 Python 子进程执行 hermes 命令 | 前端直接写 `~/.hermes/config.yaml` |
| Pros | 与 v1 同构；共享 `agent_service` 状态；前端只说 HTTP；天然跨平台 | 免后端 | 零后端 |
| Cons | 需要给 OAuth 做 start/poll 拆分；`config.yaml` 并发锁需新增 | 每次 `hermes mcp add` 都要 spawn 进程；OAuth 交互无法 headless；Windows 路径/权限地狱 | 前端写 yaml 易破坏结构；无法调用 hermes probe；绕过 credential_pool 锁 |
| Verdict | **Selected** — 继承 v1 架构、最小接口面、能被 pytest 独立测试 | Rejected — 破坏 "后端是唯一智能层" 原则 (Principle #2 违反) | Rejected — 破坏 "hermes 是唯一凭据存储" + 无 probe 能力 (Principle #1 违反) |

**Invalidation rationale**: Options B 和 C 都违反核心原则且都需要额外工作才能匹配 Option A 的能力面（OAuth headless、probe、credential_pool 写入）。

### Pre-mortem (3 Failure Scenarios)

| # | Failure | Root cause | Mitigation in plan |
|---|---|---|---|
| **P1** | 用户点 "ChatGPT OAuth" → UI 白屏 15 分钟后超时，控制台印出 user_code 但 UI 看不到 | `_codex_device_code_login` 是同步 `while … sleep` + `print(user_code)`，HTTP handler 调它会阻塞整个请求；无回调可截获 `user_code` | **WP1-B**: 二次开发 hermes，新增 `agent/codex_device_flow.py`（或 `auth.py:codex_device_flow_start/poll`）拆成 `start_device_flow()` 和 `poll_device_flow(device_auth_id, code_verifier)` 两个纯函数返回 dict；`_codex_device_code_login` 保留为 CLI 的 thin wrapper。后端在 `routes/auth.py` 维护 `flows: dict[flow_id → {device_auth_id, code_verifier, started_at, status, tokens}]`，`poll` 路由跑单次 `httpx.post`（非阻塞）并立即返回。前端 3s 一次轮询。 |
| **P2** | UI 在 CLI 正在修改 `config.yaml` 时写入，导致 yaml 结构损坏，所有 MCP 配置丢失 | `hermes_cli/config.py:save_config` 没有文件锁；只有 `auth.json` 有 `_auth_store_lock` | **WP1-C**: 二次开发 hermes — 给 `save_config` 加同款 `_config_store_lock()` (fcntl + msvcrt 跨平台)，load/save 都拿锁；在锁内 read-modify-write。PR 回馈 upstream。后端所有修改走 read-modify-save 原子路径，绝不 overwrite 未 read 的 key。 |
| **P3** | 用户把现有的 `hermes model --global sonnet` 在 UI 切到 gpt-4o，重启 CLI 后 CLI 也变成 gpt-4o，但用户其实只想在当前 vonvon 会话里临时试一下 | 后端 `POST /api/models/current` 现在直接写 `_current_model`，没区分 "UI runtime-only" vs "persist to hermes config" | **WP1-A**: `POST /api/models/current` 增加 `{model: str, persist: bool}` 字段；`persist=false` 只改 `agent_service._current_model`（不落盘，进程内生效），`persist=true` 才走 `switch_model_core` 写 config.yaml。UI 默认 `persist=false`，在下拉菜单旁加一个 "持久化到 hermes 配置" 复选框。 |
| **P4** | 用户在 UI 里点 "安装 pptx skill"，install job 卡在 `running` 状态超过 5 分钟（git clone 大 repo 或 dependency 失败），UI 一直转圈直到用户关窗，结果一半文件已写入 SKILLS_DIR 导致后续 `list_skills` 出 loaders 错误 | 同步阻塞，没有中途取消机制；异常时 hermes 不保证原子回滚 | **WP1-D**: (a) job 执行全程设置 5 分钟 `asyncio.wait_for` 超时，超时后 future cancel 并标记 `status="error"` + `error="install_timeout"`；(b) service 层在 `_do_install` 包一层 try/except：失败时调 `_do_uninstall(name)` 做 best-effort 回滚（忽略回滚异常）；(c) `list_skills` 用 try/except 包住 `_find_all_skills` 返回空数组，不传染 500。**Explicit v1.2 follow-up F7**: UI cancel button + `DELETE /api/skills/jobs/{job_id}` route（此项 Critic Minor-5 已明确推 v1.2，不在 v1.1 range）。 |
| **P5** | 用户没注意到 workspace 在沙箱，让 agent "清理当前目录所有临时文件"，agent 把 `~/.vonvon/workdir/README.md` 删了 — 还好；但如果用户后面切到项目再跑，实际 cwd 已被 os.chdir 带污染，agent 仍在旧 workspace 跑 | `os.chdir` 是进程级状态；agent tool 可能有依赖 `os.getcwd()` 的地方；hermes 的 skill 加载路径也读 cwd | **WP1-E**: (a) `workspace_service.set_workspace` 内 `os.chdir` + `os.environ["TERMINAL_CWD"]` 两者必须成对更新，没有 partial 状态 — 实现改为事务式（MF-2 修正版，chdir 先 try，env 紧跟，任一失败全量回滚）；(b) 每次 `POST /api/chat/send`、`compress_context`、`create_session` 进入前，读 `workspace_service.current_state()["path"]` 并再次 `os.environ["TERMINAL_CWD"] = …`（防御性重置，即使其他代码改动了 env）；(c) `SandboxBanner` 在沙箱状态下强制可见，用醒目黄色提示；(d) `_ensure_sandbox()` 的 README 明确写 "agent 可能修改此目录内文件"；(e) 文档化 "sandbox 仅做最小兜底，建议始终配置真实项目目录"。 |
| **P6** | 用户在 backend 正在 `save_config` 的瞬间 Ctrl-C，config.yaml 只写了前半段 → 下次启动 `load_config` 解析失败 → backend crash → 所有凭据/配置 apparently lost | 多数 yaml writer 是直写 | **已通过 hermes 自身的 atomic write 解决**（Critic MF-1 降级）：`hermes_cli/config.py:2062-2078` 的 `save_config` 通过 `utils.atomic_yaml_write` 使用 tempfile + `os.replace` 原子提交，不会出现半写 yaml。仍需增加回归测试 `test_config_atomic.py`（AC-C8）模拟进程在 `os.replace` 前被 kill，断言 `load_config` 仍返回上一个完整版本。不需要额外 hermes fork。 |

### Expanded Test Plan (unit / integration / e2e / observability)

| Layer | Test scope | Location | Key fixtures/mocks |
|---|---|---|---|
| **Unit — backend** | auth_service API-key add/remove, pool iteration, model persist flag, flow_id expiry, config-lock re-entry | `backend/tests/test_auth_service.py`, `test_mcp_service.py`, `test_config_lock.py` | `tmp_path` as `HERMES_HOME`; monkeypatch `PooledCredential` factory; freeze time for flow expiry |
| **Unit — hermes fork** | `codex_device_flow.start()` and `.poll()` return shape on success/pending/error; respects `CODEX_OAUTH_CLIENT_ID` env | `backend/hermes-agent/tests/test_codex_device_flow.py` (if existing test dir present; otherwise `backend/tests/test_hermes_codex_fork.py`) | `httpx.MockTransport` stubbing OpenAI device endpoints |
| **Integration — HTTP** | `POST /api/auth/credentials` round-trips into `auth.json`; `POST /api/auth/oauth/start` returns `user_code`+`verification_url`+`flow_id`; `GET /api/auth/oauth/poll` returns `pending` then `success`; `POST /api/mcp/servers` then `GET /api/mcp/servers` shows the entry; `DELETE /api/mcp/servers/{name}` removes it; `POST /api/models/current` with `persist=false` does not touch `config.yaml` | `backend/tests/test_api_auth.py`, `test_api_mcp.py`, `test_api_models_persist.py` | FastAPI `TestClient`; `HERMES_HOME=tmp_path`; stub `tools.mcp_tool._probe_single_server` for MCP tests |
| **Integration — concurrency** | Two backend instances concurrently call `save_config` with different `mcp_servers` changes → both mutations survive (no lost writes) | `backend/tests/test_config_lock_concurrent.py` | `multiprocessing` spawn; assert final yaml contains both keys |
| **E2E — manual walkthrough (AC matrix)** | Every AC in this plan exercised end-to-end via vonvon UI against a real `~/.hermes` | `docs/v1.1-qa-checklist.md` (new) | Real hermes-agent + test ChatGPT account; capture screenshots |
| **Observability** | Backend logs (structured JSON) at each flow transition (`flow_started`, `flow_polling`, `flow_success`, `flow_error`, `credential_added`, `mcp_probe_failed`); **never** log key material — only `provider`, `label`, `last4`, `flow_id` | `backend/app/routes/auth.py` + logging config | Assertion test: grep log capture for `sk-` substring → must be 0 matches |

---

## Architecture (v1.1 additions)

```
vonvon (Electron)                  vonvon-backend (FastAPI)              hermes-agent (subtree)
┌────────────────────────┐   HTTP  ┌───────────────────────────┐  import  ┌───────────────────────┐
│ SettingsPanel          │◄──────► │ routes/auth.py     (NEW)  │──────►  │ agent.credential_pool │
│  ├─ HermesModelPanel  *│         │ routes/mcp.py      (NEW)  │──────►  │ hermes_cli.mcp_config │
│  ├─ HermesAuthPanel   *│         │ routes/skills.py   (NEW)  │──────►  │ hermes_cli.skills_*   │
│  ├─ McpServerPanel    *│         │ routes/models.py  (EXTEND)│──────►  │ hermes_cli.model_switch│
│  ├─ SkillsPanel       *│         │                           │  import  │ tools.skills_hub      │
│  └─ BackendSettings    │         │ services/auth_service.py  │──────►  │ tools.skills_tool     │
│                        │         │ services/mcp_service.py   │──────►  │ agent.codex_device_flow│
│ hooks/                 │         │ services/skills_service.py│          │   (NEW — hermes fork) │
│  useHermesConfig  (NEW)│         │ services/agent_service.py │          │ hermes_cli.config_lock│
└────────────────────────┘         └───────────────────────────┘          │   (NEW — hermes fork) │
                                                                          └───────────────────────┘
```

\* new UI panels gated by `backendEnabled`.

---

## WP1: Backend (FastAPI) — adapter layer over hermes

### WP1-A — `routes/models.py` 扩展 & `services/agent_service.py`

**Changes to `backend/app/routes/models.py`:**
```python
# EXTEND existing POST /api/models/current
class ModelSwitchRequest(BaseModel):
    model: str
    persist: bool = False          # NEW — default runtime-only
    provider: str | None = None    # NEW — pass --provider to hermes
    base_url: str | None = None    # NEW — optional override

@router.post("/api/models/current")
async def set_current_model(req: ModelSwitchRequest):
    result = agent_service.switch_model(
        req.model,
        persist=req.persist,
        provider=req.provider,
        base_url=req.base_url,
    )
    if not result.success:
        raise HTTPException(400, result.error_message)
    return {
        "model": result.new_model,
        "provider": result.target_provider,
        "base_url": result.base_url,
        "api_mode": result.api_mode,
        "persisted": req.persist,
        "warning": result.warning_message or None,
    }

# REPLACE hard-coded AVAILABLE_MODELS with dynamic lookup
@router.get("/api/models")
async def list_models():
    from hermes_cli.model_switch import list_authenticated_providers
    try:
        providers = list_authenticated_providers(
            current_provider=agent_service.get_current_provider(),
        )
    except Exception as exc:
        logger.warning("list_authenticated_providers failed: %s", exc)
        providers = []
    return {
        "providers": providers,                     # list of {slug,name,models,total_models,is_current}
        "current": agent_service.get_current_model(),
        "current_provider": agent_service.get_current_provider(),
    }
```

**Changes to `backend/app/services/agent_service.py`:**

> **DELTA-4 (Architect):** The v1 file had a `_api_key: Optional[str] = None` memory
> copy loaded from `config.yaml:api_key` by `init_from_hermes_config`. This
> is an implicit violation of Principle P1 ("Hermes 是唯一凭据存储") because
> the backend caches a credential that should live only in `credential_pool`.
> v1.1 MUST remove this cache and let hermes resolve credentials per-request
> via `agent.credential_pool.load_pool(provider).peek()` — which is what
> `AIAgent(api_key=None, base_url=None)` already does when both are falsy.
>
> Concretely: **delete `_api_key` and `_base_url` globals from agent_service,
> delete their loaders from `init_from_hermes_config`, and stop passing
> `api_key`/`base_url` to `AIAgent(...)`**. hermes will resolve from
> `credential_pool` + `~/.hermes/config.yaml:model.base_url` itself.

```python
# ── Global state (slimmed in v1.1) ────────────────────────────────────────────
_session_db: Optional[SessionDB] = None
_current_model: str = DEFAULT_MODEL
_current_provider: str = ""       # NEW in v1.1

# AIAgent is NOT thread-safe. Serialize all run_conversation calls via this lock.
_agent_lock = asyncio.Lock()

# NOTE (v1.1): _api_key / _base_url REMOVED — credential resolution is
# delegated entirely to hermes credential_pool via per-request lookups.

def get_current_model() -> str:
    return _current_model

def get_current_provider() -> str:
    return _current_provider

def get_session_db() -> SessionDB:
    """Eager-friendly SessionDB singleton — MUST be pre-warmed in main.lifespan
    AFTER workspace_service.init_from_hermes_config() to avoid any relative
    path fallback inside SessionDB initialization picking up a user-switched
    cwd."""
    global _session_db
    if _session_db is None:
        _session_db = SessionDB()
    return _session_db

def create_agent(session_id: str, **callbacks) -> AIAgent:
    """Create a new AIAgent per request. AIAgent resolves credentials from
    hermes credential_pool internally when api_key/base_url are not passed."""
    return AIAgent(
        model=_current_model,
        session_id=session_id,
        session_db=get_session_db(),
        platform="vonvon",
        quiet_mode=True,
        **callbacks,
    )

def switch_model(model: str, *, persist: bool = False,
                 provider: str | None = None,
                 base_url: str | None = None) -> "ModelSwitchResult":
    """Runtime switch (persist=False) or persisted switch (persist=True).

    Always routes through hermes_cli.model_switch.switch_model() so alias
    resolution, credential lookup, and capability metadata stay identical
    to the CLI.
    """
    from hermes_cli.model_switch import switch_model as hermes_switch_model

    # For the hermes pipeline we need "current" context — pull from
    # credential_pool.peek() so no stale state is injected.
    try:
        from agent.credential_pool import load_pool
        cur_cred = load_pool(_current_provider or "openai").peek() if _current_provider else None
    except Exception:
        cur_cred = None

    result = hermes_switch_model(
        raw_input=model,
        current_provider=_current_provider or "",
        current_model=_current_model,
        current_base_url=cur_cred.base_url if cur_cred else "",
        current_api_key=cur_cred.access_token if cur_cred else "",
        is_global=persist,
        explicit_provider=provider or "",
    )
    if not result.success:
        return result

    # Critic MF-6: ModelSwitchResult may return success=True with empty
    # target_provider / new_model in edge cases (alias resolved on current
    # provider, no change). NEVER overwrite with empty values — that would
    # drop DELTA-4's credential_pool provider key and break subsequent
    # AIAgent creation.
    global _current_model, _current_provider
    if result.new_model:
        _current_model = result.new_model
    if result.target_provider:
        _current_provider = result.target_provider

    if persist:
        from hermes_cli.config import load_config, save_config
        from hermes_cli.config_lock import config_store_lock
        with config_store_lock():
            cfg = load_config()
            cfg.setdefault("model", {})
            cfg["model"]["provider"] = result.target_provider
            cfg["model"]["name"] = result.new_model
            if base_url:
                cfg["model"]["base_url"] = base_url
            save_config(cfg)
    return result

def get_model_context_size() -> int:
    """Return the context window size for the current model (credentials
    resolved via credential_pool, not cached globals)."""
    from agent.model_metadata import get_model_context_length
    try:
        from agent.credential_pool import load_pool
        cur_cred = load_pool(_current_provider or "openai").peek() if _current_provider else None
    except Exception:
        cur_cred = None
    return get_model_context_length(
        _current_model,
        base_url=cur_cred.base_url if cur_cred else "",
        api_key=cur_cred.access_token if cur_cred else "",
    )

def init_from_hermes_config() -> None:
    """Read model/provider from ~/.hermes/config.yaml on startup.

    DELTA-4: no longer reads or caches api_key or base_url — credential
    resolution is delegated to hermes credential_pool per request.
    """
    global _current_model, _current_provider
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
        model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else None
        model = (model_cfg or {}).get("name") or cfg.get("model") if isinstance(cfg.get("model"), str) else None
        if isinstance(model, str):
            _current_model = model
        provider = (model_cfg or {}).get("provider")
        if isinstance(provider, str):
            _current_provider = provider
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Failed to load hermes config: %s", exc)
```

### WP1-B — `routes/auth.py` + `services/auth_service.py` + hermes fork for codex device flow

**Hermes twoway-dev: split `_codex_device_code_login`**
Add `backend/hermes-agent/agent/codex_device_flow.py` (new module):
```python
"""Pure-function Codex device flow — start/poll split for non-blocking UI use."""
from __future__ import annotations
import os
from datetime import datetime, timezone
from typing import Any, Dict

import httpx
from hermes_cli.auth import (           # reuse existing constants
    CODEX_OAUTH_CLIENT_ID,
    CODEX_OAUTH_TOKEN_URL,
    DEFAULT_CODEX_BASE_URL,
    AuthError,
)

ISSUER = "https://auth.openai.com"
POLL_ENDPOINT = f"{ISSUER}/api/accounts/deviceauth/token"
USERCODE_ENDPOINT = f"{ISSUER}/api/accounts/deviceauth/usercode"
VERIFICATION_URL = f"{ISSUER}/codex/device"

def start_device_flow() -> Dict[str, Any]:
    """POST /usercode and return {device_auth_id, user_code, verification_url, interval}.
    Non-blocking: single HTTP call, <15s."""
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        resp = client.post(USERCODE_ENDPOINT, json={"client_id": CODEX_OAUTH_CLIENT_ID},
                           headers={"Content-Type": "application/json"})
    if resp.status_code != 200:
        raise AuthError(f"Device code request status {resp.status_code}",
                        provider="openai-codex", code="device_code_request_error")
    data = resp.json()
    return {
        "device_auth_id": data["device_auth_id"],
        "user_code": data["user_code"],
        "verification_url": VERIFICATION_URL,
        "interval": max(3, int(data.get("interval", 5))),
    }

def poll_device_flow(device_auth_id: str, user_code: str,
                     pending_exchange: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Single poll. Returns {status: 'pending'|'success'|'error', ...}.

    Critic MF-5: if token exchange returns a 5xx, return
    `{status: "pending", pending_exchange: {authorization_code, code_verifier}}`
    so the next poll can retry the exchange without restarting the flow.
    Callers (auth_service) MUST carry `pending_exchange` back into the
    next poll call via OAuthFlowState.
    """
    # Fast path: retrying a prior token exchange
    if pending_exchange:
        tokens_out = _try_token_exchange(
            pending_exchange["authorization_code"],
            pending_exchange["code_verifier"],
        )
        return tokens_out  # {status: 'success'|'pending'|'error', ...}

    # Normal path: poll device endpoint first
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        resp = client.post(POLL_ENDPOINT,
                           json={"device_auth_id": device_auth_id, "user_code": user_code},
                           headers={"Content-Type": "application/json"})
    if resp.status_code in (403, 404):
        return {"status": "pending"}
    if resp.status_code >= 500:
        # Device endpoint 5xx — transient; keep polling
        return {"status": "pending"}
    if resp.status_code != 200:
        return {"status": "error", "error": f"poll_status_{resp.status_code}"}

    code_resp = resp.json()
    auth_code = code_resp.get("authorization_code", "")
    verifier = code_resp.get("code_verifier", "")
    if not auth_code or not verifier:
        return {"status": "error", "error": "device_code_incomplete_exchange"}

    return _try_token_exchange(auth_code, verifier)


def _try_token_exchange(authorization_code: str, code_verifier: str) -> Dict[str, Any]:
    """Exchange authorization_code for tokens. On 5xx return pending
    with the exchange params so the caller can retry next poll."""
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        tok_resp = client.post(
            CODEX_OAUTH_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": f"{ISSUER}/deviceauth/callback",
                "client_id": CODEX_OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if tok_resp.status_code >= 500:
        return {
            "status": "pending",
            "pending_exchange": {
                "authorization_code": authorization_code,
                "code_verifier": code_verifier,
            },
        }
    if tok_resp.status_code != 200:
        return {"status": "error", "error": f"token_exchange_status_{tok_resp.status_code}"}
    tokens = tok_resp.json()
    if not tokens.get("access_token"):
        return {"status": "error", "error": "token_exchange_no_access_token"}
    base_url = (os.getenv("HERMES_CODEX_BASE_URL", "").strip().rstrip("/")
                or DEFAULT_CODEX_BASE_URL)
    return {
        "status": "success",
        "tokens": {
            "access_token": tokens["access_token"],
            "refresh_token": tokens.get("refresh_token", ""),
        },
        "base_url": base_url,
        "last_refresh": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "auth_mode": "chatgpt",
        "source": "device-code",
    }
```

Then refactor `backend/hermes-agent/hermes_cli/auth.py:_codex_device_code_login` (lines 2714-2856) to be a thin CLI shim that prints and sleeps:
```python
def _codex_device_code_login() -> Dict[str, Any]:
    from agent.codex_device_flow import start_device_flow, poll_device_flow
    import time as _time
    flow = start_device_flow()
    print(f"\nOpen {flow['verification_url']} and enter code: {flow['user_code']}\n")
    start = _time.monotonic()
    while _time.monotonic() - start < 15 * 60:
        _time.sleep(flow["interval"])
        result = poll_device_flow(flow["device_auth_id"], flow["user_code"])
        if result["status"] == "success":
            return {"tokens": result["tokens"], "base_url": result["base_url"],
                    "last_refresh": result["last_refresh"],
                    "auth_mode": "chatgpt", "source": "device-code"}
        if result["status"] == "error":
            raise AuthError(result["error"], provider="openai-codex",
                            code="device_code_error")
    raise AuthError("Login timed out after 15 minutes",
                    provider="openai-codex", code="device_code_timeout")
```
This keeps the CLI behavior byte-for-byte identical while exposing pure functions the backend can call.

**New `backend/app/routes/auth.py`:**
```python
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from app.services import auth_service

router = APIRouter()

class CredentialCreateRequest(BaseModel):
    provider: str = Field(..., description="openai, anthropic, openrouter, nous, custom, custom:<name>")
    auth_type: str = Field("api_key", pattern="^(api_key|oauth)$")
    api_key: str | None = None     # for api_key
    label: str | None = None
    base_url: str | None = None

class CredentialView(BaseModel):
    id: str
    provider: str
    label: str
    auth_type: str
    last4: str
    source: str
    status: str | None = None      # exhausted/ok
    is_current: bool

class OAuthStartResponse(BaseModel):
    flow_id: str
    provider: str
    user_code: str
    verification_url: str
    interval: int
    expires_in_seconds: int        # always 900

class OAuthPollResponse(BaseModel):
    status: str                    # pending | success | error | timeout
    credential: CredentialView | None = None
    error: str | None = None

@router.get("/api/auth/credentials")
async def list_credentials() -> list[CredentialView]:
    return auth_service.list_all_credentials()

@router.post("/api/auth/credentials")
async def add_credential(req: CredentialCreateRequest) -> CredentialView:
    if req.auth_type != "api_key":
        raise HTTPException(400, "Use /api/auth/oauth/start for OAuth")
    if not req.api_key:
        raise HTTPException(400, "api_key is required for api_key auth")
    try:
        return auth_service.add_api_key_credential(
            provider=req.provider, api_key=req.api_key,
            label=req.label, base_url=req.base_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

@router.delete("/api/auth/credentials/{provider}/{cred_id}")
async def remove_credential(provider: str, cred_id: str) -> dict:
    removed = auth_service.remove_credential(provider, cred_id)
    if not removed:
        raise HTTPException(404, f"no credential {cred_id} for provider {provider}")
    return {"removed": True}

@router.post("/api/auth/oauth/start")
async def oauth_start(provider: str) -> OAuthStartResponse:
    if provider != "openai-codex":
        raise HTTPException(400, "v1.1 only supports openai-codex OAuth")
    return auth_service.start_codex_oauth_flow()

@router.get("/api/auth/oauth/poll")
async def oauth_poll(flow_id: str) -> OAuthPollResponse:
    return auth_service.poll_codex_oauth_flow(flow_id)

@router.delete("/api/auth/oauth/flows/{flow_id}")
async def oauth_cancel(flow_id: str) -> dict:
    auth_service.cancel_codex_oauth_flow(flow_id)
    return {"cancelled": True}
```

**`backend/app/services/auth_service.py` (new):**
```python
"""Thin adapter over hermes credential_pool + codex_device_flow.

Stateless except for _active_flows which holds in-flight OAuth sessions
(expired after 15 minutes via asyncio Task)."""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

from agent.credential_pool import (
    AUTH_TYPE_API_KEY,
    AUTH_TYPE_OAUTH,
    PooledCredential,
    SOURCE_MANUAL,
    load_pool,
    label_from_token,
)
from agent.codex_device_flow import start_device_flow, poll_device_flow
from hermes_cli.auth import PROVIDER_REGISTRY

logger = logging.getLogger(__name__)

FLOW_TTL_SECONDS = 15 * 60
MAX_CONCURRENT_FLOWS = 8

@dataclass
class OAuthFlowState:
    flow_id: str
    provider: str
    device_auth_id: str
    user_code: str
    verification_url: str
    interval: int
    started_at: float = field(default_factory=time.time)
    status: str = "pending"
    error: Optional[str] = None
    credential_view: Optional[dict] = None
    # Critic MF-5: carry authorization_code + code_verifier across polls
    # so that a transient 5xx on /oauth/token can be retried on the next
    # poll without restarting the device-code flow.
    pending_exchange: Optional[Dict[str, str]] = None

_active_flows: Dict[str, OAuthFlowState] = {}
_flows_lock = asyncio.Lock()

def _mask(token: str) -> str:
    return f"…{token[-4:]}" if token and len(token) >= 4 else "…"

def _to_view(provider: str, entry: PooledCredential, *, is_current: bool) -> dict:
    return {
        "id": entry.id,
        "provider": provider,
        "label": entry.label,
        "auth_type": entry.auth_type,
        "last4": _mask(entry.access_token or ""),
        "source": entry.source,
        "status": entry.last_status,
        "is_current": is_current,
    }

def list_all_credentials() -> list[dict]:
    providers = sorted({*PROVIDER_REGISTRY.keys(), "openrouter"})
    out: list[dict] = []
    for provider in providers:
        pool = load_pool(provider)
        entries = pool.entries()
        if not entries:
            continue
        current = pool.peek()
        for entry in entries:
            is_current = current is not None and entry.id == current.id
            out.append(_to_view(provider, entry, is_current=is_current))
    return out

def add_api_key_credential(*, provider: str, api_key: str,
                           label: Optional[str] = None,
                           base_url: Optional[str] = None) -> dict:
    provider = provider.strip().lower()
    pool = load_pool(provider)
    label = (label or "").strip() or f"api-key-{len(pool.entries()) + 1}"
    entry = PooledCredential(
        provider=provider,
        id=uuid.uuid4().hex[:6],
        label=label,
        auth_type=AUTH_TYPE_API_KEY,
        priority=0,
        source=SOURCE_MANUAL,
        access_token=api_key,
        base_url=base_url or "",
    )
    pool.add_entry(entry)   # hermes handles file locking internally via _auth_store_lock
    logger.info("credential_added provider=%s label=%s last4=%s",
                provider, label, _mask(api_key))
    return _to_view(provider, entry, is_current=False)

def remove_credential(provider: str, cred_id: str) -> bool:
    pool = load_pool(provider)
    index, matched, _ = pool.resolve_target(cred_id)
    if matched is None or index is None:
        return False
    removed = pool.remove_index(index)
    logger.info("credential_removed provider=%s id=%s", provider, cred_id)
    return removed is not None

async def start_codex_oauth_flow() -> dict:
    async with _flows_lock:
        # Purge expired flows
        now = time.time()
        expired = [fid for fid, f in _active_flows.items()
                   if now - f.started_at > FLOW_TTL_SECONDS]
        for fid in expired:
            _active_flows.pop(fid, None)
        if len(_active_flows) >= MAX_CONCURRENT_FLOWS:
            raise ValueError("too many concurrent OAuth flows; try again later")
        flow = await asyncio.to_thread(start_device_flow)
        fid = uuid.uuid4().hex
        state = OAuthFlowState(
            flow_id=fid, provider="openai-codex",
            device_auth_id=flow["device_auth_id"],
            user_code=flow["user_code"],
            verification_url=flow["verification_url"],
            interval=flow["interval"],
        )
        _active_flows[fid] = state
        logger.info("oauth_flow_started flow_id=%s provider=openai-codex", fid)
        return {
            "flow_id": fid,
            "provider": "openai-codex",
            "user_code": flow["user_code"],
            "verification_url": flow["verification_url"],
            "interval": flow["interval"],
            "expires_in_seconds": FLOW_TTL_SECONDS,
        }

async def poll_codex_oauth_flow(flow_id: str) -> dict:
    # Architect iter-2: avoid concurrent double-poll race where two clients
    # simultaneously read the same pending_exchange and both POST to the
    # token endpoint (the second one gets 400 because authorization_code is
    # single-use). Gate each flow to at most one in-flight poll via a
    # transient "polling" status held under _flows_lock.
    async with _flows_lock:
        state = _active_flows.get(flow_id)
        if state is None:
            return {"status": "error", "error": "unknown_or_expired_flow"}
        if time.time() - state.started_at > FLOW_TTL_SECONDS:
            _active_flows.pop(flow_id, None)
            return {"status": "timeout"}
        if state.status in ("success", "error", "timeout"):
            return {"status": state.status,
                    "credential": state.credential_view,
                    "error": state.error}
        if state.status == "polling":
            # Another request is already polling this flow — return pending
            # without making a duplicate OpenAI request.
            return {"status": "pending"}
        state.status = "polling"
        # Snapshot the fields we need under the lock so to_thread has
        # stable copies, then release the lock.
        device_auth_id = state.device_auth_id
        user_code = state.user_code
        pending_exchange = dict(state.pending_exchange) if state.pending_exchange else None

    try:
        result = await asyncio.to_thread(
            poll_device_flow, device_auth_id, user_code, pending_exchange)
    except Exception as exc:
        async with _flows_lock:
            state.status = "error"
            state.error = f"poll_exception: {exc}"
        return {"status": "error", "error": state.error}

    # Re-acquire lock to mutate state based on result
    async with _flows_lock:
        if result["status"] == "pending":
            pe = result.get("pending_exchange")
            if pe:
                state.pending_exchange = pe
            state.status = "pending"
            return {"status": "pending"}
        if result["status"] == "error":
            state.status = "error"
            state.error = result.get("error")
            logger.info("oauth_flow_error flow_id=%s error=%s",
                        flow_id, state.error)
            return {"status": "error", "error": state.error}
        # Success path — do credential_pool write outside of _flows_lock
        # to avoid holding it during fcntl, but mark state transitionally.
        state.status = "finalizing"

    # pool.add_entry grabs its own _auth_store_lock via to_thread
    def _persist_codex_credential() -> Dict[str, Any]:
        pool = load_pool("openai-codex")
        label = label_from_token(
            result["tokens"]["access_token"],
            f"openai-codex-oauth-{len(pool.entries()) + 1}",
        )
        entry = PooledCredential(
            provider="openai-codex",
            id=uuid.uuid4().hex[:6],
            label=label,
            auth_type=AUTH_TYPE_OAUTH,
            priority=0,
            source=f"{SOURCE_MANUAL}:device_code",
            access_token=result["tokens"]["access_token"],
            refresh_token=result["tokens"].get("refresh_token"),
            base_url=result.get("base_url"),
            last_refresh=result.get("last_refresh"),
        )
        pool.add_entry(entry)
        return _to_view("openai-codex", entry, is_current=False)

    try:
        view = await asyncio.to_thread(_persist_codex_credential)
    except Exception as exc:
        async with _flows_lock:
            state.status = "error"
            state.error = f"credential_persist_failed: {exc}"
        return {"status": "error", "error": state.error}

    async with _flows_lock:
        state.status = "success"
        state.credential_view = view
    logger.info("oauth_flow_success flow_id=%s", flow_id)
    return {"status": "success", "credential": view}

async def cancel_codex_oauth_flow(flow_id: str) -> None:
    async with _flows_lock:
        _active_flows.pop(flow_id, None)
```

### WP1-C — `routes/mcp.py` + `services/mcp_service.py` + `config_lock` hermes fork

**Hermes twoway-dev: add `config_lock.py` to `hermes_cli/`** (mirror of `auth.py:_auth_store_lock`):
```python
# backend/hermes-agent/hermes_cli/config_lock.py  (NEW)
"""Cross-process file lock for ~/.hermes/config.yaml read/modify/write.

Mirrors auth.py:_auth_store_lock to prevent concurrent CLI + UI writes
from corrupting yaml. Uses fcntl on POSIX, msvcrt on Windows.

Critic Minor-2: re-entrancy uses contextvars.ContextVar instead of
threading.local because vonvon-backend runs many service calls inside
asyncio.to_thread workers — each worker is a different OS thread, so
threading.local would not recognize the re-entrant context. ContextVar
is carried across to_thread and within the asyncio task tree.
"""
from __future__ import annotations
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
try:
    import fcntl
except ImportError:
    fcntl = None
try:
    import msvcrt
except ImportError:
    msvcrt = None
from hermes_cli.config import get_config_path

CONFIG_LOCK_TIMEOUT = 10.0
_lock_depth: ContextVar[int] = ContextVar("_config_lock_depth", default=0)

def _lock_path() -> Path:
    return get_config_path().with_suffix(".yaml.lock")

@contextmanager
def config_store_lock(timeout_seconds: float = CONFIG_LOCK_TIMEOUT):
    # Reentrant via ContextVar (survives asyncio.to_thread boundaries
    # because Python copies the context into the worker)
    current = _lock_depth.get()
    if current > 0:
        token = _lock_depth.set(current + 1)
        try:
            yield
        finally:
            _lock_depth.reset(token)
        return

    lock_path = _lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if fcntl is None and msvcrt is None:
        token = _lock_depth.set(1)
        try:
            yield
        finally:
            _lock_depth.reset(token)
        return

    if msvcrt and (not lock_path.exists() or lock_path.stat().st_size == 0):
        lock_path.write_text(" ", encoding="utf-8")

    with lock_path.open("r+" if msvcrt else "a+") as lock_file:
        deadline = time.time() + max(1.0, timeout_seconds)
        while True:
            try:
                if fcntl:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except (BlockingIOError, OSError, PermissionError):
                if time.time() >= deadline:
                    raise TimeoutError("Timed out waiting for config store lock")
                time.sleep(0.05)
        token = _lock_depth.set(1)
        try:
            yield
        finally:
            _lock_depth.reset(token)
            if fcntl:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            elif msvcrt:
                try:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                except (OSError, IOError):
                    pass
```

Then **every** `save_config(...)` call site in hermes that the backend path touches (directly or transitively) MUST be wrapped with `with config_store_lock(): cfg = load_config(); ...; save_config(cfg)`. Architect DELTA-3 upgrades this from "best-effort" to **mandatory**, because `fcntl.flock` is an advisory lock — if only one side takes it, the other side's write still races. The lock must be taken on **both** CLI and UI write paths for it to protect anything.

Concrete patch list (hermes fork, WP1-C-fork extended):
- `backend/hermes-agent/hermes_cli/mcp_config.py`
  - `_save_mcp_server` — wrap its `load_config` + `save_config` RMW
  - `_remove_mcp_server` — wrap its `load_config` + `save_config` RMW
  - `cmd_mcp_configure` — wrap the `load_config` + `save_config` RMW at the end of the function (line 589-602 region)
- `backend/hermes-agent/hermes_cli/skills_config.py`
  - `save_disabled_skills` — wrap the `save_config(config)` call; also make the function do a re-read-then-write so that concurrent CLI `hermes skills` toggles don't overwrite each other
- `backend/hermes-agent/hermes_cli/auth.py:_interactive_strategy` (lines ~512-520) which also writes `config.yaml:credential_pool_strategies` — wrap RMW
- Any call site that both reads and writes `config.yaml` as a single logical update

Each wrap is ~3 lines (`with config_store_lock():` + 2-line indent). File change summary: `hermes_cli/mcp_config.py` +8 lines, `skills_config.py` +6 lines, `auth.py` +3 lines (auth.py now becomes "MODIFY" not just for codex — include in WP1-B-fork).

**Not patched (out of WP1.1 scope, but documented in `HERMES-FORK-NOTES.md`):** `hermes_cli/commands.py` and other rarely-touched config writers. The backend never triggers them, so they stay as-is — the inconsistency is acceptable because they don't collide with UI actions. Future upstream PR to cover all writers.

**New `backend/app/routes/mcp.py`:**
```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from app.services import mcp_service

router = APIRouter()

class McpServerConfig(BaseModel):
    name: str = Field(..., pattern=r"^[a-zA-Z0-9_-]{1,32}$")
    url: Optional[str] = None             # HTTP transport
    command: Optional[str] = None         # stdio transport
    args: Optional[List[str]] = None
    headers: Optional[Dict[str, str]] = None
    env: Optional[Dict[str, str]] = None
    enabled: bool = True

class McpServerView(McpServerConfig):
    tools_count: Optional[int] = None     # from last probe
    last_probed_at: Optional[float] = None
    last_error: Optional[str] = None

class McpProbeResult(BaseModel):
    ok: bool
    latency_ms: int
    tools: list[dict]                     # [{name, description}]
    error: Optional[str] = None

@router.get("/api/mcp/servers")
async def list_servers() -> list[McpServerView]:
    return mcp_service.list_servers()

@router.post("/api/mcp/servers")
async def add_server(cfg: McpServerConfig, probe: bool = True) -> McpServerView:
    try:
        return mcp_service.add_server(cfg.model_dump(), probe=probe)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

@router.delete("/api/mcp/servers/{name}")
async def remove_server(name: str) -> dict:
    if not mcp_service.remove_server(name):
        raise HTTPException(404, f"no mcp server named {name}")
    return {"removed": True}

@router.post("/api/mcp/servers/{name}/test")
async def test_server(name: str) -> McpProbeResult:
    return mcp_service.probe_server(name)
```

**`backend/app/services/mcp_service.py` (new):**

> **Concurrency note (Architect DELTA-2):** `hermes_cli/mcp_config._probe_single_server`
> calls `_ensure_mcp_loop()` at entry and `_stop_mcp_loop()` in `finally`. The
> MCP loop is a **process-wide singleton** (`tools/mcp_tool.py:1125/2168`).
> Two concurrent probes will tear each other's loop down mid-flight. We MUST
> serialize all probe operations through a module-level `asyncio.Lock` AND
> marshal the actual probe via `asyncio.to_thread` so the sync fcntl wait
> doesn't block the event loop. The lock MUST cover both `probe_server()`
> and the probe step inside `add_server(..., probe=True)`.

```python
"""Adapter over hermes_cli.mcp_config — all writes are config-locked,
all probes are serialized through a module-level asyncio.Lock."""
import asyncio
import logging
import time
from typing import Any, Dict, List

from hermes_cli.mcp_config import (
    _get_mcp_servers, _probe_single_server, _save_mcp_server,
    _remove_mcp_server,
)
from hermes_cli.config_lock import config_store_lock  # WP1-C-fork

logger = logging.getLogger(__name__)

# DELTA-2 + Critic MF-4: prevents concurrent _probe_single_server calls
# from tearing down the shared MCP loop singleton. This is a module-level
# lock so ALL probe operations serialize — the tradeoff is that adding 3
# MCP servers with probe=True is now a sequential wait (10-30s × N), not
# parallel. UX mitigation: probe uses a 10s connect timeout (not the
# hermes default 30s), and UI disables the "add server" button while a
# probe is running with copy "连接测试中…".
_probe_lock = asyncio.Lock()
_PROBE_TIMEOUT_SECONDS = 10.0   # < hermes default 30s; capped for UI responsiveness

def _sanitize(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in cfg.items() if v is not None}

def list_servers() -> List[Dict[str, Any]]:
    servers = _get_mcp_servers()
    return [{"name": name, **cfg} for name, cfg in servers.items()]

async def add_server(cfg: Dict[str, Any], *, probe: bool) -> Dict[str, Any]:
    name = cfg.pop("name")
    if not cfg.get("url") and not cfg.get("command"):
        raise ValueError("url or command is required")
    clean = _sanitize(cfg)

    if probe:
        try:
            async with _probe_lock:
                tools = await asyncio.to_thread(_probe_single_server, name, clean)
            clean["enabled"] = True
            probed_info = {"tools_count": len(tools),
                           "last_probed_at": time.time()}
        except Exception as exc:
            logger.info("mcp_probe_failed name=%s err=%s", name, exc)
            clean["enabled"] = False
            probed_info = {"last_probed_at": time.time(),
                           "last_error": str(exc)}
    else:
        clean["enabled"] = True
        probed_info = {}

    # _save_mcp_server does its own load/save; we add an outer lock for
    # cross-process safety (WP1-C-fork config_store_lock).
    await asyncio.to_thread(_save_locked, name, clean)
    logger.info("mcp_server_added name=%s probe=%s", name, probe)
    return {"name": name, **clean, **probed_info}

def _save_locked(name: str, clean: Dict[str, Any]) -> None:
    with config_store_lock():
        _save_mcp_server(name, clean)

def _remove_locked(name: str) -> bool:
    with config_store_lock():
        return _remove_mcp_server(name)

async def remove_server(name: str) -> bool:
    return await asyncio.to_thread(_remove_locked, name)

async def probe_server(name: str) -> Dict[str, Any]:
    servers = _get_mcp_servers()
    cfg = servers.get(name)
    if cfg is None:
        return {"ok": False, "latency_ms": 0, "tools": [],
                "error": f"server {name} not found"}
    start = time.monotonic()
    try:
        async with _probe_lock:
            tools = await asyncio.to_thread(_probe_single_server, name, cfg)
        return {
            "ok": True,
            "latency_ms": int((time.monotonic() - start) * 1000),
            "tools": [{"name": t[0], "description": t[1]} for t in tools],
        }
    except Exception as exc:
        return {"ok": False,
                "latency_ms": int((time.monotonic() - start) * 1000),
                "tools": [], "error": str(exc)}
```

Corresponding changes to `routes/mcp.py` handler bodies — add `await` for `add_server`, `remove_server`, `probe_server`:
```python
@router.post("/api/mcp/servers")
async def add_server(cfg: McpServerConfig, probe: bool = True) -> McpServerView:
    try:
        return await mcp_service.add_server(cfg.model_dump(), probe=probe)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

@router.delete("/api/mcp/servers/{name}")
async def remove_server(name: str) -> dict:
    if not await mcp_service.remove_server(name):
        raise HTTPException(404, f"no mcp server named {name}")
    return {"removed": True}

@router.post("/api/mcp/servers/{name}/test")
async def test_server(name: str) -> McpProbeResult:
    return await mcp_service.probe_server(name)
```

### WP1-D — `routes/skills.py` + `services/skills_service.py` + hermes platform fork

**Hermes twoway-dev: register `vonvon` as a skills platform**
Tiny patch to `backend/hermes-agent/hermes_cli/skills_config.py` (add one entry):
```python
PLATFORMS = {
    "cli":      "🖥️  CLI",
    ...
    "vonvon":   "🪄 vonvon",       # NEW — so skill toggles scope to the vonvon UI
}
```
All `get_disabled_skills`/`save_disabled_skills` semantics reused unchanged.

**Hermes twoway-dev: `install_bundle_silent` headless install helper (WP1-D-fork-2)**

Critic review (2026-04-09) **verified** the real signatures in the hermes subtree and **rejected** the earlier Architect draft because it mismatched 5 APIs. The corrected, compilable version below follows the exact signatures of `tools/skills_hub.py` + `tools/skills_guard.py` + `hermes_cli/skills_hub.py`:

| Helper | Real location | Real signature |
|---|---|---|
| `quarantine_bundle` | `tools/skills_hub.py:2480` | `(bundle: SkillBundle) -> Path` — 1 arg only |
| `scan_skill` | `tools/skills_guard.py:595` | `(skill_path: Path, source: str = "community") -> ScanResult` |
| `should_allow_install` | `tools/skills_guard.py:642` | `(result: ScanResult, force: bool = False) -> Tuple[bool, str]` — **no `assume_yes`** |
| `install_from_quarantine` | `tools/skills_hub.py:2505` | `(quarantine_path, skill_name, category, bundle, scan_result) -> Path` |
| `HubLockFile` | `tools/skills_hub.py:2332` | **Regular class**, NOT context manager — call `lock.get_installed(name)` / `lock.record_install(...)` directly |
| `_resolve_source_meta_and_bundle` | `hermes_cli/skills_hub.py:108` | `(identifier, sources) -> (meta, bundle, matched_source)` — meta is `SkillMeta`, bundle is `SkillBundle` |
| `clear_skills_system_prompt_cache` | `agent/prompt_builder.py:373` | `(*, clear_snapshot: bool = False) -> None` |

Add to `backend/hermes-agent/tools/skills_hub.py`:
```python
def install_bundle_silent(
    identifier: str,
    *,
    force: bool = False,
) -> Dict[str, Any]:
    """Headless install for one skill identifier.

    Mirrors the non-prompt code path of hermes_cli.skills_hub.do_install
    without Rich Console or input() prompts. `force=True` bypasses both
    the "already installed" check and the scan verdict (should_allow_install).

    Returns installed skill metadata dict on success.
    Raises RuntimeError with diagnostic message on any failure.
    """
    import shutil
    from hermes_cli.skills_hub import _resolve_source_meta_and_bundle
    from tools.skills_hub import (
        GitHubAuth, create_source_router, ensure_hub_dirs,
        quarantine_bundle, install_from_quarantine,
        HubLockFile, append_audit_log,
    )
    from tools.skills_guard import scan_skill, should_allow_install

    ensure_hub_dirs()
    auth = GitHubAuth()
    sources = create_source_router(auth)
    meta, bundle, _matched = _resolve_source_meta_and_bundle(identifier, sources)
    if bundle is None:
        raise RuntimeError(f"skill '{identifier}' not found or fetch failed")

    # Lock file pre-check (mirrors do_install behavior)
    lock = HubLockFile()
    if lock.get_installed(bundle.name) and not force:
        raise RuntimeError(f"skill '{bundle.name}' is already installed "
                           f"(use force=True to reinstall)")

    # Category extraction from identifier (mirrors do_install)
    category = ""
    if bundle.source == "official":
        parts = (bundle.identifier or "").split("/")
        if len(parts) >= 3:
            category = parts[1]

    # Critic M-2 + Architect iter-2: guard against pathological bundle sizes
    # before quarantine writes files to disk. SkillBundle.files is
    # dict[str, str|bytes]. MUST count UTF-8 bytes for str content so CJK/
    # emoji are not under-counted 3-4x.
    MAX_BUNDLE_BYTES = 50 * 1024 * 1024  # 50 MB
    total_bytes = 0
    for _rel, content in bundle.files.items():
        if isinstance(content, bytes):
            total_bytes += len(content)
        elif isinstance(content, str):
            total_bytes += len(content.encode("utf-8"))
    if total_bytes > MAX_BUNDLE_BYTES:
        raise RuntimeError(
            f"skill bundle too large ({total_bytes // (1024*1024)} MB > 50 MB); "
            f"install blocked to prevent sandbox disk exhaustion")

    quarantine_path = None
    try:
        # 1 arg signature
        quarantine_path = quarantine_bundle(bundle)
        # scan_skill lives in tools.skills_guard
        scan_source = bundle.identifier or identifier
        scan_result = scan_skill(quarantine_path, source=scan_source)
        # should_allow_install has no assume_yes kwarg
        allowed, reason = should_allow_install(scan_result, force=force)
        if not allowed:
            append_audit_log(
                "BLOCKED", bundle.name, bundle.source,
                bundle.trust_level, scan_result.verdict, reason,
            )
            raise RuntimeError(f"install blocked by scan policy: {reason}")

        # Install (NO `with` — HubLockFile is not a context manager;
        # install_from_quarantine calls lock.record_install internally
        # at line ~2548, so we don't need to manually record_install here.)
        installed_path = install_from_quarantine(
            quarantine_path, bundle.name, category, bundle, scan_result,
        )
        append_audit_log(
            "INSTALL", bundle.name, bundle.source,
            bundle.trust_level, scan_result.verdict,
        )
    except Exception:
        # Clean up quarantine on any failure
        if quarantine_path is not None and quarantine_path.exists():
            shutil.rmtree(quarantine_path, ignore_errors=True)
        raise

    # CF-2: invalidate cached system prompt so the newly installed skill
    # becomes visible to the next user turn without restarting the backend.
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception as exc:
        # Non-fatal — worst case: user must reset the session to see new skill
        import logging
        logging.getLogger(__name__).warning(
            "install_bundle_silent: clear_skills_system_prompt_cache failed: %s", exc)

    return {
        "name": bundle.name,
        "category": category,
        "description": getattr(meta, "description", "") or "",
        "install_path": str(installed_path),
        "source": bundle.source,
        "trust_level": bundle.trust_level,
        "identifier": bundle.identifier,
    }
```

**Pre-implementation gate (must pass before executor starts WP1-D-fork-2):**
```bash
# Signature verification — MUST all succeed, else STOP and escalate:
python - <<'PY'
import inspect
from tools.skills_hub import quarantine_bundle, install_from_quarantine, HubLockFile, ensure_hub_dirs, append_audit_log
from tools.skills_guard import scan_skill, should_allow_install
from hermes_cli.skills_hub import _resolve_source_meta_and_bundle
from agent.prompt_builder import clear_skills_system_prompt_cache

assert list(inspect.signature(quarantine_bundle).parameters) == ["bundle"]
assert "skill_path" in inspect.signature(scan_skill).parameters
assert "source" in inspect.signature(scan_skill).parameters
p = inspect.signature(should_allow_install).parameters
assert "result" in p and "force" in p and "assume_yes" not in p
p = inspect.signature(install_from_quarantine).parameters
assert list(p) == ["quarantine_path", "skill_name", "category", "bundle", "scan_result"]
assert not hasattr(HubLockFile, "__enter__"), "HubLockFile is NOT a context manager"
print("OK — all WP1-D-fork-2 signatures verified")
PY
```

**Uninstall path (DELTA CF-2 extended):** `skills_service._do_uninstall` must also call `clear_skills_system_prompt_cache(clear_snapshot=True)` after `uninstall_skill(name)` returns success. Update `_do_uninstall`:
```python
def _do_uninstall(name: str) -> Dict[str, Any]:
    from tools.skills_hub import uninstall_skill
    ok, msg = uninstall_skill(name)
    if not ok:
        raise RuntimeError(msg or f"uninstall failed for {name}")
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(
            "_do_uninstall: clear_skills_system_prompt_cache failed: %s", exc)
    return {"name": name, "install_path": "", "description": ""}
```

**Toggle path (DELTA CF-2 extended for toggle_skill):** `skills_service.toggle_skill` must invalidate the prompt cache whenever a skill's enabled state changes — disabling a skill without cache invalidation leaves the agent still able to call it this turn.

**Critical ordering (Architect iter-2):** the cache clear MUST happen **inside** the `config_store_lock` block, after `save_disabled_skills` returns but before the lock releases. Otherwise a concurrent request could read the stale cache between lock release and cache clear. Updated `_toggle_skill_sync`:
```python
def _toggle_skill_sync(name: str, enabled: bool, scope: str) -> Dict[str, Any]:
    if scope not in ("global", "vonvon"):
        raise ValueError("scope must be global or vonvon")
    platform = None if scope == "global" else "vonvon"
    with config_store_lock():
        config = load_config()
        disabled = set(get_disabled_skills(config, platform=platform))
        if enabled:
            disabled.discard(name)
        else:
            disabled.add(name)
        save_disabled_skills(config, disabled, platform=platform)
        # Inside the lock: clear cache before releasing so no concurrent
        # build_system_prompt observes "new config + old cache".
        try:
            from agent.prompt_builder import clear_skills_system_prompt_cache
            clear_skills_system_prompt_cache(clear_snapshot=True)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                "_toggle_skill_sync: clear_skills_system_prompt_cache failed: %s", exc)

    # ... (return updated view)
```

**New `backend/app/routes/skills.py`:**
```python
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from typing import Optional
from app.services import skills_service

router = APIRouter()

class SkillView(BaseModel):
    name: str
    category: Optional[str] = None
    description: str = ""
    install_path: str = ""
    version: Optional[str] = None
    source: Optional[str] = None       # "builtin" / "user" / "hub"
    enabled_global: bool = True        # not in skills.disabled
    enabled_vonvon: bool = True        # not in skills.platform_disabled.vonvon

class SkillToggleRequest(BaseModel):
    name: str
    enabled: bool
    scope: str = Field("vonvon", pattern="^(vonvon|global)$")

class SkillSearchResult(BaseModel):
    identifier: str                    # full hub identifier, e.g. "official/pptx"
    name: str
    description: str
    source: str                        # official / community / trusted
    trust_level: str

class SkillInstallStartRequest(BaseModel):
    identifier: str                    # full identifier from search result

class SkillJobStatus(BaseModel):
    job_id: str
    kind: str                          # "install" | "uninstall" | "update"
    identifier: str
    status: str                        # pending | running | success | error
    error: Optional[str] = None
    skill: Optional[SkillView] = None  # populated on success
    started_at: float
    updated_at: float

@router.get("/api/skills")
async def list_skills() -> list[SkillView]:
    return skills_service.list_skills()

@router.post("/api/skills/toggle")
async def toggle_skill(req: SkillToggleRequest) -> SkillView:
    try:
        return skills_service.toggle_skill(
            name=req.name, enabled=req.enabled, scope=req.scope)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

@router.get("/api/skills/search")
async def search_skills(q: str, limit: int = 10) -> list[SkillSearchResult]:
    if not q.strip():
        return []
    return skills_service.search_hub(q, limit=limit)

@router.post("/api/skills/install")
async def start_install(req: SkillInstallStartRequest) -> SkillJobStatus:
    return skills_service.start_install_job(req.identifier)

@router.post("/api/skills/uninstall")
async def start_uninstall(name: str) -> SkillJobStatus:
    return skills_service.start_uninstall_job(name)

@router.get("/api/skills/jobs/{job_id}")
async def poll_job(job_id: str) -> SkillJobStatus:
    status = skills_service.get_job_status(job_id)
    if status is None:
        raise HTTPException(404, "unknown job")
    return status

@router.get("/api/skills/updates")
async def check_updates() -> dict:
    return skills_service.check_updates()
```

**`backend/app/services/skills_service.py` (new):**
```python
"""Adapter over hermes skills: list/toggle/search/install/uninstall.

Install/uninstall are long-running (git fetch, file copy, dependency
resolution). We run them on a shared ThreadPoolExecutor and expose a
start+poll job API. Jobs are in-memory (same semantics as OAuth flows)."""

import asyncio
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from hermes_cli.config import load_config
from hermes_cli.config_lock import config_store_lock   # WP1-C-fork
from hermes_cli.skills_config import (
    get_disabled_skills, save_disabled_skills,
)

logger = logging.getLogger(__name__)

JOB_TTL_SECONDS = 30 * 60
MAX_CONCURRENT_JOBS = 4
_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_JOBS,
                               thread_name_prefix="skill-job")

@dataclass
class SkillJob:
    job_id: str
    kind: str                         # install | uninstall | update
    identifier: str
    status: str = "pending"
    error: Optional[str] = None
    skill: Optional[Dict[str, Any]] = None
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    future: Optional[Future] = field(default=None, repr=False)

_jobs: Dict[str, SkillJob] = {}
_jobs_lock = asyncio.Lock()

def _find_installed_skills() -> List[Dict[str, Any]]:
    from tools.skills_tool import _find_all_skills
    try:
        return _find_all_skills(skip_disabled=False)  # we want everything, then mark state
    except Exception as exc:
        logger.warning("find_all_skills failed: %s", exc)
        return []

def _to_view(skill: Dict[str, Any], *, disabled_global: set,
             disabled_vonvon: set) -> Dict[str, Any]:
    name = skill.get("name", "")
    return {
        "name": name,
        "category": skill.get("category"),
        "description": skill.get("description", "") or "",
        "install_path": skill.get("install_path", "") or "",
        "version": skill.get("version"),
        "source": skill.get("source"),
        "enabled_global": name not in disabled_global,
        "enabled_vonvon": name not in disabled_vonvon,
    }

def list_skills() -> List[Dict[str, Any]]:
    config = load_config()
    disabled_global = get_disabled_skills(config, platform=None)
    disabled_vonvon = get_disabled_skills(config, platform="vonvon")
    return [
        _to_view(s, disabled_global=disabled_global,
                 disabled_vonvon=disabled_vonvon)
        for s in _find_installed_skills()
    ]

def toggle_skill(*, name: str, enabled: bool, scope: str) -> Dict[str, Any]:
    if scope not in ("global", "vonvon"):
        raise ValueError("scope must be global or vonvon")
    platform = None if scope == "global" else "vonvon"
    with config_store_lock():
        config = load_config()
        disabled = set(get_disabled_skills(config, platform=platform))
        if enabled:
            disabled.discard(name)
        else:
            disabled.add(name)
        save_disabled_skills(config, disabled, platform=platform)

    # Return updated view
    config_after = load_config()
    dg = get_disabled_skills(config_after, None)
    dv = get_disabled_skills(config_after, "vonvon")
    for s in _find_installed_skills():
        if s.get("name") == name:
            return _to_view(s, disabled_global=dg, disabled_vonvon=dv)
    return {"name": name, "enabled_global": name not in dg,
            "enabled_vonvon": name not in dv,
            "description": "", "install_path": ""}

def search_hub(query: str, *, limit: int) -> List[Dict[str, Any]]:
    from tools.skills_hub import GitHubAuth, create_source_router, unified_search
    try:
        auth = GitHubAuth()
        sources = create_source_router(auth)
        results = unified_search(query, sources, source_filter="all", limit=limit)
    except Exception as exc:
        logger.info("skill_search_failed query=%s err=%s", query, exc)
        return []
    return [
        {
            "identifier": r.identifier,
            "name": r.name,
            "description": r.description or "",
            "source": r.source,
            "trust_level": r.trust_level,
        }
        for r in results
    ]

def _do_install(identifier: str) -> Dict[str, Any]:
    """Synchronous install — runs inside ThreadPoolExecutor.

    Calls the non-interactive hermes helper `install_bundle_silent` added
    in WP1-D-fork-2 (see below). Do NOT call `hermes_cli.skills_hub.do_install`
    directly — that function uses Rich Console output and `input()` prompts
    which are incompatible with a headless HTTP adapter.
    """
    from tools.skills_hub import install_bundle_silent  # WP1-D-fork-2
    # Note: install_bundle_silent signature is (identifier, *, force=False).
    # It does NOT accept assume_yes — that kwarg was removed per Critic CF-1
    # because the real `should_allow_install` has no such parameter.
    installed = install_bundle_silent(identifier, force=False)
    if installed is None:
        raise RuntimeError(f"install_bundle_silent returned None for {identifier}")
    return {
        "name": installed.get("name", ""),
        "category": installed.get("category"),
        "description": installed.get("description", "") or "",
        "install_path": str(installed.get("install_path", "")),
        "version": installed.get("version"),
        "source": installed.get("source", ""),
    }

def _do_uninstall(name: str) -> Dict[str, Any]:
    from tools.skills_hub import uninstall_skill
    ok, msg = uninstall_skill(name)
    if not ok:
        raise RuntimeError(msg or f"uninstall failed for {name}")
    return {"name": name, "install_path": "", "description": ""}

async def _run_job(job: SkillJob, func, *args) -> None:
    job.status = "running"
    job.updated_at = time.time()
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(_executor, func, *args)
        job.status = "success"
        job.skill = result
        logger.info("skill_job_success id=%s kind=%s ident=%s",
                    job.job_id, job.kind, job.identifier)
    except Exception as exc:
        job.status = "error"
        job.error = str(exc)
        logger.info("skill_job_error id=%s kind=%s err=%s",
                    job.job_id, job.kind, exc)
    finally:
        job.updated_at = time.time()

async def _create_job(kind: str, identifier: str, func, *args) -> Dict[str, Any]:
    async with _jobs_lock:
        now = time.time()
        expired = [jid for jid, j in _jobs.items()
                   if now - j.updated_at > JOB_TTL_SECONDS
                   and j.status in ("success", "error")]
        for jid in expired:
            _jobs.pop(jid, None)
        active = sum(1 for j in _jobs.values() if j.status in ("pending", "running"))
        if active >= MAX_CONCURRENT_JOBS:
            raise ValueError("too many concurrent skill jobs; try again later")
        job = SkillJob(job_id=uuid.uuid4().hex, kind=kind, identifier=identifier)
        _jobs[job.job_id] = job
    asyncio.create_task(_run_job(job, func, *args))
    return _job_to_dict(job)

def _job_to_dict(job: SkillJob) -> Dict[str, Any]:
    return {
        "job_id": job.job_id,
        "kind": job.kind,
        "identifier": job.identifier,
        "status": job.status,
        "error": job.error,
        "skill": job.skill,
        "started_at": job.started_at,
        "updated_at": job.updated_at,
    }

async def start_install_job(identifier: str) -> Dict[str, Any]:
    return await _create_job("install", identifier, _do_install, identifier)

async def start_uninstall_job(name: str) -> Dict[str, Any]:
    return await _create_job("uninstall", name, _do_uninstall, name)

def get_job_status(job_id: str) -> Optional[Dict[str, Any]]:
    job = _jobs.get(job_id)
    return _job_to_dict(job) if job else None

def check_updates() -> Dict[str, Any]:
    from tools.skills_hub import check_for_skill_updates
    try:
        updates = check_for_skill_updates()
    except Exception as exc:
        logger.info("check_for_skill_updates failed: %s", exc)
        return {"updates": [], "error": str(exc)}
    return {"updates": updates, "error": None}
```

**NOTE on `install_bundle`:** We assume `tools.skills_hub.install_bundle(bundle, meta, source)` exists as the pure install step used by `do_install`. If the actual public surface differs (e.g. named `install_from_bundle` or hidden under `_install_bundle`), the adapter must call whatever non-interactive entrypoint the CLI uses. WP1-D first task: confirm the exact function name via `grep -n "def .*install" backend/hermes-agent/tools/skills_hub.py` and adjust. Do NOT reimplement install logic in the backend.

### WP1-E — `routes/workspace.py` + `services/workspace_service.py`

**New `backend/app/routes/workspace.py`:**
```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.services import workspace_service

router = APIRouter()

class WorkspaceState(BaseModel):
    path: str
    exists: bool
    is_dir: bool
    is_sandbox: bool              # True when using ~/.vonvon/workdir/ fallback

class WorkspaceSetRequest(BaseModel):
    path: str = Field(..., min_length=1)

@router.get("/api/workspace")
async def get_workspace() -> WorkspaceState:
    return workspace_service.current_state()

@router.post("/api/workspace")
async def set_workspace(req: WorkspaceSetRequest) -> WorkspaceState:
    try:
        return workspace_service.set_workspace(req.path)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

@router.post("/api/workspace/reset")
async def reset_workspace() -> WorkspaceState:
    """Reset workspace to ~/.vonvon/workdir/ sandbox (clears vonvon.workspace)."""
    return workspace_service.reset_to_sandbox()
```

**`backend/app/services/workspace_service.py` (new):**
```python
"""Project workspace management — single process-wide cwd for hermes tools.

Hermes agent file/terminal tools resolve paths through os.getenv('TERMINAL_CWD')
with an os.getcwd() fallback. vonvon-backend must own this value so user
conversations affect the user's project, not the backend install dir.

Fallback: ~/.vonvon/workdir/ (auto-created sandbox). Never use $HOME as
the default — too broad, agent could scribble on dotfiles."""

import logging
import os
from pathlib import Path
from typing import Dict

from hermes_cli.config import load_config, save_config
from hermes_cli.config_lock import config_store_lock   # WP1-C-fork

logger = logging.getLogger(__name__)

SANDBOX_PATH = Path.home() / ".vonvon" / "workdir"
SANDBOX_README = """# vonvon default workdir

This is the sandbox directory vonvon uses when no project workspace
is configured in Settings. The agent's file / terminal / git tools
operate inside this folder.

You can switch to a real project directory via Settings → 工作区 → 选择目录...
"""

_current_path: Path = SANDBOX_PATH   # assumption: sandbox is primed by init

def _ensure_sandbox() -> Path:
    """Create ~/.vonvon/workdir/ if missing and seed a README."""
    try:
        SANDBOX_PATH.mkdir(parents=True, exist_ok=True)
        readme = SANDBOX_PATH / "README.md"
        if not readme.exists():
            readme.write_text(SANDBOX_README, encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to ensure sandbox %s: %s", SANDBOX_PATH, exc)
    return SANDBOX_PATH

def _state(path: Path) -> Dict[str, object]:
    return {
        "path": str(path),
        "exists": path.exists(),
        "is_dir": path.is_dir(),
        "is_sandbox": path == SANDBOX_PATH.resolve(),
    }

def current_state() -> Dict[str, object]:
    return _state(_current_path)

def _apply(path: Path) -> None:
    """Apply cwd as an atomic transaction: either both TERMINAL_CWD AND
    os.chdir succeed, or neither changes. Critic MF-2 requires no partial
    state — if chdir fails, env is rolled back and ValueError is raised
    so callers (e.g. set_workspace) skip the config.yaml persistence.
    """
    global _current_path
    resolved = path.expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise ValueError(f"workspace path does not exist or is not a directory: {resolved}")

    prev_env = os.environ.get("TERMINAL_CWD")
    # chdir FIRST — if this fails we haven't touched env yet
    try:
        os.chdir(resolved)
    except OSError as exc:
        raise ValueError(f"chdir to {resolved} failed: {exc}") from exc

    # Now env — if this somehow fails, roll chdir back
    try:
        os.environ["TERMINAL_CWD"] = str(resolved)
    except Exception as exc:
        try:
            if prev_env is not None:
                os.environ["TERMINAL_CWD"] = prev_env
            else:
                os.environ.pop("TERMINAL_CWD", None)
        finally:
            try:
                if _current_path.exists() and _current_path.is_dir():
                    os.chdir(_current_path)
            except OSError:
                pass
        raise ValueError(f"env update failed: {exc}") from exc

    _current_path = resolved
    logger.info("workspace_applied path=%s sandbox=%s",
                resolved, resolved == SANDBOX_PATH.resolve())

def set_workspace(path: str) -> Dict[str, object]:
    resolved = Path(path).expanduser().resolve()
    _apply(resolved)
    with config_store_lock():
        cfg = load_config()
        cfg.setdefault("vonvon", {})
        cfg["vonvon"]["workspace"] = str(resolved)
        save_config(cfg)
    return _state(resolved)

def reset_to_sandbox() -> Dict[str, object]:
    sandbox = _ensure_sandbox().resolve()
    _apply(sandbox)
    with config_store_lock():
        cfg = load_config()
        vcfg = cfg.get("vonvon")
        if isinstance(vcfg, dict) and "workspace" in vcfg:
            vcfg.pop("workspace", None)
            if not vcfg:
                cfg.pop("vonvon", None)
            save_config(cfg)
    return _state(sandbox)

def init_from_hermes_config() -> None:
    """Load workspace from ~/.hermes/config.yaml:vonvon.workspace at backend startup.

    Order:
      1. Persisted vonvon.workspace (if valid)
      2. ~/.vonvon/workdir/ (auto-create + seed README)
    """
    try:
        cfg = load_config()
        persisted = cfg.get("vonvon", {}).get("workspace")
        if persisted:
            try:
                _apply(Path(persisted))
                return
            except ValueError as exc:
                logger.warning("Persisted workspace invalid: %s — falling back to sandbox",
                               exc)
    except Exception as exc:
        logger.warning("Failed to load workspace config: %s", exc)

    sandbox = _ensure_sandbox().resolve()
    _apply(sandbox)
    logger.info("workspace_default_sandbox path=%s", sandbox)
```

**Integration with `main.py` lifespan (DELTA-6)** — `backend/app/main.py`:
```python
from app.services import agent_service, workspace_service

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Order matters:
    # 1. Load hermes model/provider state FIRST (reads ~/.hermes absolute path)
    agent_service.init_from_hermes_config()
    # 2. Apply workspace — this calls os.chdir + sets TERMINAL_CWD
    workspace_service.init_from_hermes_config()
    # 3. Eager SessionDB init AFTER workspace is final, BEFORE any request
    #    hits create_agent(). Locks the SQLite path to ~/.hermes/state.db
    #    (absolute via get_hermes_home) before any relative path can bite.
    agent_service.get_session_db()
    yield
```
**Why this order (Architect DELTA-6):** `SessionDB` is lazily initialized inside `get_session_db()`. If the first call happens during a request (after user switched workspace), any relative path fallback inside `SessionDB.__init__` would resolve against the user's project dir. By eagerly constructing it once the workspace is set, the SQLite handle + path are frozen for the backend lifetime.

**Request-entry defensive reset (DELTA-5)** — `backend/app/routes/chat.py` must, at the top of `send_message()` (before scheduling `run_agent`), re-apply `TERMINAL_CWD` from the workspace singleton:

```python
# backend/app/routes/chat.py  (ADD near the top of send_message())
import os
from app.services import workspace_service

@router.post("/api/chat/send")
async def send_message(req: ChatRequest):
    # DELTA-5: defensive re-apply — prevents any stale TERMINAL_CWD env
    # leaking across concurrent requests if some hermes call site mutated
    # os.environ mid-run. workspace_service owns the truth.
    _ws = workspace_service.current_state()
    os.environ["TERMINAL_CWD"] = _ws["path"]
    ...
```

Same reset MUST be added to:
- `routes/sessions.py::create_session` (if it eagerly constructs an agent)
- `routes/chat.py::compress_context` (same reason — ContextCompressor may spawn tool calls)

File-change summary: `chat.py` +3 lines, `sessions.py` +3 lines.

**Frontend IPC wiring** — Electron must expose `dialog.showOpenDialog`:

`src/main/ipc.ts` (+12 lines):
```typescript
import { dialog } from 'electron'

ipcMain.handle('workspace:pickDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: '选择项目工作区',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})
```

`src/preload/index.ts` (+3 lines):
```typescript
pickWorkspaceDirectory: (): Promise<string | null> =>
  ipcRenderer.invoke('workspace:pickDirectory'),
```

### WP1 wiring

`backend/app/main.py`: `from app.routes import chat, sessions, models, auth, mcp, skills, workspace` + `app.include_router(auth.router); app.include_router(mcp.router); app.include_router(skills.router); app.include_router(workspace.router)`.

### DELTA-7 — Event loop hygiene (apply across WP1-B/C/D/E)

Every service function that takes a file lock (`_auth_store_lock`, `config_store_lock`, `HubLockFile`) or performs disk I/O longer than a microsecond MUST be marshalled from its `async` route handler via `await asyncio.to_thread(...)`. Otherwise fcntl waits block the single event loop thread and all other requests stall.

Concrete rewrites:

**`services/auth_service.py`** — wrap in `to_thread`:
```python
async def add_api_key_credential(*, provider, api_key, label=None, base_url=None):
    return await asyncio.to_thread(
        _add_api_key_credential_sync, provider, api_key, label, base_url)

def _add_api_key_credential_sync(provider, api_key, label, base_url):
    # ... original body ...

async def remove_credential(provider, cred_id) -> bool:
    return await asyncio.to_thread(_remove_credential_sync, provider, cred_id)

async def list_all_credentials() -> list[dict]:
    return await asyncio.to_thread(_list_all_credentials_sync)
```

Route handlers in `routes/auth.py` become:
```python
@router.post("/api/auth/credentials")
async def add_credential(req: CredentialCreateRequest) -> CredentialView:
    ...
    return await auth_service.add_api_key_credential(...)

@router.delete("/api/auth/credentials/{provider}/{cred_id}")
async def remove_credential(provider: str, cred_id: str) -> dict:
    removed = await auth_service.remove_credential(provider, cred_id)
    ...

@router.get("/api/auth/credentials")
async def list_credentials() -> list[CredentialView]:
    return await auth_service.list_all_credentials()
```

**`services/skills_service.py`** — wrap `list_skills` + `toggle_skill` + `check_updates` + `search_hub` (search calls httpx → blocking):
```python
async def list_skills() -> list[dict]:
    return await asyncio.to_thread(_list_skills_sync)

async def toggle_skill(*, name, enabled, scope) -> dict:
    return await asyncio.to_thread(_toggle_skill_sync, name, enabled, scope)

async def search_hub(query, *, limit) -> list[dict]:
    return await asyncio.to_thread(_search_hub_sync, query, limit)

async def check_updates() -> dict:
    return await asyncio.to_thread(_check_updates_sync)
```
(`start_install_job` / `start_uninstall_job` / `get_job_status` stay `async` as designed — jobs already use `run_in_executor`.)

**`services/workspace_service.py`** — wrap disk-touching functions:
```python
async def set_workspace(path: str) -> dict:
    return await asyncio.to_thread(_set_workspace_sync, path)

async def reset_to_sandbox() -> dict:
    return await asyncio.to_thread(_reset_to_sandbox_sync)

# current_state() is pure memory read — stays sync, no wrap needed
# init_from_hermes_config() runs once at lifespan startup — stays sync
```

**`services/mcp_service.py`** — already wrapped above in DELTA-2.

**`services/agent_service.py:switch_model`** — `switch_model_core` + `save_config` both do disk I/O:
```python
async def switch_model(model, *, persist=False, provider=None, base_url=None):
    return await asyncio.to_thread(
        _switch_model_sync, model, persist, provider, base_url)
```
Route `POST /api/models/current` becomes `await agent_service.switch_model(...)`.

**Rule of thumb**: if a service function calls `load_config` / `save_config` / `load_pool` / any `fcntl` / `_auth_store_lock` / `HubLockFile`, it MUST be wrapped. Document this in `backend/app/services/__init__.py` as a module-level docstring.

---

## WP2: Frontend (React) — Hermes config panels

### New components (under `src/renderer/components/Settings/`)

**`HermesAuthPanel.tsx`** (~180 lines)
- Section header: "Hermes 认证"
- List of current credentials (grouped by provider): `provider / label / auth_type / last4 / status`; each row has "删除" 按钮
- "添加" 按钮 → 弹出抽屉表单 → 选 provider → 选 `api_key` 或 `oauth`
- `api_key` 路径: 表单 `api_key` (password input), optional `label`, optional `base_url` → `POST /api/auth/credentials`
- `oauth` 路径 (仅 `openai-codex`):
  1. 点 "开始 ChatGPT 登录" → `POST /api/auth/oauth/start`
  2. 弹窗显示 `user_code`, `verification_url` (可复制), 倒计时 15 分钟
  3. 每 N 秒 (用后端返回的 `interval`) `GET /api/auth/oauth/poll?flow_id=…`
  4. `pending` → 更新进度；`success` → 关闭弹窗，刷新列表；`error`/`timeout` → 显示错误 + "重试" 按钮
  5. 用户关闭弹窗 → `DELETE /api/auth/oauth/flows/{flow_id}` 取消
- **Critic M-4 安全检查**: "打开浏览器" 按钮在 renderer 调 `shell.openExternal(url)` 之前，**MUST** 用 `new URL(url).origin === "https://auth.openai.com"` 白名单校验；非白名单 URL 显示 toast "invalid verification URL, aborted" 并拒绝打开。该检查在 `HermesAuthPanel.tsx` 的 OAuth 弹窗组件内实现。同理 `WorkspacePanel.tsx` 的 `shell.showItemInFolder(path)` 调用仅允许 `workspace_service.current_state().path` 返回的绝对路径，不接受用户手输。
- 不缓存明文 key；表单提交后 input 清空

**`McpServerPanel.tsx`** (~200 lines)
- Table: `Name / Transport (url or command) / Tools / Status (enabled/disabled) / Actions`
- Actions: "测试" / "删除"
- "添加" 按钮 → 抽屉表单:
  - radio: `HTTP` / `Stdio`
  - HTTP → 输入 `url` + optional `headers` kv 列表
  - Stdio → 输入 `command` + `args` (space-split) + optional `env`
  - "保存并测试连接" 复选框 (默认 on)
  - 提交 → `POST /api/mcp/servers?probe=true`
- 测试按钮 → `POST /api/mcp/servers/{name}/test` → 显示 latency + tools 列表弹窗

**`WorkspacePanel.tsx`** (~120 lines) — rendered at the top of the hermes-mode `SettingsPanel`
- 显示当前路径（含 "sandbox" 或 "project" 标签），可点击在 Finder/Explorer 中打开（通过 Electron `shell.showItemInFolder`）
- "选择目录..." 按钮 → `window.electron.pickWorkspaceDirectory()` → 得到 path → `POST /api/workspace` → 刷新状态
- "使用默认沙箱" 按钮 → `POST /api/workspace/reset` → 刷新状态
- sandbox 状态下 Chat 区域顶部的 warning banner 组件（`<SandboxBanner />`，另外一个小组件 ~30 行），由 `App.tsx` 或 `ChatContainer.tsx` 在 `backendEnabled && workspace.is_sandbox` 时渲染
- 刷新策略：打开 SettingsPanel 时拉一次 `GET /api/workspace`；每次 set/reset 后立即回填

**`SkillsPanel.tsx`** (~260 lines)
- Two tabs: **"已安装"** / **"发现"**
- **已安装 tab**:
  - Table/list: `Name / Category / Description (truncate 60) / Global toggle / Vonvon toggle / Actions`
  - Global toggle ↔ `POST /api/skills/toggle {scope: "global"}` — 控制所有平台
  - Vonvon toggle ↔ `POST /api/skills/toggle {scope: "vonvon"}` — 仅影响 vonvon
  - Actions: "卸载" — 触发 `POST /api/skills/uninstall` → 进入 job 面板
  - 顶部 "检查更新" 按钮 → `GET /api/skills/updates` → 有更新时显示徽标
- **发现 tab**:
  - 搜索框（debounce 400ms）→ `GET /api/skills/search?q=`
  - 结果列表：`Name / Source / Trust badge / Description / [安装] 按钮`
  - 安装按钮 → `POST /api/skills/install` → 获取 `job_id` → 每 2s 轮询 `/api/skills/jobs/{job_id}` 直到 `success`/`error`
  - 运行中显示 spinner + 耗时；成功后 toast + 自动刷新已安装列表
  - 错误显示 `error` 文案；提供 "重试" 按钮
- Trust badge 颜色：`builtin` 蓝 / `trusted` 绿 / `community` 黄
- 不显示 security audit 详情（超范围）

**`HermesModelPanel.tsx`** (~140 lines) — replaces current static `ModelSettings` content when `backendEnabled === true`
- 从 `GET /api/models` 拉取 `{providers, current, current_provider}`
- Provider 下拉 (只显示已认证的 providers) + Model 下拉 + optional `base_url` 输入
- "持久化到 hermes 配置" 复选框 (默认 off)
- "应用" → `POST /api/models/current` with `{model, provider, base_url, persist}`
- 成功后显示 toast + 更新当前指示
- 若无已认证 provider → 提示 "请先在下方 '认证' 区配置 provider"

### New hook: `useHermesConfig.ts` (~130 lines)

Exports:
```typescript
export function useHermesConfig() {
  // Models
  listModels(): Promise<ListModelsResponse>
  switchModel(req: { model: string; provider?: string; base_url?: string; persist?: boolean }): Promise<SwitchModelResponse>
  // Credentials
  listCredentials(): Promise<CredentialView[]>
  addApiKey(req: { provider: string; api_key: string; label?: string; base_url?: string }): Promise<CredentialView>
  removeCredential(provider: string, cred_id: string): Promise<void>
  // OAuth (codex)
  startCodexOAuth(): Promise<OAuthStartResponse>
  pollCodexOAuth(flow_id: string): Promise<OAuthPollResponse>
  cancelCodexOAuth(flow_id: string): Promise<void>
  // MCP
  listMcpServers(): Promise<McpServerView[]>
  addMcpServer(cfg: McpServerConfig, probe: boolean): Promise<McpServerView>
  removeMcpServer(name: string): Promise<void>
  testMcpServer(name: string): Promise<McpProbeResult>
  // Skills
  listSkills(): Promise<SkillView[]>
  toggleSkill(req: { name: string; enabled: boolean; scope: "vonvon" | "global" }): Promise<SkillView>
  searchSkills(q: string, limit?: number): Promise<SkillSearchResult[]>
  startInstallSkill(identifier: string): Promise<SkillJobStatus>
  startUninstallSkill(name: string): Promise<SkillJobStatus>
  pollSkillJob(job_id: string): Promise<SkillJobStatus>
  checkSkillUpdates(): Promise<{ updates: unknown[]; error: string | null }>
  // Workspace
  getWorkspace(): Promise<WorkspaceState>
  setWorkspace(path: string): Promise<WorkspaceState>
  resetWorkspace(): Promise<WorkspaceState>
}
```
All calls go through `useBackend().apiFetch()` so backend URL comes from a single source.

### Modified files (minimal)

- **`src/renderer/components/Settings/SettingsPanel.tsx`** (+22 lines)
  - 读取 `useBackend()` 的 `backendEnabled`
  - 若 `true`: 渲染 `WorkspacePanel` (顶部) + `HermesModelPanel` + `HermesAuthPanel` + `McpServerPanel` + `SkillsPanel` + `BackendSettings` + `AboutSection`; 不渲染旧 `ProviderSettings`/`ModelSettings`
  - 若 `false`: 现有渲染路径 **完全不变**（ProviderSettings + ModelSettings + BackendSettings + AboutSection）

- **`src/main/ipc.ts`** (+12 lines) — `workspace:pickDirectory` handler（见 WP1-E 代码块）
- **`src/preload/index.ts`** (+3 lines) — `pickWorkspaceDirectory` 暴露（见 WP1-E 代码块）
- **`src/renderer/components/Chat/ChatContainer.tsx`** (+8 lines) — 顶部渲染 `<SandboxBanner workspace={ws} />`（条件渲染）

- **`src/renderer/components/Chat/ModelSelector.tsx`** (if exists, +10 lines)
  - 当 `backendEnabled` 时，从 `useHermesConfig().listModels()` 拉当前模型；切换走 `switchModel({persist: false})`
  - 否则保持现有直连行为

No changes to `store.ts` / `ipc.ts` / `preload/index.ts` / `App.tsx` (backendUrl already plumbed in v1).

---

## Work Package Split

| WP | Scope | Files | Depends on |
|----|-------|-------|-----------|
| **WP1-A** | Models runtime/persist | `backend/app/routes/models.py`, `backend/app/services/agent_service.py`, `backend/app/schemas.py` | — |
| **WP1-B-fork** | Codex device flow split | `backend/hermes-agent/agent/codex_device_flow.py` (NEW), `hermes-agent/hermes_cli/auth.py` (refactor `_codex_device_code_login`) | — |
| **WP1-B** | Auth API | `backend/app/routes/auth.py` (NEW), `backend/app/services/auth_service.py` (NEW), `backend/app/schemas.py` | WP1-B-fork |
| **WP1-C-fork** | Config lock | `backend/hermes-agent/hermes_cli/config_lock.py` (NEW), patch `mcp_config.py` helpers | — |
| **WP1-C** | MCP API | `backend/app/routes/mcp.py` (NEW), `backend/app/services/mcp_service.py` (NEW) | WP1-C-fork |
| **WP1-D-fork** | Skills platform | `backend/hermes-agent/hermes_cli/skills_config.py` (+1 line PLATFORMS entry; +6 lines config_store_lock wrap in `save_disabled_skills`) | WP1-C-fork |
| **WP1-D-fork-2** | Skills headless install | `backend/hermes-agent/tools/skills_hub.py` (+~80 lines `install_bundle_silent`) | — |
| **WP1-D** | Skills API | `backend/app/routes/skills.py` (NEW), `backend/app/services/skills_service.py` (NEW) | WP1-C-fork, WP1-D-fork, WP1-D-fork-2 |
| **WP1-E** | Workspace API | `backend/app/routes/workspace.py` (NEW), `backend/app/services/workspace_service.py` (NEW), `backend/app/main.py` lifespan hook | WP1-C-fork |
| **WP1-tests** | Backend tests | `backend/tests/test_auth_service.py`, `test_api_auth.py`, `test_mcp_service.py`, `test_api_mcp.py`, `test_api_models_persist.py`, `test_config_lock.py`, `test_config_lock_concurrent.py`, `test_skills_service.py`, `test_api_skills.py`, `test_workspace_service.py`, `test_api_workspace.py` | WP1-A,B,C,D,E |
| **WP2-ui** | React panels | `HermesAuthPanel.tsx` (NEW), `McpServerPanel.tsx` (NEW), `HermesModelPanel.tsx` (NEW), `SkillsPanel.tsx` (NEW), `WorkspacePanel.tsx` (NEW), `SandboxBanner.tsx` (NEW) | WP1 stable |
| **WP2-hook** | React hook | `src/renderer/hooks/useHermesConfig.ts` (NEW) | — |
| **WP2-ipc** | Electron workspace pick | `src/main/ipc.ts` (MODIFY), `src/preload/index.ts` (MODIFY) | — |
| **WP2-wire** | Gate existing panels | `src/renderer/components/Settings/SettingsPanel.tsx` (MODIFY), `Chat/ChatContainer.tsx` (MODIFY) | WP2-ui, WP2-hook, WP2-ipc |
| **WP3-qa** | Manual AC walkthrough | `docs/v1.1-qa-checklist.md` (NEW) | All |

**Parallelism:** agent-1 (WP1-A + WP1-C-fork + WP1-C + WP1-E), agent-2 (WP1-B-fork + WP1-B), agent-3 (WP1-D-fork + WP1-D), agent-4 (WP2-hook + WP2-ipc + WP2-ui), agent-5 (WP1-tests + WP3-qa). agent-4 can start with mocked hook; it integrates after WP1 lands.

**Est. size:** ~2250 new lines Python, ~960 new lines TypeScript, ~230 modified lines (hermes fork + SettingsPanel + ipc + chat container).

---

## File Change Summary

| File | Action | Est. Lines | WP |
|------|--------|-----------|-----|
| **Backend (new)** | | | |
| `backend/app/routes/auth.py` | NEW | ~110 | WP1-B |
| `backend/app/routes/mcp.py` | NEW | ~90 | WP1-C |
| `backend/app/routes/skills.py` | NEW | ~100 | WP1-D |
| `backend/app/routes/workspace.py` | NEW | ~55 | WP1-E |
| `backend/app/services/auth_service.py` | NEW | ~210 | WP1-B |
| `backend/app/services/mcp_service.py` | NEW | ~110 | WP1-C |
| `backend/app/services/skills_service.py` | NEW | ~260 | WP1-D |
| `backend/app/services/workspace_service.py` | NEW | ~130 | WP1-E |
| `backend/app/schemas.py` | MODIFY | +140 | WP1-A,B,C,D,E |
| `backend/app/routes/models.py` | MODIFY | +40 | WP1-A |
| `backend/app/services/agent_service.py` | MODIFY | +50 | WP1-A |
| `backend/app/main.py` | MODIFY | +7 | WP1 |
| **Hermes fork (new / modify)** | | | |
| `backend/hermes-agent/agent/codex_device_flow.py` | NEW | ~110 | WP1-B-fork |
| `backend/hermes-agent/hermes_cli/config_lock.py` | NEW | ~85 | WP1-C-fork |
| `backend/hermes-agent/hermes_cli/auth.py` | MODIFY | ~-60/+30 + 3 (strategy RMW lock) | WP1-B-fork |
| `backend/hermes-agent/hermes_cli/mcp_config.py` | MODIFY | +20 | WP1-C-fork |
| `backend/hermes-agent/hermes_cli/skills_config.py` | MODIFY | +7 (platform + lock) | WP1-D-fork |
| `backend/hermes-agent/tools/skills_hub.py` | MODIFY | +80 (`install_bundle_silent`) | WP1-D-fork-2 |
| `backend/hermes-agent/HERMES-FORK-NOTES.md` | NEW | ~80 | WP1-B/C/D-fork |
| **Backend tests (new)** | | | |
| `backend/tests/test_auth_service.py` | NEW | ~120 | WP1-tests |
| `backend/tests/test_api_auth.py` | NEW | ~150 | WP1-tests |
| `backend/tests/test_mcp_service.py` | NEW | ~90 | WP1-tests |
| `backend/tests/test_api_mcp.py` | NEW | ~120 | WP1-tests |
| `backend/tests/test_api_models_persist.py` | NEW | ~70 | WP1-tests |
| `backend/tests/test_config_lock.py` | NEW | ~60 | WP1-tests |
| `backend/tests/test_config_lock_concurrent.py` | NEW | ~80 | WP1-tests |
| `backend/tests/test_skills_service.py` | NEW | ~100 | WP1-tests |
| `backend/tests/test_api_skills.py` | NEW | ~140 | WP1-tests |
| `backend/tests/test_workspace_service.py` | NEW | ~90 | WP1-tests |
| `backend/tests/test_api_workspace.py` | NEW | ~70 | WP1-tests |
| `backend/tests/test_log_safety.py` | NEW | ~40 | WP1-tests |
| `backend/tests/test_event_loop_latency.py` | NEW | ~100 | WP1-tests (DELTA-7 / AC-C6) |
| `backend/tests/test_concurrent_mcp_probe.py` | NEW | ~60 | WP1-tests (DELTA-2 / AC-P8,P9) |
| `backend/tests/test_config_lock_cli_vs_ui.py` | NEW | ~80 | WP1-tests (AC-P10) |
| `backend/tests/test_config_atomic.py` | NEW | ~50 | WP1-tests (AC-C8) |
| `backend/tests/test_hermes_home_permissions.py` | NEW | ~45 | WP1-tests (AC-C9) |
| `backend/tests/test_install_bundle_silent.py` | NEW | ~120 | WP1-tests (AC-S12 + CF-1 signature gate) |
| `backend/tests/test_skill_prompt_cache.py` | NEW | ~70 | WP1-tests (AC-S12 + AC-S13 / CF-2) |
| `backend/tests/test_switch_model_empty_guard.py` | NEW | ~50 | WP1-tests (MF-6) |
| `backend/tests/test_workspace_apply_tx.py` | NEW | ~70 | WP1-tests (MF-2 / AC-W2b) |
| `backend/tests/test_oauth_token_exchange_retry.py` | NEW | ~90 | WP1-tests (MF-5 / AC-A12) |
| **Frontend (new)** | | | |
| `src/renderer/hooks/useHermesConfig.ts` | NEW | ~220 | WP2-hook |
| `src/renderer/components/Settings/HermesAuthPanel.tsx` | NEW | ~180 | WP2-ui |
| `src/renderer/components/Settings/McpServerPanel.tsx` | NEW | ~200 | WP2-ui |
| `src/renderer/components/Settings/HermesModelPanel.tsx` | NEW | ~140 | WP2-ui |
| `src/renderer/components/Settings/SkillsPanel.tsx` | NEW | ~260 | WP2-ui |
| `src/renderer/components/Settings/WorkspacePanel.tsx` | NEW | ~120 | WP2-ui |
| `src/renderer/components/Chat/SandboxBanner.tsx` | NEW | ~40 | WP2-ui |
| **Frontend (modify)** | | | |
| `src/renderer/components/Settings/SettingsPanel.tsx` | MODIFY | +22 | WP2-wire |
| `src/renderer/components/Chat/ChatContainer.tsx` | MODIFY | +8 | WP2-wire |
| `src/main/ipc.ts` | MODIFY | +12 | WP2-ipc |
| `src/preload/index.ts` | MODIFY | +3 | WP2-ipc |
| **Docs (new)** | | | |
| `docs/v1.1-qa-checklist.md` | NEW | ~130 | WP3-qa |
| **Total** | 41 new / 14 modify | **~4850** | |

---

## Acceptance Criteria

### Models
- [ ] **AC-M1** `GET /api/models` 返回基于 hermes `list_authenticated_providers` 的 providers 数组，每个含 `{slug, name, models, total_models, is_current, source}`。
- [ ] **AC-M2** `POST /api/models/current {model: "sonnet", persist: false}` 成功切换且 `~/.hermes/config.yaml` 内容在 diff 下 0 字节变化。
- [ ] **AC-M3** `POST /api/models/current {model: "sonnet", persist: true}` 后 `~/.hermes/config.yaml` 的 `model.provider` + `model.name` 被更新，且重启后端后仍生效。
- [ ] **AC-M4** UI `HermesModelPanel` 在用户切换 provider 时只显示该 provider 已认证下的模型列表，未认证时显示引导。

### Auth — API Key
- [ ] **AC-A1** `POST /api/auth/credentials {provider: "openai", api_key: "sk-test", label: "work"}` → 201 返回 `CredentialView{last4: "…test"}`；`auth.json` 中多出一条 `credential_pool.openai` 条目。
- [ ] **AC-A2** `GET /api/auth/credentials` 返回列表，明文 key **永不出现**（grep 响应 body 不含 `sk-test` 完整串）。
- [ ] **AC-A3** `DELETE /api/auth/credentials/openai/{cred_id}` 移除条目；后续 `GET` 不再包含。
- [ ] **AC-A4** UI 添加表单关闭后 React state 中 api_key 字段清空（无持久化）。

### Auth — ChatGPT OAuth device code
- [ ] **AC-A5** `POST /api/auth/oauth/start?provider=openai-codex` 在 <3 秒内返回 `{flow_id, user_code, verification_url, interval, expires_in_seconds: 900}`；`user_code` 符合 OpenAI 8-字符格式。
- [ ] **AC-A6** 未完成登录时 `GET /api/auth/oauth/poll?flow_id=…` 在 <2 秒内返回 `{status: "pending"}`（即使后端在处理并发请求，**不阻塞超过 interval 秒**）。
- [ ] **AC-A7** 用户在浏览器完成授权后 ≤ 2 × interval 秒内下一次 poll 返回 `{status: "success", credential: …}`，且 `credential_pool.openai-codex` 新增 OAuth 类型条目。
- [ ] **AC-A8** 未使用的 flow 在 15 分钟后 poll 返回 `{status: "timeout"}` 且从 `_active_flows` 清除。
- [ ] **AC-A9** `DELETE /api/auth/oauth/flows/{flow_id}` 取消未完成的 flow。
- [ ] **AC-A10** UI 登录弹窗显示 `user_code` 可点击复制，`verification_url` 可点击打开系统浏览器（Electron `shell.openExternal`）。
- [ ] **AC-A11** 超过 8 个并发 flows 时 `POST /api/auth/oauth/start` 返回 `400 too many concurrent OAuth flows`。
- [ ] **AC-A12** (Critic MF-5) Token exchange 5xx 可恢复：mock OpenAI token endpoint 在第 1 次调用返回 503，第 2 次返回 200。用户走完 device code 流程后，前端第 N 次 poll 得到 `{status: "pending"}`（内部已保存 `pending_exchange`），第 N+1 次 poll 得到 `{status: "success"}` 且用户**无需重新扫码**（`user_code`/`device_auth_id` 从未失效）。
- [ ] **AC-A13** (Architect iter-2) 并发 poll 去重：对同一 `flow_id` 发起 3 个并发 `GET /api/auth/oauth/poll`，只有 **1 次** 实际到达 `poll_device_flow`（mock spy 计数），另外 2 次立即返回 `{status: "pending"}`。证明 `state.status = "polling"` gate 抑制了重复 token exchange。

### MCP Server
- [ ] **AC-P1** `POST /api/mcp/servers {name: "fs", command: "npx", args: ["@modelcontextprotocol/server-filesystem","/tmp"]}` 在连接成功时写入 `config.yaml:mcp_servers.fs`，响应包含 `tools_count > 0`。
- [ ] **AC-P2** 连接失败时返回 200 + `last_error` 但仍写入 `config.yaml`（`enabled: false`），与 hermes CLI 行为一致。
- [ ] **AC-P3** `GET /api/mcp/servers` 返回 yaml 中的所有 servers。
- [ ] **AC-P4** `DELETE /api/mcp/servers/fs` 移除；随后 `GET` 不含。
- [ ] **AC-P5** `POST /api/mcp/servers/fs/test` 成功返回 `{ok: true, latency_ms, tools: […]}`。
- [ ] **AC-P6** 并发 2 个后端进程同时 `POST /api/mcp/servers` 添加不同 server，最终 `config.yaml` 包含两者（无丢失写入）— 通过 `config_store_lock` 保证。
- [ ] **AC-P7** UI McpServerPanel 在添加成功时刷新列表；失败时显示错误消息并保留表单内容便于修正。
- [ ] **AC-P8** (Critic MF-3 + DELTA-2) `test_concurrent_mcp_probe.py` 并发触发 3 个 `probe_server()`：全部返回完整 `{ok, tools}` 结构，无 `RuntimeError: Event loop is closed` 或 "task group" 报错。证明 `_probe_lock` + `asyncio.to_thread` 路径抵御了 MCP loop singleton tear-down race。
- [ ] **AC-P9** (Critic MF-4) 并发 5 个 `POST /api/mcp/servers/{n}/test` 全部在 **< 60 秒** 内返回（每个 probe 受 `_PROBE_TIMEOUT_SECONDS=10` 保护）；证明没有退化成 `30s × 5 = 150s` 的级联串行。
- [ ] **AC-P10** (Critic CLI vs UI) `test_config_lock_cli_vs_ui.py`：起一个 subprocess `python -m hermes_cli mcp add test-cli --url http://x` 同时起 backend `POST /api/mcp/servers {name: "test-ui", ...}`。最终 `config.yaml` 包含 `test-cli` + `test-ui`（advisory lock 在 CLI 和 backend 两侧都生效）。

### Skills
- [ ] **AC-S1** `GET /api/skills` 返回所有已安装 skill，每项含 `{name, category, description, install_path, enabled_global, enabled_vonvon}`；即便 `_find_all_skills` 抛异常也返回空数组而非 500。
- [ ] **AC-S2** `POST /api/skills/toggle {name: "pptx", enabled: false, scope: "vonvon"}` 后 `~/.hermes/config.yaml:skills.platform_disabled.vonvon` 包含 `pptx`；`scope: "global"` 则写入 `skills.disabled`。
- [ ] **AC-S3** 关闭 vonvon 下的 skill 不影响 `skills.disabled` 全局列表；反之亦然（两个 scope 独立）。
- [ ] **AC-S4** `GET /api/skills/search?q=pptx&limit=5` 通过 hermes `unified_search` 返回 ≤5 条结果；hub 网络失败时返回空数组 + 日志告警，不抛 500。
- [ ] **AC-S5** `POST /api/skills/install {identifier: "official/pptx"}` 立即返回 `{job_id, status: "pending"}`（<300ms）；后续 `GET /api/skills/jobs/{job_id}` 轮询直到 `status` 为 `success` 或 `error`。
- [ ] **AC-S6** 安装成功后 `GET /api/skills` 响应包含新 skill 且 `enabled_vonvon === true`、`enabled_global === true`。
- [ ] **AC-S7** `POST /api/skills/uninstall?name=pptx` 同样返回 job，完成后 `GET /api/skills` 不再包含该项。
- [ ] **AC-S8** 超过 4 个并发 install/uninstall job → `POST /api/skills/install` 返回 `400 too many concurrent skill jobs`。
- [ ] **AC-S9** `GET /api/skills/updates` 返回 hermes `check_for_skill_updates()` 的结果；失败时 `{updates: [], error: "<msg>"}` 不抛 500。
- [ ] **AC-S10** UI `SkillsPanel` "发现" 标签的安装按钮在 job 运行时显示 spinner + "安装中…"，完成后自动切换到 "已安装" 并滚动到新条目。
- [ ] **AC-S11** 完成的 job 在 30 分钟后自动从 `_jobs` 表驱逐（通过 freeze time 测试验证 **并且** `get_job_status` 本身也会触发懒清理，不仅靠 `_create_job` 入口）。
- [ ] **AC-S12** (Critic CF-1 + CF-2) **Skill 即刻可用**: 调用 `install_bundle_silent("official/pptx")` 后，在不重启 backend 的前提下：(a) `GET /api/skills` 返回 `pptx`；(b) 同一进程中 **新建** 的 `AIAgent` 实例的 system prompt 包含 `pptx` 工具定义（通过测试 `prompt_builder` 构建结果断言，或 E2E 让 agent 自报工具列表）；(c) `WP1-D-fork-2` 的 signature gate 脚本运行通过（`python -c 'from tools.skills_hub import install_bundle_silent' && <inspect.signature 检查>`）。卸载路径同样 AC：`uninstall_skill("pptx")` 后 system prompt 重建不再含 `pptx`。
- [ ] **AC-S13** (Critic CF-2) `toggle_skill(name="pptx", enabled=False, scope="vonvon")` 调用后，`clear_skills_system_prompt_cache` 被调用一次（mock + spy 验证）；下一次 `_build_system_prompt(platform="vonvon")` 的返回不含 `pptx`。

### Workspace
- [ ] **AC-W1** 后端启动时若 `~/.hermes/config.yaml:vonvon.workspace` 未设置，则自动创建 `~/.vonvon/workdir/`（包含 `README.md`），并设置 `os.environ["TERMINAL_CWD"]` + `os.chdir` 到该目录；`GET /api/workspace` 返回 `{path: "~/.vonvon/workdir", is_sandbox: true}`。
- [ ] **AC-W2** `POST /api/workspace {path: "/Users/x/proj"}` 在 path 存在且是目录时返回 200 + `{is_sandbox: false}`；`os.environ["TERMINAL_CWD"]` **和** `os.getcwd()` 两者都等于该路径；`~/.hermes/config.yaml:vonvon.workspace` 被更新。
- [ ] **AC-W2b** (Critic MF-2) `_apply` 事务性：当 `os.chdir` 触发 `OSError`（例如 path 存在但无 execute 权限）时，`POST /api/workspace` 返回 400；`os.environ["TERMINAL_CWD"]` 保持为切换前的旧值（通过 fixture 断言）；`config.yaml:vonvon.workspace` 未被写入。
- [ ] **AC-W3** `POST /api/workspace` 传入不存在的路径 → 返回 400 `workspace path does not exist or is not a directory`；`_current_path` / `os.environ["TERMINAL_CWD"]` / `os.getcwd()` 均保持不变。
- [ ] **AC-W4** `POST /api/workspace/reset` 清除 `config.yaml:vonvon.workspace`，回到 `~/.vonvon/workdir/`，返回 `{is_sandbox: true}`。
- [ ] **AC-W5** 切换 workspace 后，在 vonvon 聊天里让 agent "read file in current dir" 能读到新目录下的文件（而不是 backend/）。通过手动 E2E 验证。
- [ ] **AC-W6** UI `WorkspacePanel` "选择目录..." 按钮弹出 Electron 原生文件夹选择对话框；取消时不触发任何 POST。
- [ ] **AC-W7** 当 `workspace.is_sandbox === true` 时，`ChatContainer` 顶部渲染黄色 banner "⚠️ 当前使用默认沙箱..." 且可点击跳转到 Settings；非沙箱状态下 banner 不渲染（React 测试验证）。
- [ ] **AC-W8** 并发请求 `POST /api/workspace` 与 `hermes` CLI 手动修改 `config.yaml` 不导致 yaml 损坏（靠 `config_store_lock`，和 AC-P6 同机制）。
- [ ] **AC-W9** (Critic MF-3 / DELTA-5) 防御性 `TERMINAL_CWD` 重置：测试 fixture 在调用 `POST /api/chat/send` 前用 `monkeypatch.setenv("TERMINAL_CWD", "/tmp/garbage-dir-that-exists")`；请求处理完成后断言 `os.environ["TERMINAL_CWD"]` 已被重置为 `workspace_service.current_state()["path"]`。同测试覆盖 `compress_context` 和 `sessions.create_session` 路径。
- [ ] **AC-W10** (Critic MF-3 / DELTA-6) Lifespan 顺序固化 SessionDB：测试构造一个 `workspace_service.set_workspace(/tmp/some_user_proj)` 被注入到 lifespan 执行 **之后**，断言 `agent_service._session_db.db_path` 仍是 `get_hermes_home() / "state.db"` 的绝对路径（不是相对当前 cwd 的 `./state.db`）。同时 `grep "Path\(\".\"\)" backend/app/ -r` 返回 0 行（确认没有 `.`-relative 路径落地）。

### Config safety & regression
- [ ] **AC-C1** 当 `backendEnabled === false` 时，`SettingsPanel` 渲染树与 v1 完全一致（通过 React snapshot 测试或手动 diff）。
- [ ] **AC-C2** v1.1 引入的 hermes fork 改动在 `pytest backend/hermes-agent/tests/` 下不回退现有用例（只增不改断言）。
- [ ] **AC-C3** 后端日志中 grep `sk-` / `refresh_token` 明文 → 0 次出现（观察性测试）。
- [ ] **AC-C4** 任何路由在处理请求时抛异常不会把敏感字段回写到响应 body（`HTTPException` detail 手工审查）。
- [ ] **AC-C5** (Critic Minor-3) hermes subtree 的 fork 改动集中在 5 个新/修改文件的最小加法；`git diff --numstat main -- backend/hermes-agent/ | awk '{added+=$1; removed+=$2} END {print added+removed}'` ≤ **600**（净增/减行数，不含 context/header lines）。
- [ ] **AC-C6** (DELTA-7) 事件循环健康：在后台并发运行 (a) 5 个 `POST /api/auth/credentials`、(b) 3 个 `POST /api/mcp/servers/{n}/test`、(c) 2 个 `GET /api/skills` 的同时，对 `GET /api/health` 的 p99 响应时间 < 200ms（意味着所有 fcntl/thread 阻塞工作都在 `asyncio.to_thread` 里跑，没有阻塞 event loop）。通过 `pytest backend/tests/test_event_loop_latency.py` 用 asyncio 压测验证。
- [ ] **AC-C7** (DELTA-4) `agent_service` 不再缓存 `_api_key`/`_base_url`；凭据解析 100% 走 `credential_pool`。`grep -nE "^_api_key|^_base_url" backend/app/services/agent_service.py` 应无匹配。
- [ ] **AC-C8** (Critic MF-1) `hermes_cli/config.py:save_config` 已通过 `utils.atomic_yaml_write` 做 tempfile + `os.replace` 原子写入（已验证，`backend/hermes-agent/hermes_cli/config.py:2062,2078`）。**不需要** 额外 hermes fork。`test_config_atomic.py` 回归：在 `os.replace` 调用前 kill 子进程模拟崩溃，下次 `load_config` 返回上一个完整版本（不是半写 yaml）。
- [ ] **AC-C9** (Critic M-7) `~/.hermes/` 无写权限场景：测试用 `chmod 500` 模拟只读 hermes home，调用 `POST /api/auth/credentials` → 返回 **503** `hermes home not writable: <path>` 而非 500 stack trace。backend 启动时如果 lifespan 发现 hermes home 不可写，`/api/health` 返回 `{status: "degraded", reason: "hermes_home_not_writable"}`。
- [ ] **AC-C10** (Critic M-3) Fresh start provider 解析：`_current_provider=""` 状态下（backend 首次启动，用户还没切 model），`POST /api/chat/send` 仍能成功 —— 因为 `AIAgent(api_key=None, base_url=None)` 会走 hermes 内部 `credential_pool.load_pool(model)` 解析。回归测试 mock credential_pool 断言 peek 被调。
- [ ] **AC-C11** (Critic M-6) Observability 密钥泄漏检测扩展：`test_log_safety.py` 对所有日志捕获 grep 以下模式并断言 **0 次出现**：`sk-`, `sk_`, `refresh_token`, `access_token`, `eyJ[A-Za-z0-9_-]{20,}` (JWT prefix), `Bearer `, `oauth_token`。

---

## Verification Plan

### 1. Unit / integration tests
```bash
cd backend
pytest tests/ -v                                       # WP1 + hermes fork
pytest tests/test_config_lock_concurrent.py -v         # concurrent save_config
pytest tests/test_api_auth.py::test_oauth_timeout -v   # flow expiry
```

### 2. Observability assertion
```bash
# After running full auth+mcp test suite, assert no secret leaked
pytest tests/test_log_safety.py::test_no_plaintext_secrets_in_logs
```

### 3. Manual AC walkthrough
1. 启动 backend: `cd backend && uvicorn app.main:app --port 8000`
2. 启动 frontend: `npm run dev`
3. 打开 Settings → 切换 `backendEnabled` on
4. 依次验证 AC-M1…AC-M4, AC-A1…AC-A11, AC-P1…AC-P7, AC-C1…AC-C4
5. 在 `docs/v1.1-qa-checklist.md` 中逐项勾选并截图

### 4. Regression
```bash
# v1 functionality still works
pytest backend/tests/test_chat.py backend/tests/test_sessions.py -v
npm run test -- --run src/renderer/hooks/useChat.test.tsx  # if exists
```

### 5. Upstream sync check
```bash
# After hermes fork changes, confirm subtree diff is minimal
git diff main -- backend/hermes-agent/ | diffstat
# Expect: +110 codex_device_flow.py, +85 config_lock.py, ~±50 auth.py/mcp_config.py
```

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **R1** Hermes fork diverges from upstream, next subtree pull conflicts | Med | High | Keep changes isolated to new files (`codex_device_flow.py`, `config_lock.py`); only minimal in-place edits in `auth.py`/`mcp_config.py`. Document changes in `backend/hermes-agent/HERMES-FORK-NOTES.md`. Prepare upstream PR for `config_lock` since it benefits CLI too. |
| **R2** OAuth flow state lost on backend restart (in-memory dict) | Med | Low | Accept — 15-min TTL anyway; UI shows "flow expired, restart" on error. Future enhancement: persist to `auth.json:oauth_flows` bucket. |
| **R3** `_probe_single_server` starts a global MCP asyncio loop; multiple concurrent probes may race | Low | Med | Wrap `mcp_service.probe_server` in a module-level `asyncio.Lock` (same pattern as `agent_service._agent_lock`). Noted in WP1-C. |
| **R4** User enters malformed MCP command; backend shell-executes it via hermes | Med | High | Never `shell=True`; command + args are passed as list to `_probe_single_server` which uses stdio transport (no shell). Validate `name` with regex; reject absolute paths in `command` unless user is explicitly warned. |
| **R5** Electron `shell.openExternal(verification_url)` on untrusted URL | Low | Med | Whitelist `verification_url` to `https://auth.openai.com/codex/device` in frontend before calling `openExternal`. |
| **R6** Listing credentials leaks `last4` of refresh tokens in memory | Low | Low | `_mask` only operates on `access_token`; `refresh_token` never appears in `_to_view`. Verified by test. |
| **R7** `list_authenticated_providers` hits models.dev remote → slow cold start | Low | Med | Already cached 1h in hermes; backend falls back to `AVAILABLE_MODELS` hardcoded list (v1) if call raises. Log warning. |
| **R8** 用户在 CLI 删除凭据后 UI 列表未刷新 | Low | Low | UI 在 focus 和每 30s 做一次 `listCredentials` 静默刷新；接受短暂 stale。 |
| **R9** `config.yaml` 锁在 NFS / Dropbox 挂载下 fcntl 不可靠 | Low | Med | 文档化："hermes home 必须位于本地 ext4/APFS/NTFS 分区"；锁失败时 WARN 日志 + 降级为 asyncio 单进程串行（不跨进程）。 |
| **R10** Skill hub 搜索需要 GitHub token 但用户没配置，`create_source_router` 降级只能搜本地 cache | Med | Low | `search_hub` 已 try/except 并返回空数组；UI 在 "发现" tab 空结果下显示 "未配置 GitHub token 或无匹配，查看文档配置 hub credential"。不阻断主流程。 |
| **R11** Skill install 半完成状态（文件部分写入，元数据未更新） | Med | Med | WP1-D 的 `_do_install` 外层 try/except 触发 `_do_uninstall` 做 best-effort 清理；`list_skills` 对 `_find_all_skills` 异常返回空数组并打 WARN；`docs/v1.1-qa-checklist.md` 包含手动清理步骤 `hermes skills remove <name>`。 |
| **R12** 长耗时 install job 阻塞整个 `skill-job` ThreadPoolExecutor（4 workers），用户发起第 5 个 install 时立即被拒 | Low | Low | `AC-S8` 明确提示；UI 队列化：安装按钮在有 running job 时置灰并显示 "有 N 个任务进行中"。接受当前 4 的上限（避免 IO 爆炸）。 |
| **R13** ~~~~`install_bundle` 实际签名与计划假设不符~~~~ — **已在 Critic 审查中解决**：WP1-D-fork-2 的 `install_bundle_silent` 已用 verified signatures 重写（`quarantine_bundle(bundle)` / `scan_skill(path, source=)` / `should_allow_install(result, force=)` / `install_from_quarantine(5 args)` / `HubLockFile` non-context-manager）。Pre-implementation signature gate script 强制执行。风险降级为 **已解决**。 |
| **R14** 后端 `os.chdir` 会改变全局进程状态，影响其它模块（例如 session db 的相对路径） | Low | Med | `SessionDB` 路径已用 `get_hermes_home()`（绝对路径），`_session_db` 在 `_apply` 前 lazy init；DELTA-6 eager 初始化在 lifespan；AC-W10 回归 `grep "Path\(\".\")" backend/app/ -r` 应为 0 行。切换 workspace 后 send_message 测试覆盖。 |
| **R15** 沙箱 `~/.vonvon/workdir/` 被 agent 写满磁盘（大文件 / git clone） | Low | Med | 文档化沙箱是调试用。**Critic M-2**: `install_bundle_silent` 在 `quarantine_bundle(bundle)` 之前加一道 bundle total size 检查 — 超过 50 MB 直接抛 `RuntimeError: skill bundle too large`（两行代码，见下方 DELTA CF-1 代码实现）。不做沙箱硬限制（留 v1.2 F8）。 |

---

## ADR (Architecture Decision Record)

### Decision
v1.1 的 Hermes 配置通过 **vonvon-backend 内新增 `/api/auth`、`/api/mcp`、`/api/skills`、`/api/workspace` 四组路由，并扩展 `/api/models`** 实现，所有路由都是对 `backend/hermes-agent/` subtree 内部函数的薄 HTTP adapter；hermes 本身做三项最小二次开发——(a) 拆分 `_codex_device_code_login` 为 `agent/codex_device_flow.py` 的 `start_device_flow`/`poll_device_flow` 纯函数，(b) 新增 `hermes_cli/config_lock.py` 文件锁并在 `mcp_config` / skills / workspace 写路径上使用，(c) 在 `hermes_cli/skills_config.py:PLATFORMS` 注册 `vonvon` 平台。后端启动 lifespan 新增 `workspace_service.init_from_hermes_config()`，把 hermes agent 的 `TERMINAL_CWD` 固定到用户配置的项目目录或 `~/.vonvon/workdir/` 沙箱。

### Drivers
1. 消除 CLI/UI 配置割裂（onboarding 阻断点）— 所有 hermes 配置（模型/认证/MCP/skills/workspace）都能从 vonvon UI 完成
2. 复用已经测试过的 hermes 函数，不重写认证/MCP/skills 逻辑
3. `~/.hermes` 作为凭据 + 配置的唯一来源，与 `hermes` CLI 互不覆盖
4. 修复 v1 workspace 漏洞：agent 之前默默用 `backend/` 作为 cwd，v1.1 必须让用户明确知道并能切换
5. 不回退 v1 直连模式的行为

### Alternatives Considered
- **B: Electron 主进程 spawn `hermes` CLI 子进程** — 破坏 v1 "后端唯一智能层" 架构、OAuth 无法 headless、Windows 体验差。
- **C: 前端直接读写 `~/.hermes/config.yaml`** — 破坏单一凭据存储、无 MCP probe 能力、绕过 credential_pool 锁。
- **D: v1.1 只做模型和 API Key，推迟 OAuth 和 MCP 到 v1.2** — 短期 win 但用户仍需打开终端，违反 v1.1 核心目标。

### Why Chosen (Option A)
- 继承 v1 `agent_service`/`session_service` 架构，改动面最小。
- 新增路由都是 pure HTTP adapter，有清晰 pytest 边界。
- 两处 hermes fork 都是 **加法**（新文件或拆分内部函数），CLI 外部行为不变。
- 与 `autopilot` v1.2 的打包路径兼容（PyInstaller 只需额外包含 `codex_device_flow.py` + `config_lock.py`）。

### Consequences
**Positive:**
- 前端 0 新 IPC 通道，全 HTTP；前端测试可用 `msw` mock 后端。
- 后端所有敏感操作在 `asyncio.Lock` + `file lock` 双层保护下；并发安全。
- OAuth 流被拆成纯函数后，未来支持 Anthropic PKCE 的模式同构。

**Negative:**
- 引入 hermes subtree 本地 patch — 需要在 `HERMES-FORK-NOTES.md` 跟踪并计划回馈 upstream。
- 新增一套 `config_store_lock` 需在所有 `save_config` 路径采纳才能真正保护；v1.1 仅强制在后端调用的路径使用，CLI 路径是 best-effort。
- `_active_flows` 在后端重启后丢失；15 分钟内用户必须重新开始 OAuth。

### Follow-ups
- **F1** 向 hermes upstream 提 PR：`config_store_lock`（纯工程改进，独立于 vonvon）
- **F2** 向 hermes upstream 提 PR：`codex_device_flow` 拆分（解耦 CLI I/O 与协议逻辑）
- **F3** v1.2：认证支持 Anthropic PKCE + Nous device code（同 pattern 扩展）
- **F4** v1.2：`_active_flows` 持久化到 `auth.json:oauth_flows`（解决 R2）
- **F5** v1.2：Electron 打包把 hermes fork 一起 PyInstaller
- **F6** v1.2：per-session workspace —— 目前 workspace 是 backend 进程级全局状态；v1.2 应把 workspace 存到 `SessionDB` 每行，`POST /api/chat/send` 前按 session 切换 cwd
- **F7** v1.2：`DELETE /api/skills/jobs/{job_id}` 取消运行中 job（P4 的 (c) 项）
- **F8** v1.2：Skill 安装的磁盘/时间限额 + 沙箱目录大小监控

---

## Changelog
- **2026-04-09 (init)** — Planner drafted initial deliberate plan (WP1-A/B/C, WP2, WP3; models + auth + MCP only)
- **2026-04-09 (skills)** — Added Skill 管理 scope (WP1-D + `SkillsPanel.tsx`), vonvon platform fork entry, long-running install job pattern (start/poll with ThreadPoolExecutor), ACs S1-S11, risks R10-R13, pre-mortem P4
- **2026-04-09 (workspace)** — Added Project Workspace scope (WP1-E), fixed v1 `TERMINAL_CWD` gap, `~/.vonvon/workdir/` sandbox fallback, Electron `dialog.showOpenDialog` IPC, `WorkspacePanel.tsx` + `SandboxBanner.tsx`, ACs W1-W8, risks R14-R15, pre-mortem P5, principle #6
- **2026-04-09 (architect-pass)** — Architect review **APPROVE-WITH-CHANGES**. Absorbed 7 DELTAs:
  - **DELTA-1** Replaced non-existent `tools.skills_hub.install_bundle` reference with proper `install_bundle_silent` thin wrapper (new WP1-D-fork-2 in hermes subtree, ~80 lines)
  - **DELTA-2** Added `_probe_lock: asyncio.Lock` in `mcp_service` + `asyncio.to_thread` wrapping around `_probe_single_server`; made `add_server/remove_server/probe_server` async; added `test_concurrent_mcp_probe.py`
  - **DELTA-3** Upgraded `config_store_lock` from "best-effort" to **mandatory** on all hermes write paths the backend transitively touches (`mcp_config.py` 3 sites, `skills_config.save_disabled_skills`, `auth.py:_interactive_strategy`)
  - **DELTA-4** Removed `agent_service._api_key`/`_base_url` memory caches; all credential resolution now delegates to `credential_pool.peek()` per request. Added `AC-C7`
  - **DELTA-5** Added defensive `os.environ["TERMINAL_CWD"] = workspace_service.current_state()["path"]` at entry of `chat.py:send_message`, `chat.py:compress_context`, `sessions.py:create_session`
  - **DELTA-6** Lifespan order fixed: `agent_service.init_from_hermes_config()` → `workspace_service.init_from_hermes_config()` → **eager** `agent_service.get_session_db()` so SessionDB locks onto absolute path before any request-time relative path leaks
  - **DELTA-7** Event-loop hygiene: every service function that touches fcntl or disk is wrapped in `asyncio.to_thread` (auth, skills, workspace, mcp, agent.switch_model). Added `AC-C6` p99 < 200ms under mixed concurrent load via `test_event_loop_latency.py`
- **2026-04-09 (critic-pass)** — Critic review **ITERATE** with 2 CRITICAL + 5 MAJOR + 7 Minor. Absorbed all 12 must-fix items:
  - **CF-1** (CRITICAL) Rewrote `install_bundle_silent` against **verified** hermes signatures: `quarantine_bundle(bundle)`, `scan_skill` from `tools.skills_guard`, `should_allow_install(result, force=)` (no `assume_yes`), `install_from_quarantine(path, name, cat, bundle, result)`, `HubLockFile` non-context-manager. Added pre-implementation signature gate script. Added AC-S12 (signature verification + skill即刻可用 E2E)
  - **CF-2** (CRITICAL) Added `clear_skills_system_prompt_cache(clear_snapshot=True)` calls in `install_bundle_silent`, `_do_uninstall`, and `_toggle_skill_sync` so skills become visible/hidden in the current session without restart. Added AC-S13 toggle invalidation
  - **MF-1** (MAJOR) Verified `hermes_cli/config.py:save_config` already uses `atomic_yaml_write` (tempfile + os.replace) — no hermes fork needed. Added P6 pre-mortem + AC-C8 atomic write regression test
  - **MF-2** (MAJOR) Rewrote `workspace_service._apply` as a transaction: chdir first (fail-fast), then env update, with rollback on either failure. `set_workspace` no longer persists if `_apply` raises. Added AC-W2b failure-rollback test
  - **MF-3** (MAJOR) Added AC-S12, AC-P8, AC-P9, AC-P10, AC-W9, AC-W10 to directly test every DELTA (signature/probe-concurrency/probe-serial-latency/cli-ui-lock/TERMINAL_CWD-reset/lifespan-order)
  - **MF-4** (MAJOR) `_probe_lock` documented as global serialization with `_PROBE_TIMEOUT_SECONDS=10` UX cap; AC-P9 enforces <60s for 5 concurrent probes
  - **MF-5** (MAJOR) `poll_device_flow` now returns `pending` on token-exchange 5xx and carries `pending_exchange` (authorization_code + code_verifier) in `OAuthFlowState` for retry on next poll. Added AC-A12
  - **MF-6** (MAJOR) `agent_service.switch_model` guards empty `target_provider`/`new_model` from `ModelSwitchResult` so alias-on-current-provider edge case doesn't clobber `_current_provider`
  - **Minor-2** `config_store_lock` re-entrancy migrated from `threading.local` to `contextvars.ContextVar` for correctness under `asyncio.to_thread`
  - **Minor-3** `AC-C5` fork-size gate switched from `wc -l` to `--numstat` net delta (≤600)
  - **Minor-5** Removed P4 mitigation (c) "cancel button"; F7 is the single source of truth for v1.2
  - **M-2** `install_bundle_silent` adds 50 MB bundle size cap (R15 mitigation on-plan, not deferred)
  - **M-3** Added AC-C10 fresh-start provider resolution via `credential_pool.peek()` with `AIAgent(api_key=None)`
  - **M-4** `HermesAuthPanel.tsx` / `WorkspacePanel.tsx` must whitelist `shell.openExternal` / `showItemInFolder` URLs/paths before invoking Electron native
  - **M-6** `test_log_safety.py` grep list expanded to include `eyJ[...]` JWT prefix, `Bearer `, `oauth_token`, `sk_`, `access_token`, `refresh_token`
  - **M-7** AC-C9 covers read-only hermes home → 503 (not 500) + `/api/health` degraded status
  - **R13** downgraded to RESOLVED (superseded by verified CF-1 signatures)
  - Added 9 new test files for these deltas; total file change summary now 41 new / 14 modify / ~4850 lines
- **2026-04-09 (architect-iter2)** — Architect re-review **APPROVE** with 3 minor follow-ups absorbed without new DELTA:
  - UTF-8 byte counting in `install_bundle_silent` 50MB guard (`len(content.encode("utf-8"))` for str content)
  - `_toggle_skill_sync` cache clear moved **inside** `config_store_lock` block to close stale-cache window
  - `poll_codex_oauth_flow` added `state.status = "polling"` dedup gate + extracted credential persistence into `asyncio.to_thread`, preventing concurrent double-poll from issuing duplicate token exchange POSTs. Added AC-A13 for the 3-concurrent-poll scenario
