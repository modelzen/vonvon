# Deep Interview Spec: vonvon Agent Integration

## Metadata
- Interview ID: vonvon-agent-2026-04-09
- Rounds: 8
- Final Ambiguity Score: 13%
- Type: brownfield
- Generated: 2026-04-09
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.95 | 0.35 | 0.333 |
| Constraint Clarity | 0.85 | 0.25 | 0.213 |
| Success Criteria | 0.80 | 0.25 | 0.200 |
| Context Clarity | 0.85 | 0.15 | 0.128 |
| **Total Clarity** | | | **0.873** |
| **Ambiguity** | | | **13%** |

## Goal

将 vonvon 从一个简单的 LLM 聊天客户端升级为 **hermes-agent 的桌面前端**，通过 hermes-agent 的 OpenAI 兼容 API server 获得完整的 agent 能力（68 工具、MCP、Memory、Skills、ChatGPT OAuth），而不是自己实现 agent 逻辑。

## Architecture

```
vonvon (Electron + React)         vonvon-backend (Python)          hermes-agent
┌──────────────────────┐         ┌───────────────────────┐        ┌──────────────┐
│  Renderer (React)    │         │  FastAPI/aiohttp      │        │              │
│  ├─ SessionSwitcher  │  HTTP   │  ├─ /api/chat/send    │ import │  AIAgent     │
│  ├─ ToolCard         │  SSE    │  ├─ /api/chat/new     │───────►│  68 tools    │
│  ├─ UsageBar         │◄──────►│  ├─ /api/chat/reset   │        │  MCP servers │
│  ├─ ModelSelector    │         │  ├─ /api/chat/compress │        │  Memory      │
│  ├─ CompressHint     │         │  ├─ /api/models       │        │  Skills      │
│  └─ SettingsPanel    │         │  ├─ /api/chat/usage   │        │  OAuth       │
│                      │         │  └─ /api/health       │        │  SessionDB   │
│  Main Process        │         │                       │        └──────────────┘
│  └─ Kirby Native     │         │  Services             │
└──────────────────────┘         │  ├─ AgentService      │  ← import AIAgent
                                 │  ├─ SessionService    │  ← 复用 hermes SessionDB
                                 │  └─ UsageTracker      │
                                 └───────────────────────┘
```

### Architecture Change Log (Round 8+)
- **v1 原方案**: vonvon 直连 hermes-agent API（/v1/runs）
- **v2 修订**: 新增 vonvon-backend Python 封装层，直接 import hermes-agent AIAgent
- **原因**: hermes API 功能受限（/v1/runs 不支持 conversation），且需要自定义会话管理、上下文压缩、用量追踪等功能
- **后端定位**: hermes-agent 封装层，不是独立 agent 框架

## Constraints

- **前端**: vonvon Electron + React，纯 UI 层，不实现 agent 逻辑
- **后端**: vonvon-backend（Python），hermes-agent 封装层，直接 import AIAgent
- **通信**: 前端 ←HTTP/SSE→ 后端，后端 ←import→ hermes-agent
- **AI Provider**: ChatGPT OAuth（通过 hermes-agent 的 Codex device code flow 支持）
- **后端 API**: 自定义 RESTful + SSE，按需设计（不受 hermes API 限制）
- **会话管理**: 后端自行管理，复用 hermes SessionDB（SQLite + FTS5）
- **上下文压缩**: 混合模式 — 80% 提示用户，95% 自动压缩，支持手动触发
- **Usage 显示**: 当前会话上下文窗口使用百分比
- **分阶段部署**:
  - v1 开发: 用户本地安装 hermes-agent + vonvon-backend，分别启动
  - v1 发布: Electron 内嵌打包 Python 后端（PyInstaller 或 embedded Python）
- **保留现有功能**: 现有 OpenAI/Anthropic 直连 provider 保留作为简单聊天模式
- **可自行测试**: 后端 API 可独立测试（pytest），无需启动 Electron

## Non-Goals

- 不自己实现 agent loop / 工具系统 / MCP / Memory（复用 hermes-agent）
- 不在 v1 开发阶段做 Electron 内嵌打包（v1 发布阶段做）
- 不做移动端适配（macOS only）
- 不做远端多用户部署（v1 仅本地）

## Secondary Development Policy
- **hermes-agent 可以二次开发**（如需扩展 API、修复 bug、增加回调）
- vonvon-backend 直接 import hermes-agent 源码（非 pip 包），便于修改
- 二次开发优先通过封装层解决，必要时才改 hermes-agent 核心代码

## Acceptance Criteria

### Agent 核心
- [ ] **AC-1 多步工具链**: 输入「搜索 XX 的最新新闻并总结」，agent 自主调用 web_search → web_extract → 返回总结，UI 展示每步工具执行状态（tool.started/completed 卡片）
- [ ] **AC-2 MCP 集成**: 在 hermes-agent 配置一个 MCP server（如 filesystem），vonvon 中 agent 能调用 MCP 提供的工具
- [ ] **AC-3 记忆持久化**: 跨会话记住用户偏好/信息，下次对话时能引用之前的记忆
- [ ] **AC-4 流式响应**: 逐 token 展示 agent 回复，不是等全部完成才显示
- [ ] **AC-5 ChatGPT OAuth**: 通过 hermes-agent 的 Codex auth 使用 ChatGPT 订阅

### 会话管理 UI
- [ ] **AC-6 多会话**: 顶部 SessionSwitcher 下拉菜单，可创建、切换、删除独立会话
- [ ] **AC-7 新建会话**: [+] 按钮一键新建，自动切换到新会话
- [ ] **AC-8 重置会话**: [🔄] 按钮重置当前会话上下文，保留会话但清空消息
- [ ] **AC-9 模型切换**: 底部模型下拉菜单，运行时切换模型（通过后端 API）

### 上下文与用量
- [ ] **AC-10 Usage 显示**: 底栏显示当前会话上下文窗口使用百分比
- [ ] **AC-11 上下文压缩（混合）**: 80% 时 UI 提示建议压缩，95% 时自动压缩，支持手动触发按钮
- [ ] **AC-12 连接管理**: 可配置后端 URL，显示连接状态，断连时优雅提示

### 回归
- [ ] **AC-13 现有功能不回退**: 直连 OpenAI/Anthropic 的简单聊天模式继续可用

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 需要自己实现 agent 核心 | hermes-agent 已有完整 API server | 直接作为前端连接，零 agent 代码 |
| 用 TypeScript 重写 68 个工具 | hermes-agent API 暴露所有工具能力 | 通过 HTTP/SSE 调用，不重写 |
| OpenAI 订阅指标准 API key | 用户指 ChatGPT Plus/Pro 订阅 | 通过 hermes-agent Codex OAuth device code flow |
| 需要自建 MCP 支持 | hermes-agent 已完整支持 MCP（stdio/HTTP） | MCP 在 hermes 侧配置，vonvon 透明享用 |
| 前端需要复杂 agent 状态管理 | `/v1/runs` API 提供结构化事件流 | 前端只需解析 SSE 事件展示 UI |
| 多会话需要自建数据库 | hermes-agent ResponseStore（SQLite）管理服务端会话 | 前端维护会话列表，后端维护上下文 |

## Technical Context

### hermes-agent 可用能力（通过 import AIAgent）

**AIAgent 核心 API**（`run_agent.py`）:
```python
agent = AIAgent(
    model="...", api_key="...", base_url="...",
    max_iterations=90,
    stream_delta_callback=on_delta,        # 逐 token 流式
    tool_progress_callback=on_tool,        # 工具执行进度
    step_callback=on_step,                 # 每轮 API 调用
    thinking_callback=on_thinking,         # reasoning 内容
    session_id="...",
    session_db=session_db,                 # 复用 SessionDB
    platform="vonvon",
)

result = agent.run_conversation(
    user_message="...",
    conversation_history=[...],            # user/assistant 文本对
)
# result: {final_response, messages, api_calls, total_tokens, estimated_cost_usd}
```

**回调类型**（后端 SSE 事件源）:
```
stream_delta_callback(delta)       → message.delta 事件
tool_progress_callback(event_type, tool_name, preview, args)
  event_type: "tool.started"       → tool.started 事件
  event_type: "tool.completed"     → tool.completed 事件
thinking_callback(text)            → reasoning.available 事件
```

**上下文压缩**（`agent/context_compressor.py`）:
- hermes-agent 内置自动压缩（token 超限时）
- 可通过 AIAgent 参数控制压缩行为
- 后端可主动调用压缩逻辑

**SessionDB**（`hermes_state.py`）:
- SQLite + FTS5 全文搜索
- 存储: 消息、token 用量、成本、reasoning 内容
- 可直接 import 复用，无需自建存储

### vonvon 前端现有代码库

**可复用**:
- `src/main/providers/base.ts` — Provider 抽象接口
- `src/main/providers/registry.ts` — Provider 注册机制
- `src/main/store.ts` — electron-store（存后端连接配置）
- `src/main/ipc.ts` — IPC 通道框架
- `src/renderer/hooks/useChat.ts` — 聊天状态管理（需扩展）
- `src/renderer/components/Chat/*` — 聊天 UI 组件（需扩展）
- `src/preload/index.ts` — Context bridge（需扩展）

**需新增（前端）**:
- `src/renderer/components/Chat/ToolCard.tsx` — 工具执行卡片
- `src/renderer/components/Session/SessionSwitcher.tsx` — 顶部会话切换器
- `src/renderer/components/Chat/UsageBar.tsx` — 上下文用量百分比
- `src/renderer/components/Chat/CompressHint.tsx` — 压缩提示/按钮
- `src/renderer/components/Settings/BackendSettings.tsx` — 后端连接配置
- `src/renderer/hooks/useSession.ts` — 多会话 hook

**需新增（后端）**:
- `backend/app/main.py` — FastAPI 入口
- `backend/app/routes/chat.py` — 对话 API（SSE）
- `backend/app/routes/models.py` — 模型管理
- `backend/app/services/agent.py` — AIAgent 封装
- `backend/app/services/session.py` — 会话管理（复用 SessionDB）
- `backend/app/services/usage.py` — 用量追踪

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Agent Session | core domain | id, name, conversation_id, created_at, last_message_at | belongs to User, has many Messages |
| Message | core domain | id, role, content, tool_calls, timestamp | belongs to Session |
| Tool Execution | core domain | tool_name, status, preview, duration, error | belongs to Message |
| Hermes Connection | infrastructure | url, api_key, status, last_health_check | singleton, used by HermesProvider |
| Provider | external system | type (hermes/openai/anthropic), config | has many Sessions |
| MCP Server | external system | name, transport, tools | managed by hermes-agent |
| Memory | core domain | key, value, scope | managed by hermes-agent |

## Deployment Phases

### Phase 1: 开发阶段（本地独立安装）
```
用户操作:
1. pip install hermes-agent
2. hermes model  (配置 ChatGPT OAuth 或 API key)
3. 编辑 ~/.hermes/.env 启用 API server
4. hermes gateway  (启动后端)
5. 打开 vonvon  (自动连接 localhost:8642)
```

### Phase 2: 发布阶段（Electron 内嵌打包）
```
vonvon 安装包内嵌 hermes-agent，用户双击即用:
- Electron 启动时自动 spawn hermes-agent 子进程
- 通信：localhost HTTP/SSE（同开发阶段）
- 用户 API key 存储在本地（~/.hermes/.env 或 Electron safeStorage）

打包方案（优先级排序）:
1. PyInstaller binary (~200MB) — 最简单，单文件
2. Embedded Python + hermes wheel — 更灵活，可热更新
3. 备选: 引导用户安装 Python + pip install（降级方案）
```

### 远端部署：暂不考虑
多用户远端服务（容器化/SaaS）不在 v1 范围内。

## Interview Transcript
<details>
<summary>Full Q&A (8 rounds)</summary>

### Round 1
**Q:** 当你说「真正的 agent，不是 LLM 套壳」时，你心目中 agent 和普通聊天机器人的核心区别是什么？
**A:** 就参考 hermes agent
**Ambiguity:** 65% (Goal: 0.65, Constraints: 0.10, Criteria: 0.10, Context: 0.50)

### Round 2
**Q:** hermes-agent 的核心是 Python 实现（9500 行，68 个工具）。在 vonvon 的 Electron 环境中，你倾向哪种实现路径？
**A:** 我不关注使用什么语言，你来综合考虑下
**Ambiguity:** 58% (Goal: 0.65, Constraints: 0.35, Criteria: 0.10, Context: 0.55)

### Round 3
**Q:** 你说「模型提供商支持 OpenAI 订阅」，具体指的是哪种？
**A:** ChatGPT Plus/Pro 订阅
**Ambiguity:** 54% (Goal: 0.65, Constraints: 0.50, Criteria: 0.10, Context: 0.55)

### Round 4
**Q:** 假设我明天给你演示完成的第一版，你会通过什么操作来判断「这就是我要的」？
**A:** 以上全部（多步工具链 + MCP 集成 + 记忆上下文）
**Ambiguity:** 38% (Goal: 0.75, Constraints: 0.50, Criteria: 0.60, Context: 0.55)

### Round 5 (Contrarian Mode)
**Q:** 你确定要从零实现 agent loop，而不是用现有的 JS agent 框架？
**A:** 你来决定。我已经给了你很多 agent 项目参考
**Ambiguity:** 33% (Goal: 0.80, Constraints: 0.60, Criteria: 0.60, Context: 0.60)

### Round 6
**Q:** v1 的内置工具范围是什么？
**A:** 实用工具集（Web 搜索 + 网页提取 + 文件读写 + 终端命令 + 代码运行 + 图片分析）
**Ambiguity:** 25% (Goal: 0.85, Constraints: 0.75, Criteria: 0.65, Context: 0.65)

### Round 7 (Simplifier Mode)
**Q:** Agent 执行工具时，UI 展示的最简版本是什么？
**A:** 你来设计
**Ambiguity:** 19% (Goal: 0.90, Constraints: 0.80, Criteria: 0.75, Context: 0.70)

### Round 8 (Post-interview corrections)
**User corrections:**
1. 不是移植 Python 代码，通过 hermes-agent API 桥接
2. hermes-agent 有 API server，用 API 连接
3. AI provider 支持 ChatGPT OAuth，参考 hermes-agent 文档
4. 需要支持多会话
5. 前期独立安装，最终打包在一起
**Ambiguity:** 13%

</details>
