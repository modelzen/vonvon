# Deep Interview Spec: Vonvon - 飞书 AI 宠物助手

## Metadata
- Interview ID: vonvon-001
- Rounds: 10
- Final Ambiguity Score: 19.5%
- Type: greenfield
- Generated: 2026-04-08
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.40 | 0.34 |
| Constraint Clarity | 0.80 | 0.30 | 0.24 |
| Success Criteria | 0.75 | 0.30 | 0.225 |
| **Total Clarity** | | | **0.805** |
| **Ambiguity** | | | **19.5%** |

## Goal

构建一个 macOS 桌面应用 **Vonvon**，形态为星之卡比风格的粉红色圆形宠物浮窗。用户可将其拖拽到飞书（Feishu/Lark）桌面窗口右侧，触发吸附动画后变为紧贴飞书的独立侧边栏对话框。该对话框是一个通用型 AI Agent，类似空白的 Claude Code——初始无预置能力，随使用逐步积累记忆、创建/导入 Skill、安装 MCP 服务，用户可启用/禁用各项功能。

**MVP 聚焦**：卡比宠物浮窗 + 窗口吸附动画 + 基础多模型 AI 对话。飞书上下文集成、Skill/MCP 系统、记忆系统为后续迭代。

## Constraints

- **平台**: macOS only（需提供安装包给外部用户）
- **技术栈**: Electron + Swift 混合架构
  - Electron (Next.js/React): 对话 UI、设置页、Plugin 系统
  - Swift Native Module: 卡比浮窗 (NSWindow)、吸附动画 (Core Animation)、窗口跟踪 (Accessibility API)
- **LLM 后端**: 多模型支持（OpenAI OAuth 订阅 + 多 Provider），参考 opencode 项目的 provider 实现
- **飞书集成**: 通过已有的飞书 CLI (larksuite/cli) 获取上下文（单聊/群聊/文档），MVP 阶段不含此功能
- **分发**: 需要安装包（DMG）、代码签名、公证（Notarization）
- **参考项目**:
  - CodePilot (Electron + Next.js): 多模型 AI 桌面客户端，参考 UI 架构
  - Proma (Electron + React + Claude Agent SDK): 多 Agent 协作 + 飞书集成，参考 Agent 架构
  - claude-fork (TypeScript + Bun + React Ink): Claude Code 完整源码，参考 Skill/MCP/Memory 系统
  - opencode (Bun + Turbo + SolidJS): 多模型 Provider + OpenAI OAuth，参考认证和多模型实现

## Non-Goals

- MVP 不含飞书上下文集成（后续迭代）
- MVP 不含 Skill/MCP 系统（后续迭代）
- MVP 不含记忆系统（后续迭代）
- MVP 不含卡比待机动画（呼吸/眨眼等）
- MVP 不含 Markdown 渲染
- MVP 不含对话历史持久化
- 不支持 Windows/Linux
- 不支持飞书窗口移动时的自动跟随（nice-to-have，非必须）

## Acceptance Criteria

- [ ] 卡比宠物以粉红色圆形浮窗形态显示在桌面上，可自由拖拽
- [ ] 拖拽卡比到飞书窗口右侧附近时，出现"即将被吸附"的动画效果
- [ ] 松开后，卡比吸附到飞书窗口右侧，浮窗变形为独立的侧边栏对话窗口
- [ ] 侧边栏中可以和 AI 进行基础对话（发送消息、接收流式回复）
- [ ] 支持多模型切换（至少 OpenAI + Claude）
- [ ] 提供 DMG 安装包，可在其他 Mac 上正常安装运行

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 需要自建 Agent 框架 | Contrarian: 是否可以直接复用 Claude Code？ | 参考多个项目后决定自建，借鉴 claude-fork/Proma 的实现 |
| 需要完整功能才有价值 | Simplifier: MVP 最少需要什么？ | 宠物+对话即可，skill/mcp/飞书集成均为后续迭代 |
| 技术栈不确定 | 基于参考项目分析 | Electron + Swift 混合：Electron 做 UI，Swift 做原生窗口控制 |
| LLM 只用 Claude | 用户明确多模型需求 | 多模型支持 + OpenAI OAuth，参考 opencode 实现 |
| 个人工具 | 目标用户是谁？ | 面向外部用户分发，需要安装包和签名公证 |

## Technical Context

### 架构概览

```
Vonvon.app (Electron + Swift Hybrid)
├── Electron Layer (Next.js/React)
│   ├── Chat UI - 对话界面（流式响应）
│   ├── Settings - 设置页（API Key 配置、模型选择）
│   ├── Provider System - 多模型 Provider（参考 opencode）
│   │   ├── OpenAI (OAuth 订阅)
│   │   ├── Anthropic (API Key)
│   │   └── ... (可扩展)
│   └── IPC Bridge - 与 Swift 原生模块通信
│
├── Swift Native Module
│   ├── KirbyWindow - 卡比浮窗 (NSWindow, NSPanel)
│   │   ├── 圆形粉红色外观
│   │   ├── 拖拽手势处理
│   │   └── 待机状态显示
│   ├── SnapEngine - 吸附引擎
│   │   ├── 检测目标窗口位置 (CGWindowListCopyWindowInfo)
│   │   ├── 吸附动画 (Core Animation)
│   │   └── 侧边栏变形动画
│   └── WindowTracker - 窗口跟踪（可选）
│       └── Accessibility API 跟踪飞书窗口移动
│
└── Future Iterations
    ├── Feishu CLI Integration (larksuite/cli)
    ├── Skill System (参考 claude-fork)
    ├── MCP Support (参考 claude-fork bridge)
    └── Memory System (参考 claude-fork memdir)
```

### 关键技术挑战

1. **Swift-Electron 通信**: 需要通过 Node.js native addon 或 IPC 桥接 Swift 原生模块与 Electron 进程
2. **窗口吸附检测**: 使用 `CGWindowListCopyWindowInfo` 获取飞书窗口位置，计算吸附触发区域
3. **吸附动画**: Core Animation 实现从圆形浮窗到矩形侧边栏的平滑变形
4. **OpenAI OAuth**: 参考 opencode 的 `oauth-provider.ts` 实现 OAuth 流程（端口回调）

### 参考项目关键路径

| 参考项目 | 关键路径 | 参考内容 |
|----------|----------|----------|
| opencode | `/packages/opencode/src/provider/` | 多模型 Provider 架构 |
| opencode | `/packages/opencode/src/mcp/oauth-provider.ts` | OpenAI OAuth 实现 |
| opencode | `/packages/opencode/src/provider/auth.ts` | Provider 授权管理 |
| claude-fork | `/claude-code-source/src/skills/` | Skill 系统（后续迭代） |
| claude-fork | `/claude-code-source/src/bridge/` | MCP Bridge（后续迭代） |
| claude-fork | `/claude-code-source/src/memdir/` | Memory 系统（后续迭代） |
| Proma | GitHub: ErlichLiu/Proma | Electron + Agent SDK 集成 |
| CodePilot | GitHub: op7418/CodePilot | Electron 多模型桌面客户端 UI |

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Kirby Pet | core domain | position, state (floating/snapping/docked), appearance | 变形为 Sidebar |
| Sidebar | core domain | width, height, docked_to, conversation_id | 由 Kirby Pet 变形而来，包含 Conversation |
| Conversation | core domain | messages[], model, provider, created_at | 属于 Sidebar，使用 Provider |
| Provider | core domain | type (openai/anthropic/...), auth_method, models[] | 为 Conversation 提供 LLM 能力 |
| Snap Engine | supporting | target_window, snap_threshold, animation_state | 控制 Kirby Pet 的吸附行为 |
| Agent | core domain | skills[], mcps[], memory | 管理 Skill 和 MCP（后续迭代） |
| Skill | core domain | name, enabled, triggers, actions | 属于 Agent（后续迭代） |
| MCP | core domain | server_url, tools[], status | 属于 Agent（后续迭代） |
| Memory | core domain | type, content, created_at | 属于 Agent（后续迭代） |
| Feishu Context | external system | context_type (chat/group/doc), content, participants | 通过 Feishu CLI 获取（后续迭代） |
| Feishu CLI | external system | commands, auth_status | 提供 Feishu Context 数据 |
| OpenAI OAuth | supporting | token, refresh_token, expires_at | Provider 的认证方式之一 |
| Mac Desktop App | supporting | bundle_id, version, signed | 分发载体 |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 5 | 5 | - | - | N/A |
| 2 | 6 | 1 | 0 | 5 | 83% |
| 3 | 7 | 1 | 0 | 6 | 86% |
| 4 | 10 | 3 | 0 | 7 | 70% |
| 5 | 10 | 0 | 0 | 10 | 100% |
| 6 | 10 | 0 | 0 | 10 | 100% |
| 7 | 12 | 2 | 0 | 10 | 83% |
| 8 | 12 | 0 | 0 | 12 | 100% |
| 9 | 13 | 1 | 0 | 12 | 92% |
| 10 | 13 | 0 | 0 | 13 | 100% |

## Interview Transcript

<details>
<summary>Full Q&A (10 rounds)</summary>

### Round 1
**Q:** 当用户在飞书中遇到什么具体场景时，会唤起这个卡比宠物来帮忙？请描述 1-3 个最核心的使用场景。
**A:** 各种场景。这个 agent 最初是类似什么都没加载的 claude code, 随着用户使用，会增加记忆，创建 skill, 导入增加 skill, 安装 mcp 等。还可以启用禁用。
**Ambiguity:** 74% (Goal: 0.50, Constraints: 0.10, Criteria: 0.10)

### Round 2
**Q:** 这个 Mac 桌面应用你倾向用什么技术栈来开发？
**A:** 还没确定。
**Ambiguity:** 72% (Goal: 0.50, Constraints: 0.15, Criteria: 0.10)

### Round 3
**Q:** 你提到"通过飞书 CLI 获取上下文"——这个飞书 CLI 是已经存在的工具吗？还是需要自己开发？
**A:** 已有飞书 CLI 工具 https://github.com/larksuite/cli, 我本地也已经安装了。
**Ambiguity:** 66% (Goal: 0.50, Constraints: 0.35, Criteria: 0.10)

### Round 4 [Contrarian Mode]
**Q:** 你的 Agent 和 Claude Code 的关系是什么？是在底层直接调用 Claude Code 作为引擎，还是完全自建一套 Agent 框架？
**A:** 有几个参考项目：CodePilot, Proma, claude-fork。需要调研后决定。
**Ambiguity:** 63% (Goal: 0.55, Constraints: 0.40, Criteria: 0.10)
*调研发现：CodePilot (Electron+Next.js), Proma (Electron+React+飞书集成), claude-fork (完整Claude Code源码)*

### Round 5
**Q:** 请描述卡比宠物的完整交互流程：平时在哪里？怎么触发吸附？吸附后是什么形态？
**A:** 平时桌面浮窗。拖拽到窗口右侧附近时有吸附动画，松开后吸到窗口侧边变成独立窗口紧贴飞书。最好飞书移动时也跟着移动，很难实现就算了。
**Ambiguity:** 55% (Goal: 0.70, Constraints: 0.45, Criteria: 0.10)

### Round 6 [Simplifier Mode]
**Q:** 如果你只能发布一个最小可用版本（MVP），什么功能是必须有的？
**A:** 宠物 + 对话。
**Ambiguity:** 43% (Goal: 0.75, Constraints: 0.45, Criteria: 0.45)

### Round 7
**Q:** 基于参考项目的调研，我建议两条技术路线。你倾向哪个？
**A:** Electron + Swift 混合（推荐）。
**Ambiguity:** 37% (Goal: 0.75, Constraints: 0.65, Criteria: 0.45)

### Round 8
**Q:** 假设 MVP 做完了，你给朋友演示。以下哪些是必须能演示成功的？
**A:** 基础体验：①卡比浮窗可拖拽 ②拖到飞书旁有吸附动画 ③吸附后变成侧边栏 ④能和 AI 对话。
**Ambiguity:** 27% (Goal: 0.80, Constraints: 0.65, Criteria: 0.70)

### Round 9
**Q:** MVP 的 AI 对话后端用什么？
**A:** 多模型支持，特别是要支持 openAI 的订阅 oauth, 可以参考 opencode 的实现。
**Ambiguity:** 24% (Goal: 0.80, Constraints: 0.75, Criteria: 0.70)
*调研 opencode：Bun+Turbo monorepo, 25+ AI SDK, OAuth on port 19876*

### Round 10
**Q:** 这个产品的目标用户是谁？
**A:** 要提供安装包，给其他用户使用的。
**Ambiguity:** 19.5% (Goal: 0.85, Constraints: 0.80, Criteria: 0.75)

</details>
