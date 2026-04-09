# Implementation Plan: vonvon Agent Integration (v2 Architecture)

## Spec Reference
`.omc/specs/deep-interview-vonvon-agent.md` (updated with Python backend architecture)

## RALPLAN-DR Summary

### Principles
1. **前端不改已有代码** — 只增量添加新组件，现有 Chat/Settings/Kirby 逻辑不动
2. **后端是唯一智能层** — Python 后端封装 hermes-agent，前端是纯展示
3. **复用优先** — 复用 hermes SessionDB、AIAgent 回调、上下文压缩器，不造轮子
4. **可独立测试** — 后端 pytest 测试不依赖 Electron，前端可 mock 后端 API
5. **hermes 可二次开发** — 必要时修改 hermes-agent 源码（优先封装层解决）

### Decision Drivers
1. 后端直接 import AIAgent（零 HTTP 开销，完整 10+ callback 支持）
2. 复用 hermes SessionDB（SQLite + FTS5，含完整工具调用历史）
3. SSE 事件流驱动前端 UI（tool cards + streaming + usage）

### Options Evaluated
| | Option A: Python 后端 + import AIAgent (chosen) | Option B: 直连 hermes API server |
|---|---|---|
| Pros | 完整回调、自定义 API、会话管理自由 | 零后端代码、即用 |
| Cons | 需维护后端服务 | API 受限（/v1/runs 不支持 conversation）、无法自定义 |
| Verdict | **Selected** — 满足所有 AC | Rejected — AC-8/10/11 无法实现 |

---

## Architecture

```
vonvon (Electron)                vonvon-backend (Python)           hermes-agent
┌────────────────┐              ┌─────────────────────┐           ┌────────────┐
│ React UI       │   HTTP/SSE   │ FastAPI :8000        │  import   │ AIAgent    │
│ (已有+增量)     │◄───────────►│                     │──────────►│ 68 tools   │
│                │              │ routes/              │           │ MCP        │
│ Main Process   │              │  chat.py (SSE)       │           │ Memory     │
│  Kirby Native  │              │  models.py           │           │ Skills     │
│  IPC proxy     │              │  config.py           │           │ SessionDB  │
└────────────────┘              │                     │           └────────────┘
                                │ services/            │
                                │  agent_service.py    │
                                │  session_service.py  │
                                └─────────────────────┘
```

---

## WP1: Python Backend Service

### 目录结构
```
backend/
├── pyproject.toml           # deps: hermes-agent, fastapi, uvicorn, sse-starlette
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI app, lifespan, CORS
│   ├── config.py            # 配置（hermes home、model、port）
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── chat.py          # 对话 API（核心）
│   │   ├── models.py        # 模型列表/切换
│   │   └── sessions.py      # 会话 CRUD
│   ├── services/
│   │   ├── __init__.py
│   │   ├── agent_service.py # AIAgent 封装
│   │   └── session_service.py # 会话管理（复用 hermes SessionDB）
│   └── schemas.py           # Pydantic models
└── tests/
    ├── test_chat.py
    ├── test_sessions.py
    └── conftest.py           # pytest fixtures, mock AIAgent
```

### API Endpoints

> **Spec 路由差异说明**: Spec 中使用 `/api/chat/*` 统一路由。Plan 改为 RESTful
> 资源路径 `/api/sessions/*` 用于会话管理，因为会话是独立资源实体。
> 映射: spec `/api/chat/new` → plan `POST /api/sessions`,
> spec `/api/chat/reset` → plan `POST /api/sessions/{id}/reset`。
> `/api/chat/send` 和 `/api/chat/compress` 保留在 chat 路径下（操作语义）。

```
POST   /api/chat/send           ← 发消息，SSE 返回事件流
POST   /api/chat/compress       ← 手动压缩上下文
GET    /api/sessions            ← 会话列表
POST   /api/sessions            ← 新建会话
DELETE /api/sessions/{id}       ← 删除会话
POST   /api/sessions/{id}/reset ← 重置会话（清空消息，保留会话）
GET    /api/sessions/{id}/usage ← 当前会话上下文使用百分比
GET    /api/models              ← 可用模型列表
POST   /api/models/current      ← 切换当前模型
GET    /api/health              ← 健康检查 + 连接状态
```

### Key: `POST /api/chat/send` (SSE)

```python
# routes/chat.py
@router.post("/api/chat/send")
async def send_message(req: ChatRequest):
    """发送消息，返回 SSE 事件流"""
    # req: {session_id: str, message: str}

    async def event_generator():
        queue = asyncio.Queue()

        def on_delta(delta):
            if delta is not None:
                queue.put_nowait({"event": "message.delta", "data": {"delta": delta}})

        def on_tool_progress(event_type, tool_name, preview, args, **kwargs):
            if event_type == "tool.started":
                queue.put_nowait({"event": "tool.started", "data": {
                    "tool": tool_name, "preview": preview or tool_name
                }})
            elif event_type == "tool.completed":
                queue.put_nowait({"event": "tool.completed", "data": {
                    "tool": tool_name,
                    "duration": round(kwargs.get("duration", 0), 3),
                    "error": kwargs.get("is_error", False)
                }})

        def on_thinking(text):
            queue.put_nowait({"event": "reasoning", "data": {"text": text}})

        # Load session history from SessionDB
        session = session_service.get_session(req.session_id)
        history = session_service.get_messages(req.session_id)

        # Run agent in thread, serialized via lock (AIAgent is not thread-safe)
        async def run_agent():
         try:
          async with agent_service._agent_lock:
            agent = agent_service.create_agent(
                session_id=req.session_id,
                stream_delta_callback=on_delta,
                tool_progress_callback=on_tool_progress,
                thinking_callback=on_thinking,
            )
            result = await asyncio.to_thread(
                agent.run_conversation,
                user_message=req.message,
                conversation_history=history,
            )
            # Emit completion with usage
            # NOTE: use last_prompt_tokens (last API call's prompt size),
            # NOT total_tokens (cumulative across all API calls in session)
            prompt_tokens = result.get("last_prompt_tokens", 0)
            model_ctx = agent_service.get_model_context_size()
            usage_pct = round(prompt_tokens / model_ctx * 100) if model_ctx else 0

            # Check session_id drift (hermes compression creates new session)
            new_session_id = getattr(agent, 'session_id', req.session_id)

            queue.put_nowait({"event": "run.completed", "data": {
                "output": result.get("final_response", ""),
                "usage_percent": usage_pct,
                "prompt_tokens": prompt_tokens,
                "context_size": model_ctx,
                "session_id": new_session_id,  # may differ if compressed
            }})
            queue.put_nowait(None)  # sentinel
         except Exception as exc:
            queue.put_nowait({"event": "run.failed", "data": {"error": str(exc)}})
            queue.put_nowait(None)  # sentinel — 确保 event_generator 不会永久挂起

        task = asyncio.create_task(run_agent())

        while True:
            item = await queue.get()
            if item is None:
                break
            yield f"event: {item['event']}\ndata: {json.dumps(item['data'])}\n\n"

    return EventSourceResponse(event_generator())
```

### Key: `agent_service.py`

```python
# services/agent_service.py
# 前置条件: pip install -e /path/to/hermes-agent (editable install)
import asyncio
from run_agent import AIAgent
from hermes_state import SessionDB

_session_db = None
_current_model = "anthropic/claude-sonnet-4-20250514"
_base_url = None   # 从 hermes config 读取
_api_key = None    # 从 hermes config 读取

# 请求序列化锁 — AIAgent 非线程安全，同一时刻只允许一个 run_conversation
_agent_lock = asyncio.Lock()

def get_session_db() -> SessionDB:
    global _session_db
    if _session_db is None:
        _session_db = SessionDB()
    return _session_db

def create_agent(session_id: str, **callbacks) -> AIAgent:
    """每次请求创建新 AIAgent 实例（轻量），但通过 _agent_lock 保证串行执行"""
    return AIAgent(
        model=_current_model,
        base_url=_base_url,
        api_key=_api_key,
        session_id=session_id,
        session_db=get_session_db(),
        platform="vonvon",
        quiet_mode=True,
        **callbacks,
    )

def get_model_context_size() -> int:
    from agent.model_metadata import get_model_context_length
    return get_model_context_length(_current_model, base_url=_base_url or "",
                                    api_key=_api_key or "")

def switch_model(model: str):
    global _current_model
    _current_model = model

def init_from_hermes_config():
    """启动时从 ~/.hermes/config.yaml 读取 model/base_url/api_key"""
    global _current_model, _base_url, _api_key
    from hermes_cli.config import load_config
    cfg = load_config()
    # ... 从 cfg 中提取 model, base_url, api_key
```

### Key: `session_service.py`

```python
# services/session_service.py
# 复用 hermes SessionDB — 会话+消息+工具调用链全部存在 hermes 的 state.db

def get_session_db():
    return agent_service.get_session_db()

def list_sessions() -> list:
    db = get_session_db()
    return db.list_sessions_rich(source="vonvon")  # 正确方法名

def create_session(name: str) -> dict:
    db = get_session_db()
    session_id = str(uuid.uuid4())
    db.create_session(session_id, source="vonvon", model=agent_service._current_model)
    db.set_session_title(session_id, name)  # 已有方法，无需二次开发
    return {"id": session_id, "name": name}

def get_messages(session_id: str) -> list:
    """从 SessionDB 读取完整会话历史（含工具调用链）"""
    db = get_session_db()
    return db.get_messages_as_conversation(session_id)
    # hermes SessionDB 已存储完整 messages（包含 tool_calls + tool results）
    # AIAgent.run_conversation 会在每个 exit path 调用 _persist_session()
    # 写入 user/assistant/tool 所有消息类型

def reset_session(session_id: str):
    """清空会话消息但保留会话记录"""
    db = get_session_db()
    db.clear_messages(session_id)  # 已存在 (hermes_state.py:1225)

def delete_session(session_id: str):
    db = get_session_db()
    db.delete_session(session_id)

def get_usage(session_id: str) -> dict:
    """当前会话的上下文使用百分比"""
    db = get_session_db()
    messages = db.get_messages_as_conversation(session_id)
    # 粗估 token 数
    from agent.model_metadata import estimate_tokens_rough  # 正确函数名
    total_tokens = sum(estimate_tokens_rough(m.get("content", "") or "") for m in messages)
    ctx_size = agent_service.get_model_context_size()
    return {
        "usage_percent": round(total_tokens / ctx_size * 100) if ctx_size else 0,
        "total_tokens": total_tokens,
        "context_size": ctx_size,
    }
```

### Key: 上下文压缩

**策略**: AIAgent 内置自动压缩（token 超限时自动触发）。手动压缩通过
hermes 二次开发 `AIAgent.manual_compress()` 实现，或实例化 ContextCompressor。

```python
# routes/chat.py
@router.post("/api/chat/compress")
async def compress_context(req: CompressRequest):
    """手动触发上下文压缩 — 使用 ContextCompressor 直接压缩"""
    # req: {session_id: str}
    from agent.context_compressor import ContextCompressor

    compressor = ContextCompressor(
        model=agent_service._current_model,
        base_url=agent_service._base_url or "",
        api_key=agent_service._api_key or "",
    )
    messages = session_service.get_messages(req.session_id)
    compressed = await asyncio.to_thread(compressor.compress, messages)

    # replace_messages: hermes 二次开发（必须）— DELETE + INSERT
    session_service.replace_messages(req.session_id, compressed)

    usage = session_service.get_usage(req.session_id)
    return {"compressed": True, **usage}
```

**压缩方案决策**: 选定方案 B（直接用 ContextCompressor），因为不需要修改 AIAgent 核心类。
唯一的 hermes 二次开发依赖是 `SessionDB.replace_messages(session_id, msgs)`（简单的 DELETE + INSERT SQL）。
方案 A（AIAgent.manual_compress）和方案 C 不采用。

### hermes-agent API 验证结果 (Architect Review)

| 功能 | hermes 实际 API | 状态 |
|------|----------------|------|
| `SessionDB.clear_messages(session_id)` | **已存在** (`hermes_state.py:1225`) | ✅ 无需开发 |
| `SessionDB.list_sessions_rich(source=)` | 实际方法名（非 `list_sessions`） | ✅ 直接用 |
| `SessionDB.get_messages_as_conversation(id)` | 已存在，返回 OpenAI 格式 (`hermes_state.py:951`) | ✅ 直接用 |
| `SessionDB.delete_session(id)` | 已存在 (`hermes_state.py:1237`) | ✅ 直接用 |
| 会话 display name | 已有 `set_session_title/get_session_title` | ✅ 直接用 |
| `SessionDB.replace_messages(session_id, msgs)` | 不存在 | ⚠️ 需二次开发 |
| `AIAgent.manual_compress()` | 不存在 | ⚠️ 考虑二次开发 |

### hermes-agent 关键 API 签名修正

```python
# ❌ 计划中的错误假设 → ✅ 实际签名

# 1. Session 列表
# ❌ db.list_sessions(source="vonvon")
# ✅ db.list_sessions_rich(source="vonvon", limit=50, offset=0)
#    返回: [{id, source, model, title, started_at, ended_at, message_count, preview, last_active}]

# 2. Token 估算
# ❌ from agent.model_metadata import estimate_tokens
# ✅ from agent.model_metadata import estimate_tokens_rough  (len(text)//4 粗估)

# 3. 模型上下文长度
# ❌ get_model_context_length(model)  (仅传 model 可工作但不精确)
# ✅ get_model_context_length(model, base_url="", api_key="", provider="")

# 4. 上下文压缩
# ❌ from agent.context_compressor import compress_conversation (不存在)
# ✅ from agent.context_compressor import ContextCompressor
#    compressor = ContextCompressor(model=, base_url=, api_key=)
#    compressed = compressor.compress(messages, current_tokens=)

# 5. Usage 百分比
# ❌ total_tokens / ctx_size  (total_tokens 是累计值)
# ✅ result["last_prompt_tokens"] / ctx_size  (最后一次 API 调用的 prompt tokens)
```

### 关键架构修正

**压缩策略**: 手动压缩使用方案 B（直接实例化 ContextCompressor），见上方代码示例和决策声明。自动压缩依赖 AIAgent 内置逻辑（token 超限时自动触发）。方案 A/C 不采用。

**Session ID 漂移**: hermes 自动压缩时会 end old session + create new session(parent=old)。
后端需在 run_conversation 返回后检查 agent.session_id 是否变化，若变化则通过 SSE 事件通知前端更新。

**线程安全**: AIAgent 非线程安全。每次请求创建新 AIAgent 实例，通过 `asyncio.Lock` 序列化请求（见 agent_service.py 中的 `_agent_lock`），同一时刻只允许一个 `run_conversation` 执行。

**Import 路径**: 使用 `pip install -e /path/to/hermes-agent`（editable install），不用 `sys.path.insert`。

---

## WP2: Electron 前端增量（不改已有代码）

### 新增组件

**`src/renderer/components/Chat/ToolCard.tsx`** (~80 lines)
- 单行紧凑卡片：`🔍 web_search ✓ 1.2s`
- 三态：running（spinner）/ completed（✓ + 耗时）/ failed（✗ 红色）
- Kirby 粉色主题边框

**`src/renderer/components/Session/SessionSwitcher.tsx`** (~100 lines)
- 顶部下拉：当前会话名 ▼
- 下拉列表：会话列表 + [+新建] + [🗑管理]
- 调用后端 API: GET /api/sessions, POST /api/sessions, DELETE

**`src/renderer/components/Chat/UsageBar.tsx`** (~40 lines)
- 底栏细条：显示上下文窗口使用百分比
- 颜色渐变：绿(<60%) → 黄(60-80%) → 橙(80-95%) → 红(>95%)
- 文本：`42% context used`

**`src/renderer/components/Chat/CompressHint.tsx`** (~50 lines)
- 80-95%: 黄色横幅 "上下文较满，建议压缩" + [压缩] 按钮
- >95%: 自动触发压缩（调用后端 API），显示 "正在压缩..."
- 压缩完成后更新 UsageBar

**`src/renderer/components/Settings/BackendSettings.tsx`** (~60 lines)
- 后端 URL 输入（默认 http://localhost:8000）
- 测试连接按钮 → GET /api/health
- 连接状态指示器

### 新增 Hooks

**`src/renderer/hooks/useBackend.ts`** (~50 lines)
- `backendUrl`, `isConnected`, `testConnection()`
- 封装所有后端 API 调用（fetch wrapper）
- SSE 连接管理

**`src/renderer/hooks/useSession.ts`** (~60 lines)
- `sessions`, `activeSession`, `createSession()`, `switchSession()`, `deleteSession()`, `resetSession()`

**`src/renderer/hooks/useAgentChat.ts`** (~80 lines)
- 独立于现有 `useChat`（不修改它）
- 管理 hermes agent 模式的消息流
- 监听 SSE 事件 → 更新 messages state（含 ToolCard 数据）
- `sendMessage()` → POST /api/chat/send → 解析 SSE
- `usagePercent` state，从 run.completed 事件更新

### 修改的文件（最小改动）

**`src/main/ipc.ts`** (+10 lines)
- 仅添加后端 URL 配置的 get/set handler
- 不改现有 chat:send 逻辑

**`src/main/store.ts`** (+15 lines)
- `StoreSchema` 接口添加: `backendUrl: string`（默认 `"http://localhost:8000"`）、`backendEnabled: boolean`（默认 `false`）
- defaults 添加对应默认值
- 新增 `async getBackendConfig(): Promise<{url: string, enabled: boolean}>`
- 新增 `async setBackendConfig(config: Partial<{url, enabled}>): Promise<void>`

**`src/preload/index.ts`** (+10 lines)
- 暴露 backendUrl get/set 方法
- 不改现有 allowedChannels

**`src/renderer/App.tsx`** (+15 lines)
- 根据 backendEnabled 切换显示模式：
  - hermes 模式：SessionSwitcher + AgentChat + UsageBar
  - 直连模式：现有 UI 不变

**注意**：前端直接通过 fetch 调后端 API（不走 Electron IPC），因为后端是独立 HTTP 服务。IPC 仅用于读写后端 URL 配置。

---

## WP3: Integration + Lifecycle

### 启动流程
```
1. 用户启动 vonvon (Electron)
2. Electron 读取 store 中的 backendUrl
3. 如果 backendEnabled:
   a. fetch GET /api/health
   b. 连接成功 → 显示 hermes 模式 UI
   c. 连接失败 → 显示 "后端未连接" 提示 + 设置入口
4. 如果 !backendEnabled:
   a. 显示现有直连模式 UI
```

### 开发阶段启动
```bash
# Terminal 1: 启动后端
cd vonvon/backend
pip install -e ".[dev]"
pip install -e /path/to/hermes-agent  # editable install
uvicorn app.main:app --port 8000

# Terminal 2: 启动前端
cd vonvon
npm run dev
```

---

## File Change Summary

| File | Action | Est. Lines | WP |
|------|--------|-----------|-----|
| **Backend (新建)** | | | |
| `backend/pyproject.toml` | NEW | ~30 | WP1 |
| `backend/app/main.py` | NEW | ~50 | WP1 |
| `backend/app/config.py` | NEW | ~30 | WP1 |
| `backend/app/schemas.py` | NEW | ~40 | WP1 |
| `backend/app/routes/chat.py` | NEW | ~120 | WP1 |
| `backend/app/routes/sessions.py` | NEW | ~60 | WP1 |
| `backend/app/routes/models.py` | NEW | ~40 | WP1 |
| `backend/app/services/agent_service.py` | NEW | ~80 | WP1 |
| `backend/app/services/session_service.py` | NEW | ~100 | WP1 |
| `backend/tests/test_chat.py` | NEW | ~80 | WP1 |
| `backend/tests/test_sessions.py` | NEW | ~60 | WP1 |
| **Frontend (新建)** | | | |
| `src/renderer/components/Chat/ToolCard.tsx` | NEW | ~80 | WP2 |
| `src/renderer/components/Session/SessionSwitcher.tsx` | NEW | ~100 | WP2 |
| `src/renderer/components/Chat/UsageBar.tsx` | NEW | ~40 | WP2 |
| `src/renderer/components/Chat/CompressHint.tsx` | NEW | ~50 | WP2 |
| `src/renderer/components/Settings/BackendSettings.tsx` | NEW | ~60 | WP2 |
| `src/renderer/hooks/useBackend.ts` | NEW | ~50 | WP2 |
| `src/renderer/hooks/useSession.ts` | NEW | ~60 | WP2 |
| `src/renderer/hooks/useAgentChat.ts` | NEW | ~80 | WP2 |
| **Frontend (最小修改)** | | | |
| `src/renderer/App.tsx` | MODIFY | +15 | WP2 |
| `src/main/store.ts` | MODIFY | +10 | WP2 |
| `src/main/ipc.ts` | MODIFY | +10 | WP2 |
| `src/preload/index.ts` | MODIFY | +10 | WP2 |
| **hermes-agent 二次开发（如需）** | | | |
| `hermes_state.py` | MODIFY | +30 | WP1 |
| **Total** | 19 new, 4 modify (+1 hermes) | **~1345** | |

---

## AC Coverage

| AC | How Verified | WP |
|----|-------------|-----|
| AC-1 多步工具链 | 发送"搜索AI新闻" → SSE 返回 tool.started/completed → ToolCard 渲染 | WP1+2 |
| AC-2 MCP 集成 | hermes 配置 MCP → vonvon 中工具卡片展示 MCP 工具调用 | WP1 (transparent) |
| AC-3 记忆持久化 | "记住我喜欢简洁" → 新会话 → 验证记忆生效 | WP1 (transparent) |
| AC-4 流式响应 | message.delta 事件 → 逐 token 显示 | WP1+2 |
| AC-5 ChatGPT OAuth | hermes model 配置 Codex → vonvon 对话正常 | WP1 (transparent) |
| AC-6 多会话 | SessionSwitcher 创建/切换/删除 | WP1+2 |
| AC-7 新建会话 | [+] 按钮 → POST /api/sessions → 切换 | WP2 |
| AC-8 重置会话 | [🔄] → POST /api/sessions/{id}/reset → 清空 | WP1+2 |
| AC-9 模型切换 | 下拉 → POST /api/models/current | WP1+2 |
| AC-10 Usage | run.completed 返回 usage_percent → UsageBar 显示 | WP1+2 |
| AC-11 上下文压缩 | 80% CompressHint 提示 / 95% 自动 / 手动按钮 | WP1+2 |
| AC-12 连接管理 | BackendSettings 配置 URL + 状态指示 | WP2 |
| AC-13 不回退 | App.tsx 模式切换，直连模式代码不改 | WP2 |

## Verification Plan

```bash
# 1. 后端单元测试（不依赖 Electron）
cd backend && pytest tests/ -v

# 2. 后端集成测试（需 hermes-agent 可 import）
pytest tests/test_chat.py -k "integration" --hermes-home ~/.hermes

# 3. 手动 AC 验证
# 启动后端: uvicorn app.main:app --port 8000
# 启动前端: npm run dev
# 逐项验证 AC-1 到 AC-13
```

## Team Execution Split

| Agent | Scope | Files |
|-------|-------|-------|
| **agent-1** | WP1 后端: FastAPI + services + hermes 集成 | backend/* |
| **agent-2** | WP2 前端: 新增组件 + hooks | renderer 新文件 |
| **agent-3** | WP2 前端: 最小修改 + 集成 | App.tsx, store, ipc, preload |
| **agent-4** | WP1 测试 + hermes 二次开发 | tests/*, hermes_state.py |

agent-1 和 agent-2 可并行（前后端独立）。agent-3 依赖 agent-2 的 hooks。agent-4 依赖 agent-1 确认哪些 hermes 方法需要添加。
