# Plan: 对话页文件拖拽发送功能

**Spec:** `.omc/specs/deep-interview-file-drag.md`
**Date:** 2026-04-12
**Complexity:** MEDIUM
**Scope:** 3 files改动 + 1 新工具模块

---

## Context

vonvon 对话页已支持图片拖拽（base64 DataURL 流程）。本次扩展非图片文件支持：用户拖拽任意文件到 InputArea，消息文本中内嵌 `@file:/abs/path` 格式引用，前端渲染为带图标的彩色 chip，后端调用 hermes-agent 已有的 `preprocess_context_references_async()` 展开文件内容供 agent 使用。

## Work Objectives

1. InputArea 支持非图片文件拖拽，插入 `@file:` 文本并显示可编辑的 chip
2. 消息气泡（用户 + 历史）中 `@file:` token 渲染为只读 chip
3. 后端 chat.py 集成 `preprocess_context_references_async()` 展开文件引用
4. 图片拖拽行为完全不变

## Guardrails

**Must Have:**
- `@file:` 格式严格遵循 spec（无空格直接拼接，含空格引号包裹）
- chip 按扩展名显示不同图标/颜色（spec 表格定义的 9 类）
- 图片文件（`image/*`）继续走现有 base64 流程，不进入 `@file:` 路径
- 历史消息中文件不存在时显示灰色 chip，不报错

**Must NOT Have:**
- 不改动 `AgentAttachment` 类型定义
- 不改动 `useAgentChat.ts` 的发送逻辑（文本就是文本）
- 不实现文件上传进度条或文件大小校验
- 不存储文件内容到 DB

---

## Task Flow

```
Task 1 (FileChip 工具模块)
   |
   v
Task 2 (InputArea 拖拽) ---> Task 3 (消息渲染)
                                |
                                v
                          Task 4 (后端集成)
                                |
                                v
                          Task 5 (端到端验证)
```

---

## Detailed TODOs

### Task 1: 创建 FileChip 共享模块

**文件:** `src/renderer/components/Chat/FileChip.tsx`（新建）

**内容:**

1. **`getFileTypeInfo(filename: string)` 工具函数** — 根据扩展名返回 `{ icon, color, label }`
   - `.py` -> 绿色 `#4CAF50`，蛇图标/Python 文字
   - `.js` `.jsx` `.mjs` -> 黄色 `#F7DF1E`，JS 文字
   - `.ts` `.tsx` -> 蓝色 `#3178C6`，TS 文字
   - `.md` `.mdx` -> 蓝色 `#42A5F5`，文档图标
   - `.pdf` -> 红色 `#E53935`，PDF 图标
   - `.json` -> 橙色 `#FF9800`，`{}` 图标
   - `.html` `.css` `.scss` -> 橙红色 `#FF5722`，`<>` 图标
   - `.txt` `.log` `.csv` -> 灰色 `#9E9E9E`，文本图标
   - 其他 -> 灰色 `#9E9E9E`，通用文件图标

2. **`parseFileReferences(text: string)` 工具函数** — 用正则解析文本中所有 `@file:` token
   - 正则：`/@file:(?:"([^"]+)"|(\S+))/g`
   - 返回数组：`{ raw: string, path: string, filename: string, start: number, end: number }[]`

3. **`<FileChip>` 组件** — 渲染单个文件 chip
   - Props: `{ path: string, onRemove?: () => void, disabled?: boolean }`
   - 无 `onRemove` 时为只读模式（消息气泡中）
   - `disabled` 为 true 时灰色显示（文件不存在）
   - 样式：圆角胶囊，左侧图标 + 文件名 + 右侧 x 按钮

4. **`<FileChipRenderer>` 组件** — 将含 `@file:` 的文本拆分渲染为 text + chip 混排
   - Props: `{ text: string }`
   - 用 `parseFileReferences` 拆分文本，非匹配部分渲染为 `<span>`，匹配部分渲染为 `<FileChip>`

**验收标准:**
- [x] `getFileTypeInfo` 覆盖 spec 定义的全部 9 类扩展名
- [x] `parseFileReferences` 能正确解析无空格和有空格（引号）两种格式
- [x] `<FileChip>` 可编辑模式有 x 按钮，只读模式无按钮
- [x] 组件无外部依赖，纯 React + inline style（与现有代码风格一致）

---

### Task 2: InputArea 扩展文件拖拽

**文件:** `src/renderer/components/Chat/InputArea.tsx`

**改动点:**

1. **`handleDrop` 函数（第 170 行）** — 扩展拖拽处理逻辑
   - 现有逻辑：过滤 `image/*` 文件 -> `addImageFiles()`
   - 新增逻辑：非 `image/*` 文件 -> 构造 `@file:` 文本插入到 textarea 当前光标位置
   - 路径获取：`(file as any).path`（Electron File 对象有 `path` 属性）
   - 路径含空格时包裹引号：`@file:"/path with spaces/file.pdf"`
   - 多个文件用空格分隔
   - 图片文件仍走原有 `addImageFiles()` 路径

2. **新增 `insertFileReference(filePath: string)` 辅助函数**
   - 构造格式化的 `@file:` 字符串
   - 在 textarea 光标位置插入文本（操作 `value` state + 更新光标位置）
   - 如果 value 非空且末尾不是空格，先插入一个空格

3. **textarea 渲染层（可选优化）**
   - 最简方案：`@file:` 作为纯文本显示在 textarea 中，用户可以手动编辑/删除
   - 进阶方案：在 textarea 上方叠加一个同步的 overlay 层，将 `@file:` 渲染为 chip（视觉增强）
   - **建议先实现最简方案**，chip 可视化仅在发送后的消息气泡中体现

4. **`handleDragOver` 函数（第 178 行）** — 移除 `attachmentsEnabled` 门禁
   - 当前逻辑：`if (!attachmentsEnabled) return`，这会阻止非图片拖拽
   - 修改：拖拽文件时始终允许 dragover（文件拖拽不依赖 attachmentsEnabled）
   - 注意：仅当全部文件都是图片且 `!attachmentsEnabled` 时才 return

5. **`handleDrop` 函数** — 同步更新门禁逻辑
   - 非图片文件不受 `attachmentsEnabled` 限制（`@file:` 只是文本操作）

**验收标准:**
- [ ] 拖拽 .py 文件到 InputArea，textarea 中出现 `@file:/abs/path/to/file.py`
- [ ] 拖拽含空格路径的文件，textarea 中出现 `@file:"/abs/path with spaces/file.pdf"`
- [ ] 同时拖拽图片和非图片文件，图片走 base64 流程，非图片插入 `@file:`
- [ ] 拖拽图片文件行为完全不变（base64 thumbnail 预览）
- [ ] 多个文件拖拽后，textarea 中有多个 `@file:` token 以空格分隔

---

### Task 3: 消息气泡渲染 `@file:` chip

**文件:** `src/renderer/components/Chat/AgentMessageList.tsx`

**改动点:**

1. **用户消息渲染（`renderMessage` 函数，第 141-184 行）**
   - 当前：`{msg.content}` 直接渲染纯文本
   - 修改：用 `<FileChipRenderer text={msg.content} />` 替换 `{msg.content}`
   - 这样 `@file:` token 会自动渲染为蓝色 chip，其余文本正常显示

2. **import FileChipRenderer**
   - 从 `./FileChip` 导入 `FileChipRenderer` 组件

3. **历史消息兼容**
   - `FileChipRenderer` 天然支持历史消息，因为 `@file:` 格式存储在 DB 文本中
   - 文件不存在时 chip 显示灰色（由 FileChip 组件内部处理，可选：用 Electron IPC 检查文件是否存在，或简化为始终显示正常颜色）
   - **建议 V1 简化：** 不做文件存在性检查，始终显示正常颜色 chip（spec 允许灰色但不强制）

**验收标准:**
- [ ] 发送包含 `@file:/path/to/file.py` 的消息，用户气泡中显示绿色 Python chip
- [ ] 文字和 chip 可以混排："看看 [chip] 这个文件"
- [ ] 一条消息中多个 `@file:` 各自渲染为独立 chip
- [ ] 不含 `@file:` 的普通消息渲染不受影响

---

### Task 4: 后端集成 preprocess_context_references_async

**文件:** `backend/app/routes/chat.py`

**改动点:**

1. **在 `run_agent()` 内部、`agent.run_conversation()` 调用之前**（约第 105 行 `async def run_agent():` 内部，第 124 行 `agent = agent_service.create_agent(...)` 之前）

2. **插入 `@file:` 展开逻辑（参考 gateway/run.py:2879-2901）:**
   ```python
   # Expand @file: context references
   if "@" in plain_text:
       try:
           from agent.context_references import preprocess_context_references_async
           _msg_cwd = os.path.expanduser("~")
           _msg_ctx_len = agent_service.get_model_context_size()
           _ctx_result = await preprocess_context_references_async(
               plain_text, cwd=_msg_cwd,
               context_length=_msg_ctx_len, allowed_root=_msg_cwd)
           if _ctx_result.blocked:
               queue.put_nowait({
                   "event": "run.failed",
                   "data": {"error": "\n".join(_ctx_result.warnings) or "Context reference blocked."},
               })
               return
           if _ctx_result.expanded:
               plain_text = _ctx_result.message
               # 同步更新 effective_message（非图片场景）
               if not image_count:
                   effective_message = plain_text
       except Exception:
           pass  # 静默降级，与 gateway 行为一致
   ```

3. **关键细节:**
   - `cwd` 设为 `os.path.expanduser("~")`（vonvon 无项目目录概念）
   - `allowed_root` 也设为 `~`，允许访问用户 home 下所有文件
   - `context_length` 从 `agent_service.get_model_context_size()` 获取
   - 展开结果只替换 `plain_text`（和 `effective_message`），不影响 `persisted_text`
   - DB 中仍存储原始 `@file:` 格式文本（这是设计决策：历史可回显 chip）
   - `blocked` 时直接返回 `run.failed` 事件
   - 位置：必须在 `lock_held = True` 之后、`agent_service.create_agent()` 之前

4. **persisted_text 处理:**
   - 当有 `@file:` 但无图片附件时，`persisted_text` 当前为 `None`
   - 保持 `None` 不变 -- `run_conversation` 使用 `persist_user_message=persisted_text`，`None` 意味着用原始 `effective_message` 存储
   - 但此时 `effective_message` 已被展开，我们希望 DB 存的是原始 `@file:` 格式
   - **修复：** 当发生了展开时，设置 `persisted_text = req.message.strip()`（原始文本）

**验收标准:**
- [ ] 发送含 `@file:/path/to/real_file.py` 的消息，agent 回复中体现文件内容
- [ ] DB 中存储的是原始 `@file:` 格式（不是展开后的内容）
- [ ] `@file:` 指向不存在文件时不 crash，agent 正常回复（可能说文件不存在）
- [ ] 安全：`allowed_root=~` 阻止 `@file:/etc/shadow` 等越界访问
- [ ] 无 `@file:` 的普通消息不受影响（`"@" in plain_text` 短路跳过）

---

### Task 5: 端到端验证

**手动测试清单:**

1. 拖拽一个 `.py` 文件到输入框 -> textarea 显示 `@file:` 文本
2. 发送消息 -> 用户气泡显示绿色 Python chip
3. Agent 回复内容体现了文件内容（如总结代码）
4. 拖拽一个路径含空格的 PDF -> 引号包裹格式正确
5. 同时拖拽图片 + .ts 文件 -> 图片走 base64 缩略图，.ts 走 `@file:`
6. 刷新页面 -> 历史消息中 `@file:` 正确渲染为 chip
7. 纯文本消息（无 @file）-> 行为完全不变
8. 纯图片消息 -> 行为完全不变

---

## Potential Risks

| 风险 | 影响 | 缓解策略 |
|------|------|---------|
| `(file as any).path` 在非 Electron 环境为 undefined | 文件路径为空 | 加 guard：`if (!filePath) return`，浏览器环境静默忽略 |
| `preprocess_context_references_async` 展开大文件超出 context budget | Token 超限 | hermes 已有 token budget 机制，无需额外处理 |
| `allowed_root=~` 可能过于宽松 | 安全 | hermes 已有 `_SENSITIVE_HOME_DIRS/FILES` 黑名单，阻止 .ssh 等敏感路径 |
| `effective_message` 在图片+文件混合场景的正确性 | 文件未被展开 | 图片场景下 `effective_message` 是 content_parts 列表，需在 text 部分做替换 |
| textarea 中 `@file:` 纯文本不够直观 | UX | V1 可接受，后续可加 overlay chip 层优化 |

---

## Implementation Order

1. **Task 1** (FileChip 模块) — 无依赖，先行
2. **Task 2** (InputArea 拖拽) — 依赖 Task 1（但可并行，Task 1 只提供类型）
3. **Task 3** (消息渲染) — 依赖 Task 1
4. **Task 4** (后端集成) — 独立于前端，可与 Task 2/3 并行
5. **Task 5** (验证) — 依赖全部完成

**建议并行:** Task 1 + Task 4 先行，然后 Task 2 + Task 3，最后 Task 5。
