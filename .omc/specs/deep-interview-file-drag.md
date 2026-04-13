# Deep Interview Spec: 对话页文件拖拽发送

## Metadata
- Interview ID: di-vonvon-file-drag
- Rounds: 7
- Final Ambiguity Score: ~15%
- Type: brownfield
- Generated: 2026-04-12
- Threshold: 0.2
- Status: PASSED

## Clarity Breakdown
| 维度 | 分值 | 权重 | 加权 |
|------|------|------|------|
| 目标清晰度 | 0.90 | 35% | 0.315 |
| 约束清晰度 | 0.80 | 25% | 0.200 |
| 成功标准 | 0.85 | 25% | 0.213 |
| 上下文清晰度 | 0.90 | 15% | 0.135 |
| **总清晰度** | | | **0.863** |
| **模糊度** | | | **~14%** |

## Goal

在 vonvon 对话页中，用户可以将任意文件拖拽到消息输入框，文件以约定文本格式 `@file:/abs/path` 内嵌到消息内容中。前端将其渲染为蓝色 chip（文件图标 + 文件名），后端透传给 Hermes agent，agent 通过自身工具（read_file、pdf_parser 等 skill）自主处理文件内容。

## 核心设计决策

**统一文本格式**：文件引用不作为独立 attachment 字段存储，而是内嵌在消息文本中：

```
用户输入/DB存储（纯文本）:
  "帮我看这个 @file:/Users/clay/docs/report.pdf 的第三章"

前端渲染:
  "帮我看这个 [📄 report.pdf] 的第三章"   ← 蓝色 chip

后端/Agent:
  调用 preprocess_context_references_async() 展开 @file: 内容
```

**格式规范**：
- 无空格路径：`@file:/abs/path/to/file.ext`
- 含空格路径：`@file:"/abs/path/with spaces/file.ext"`
- 图片文件仍走现有 base64 DataURL 流程（`image/*` 类型），不走 @file

## Constraints

- 仅对非图片文件使用 `@file:` 文本格式；图片继续走现有 base64 + IndexedDB 流程
- 历史回显：文件 chip 显示文件名即可；文件不存在时显示灰色 chip，不报错
- 路径含空格时用引号包裹
- 不限制文件类型（agent 自行决定能否处理）
- 不限制文件数量（每条消息可含多个 @file 引用）
- 文件大小不在前端校验，由 agent/hermes 的 context budget 机制控制

## File Chip 视觉规范

文件 chip 按扩展名显示不同图标和颜色：

| 类型 | 扩展名 | 图标 | 颜色 |
|------|--------|------|------|
| Python | `.py` | 🐍 或 Python logo | 绿色 |
| JavaScript | `.js` `.jsx` `.mjs` | JS logo | 黄色 |
| TypeScript | `.ts` `.tsx` | TS logo | 蓝色 |
| Markdown | `.md` `.mdx` | 文档图标 | 蓝色 |
| PDF | `.pdf` | PDF 图标 | 红色 |
| JSON | `.json` | `{}` 图标 | 橙色 |
| HTML/CSS | `.html` `.css` `.scss` | `<>` 图标 | 橙红色 |
| 文本 | `.txt` `.log` `.csv` | 文本图标 | 灰色 |
| 其他 | * | 通用文件图标 | 灰色 |

chip 结构：`[图标] 文件名` + 右侧 `×` 移除按钮（输入框中）  
历史消息中文件不存在时：灰色 chip，无 × 按钮

## Non-Goals

- 不在 DB 中存储文件内容或 base64（历史可用性不是需求）
- 不实现文件上传进度条
- 不对二进制文件在前端做类型过滤
- 不改动 AgentAttachment 类型定义（该字段仍用于图片）
- 不实现跨设备文件访问

## Acceptance Criteria

- [ ] 用户拖拽文件到 InputArea，输入框中出现蓝色 chip（文件图标 + 文件名）
- [ ] chip 可点击 × 移除
- [ ] 消息文本中可以文字和文件 chip 混排（如"看这个 [📄 a.pdf] 和这个 [📄 b.py]"）
- [ ] 发送后，消息气泡中的 @file: 被渲染为蓝色 chip
- [ ] 历史消息中的 @file: 也被渲染为 chip（文件不存在时灰色 chip）
- [ ] 后端 chat.py 在 run_conversation 前调用 preprocess_context_references_async()
- [ ] Agent 能读取到文件内容并在回复中体现
- [ ] 图片拖拽行为不变（仍走 base64 流程）

## Technical Context

### 现有代码结构（已探明）

**前端关键文件：**
- `src/renderer/components/Chat/InputArea.tsx` — 核心输入组件，已有图片拖拽逻辑（`addImageFiles`、`handleDrop`）
- `src/renderer/components/Chat/AgentMessageList.tsx` — 消息气泡渲染
- `src/renderer/hooks/useAgentChat.ts` — 消息发送逻辑，`AgentAttachment` 类型定义

**后端关键文件：**
- `backend/app/routes/chat.py` — `/api/chat/send` 端点，**缺 preprocess_context_references_async() 调用**
- `backend/hermes-agent/agent/context_references.py` — @file: 展开逻辑（完整实现，有安全检查、token budget）
- `backend/hermes-agent/gateway/run.py:2879` — Gateway 已集成的参考实现

### 改动范围

| 文件 | 改动内容 |
|------|---------|
| `InputArea.tsx` | `handleDrop` 扩展：非图片文件 → 插入 `@file:` 文本；输入框实时解析渲染文件 chip |
| `AgentMessageList.tsx` 或消息渲染层 | 解析消息文本中的 `@file:` → 渲染蓝色 chip |
| `backend/app/routes/chat.py` | 加 `preprocess_context_references_async()` 调用，cwd 设为用户 home 目录 |

**不需要改动：**
- `useAgentChat.ts`（文本就是文本，发送逻辑不变）
- `AgentAttachment` 类型（图片附件流程不变）
- Hermes agent（context_references 已完整实现）

### 参考实现（gateway/run.py:2879-2901）
```python
if "@" in message_text:
    from agent.context_references import preprocess_context_references_async
    from agent.model_metadata import get_model_context_length
    _msg_cwd = os.environ.get("MESSAGING_CWD", os.path.expanduser("~"))
    _msg_ctx_len = get_model_context_length(self._model, ...)
    _ctx_result = await preprocess_context_references_async(
        message_text, cwd=_msg_cwd,
        context_length=_msg_ctx_len, allowed_root=_msg_cwd)
    if _ctx_result.blocked:
        # 返回 warning
    if _ctx_result.expanded:
        message_text = _ctx_result.message
```

## Ontology (Key Entities)

| 实体 | 类型 | 关键属性 | 关系 |
|------|------|---------|------|
| Message | core domain | content(text), role, timestamp | 包含零个或多个 FileReference |
| FileReference | supporting | path(absolute), displayName(basename) | 内嵌于 Message.content 文本 |
| FileChip | UI component | path, displayName, exists(bool) | 渲染自 FileReference |
| ImageAttachment | supporting | dataUrl, name | 独立于 FileReference，走现有流程 |

## Interview Transcript

<details>
<summary>完整 Q&A（7 轮）</summary>

**R1 Q:** 现有代码已支持图片拖拽，你说的"文件"是指？
**R1 A:** 扩展到非图片文件（PDF、代码、文档等）

**R2 Q:** 当用户拖拽非图片文件时，期望 AI 能做什么？
**R2 A:** hermes 是怎么做的，应该是只传文件的绝对路径让 agent 用 tool 读取

**R3 Q:** 后端集成方式偏好？
**R3 A:** 不用 @file 机制，都是"添加的文件"，vonvon 没有项目目录

**R4 Q:** 文件 chip 范围和大小限制？
**R4 A:** 为什么不只传绝对路径让 agent 用 tool/skill 解读？

**R5 Q:** 方案确认——文件附件只传绝对路径，agent 自己处理
**R5 A:** 考虑下历史消息回显；约定格式内嵌文本，前端解析渲染蓝色 chip

**R6 Q:** 这个设计有什么缺点？
**R6 A:** 历史可用性（文件移动后 chip 变灰）不重要，就按这个方案

**R7:** 规格确认，进入执行

</details>
