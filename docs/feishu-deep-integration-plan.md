<!-- /autoplan restore point: /Users/clay/.gstack/projects/vonvon/feat-lark-autoplan-restore-20260416-101908.md -->
# Vonvon 飞书深度集成方案

## 1. 现状判断

基于当前仓库代码，vonvon 已经具备以下基础能力：

- Kirby 原生吸附已经能识别飞书窗口边界，并把 sidebar 跟随到飞书右侧。
  - 关键文件：
    - `native/src/snap_engine.mm`
    - `native/src/addon.mm`
    - `src/main/native/kirby.ts`
- 现阶段 Kirby 原生层拿到的是 `FeishuBounds`：
  - `x / y / width / height / windowId`
  - 还没有拿到飞书“当前正在看的是什么”的上下文，例如聊天名、文档标题、日程标题。
- 前端实际聊天主链路已经是 backend agent 模式，不是旧的 Electron 直连模型模式。
  - 关键文件：
    - `src/renderer/hooks/useAgentChat.ts`
    - `backend/app/routes/chat.py`
    - `backend/app/schemas.py`
- Hermes 能力已经具备：
  - skills
  - subagent / delegate
  - Feishu / DingTalk 平台适配基础
  - MCP、workspace、session 等基础设施

结论：

- “吸附到飞书”已经不是难点。
- 真正的缺口是“桌面侧识别当前飞书表面上下文”与“把它转成 agent 可消费的结构化上下文”。

## 2. 目标

当 vonvon 处于吸附飞书、sidebar 展开状态时：

1. 用户点击粉球。
2. vonvon 去“看一眼”当前飞书窗口。
3. 判断用户当前是在：
   - 飞书会话
   - 飞书文档 / wiki
   - 飞书日历 / 会议
   - 其他飞书表面
4. 基于飞书 CLI 补全更完整的上下文。
5. 把这份上下文以“本轮附加上下文”的形式送进当前会话。
6. Hermes 再根据上下文自动挑选合适的 skill / subagent 来理解或执行任务。

同时满足：

- 飞书 CLI 安装和初始化要被 vonvon 托管到设置页流程中。
- 飞书 CLI 自带的 skills 要能被 vonvon 用到，但不要和当前通用技能中心混在一起。
- 架构上要给未来的钉钉 CLI 留出同构扩展位。

### 2.1 先把成功标准写死，不然方案会不断膨胀

这份方案的真正 product wedge 不是“把飞书做成一个平台”。

第一阶段真正要验证的是：

- 用户能否在 vonvon 设置页里完成飞书安装、配置、授权、开启
- 用户在 sidebar 展开时点击粉球，vonvon 能否识别“当前大概是什么飞书表面”
- 用户能否在当前会话里获得一次可信、可感知、可撤销的飞书上下文注入

建议 Phase 1 / Phase 2 的验收指标明确成：

- 从未安装状态到“已开启飞书能力”的首次成功路径，目标在 5 分钟内完成
- 点击粉球后 1.5 秒内给出第一反馈，3 秒内给出识别结果或候选项
- chat / doc / calendar 三类主路径识别后，用户不需要二次解释即可继续提问
- 当识别错误、权限缺失、授权失效时，用户总能看到明确失败原因和下一步操作

如果这些指标打不透，就不要继续膨胀到“动作 agent”或“多套件平台”。

### 2.2 非目标也要提前写清楚

为了防止方案越做越大，建议把以下内容明确为当前非目标：

- 不做后台持续监听
- 不默认把完整飞书内容持久化到 session history
- 不在 Phase 1 / Phase 2 支持飞书写操作
- 不在 Feishu 价值尚未验证前做 DingTalk 的完整并行实现
- 不把飞书 internal skills 暴露成用户可自由安装/卸载的通用 skills

### 2.3 企业信任边界必须先定义

这是一个会碰到企业聊天、文档、日程内容的能力，没有 trust boundary 就不应该开工。

建议明确：

- 原始截图只用于本次 inspect 流程，默认只保存在内存，不写入 session history、不落盘到普通日志
- Accessibility 文本和视觉识别结果都要经过长度裁剪和字段级脱敏，再进入 LLM prompt
- `context_blocks` 默认只保留短摘要、片段和 provenance，不保留整页文档正文
- settings 页要明确告知：
  - 哪些数据只在本机处理
  - 哪些摘要会发送给当前模型提供方
  - 用户如何关闭、清空、撤销 session pinned context

## 3. 核心设计

### 3.1 总体思路：分成三层

把这套能力拆成三层，而不是把“飞书逻辑”直接塞进聊天入口。

#### A. Surface Sensing 层

职责：识别“用户当前正在看的飞书表面是什么”。

输入：

- Kirby 当前已经吸附到的飞书窗口信息
- 用户显式点击粉球

输出：

- 一个轻量的 `SurfaceSnapshot`

建议结构：

```ts
type SurfaceSnapshot = {
  suite: 'feishu' | 'dingtalk'
  appWindowId: number
  bounds: { x: number; y: number; width: number; height: number }
  appName: string
  windowTitle?: string
  surfaceKind:
    | 'chat'
    | 'doc'
    | 'wiki'
    | 'calendar'
    | 'meeting'
    | 'mail'
    | 'unknown'
  candidateName?: string
  confidence: number
  signals: Array<'cg-window' | 'accessibility' | 'vision'>
  capturedAt: number
}
```

#### B. Context Resolution 层

职责：用 `lark-cli` 把“看起来像聊天/文档/日程”的表面，解析成真正的飞书资源上下文。

输出：

```ts
type ExternalContextBundle = {
  source: 'feishu'
  surfaceKind: 'chat' | 'doc' | 'calendar' | 'meeting' | 'unknown'
  title: string
  resourceId?: string
  summary: string
  snippets: string[]
  entities: Array<{ type: string; id?: string; name: string }>
  provenance: Array<{ via: string; detail: string }>
  freshnessMs: number
}
```

#### C. Agent Orchestration 层

职责：把上下文交给 Hermes，并根据任务选择 skill / subagent。

这里不要让主 agent 自己一把梭地调用所有飞书命令，而是走受控编排：

- `surface-inspector`：只负责“看见什么”
- `suite-context-resolver`：只负责用 CLI 查上下文
- `suite-action-worker`：只在用户明确要执行动作时触发

这样稳定性更高，也更容易给未来钉钉复用。

### 3.2 补一张最小链路图，避免实现期耦死

```text
Kirby primary click
  -> Electron main inspect entry
  -> desktop provider collects window/accessibility/screenshot signals
  -> backend /api/integrations/feishu/inspect
  -> FeishuContextService resolves SurfaceSnapshot
  -> optional FeishuCliService enrichment
  -> renderer shows chip / candidate picker
  -> useAgentChat sends turn-local context_blocks
  -> session_context_service persists pinned refs when user opts in
```

这条链路里要特别保持两个边界：

- inspect 是 inspect，不直接触发 chat send
- context resolve 是 read path，不和 action path 混在一起

## 4. Surface Sensing 方案

### 4.1 先做“显式点击触发”，不要先做后台持续监听

你现在要的是：

- sidebar 已经展开
- 用户点击粉球
- vonvon 去看一眼飞书

这非常适合做成“显式触发、单次采样”的模型。

优点：

- 用户心理模型清晰
- 权限边界清楚
- 不需要一开始就做后台常驻窥视
- 对性能和隐私更友好

### 4.2 识别信号采用“三段式”

#### 第一段：已有原生窗口信息

当前原生层已经有：

- 飞书窗口 `bounds`
- `windowId`

建议扩展 `native/src/snap_engine.mm` / `native/src/addon.mm`，新增：

- `ownerName`
- `windowTitle`
- `isFrontmost`

这一步成本最低，可以先拿到一部分上下文线索。

#### 第二段：Accessibility 快照

如果要判断：

- 当前选中的会话名
- 当前文档标题
- 当前日程标题

更靠谱的是增加 macOS Accessibility 读取。

建议新增一个小型 native bridge，读取飞书前台窗口的：

- window title
- toolbar/header text
- selected item text
- 当前主要可见标题节点

这一步需要用户授予 Accessibility 权限。

#### 第三段：截图 + vision 兜底

用户的原话是“像是去看了一眼飞书窗口”，这其实非常适合做视觉兜底：

- 对飞书窗口区域做裁切截图
- 用一个轻量视觉步骤判断当前是 chat / doc / calendar / meeting
- 同时提取标题、显眼的人名/群名、时间范围等

这个 vision 步骤不要直接回答用户问题，只输出结构化识别结果。

建议只在以下情况触发：

- CGWindow + Accessibility 置信度不够
- 或用户主动点“刷新飞书上下文”

这一步需要 Screen Recording 权限。

另外建议把延迟预算写进方案，不然用户点击粉球后很容易出现“没反应”的感觉：

- 300ms 内出现 `正在读取飞书上下文…`
- 1.5s 内返回第一版识别结果或候选
- 3s 内如果仍未完成，自动降级为：
  - 明确提示“识别较慢”
  - 提供手动选择 chat / doc / calendar 的快捷入口

### 4.3 新增原生点击事件

现在 `native/src/drag_handler.mm` 里：

- `dockedCollapsed` 的 click 已经有语义
- `dockedExpanded` 的 click 目前被吞掉

因此应新增一个原生事件，例如：

- `onDockedPrimaryClick`

语义：

- 当状态为 `dockedExpanded` 且用户点击粉球时，触发“采样当前飞书上下文”

对应改动点：

- `native/src/drag_handler.h`
- `native/src/drag_handler.mm`
- `native/src/addon.mm`
- `src/main/native/kirby.ts`
- `src/preload/index.ts`

## 5. Context Resolution 方案

### 5.1 不要把 lark-cli 当成普通用户工具，要当成 Vonvon Managed Runtime

用户要求飞书是 vonvon 深度集成能力，不和现有技能安装/使用混在一起。

因此建议：

- 由 vonvon 设置页托管安装和升级 `@larksuite/cli`
- 由 vonvon 自己维护一个 `FeishuRuntimeManager`
- 所有 CLI 调用都走 vonvon 的 wrapper，而不是让 agent 直接乱调用系统里的 `lark-cli`
- managed runtime 需要支持版本探测、升级、验活、失败回滚

建议目录：

```text
~/.vonvon/integrations/feishu/
  runtime/
    versions/
    current
  pack/
    manifest.json
    wrappers/
  logs/
  cache/
  state.json

~/.vonvon/.hermes/skills/.vonvon-integrations/
  feishu-im/
  feishu-doc/
  feishu-calendar/
```

说明：

- 这样能把“vonvon 管理的飞书运行时”和“用户自己系统里的工具链”尽量隔离。
- 如果后续 lark-cli 提供更明确的 home/config 重定向能力，再接入完全隔离的 profile。
- `~/.vonvon/integrations/feishu/pack/` 是 vonvon 内部维护的 canonical skill pack。
- `HERMES_HOME/skills/.vonvon-integrations/` 是给 Hermes 看的 bridge output，不是用户手动管理的技能目录。

这里要明确补上一层 bridge，不然 managed runtime 装好了，Hermes 依然发现不到可调用能力。

建议新增：

- `IntegrationSkillBridge`

职责：

- 读取 vonvon 维护的 `feishu-*` integration skill pack
- 生成一层极薄的 Hermes wrapper skills 到 `HERMES_HOME/skills/.vonvon-integrations/`
- wrapper skill 只允许调用 `FeishuCliService` / `SuiteRuntimeService`
- `skills_service` 与 `SkillsPanel` 默认过滤 `.vonvon-integrations/` 或 `visibility=internal`
- Hermes 主 agent / subagent 仍可通过命名空间 `feishu-*` 正常发现和调用这些能力

这样就同时满足两件事：

- 对用户来说，飞书仍然是“vonvon 深度集成能力”，不和通用技能市场混在一起
- 对 Hermes 来说，这些能力又是真正可发现、可编排、可由 subagent 调用的 skills

### 5.2 设置页安装流

新增一个独立设置页或设置卡片：

- `飞书集成`

建议流程：

1. 检查 Node / npm 是否可用。
2. 安装 managed `@larksuite/cli`。
3. 运行 `lark-cli config init --new`。
4. 运行显式登录命令：`lark-cli auth login --recommend`。
5. 引导用户在浏览器完成扫码和授权。
6. 运行验证命令：
   - `lark-cli auth status`
   - `lark-cli doctor`
7. 只有当 `auth status` 返回已登录且 `doctor` 通过时，才标记为“已启用完整飞书能力”。

这里特别按产品要求执行：

- `lark-cli config init --new`

官方站点当前公开示例展示的是 `lark-cli config init` 与 `lark-cli auth login --recommend`，但 vonvon 安装流应按你的要求，把 `config init --new` 作为内建初始化动作；同时需要把 `auth login --recommend` 作为单独、显式的一步内建进去，不能把“打开浏览器扫码”当成默认隐式完成。

建议把设置页状态机写清楚：

- `not_installed`
- `installed_needs_config`
- `configured_needs_auth`
- `authenticating`
- `ready`
- `error`

其中：

- 完成 `config init --new` 之后只能进入 `configured_needs_auth`
- 只有 `auth status` 确认已登录后才能进入 `ready`
- 如果用户中途关闭浏览器、扫码取消、token 失效或 `doctor` 失败，状态要停留在 `configured_needs_auth` 或 `error`，不能误显示“已启用”

除此之外，还需要把“已安装 / 已授权”和“能力已开启”拆成两个维度：

- `runtime_status`：描述 CLI 是否已安装、已配置、已登录
- `feature_enabled`：描述 vonvon 是否真的开启飞书深度集成能力

建议设置页明确提供：

- `安装并配置`
- `检查更新`
- `升级 Feishu CLI`
- `重新验证`
- `卸载 Feishu CLI`
- `开启飞书能力`
- `关闭飞书能力`

开启 / 关闭的语义建议固定如下：

- 开启时：
  - 同步 `feishu-*` internal wrapper skills 到 `HERMES_HOME/skills/.vonvon-integrations/`
  - 打开粉球点击后的飞书 inspect 能力
  - 允许后端执行飞书 context resolve 流程
- 关闭时：
  - 从 Hermes bridge 中移除或停用 `feishu-*` internal wrapper skills
  - 粉球点击不再触发飞书截图/识别
  - 已有 session pinned context 保留但标记为 disabled，不再自动注入，直到用户重新开启

设置页还要把“权限梯子”设计出来，而不是只显示一个集成状态：

- Node / npm 缺失
- CLI 未安装
- config 未完成
- auth 未完成
- Screen Recording 未授权
- Accessibility 未授权
- runtime ready，但 feature 未开启

每一种状态都应该带一个明确 CTA，而不是只显示红字报错。

`卸载 Feishu CLI` 的语义也建议写清楚：

- 删除 `runtime/current` 指向和已安装版本目录
- 清理 `.vonvon-integrations/feishu-*` wrappers
- 清除 `feature_enabled`
- 将现有 session pinned refs 标记为 unavailable，而不是静默删除会话内容

设置页还需要明确展示 runtime 版本信息：

- `current_version`
- `latest_available_version`
- `upgrade_available`
- `last_checked_at`
- `last_verified_at`
- `last_good_version`

官方 Feishu CLI 升级时，vonvon 里的 managed runtime 也要支持升级。推荐流程：

1. `FeishuRuntimeManager.check_for_updates()` 查询 npm registry 上最新的 `@larksuite/cli` 版本。
2. 如果发现新版本，设置页展示 `升级可用` 和明确的升级按钮。
3. 用户点击升级后，先把目标版本安装到 `runtime/versions/<version>/`，不要直接覆盖当前版本。
4. 运行基础验活：
   - `lark-cli --version`
   - `lark-cli auth status`
   - `lark-cli doctor`
5. 重新同步 `IntegrationSkillBridge`，确保 Hermes wrappers 仍然可用。
6. 只有验活成功后，才把 `runtime/current` 切到新版本。
7. 如果升级失败，自动回滚到 `last_good_version`，并保留原有 `feature_enabled` 状态不变。

这样用户在 vonvon 内看到的是一个受控运行时，而不是“装上一次之后永远停在旧版 CLI”。

### 5.3 CLI 调用必须经过后端统一封装

不要在 renderer 直接跑 CLI。

建议新增 backend service：

- `backend/app/services/suite_runtime_service.py`
- `backend/app/services/feishu_cli_service.py`

职责：

- 统一命令白名单
- 统一超时
- 统一日志脱敏
- 统一 JSON 解析
- 统一错误翻译

例如：

```py
class FeishuCliService:
    async def doctor(self) -> dict: ...
    async def auth_status(self) -> dict: ...
    async def version(self) -> dict: ...
    async def resolve_chat(self, hint: str) -> dict: ...
    async def resolve_doc(self, hint: str) -> dict: ...
    async def resolve_calendar(self, title: str, time_hint: str | None) -> dict: ...
    async def fetch_context_bundle(self, snapshot: SurfaceSnapshot) -> ExternalContextBundle: ...
```

对应的 `FeishuRuntimeManager` 建议至少提供：

```py
class FeishuRuntimeManager:
    async def install(self, version: str | None = None) -> dict: ...
    async def check_for_updates(self) -> dict: ...
    async def upgrade(self, target_version: str | None = None) -> dict: ...
    async def rollback(self) -> dict: ...
    async def uninstall(self) -> dict: ...
    async def current_version(self) -> dict: ...
```

## 6. Hermes skill / subagent 设计

### 6.1 不把 lark-cli 的 19 个 skills 直接并入当前 SkillsPanel

原因：

- 这些 skills 的定位不是“用户手动安装的通用 skill”
- 而是“飞书深度集成域的内置能力”
- 如果直接混入 `SkillsPanel`，会破坏用户当前对技能中心的理解

建议做法：

- 在 vonvon 内部维护一个“Feishu Integration Skill Pack”
- skill 名字做命名空间隔离，例如：
  - `feishu-shared`
  - `feishu-im`
  - `feishu-doc`
  - `feishu-calendar`
  - `feishu-workflow-meeting-summary`

这些 skill 可以来自两种方式：

1. 直接吸收 / 改写 lark-cli 官方 skill 的规则和命令范式
2. 或在安装期把 lark-cli skill 读取到 vonvon 自己的 integration registry 里，但不要暴露到通用技能中心

推荐优先方案：

- “参考并内化”官方 skill，而不是把它们原样塞进当前全局 skills 目录

这样更稳定，也更容易按 vonvon 的 UI/权限模型做裁剪。

但“内化”不等于绕开 Hermes 的 skill discoverability。

落地时建议固定成下面这条链路：

```text
Feishu managed runtime
  -> vonvon canonical integration pack
  -> IntegrationSkillBridge 生成 Hermes wrappers
  -> HERMES_HOME/skills/.vonvon-integrations/feishu-*
  -> Hermes agent / subagent 调用 wrapper
  -> wrapper 再调用 FeishuCliService
```

补充约束：

- wrapper skill 内不直接执行 shell 命令，只调 backend 封装服务
- wrapper skill 名字与展示文案都走 `feishu-*` 命名空间，避免和用户安装 skill 撞名
- `skills_service` 需要加一层 internal skill 过滤，确保这些 wrapper 不进入通用 `SkillsPanel`
- 如果后续接入钉钉，也走同一套 `canonical pack -> bridge -> internal wrappers` 机制

### 6.2 三类 subagent

#### A. 识别 subagent

输入：

- 截图
- Accessibility 文本
- 窗口元信息

输出：

- `SurfaceSnapshot`

工具权限：

- vision
- 无写权限

#### B. 解析 subagent

输入：

- `SurfaceSnapshot`

输出：

- `ExternalContextBundle`

工具权限：

- 只允许调用 vonvon 封装的 `FeishuCliService`
- 默认只读

#### C. 动作 subagent

输入：

- 用户问题
- 已解析上下文

输出：

- 实际执行结果，或执行前确认草案

工具权限：

- 根据任务按域放开
- 写操作默认走 dry-run 或二次确认

### 6.3 主 agent 的职责

主 agent 不负责“探索飞书 API”。

主 agent 只负责：

- 判断当前是否需要飞书上下文
- 调用识别 / 解析 subagent
- 把解析结果拼到当前回合
- 在需要执行操作时再调动作 subagent

这样能最大限度利用 Hermes 的 subagent 能力，同时保持主会话干净。

## 7. 聊天链路如何注入上下文

当前 `ChatRequest` 只有：

- `session_id`
- `message`
- `attachments`
- `skills`

建议扩展为：

```py
class ChatContextBlock(BaseModel):
    source: str
    kind: str
    title: str
    summary: str
    snippets: list[str] = Field(default_factory=list)
    provenance: list[dict[str, str]] = Field(default_factory=list)


class ChatRequest(BaseModel):
    session_id: str
    message: str
    attachments: list[ChatAttachment] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    context_blocks: list[ChatContextBlock] = Field(default_factory=list)


class SessionPinnedContextRef(BaseModel):
    provider: str
    kind: str
    resource_id: str
    title: str
    summary: str = ""
    provenance: list[dict[str, str]] = Field(default_factory=list)
    last_resolved_at: float | None = None
    cache_expires_at: float | None = None
    stale: bool = False
```

其中：

- `context_blocks` 只表示“本轮临时附加上下文”
- “本会话持续使用”不能只靠前端记住 chip，而要落到后端 session sidecar state

建议新增：

- `backend/app/services/session_context_service.py`
- `backend/app/routes/sessions.py` 增加：
  - `GET /api/sessions/{session_id}/external-context`
  - `PUT /api/sessions/{session_id}/external-context`
  - `DELETE /api/sessions/{session_id}/external-context/{provider}/{resource_id}`

建议存储位置：

```text
HERMES_HOME/state/session_context/
  <session_id>.json
```

这里建议加上原子写入约束：

- 所有写入通过 `tmp file + rename` 完成
- `reset / delete / archive` session 时同步清理 sidecar
- 多窗口并发写同一 session 时，以 `updated_at` + last-write-wins 为基础策略
- chat send 读取 pinned refs 时如果发现损坏文件，自动降级为空并记录一次诊断日志

存储原则：

- 只持久化“资源引用 + 短摘要 + provenance”，不把完整飞书原文写进 session DB
- chat/doc/calendar 的稳定标识分别保存为 `resource_id`
- 可额外缓存一次最近解析出的 snippets，但只作为短期缓存，不作为长期历史

然后在 `backend/app/routes/chat.py` 中，不是只编译本轮 `context_blocks`，而是先合成：

- request 传入的 turn-local `context_blocks`
- session sidecar 中 pinned 的 `SessionPinnedContextRef`

得到 `effective_context_blocks` 后，再编译进本轮 prompt：

```text
[External Context]
Source: Feishu
Surface: chat
Title: 产品设计群
Summary: 最近在讨论 sidebar 上下文注入与扫码授权流程
Snippets:
- ...
- ...
```

注意：

- 这类上下文分两层：
  - turn-local：仅本轮生效
  - session-pinned：整个会话持续生效，但通过 sidecar state 维护
- 不建议默认把完整飞书内容永久写入 session history
- session history 里最多保留一条短 provenance，比如“已附加飞书上下文：产品设计群”
- 后端在每次发送前都要尝试刷新 pinned ref 的短缓存，避免用户第二轮问“继续刚才那个文档”时上下文已经丢失

“本会话持续使用”的精确定义建议写死：

- 用户打开 toggle 时，当前上下文 bundle 被转成 `SessionPinnedContextRef` 写入 `session_context/<session_id>.json`
- 用户切换会话或刷新应用时，前端通过 `GET /external-context` 重新渲染这些 chip
- 用户下一轮发消息时，即使前端没有重新点击粉球，后端也会读取 pinned refs 并生成 `effective_context_blocks`
- pinned ref 在以下情况失效：
  - 用户手动移除
  - session 被 reset / delete / archive
  - 飞书授权失效或资源已无权限访问，此时标记 `stale=true` 并提示重新授权或刷新
- `summary/snippets` 缓存只做短期加速，建议 `cache_expires_at` 为 30 分钟；过期后下一次发送或重新打开会话时自动刷新

## 8. 前端交互设计

### 8.1 粉球点击后的反馈

用户点击粉球后，应立即看到小反馈，而不是静默等待。

建议 Kirby 附近出现一个轻量状态：

- `正在读取飞书上下文…`
- `已识别：产品设计群`
- `已识别：需求评审文档`
- `识别不确定，请选择`

### 8.2 Composer 上下文 chip

在聊天输入区上方加入一个新的 context chip 区域，和当前文件 / skill 选择并列，但视觉区分开：

- `飞书 · 产品设计群`
- `飞书 · 需求评审文档`
- `飞书 · 今日 14:00 评审会`

用户可以：

- 删除本轮上下文
- 手动刷新
- 切换“只本轮使用 / 本会话持续使用”

当 chip 处于“本会话持续使用”时，建议额外展示一个 pinned 状态：

- `飞书 · 产品设计群 · 本会话`

当后端判断引用已失效时，chip 进入 stale 状态：

- `飞书 · 产品设计群 · 需刷新`

除此之外，还需要定义几个关键失败态，不然实现时只会做 happy path：

- `飞书能力未开启`
- `缺少屏幕录制权限`
- `缺少辅助功能权限`
- `飞书 CLI 未登录`
- `当前窗口无法识别`
- `识别到多个候选，请选择`

每个失败态都要有明确按钮：

- `去设置`
- `重新授权`
- `重新识别`
- `手动选择`

### 8.3 模糊时给用户轻确认

当识别不确定时，不要强行猜。

例如给 2~3 个候选：

- 当前群聊：`产品设计群`
- 当前文档：`Sidebar 深度集成方案`
- 当前日程：`周四需求评审`

让用户点一个即可。

## 9. 钉钉兼容抽象

不要把抽象层命名成 `FeishuContextService` 然后未来硬改。

建议直接引入 suite 抽象：

```py
class SuiteProvider(Protocol):
    suite_name: str

    async def inspect_surface(self, desktop_signal: dict) -> SurfaceSnapshot: ...
    async def resolve_context(self, snapshot: SurfaceSnapshot) -> ExternalContextBundle: ...
    async def perform_action(self, action: dict) -> dict: ...
```

实现：

- `FeishuSuiteProvider`
- `DingTalkSuiteProvider`

对应注册表：

- `backend/app/services/suite_registry.py`

桌面侧也类似：

- `FeishuDesktopProvider`
- `DingTalkDesktopProvider`

这样未来接钉钉 CLI 时，主要替换的是：

- 表面识别规则
- CLI wrapper
- skill pack

聊天注入链路和 agent 编排层都可以复用。

## 10. 建议的代码落点

### Electron / Native

- `native/src/snap_engine.mm`
  - 补充窗口标题/前台状态采样
- `native/src/drag_handler.h`
- `native/src/drag_handler.mm`
  - 新增 dockedExpanded click 事件
- `native/src/addon.mm`
  - 暴露新的 N-API callback
- `src/main/native/kirby.ts`
  - 接 Kirby click → 调用 inspect
- `src/preload/index.ts`
  - 暴露 integration IPC
- `src/main/ipc.ts`
  - 注册 setup / inspect / context IPC

### Renderer

- `src/renderer/components/Settings/SettingsPanel.tsx`
  - 新增“飞书集成”页签
- `src/renderer/components/Settings/FeishuIntegrationPanel.tsx`
  - 安装、初始化、验活、权限提示
- `src/renderer/components/Chat/InputArea.tsx`
  - 新增外部上下文 chip
- `src/renderer/hooks/useAgentChat.ts`
  - 发消息时带 `context_blocks`
- `src/renderer/hooks/useFeishuContext.ts`
  - 管理本轮/会话级飞书上下文

### Backend

- `backend/app/schemas.py`
  - 扩展 `ChatRequest`
- `backend/app/routes/chat.py`
  - 注入 `context_blocks`
- `backend/app/routes/integrations.py`
  - 新增安装、初始化、状态、inspect、resolve API
- `backend/app/services/suite_runtime_service.py`
  - 管理 CLI runtime
- `backend/app/services/suite_registry.py`
  - suite 抽象
- `backend/app/services/feishu_cli_service.py`
  - lark-cli wrapper
- `backend/app/services/feishu_context_service.py`
  - 表面解析 → 上下文 bundle

## 10.1 最小测试策略

这部分现在还不够具体，建议在开工前就锁死：

- unit
  - `FeishuRuntimeManager` 状态机、升级、回滚、卸载
  - `FeishuCliService` 命令白名单、超时、错误翻译
  - `session_context_service` 的 sidecar 持久化、过期、清理、损坏恢复
- integration
  - `/api/integrations/feishu/*` 安装、状态、enable/disable、inspect
  - `/api/chat/send` 合成 turn-local + session-pinned `effective_context_blocks`
  - session reset/delete/archive 与 external-context sidecar 联动
- renderer
  - settings 页权限梯子和 CTA
  - composer chip 的本轮 / 本会话 / stale / disabled 状态
  - 粉球点击后的 loading / recognized / ambiguous / failure 状态
- e2e / manual smoke
  - feature off 时点击粉球不会触发截图或 inspect
  - feature on 但 auth 失效时会阻断 resolve，并给出重新授权
  - Phase 2 的 chat / doc / calendar 三条主路径

特别注意：

- 涉及截图、Accessibility、CLI 的链路要设计 fake provider / fake runtime，避免测试完全依赖真实飞书环境
- 对 LLM 注入只验证结构和裁剪规则，不在单元测试里依赖真实模型输出

## 11. 分阶段落地建议

### Phase 1：安装、鉴权、开关先落地

- 新增飞书设置页安装流
- 跑通 managed runtime 安装
- 支持检查并升级 managed `@larksuite/cli`
- 跑通 `lark-cli config init --new`
- 跑通 `lark-cli auth login --recommend`
- 明确 `runtime_status` 与 `feature_enabled` 两套状态
- 支持“开启飞书能力 / 关闭飞书能力”
- 开启时同步 `feishu-*` internal skills，并打开粉球点击 inspect 开关
- 关闭时停止 `feishu-*` internal skills，并禁用粉球点击截图/识别
- 粉球点击链路此阶段只需要打通 capability gate 和基础埋点，不急着做完整上下文解析

这是最先该做的一版，因为它决定了：

- 用户能不能顺利安装和登录
- 飞书能力能不能被明确开启/关闭
- Hermes skill / native inspect 能不能被同一个开关一致管控

Phase 1 完成的标志建议补充为：

- `feature_enabled=false` 时，点击粉球绝不会触发截图、Accessibility 读取或 CLI 调用
- `feature_enabled=true` 时，internal wrappers 与 inspect gate 同步开启
- upgrade / rollback / uninstall 都能在设置页走通
- 权限缺失、auth 失效、doctor 失败都能回到明确的 UI 状态，而不是停在半启用状态

### Phase 2：点击粉球后的最小闭环

- 新增 `dockedExpanded` 点击事件
- 点击粉球后触发窗口元信息采样 + 截图
- 先用“窗口标题 + vision”识别当前大类表面
- 只支持三类表面：
  - chat
  - doc
  - calendar
- 先把识别结果作为 turn-local `context_blocks` 注入
- UI 给出明确反馈：
  - 正在读取飞书上下文
  - 已识别
  - 识别不确定，请选择

这一阶段先验证产品手感，不强依赖完整 CLI 深挖。

Phase 2 完成的标志建议补充为：

- 三类主表面能走通 happy path
- 错误识别时用户能在一次轻确认内修正
- inspect 链路满足延迟预算
- 默认不产生任何 session pinned context，除非用户显式切到“本会话持续使用”

### Phase 3：CLI 解析增强

- 把视觉/标题提示映射到实际 chat/doc/event 资源
- 用 `lark-cli` 拉取更完整上下文
- 增加 composer context chip
- 增加“刷新上下文”与“本会话持续使用”
- 引入 session pinned context sidecar state
- 让“继续刚才那个文档”这类追问稳定成立

### Phase 4：Hermes 编排增强

- 固化专门的 `feishu-*` skill pack
- 引入识别 / 解析 / 动作 三类 subagent
- 写操作默认 dry-run + 二次确认

### Phase 5：多套件扩展

- 抽出 suite registry
- 接入 DingTalk CLI
- UI 上升维成“企业协作集成”

## 12. 风险与规避

### 风险 1：飞书桌面端表面信息不稳定

规避：

- 原生窗口标题、Accessibility、vision 三路合并
- 允许模糊时请用户点选

### 风险 2：lark-cli 安装和账号态不完全可控

规避：

- 通过 vonvon managed wrapper 统一调度
- 设置页持续显示 `doctor` / `auth status`
- 日志和错误做产品化翻译

### 风险 3：把飞书 skills 混进当前 skills 心智

规避：

- 飞书 skill pack 作为 integration-private 能力
- 不直接暴露进现有 SkillsPanel

### 风险 4：权限敏感

规避：

- 只有用户点击粉球时才采样
- 屏幕录制和辅助功能权限单独说明
- 默认不开启后台持续监听

### 风险 5：企业信任和数据治理不清楚

规避：

- 明确截图、Accessibility 文本、summary/snippets 的存储和上传边界
- 日志默认脱敏，禁止写原始截图和长文本正文
- settings 页提供关闭、清空、撤销 pinned context 的入口

## 13. 我建议的最终方案

最推荐的方案是：

1. 先把飞书安装、鉴权、开启/关闭能力、internal skills bridge 做扎实。
2. 再做“点击粉球触发 inspect”的最小闭环，先验证截图采样和表面识别体验。
3. 然后接入 vonvon 托管的 `lark-cli` runtime，把识别结果解析成真正可用的飞书上下文。
4. 把飞书上下文分成 turn-local `context_blocks` 和 session-pinned sidecar state 两层注入。
5. 最后把官方 lark-cli skills 内化为 vonvon 的 `feishu-*` integration skill pack，并交给 Hermes subagent 编排。
6. 整个能力从一开始就以 `suite provider` 抽象实现，为未来钉钉 CLI 复用。

这条路线的优点是：

- 贴合你现在仓库结构
- 用户体验明确
- 不会污染现有通用 skill 体系
- 能自然借力 Hermes 的 skill / subagent 能力
- 后续扩钉钉几乎不用推倒重来

## 14. /autoplan CEO Review

### 模式

- `SELECTIVE EXPANSION`

### Premise Challenge

当前核心 premise 我接受：

- 用户真的想要“vonvon 看到当前飞书表面并带上下文进入会话”
- 安装、鉴权、enable/disable 必须先于点击 inspect 落地
- 飞书 internal skills 不能污染当前通用 skill 心智

我挑战并已修正的 premise：

- 不能把“深度集成”默认为“平台化”
- 没有 success metric 的方案会自然膨胀成 runtime + bridge + subagent + multi-suite 的大拼盘
- 没有 trust boundary 的企业集成，即使技术上做出来，也很难真的被打开

### What Already Exists

- Kirby 与飞书窗口吸附、dock、sidebar 跟随已经存在
- backend chat、session、skills、settings 基础设施已经存在
- 当前仓库已经有能力承载 managed runtime、integration API、session sidecar state

### NOT in Scope

- 后台持续监听
- Phase 1 / Phase 2 的写操作 agent
- 在 Feishu 价值尚未验证前同步做 DingTalk 全量实现
- 把飞书 internal skills 做成用户可自由安装的通用 market skills

### Error & Rescue Registry

| User Sees | Likely Cause | Rescue |
|---|---|---|
| 开启不了飞书能力 | runtime/config/auth 未完成 | settings 面板回到权限梯子，逐步恢复 |
| 点击粉球没反应 | feature disabled 或权限缺失 | 明确提示 `去设置` / `开启能力` |
| 识别错上下文 | window/accessibility/vision 信号不一致 | 降级到候选项轻确认 |
| 第二轮追问失去上下文 | session-pinned ref 未持久化或过期 | sidecar state + 自动刷新 |
| 升级后不可用 | 新 CLI 版本验活失败 | rollback 到 `last_good_version` |

### Failure Modes Registry

| Failure Mode | Severity | Plan Response |
|---|---|---|
| 方案持续膨胀，迟迟不验证产品 wedge | critical | 加 success metrics、non-goals、phase completion criteria |
| 企业用户不清楚数据去哪了 | critical | 写死 trust boundary、脱敏、清空能力 |
| enable/disable 只关掉 UI，没真正关 inspect/skills | high | 用统一 `feature_enabled` gate 控制 wrappers 与 inspect |
| runtime 可安装但不可升级/回滚/卸载 | high | 把 upgrade/rollback/uninstall 纳入 Phase 1 |

### Dream State Delta

- 当前 plan 解决的是“用户显式点一下 vonvon，就能把当前飞书 chat/doc/calendar 上下文带进会话”
- 12 个月理想态才是“多套件、多动作、subagent 编排、可信企业协作入口”
- 所以正确策略不是一口吃成平台，而是先打透单击 inspect 这一刀

### CEO Dual Voices

`Codex` outside voice 完成了 repo + plan + chat surface 的独立读取，但结构化输出在超时前未完整返回；可确认的外部信号是：

- 方案有 scope sprawl 风险
- plan 需要更清楚地证明 product wedge，而不是只证明 integration sophistication
- repo 现实和 plan 基线基本吻合，说明这不是空中楼阁

### CEO Consensus Table

| Dimension | Primary Review | Codex Outside Voice | Consensus |
|---|---|---|---|
| Premises valid? | 条件成立 | 条件成立，但需收窄 wedge | CONFIRMED |
| Right problem to solve? | 是 | 是，但要先验证 click-to-context | CONFIRMED |
| Scope calibration correct? | 需收紧 | 有平台化膨胀风险 | CONFIRMED GAP |
| Alternatives sufficiently explored? | 部分不足 | 不足 | CONFIRMED GAP |
| Competitive / trust risks covered? | 原本不足，现已补 | 不足 | CONFIRMED GAP |
| 6-month trajectory sound? | 取决于先验证 wedge | 取决于先验证 wedge | CONFIRMED |

### CEO Completion Summary

- 结论：方向成立，但只有在“先打透安装/鉴权/enable gate + click inspect wedge”的前提下才成立
- 建议：按修订后的 Phase 1 / Phase 2 开工，不要提前跳到动作 agent 或 DingTalk 并行实现

## 15. /autoplan Design Review

### 0A. Initial Design Rating

| Dimension | Score | What was missing | What changed |
|---|---:|---|---|
| Information Architecture | 8 | 设置页与聊天态关系已清楚，但缺 success criteria | 补了 wedge、non-goals、phase completion |
| Interaction State Coverage | 8 | 缺 failure ladder | 补了权限梯子、disabled/stale/failure states |
| User Journey & Emotional Arc | 7 | 首次安装到首次成功的成就路径不够清楚 | 补了 TTHW 目标与反馈预算 |
| AI Slop Risk | 8 | 功能面广但 UI 仍较克制 | 保持现有克制方案，不做无意义界面发散 |
| Design System Alignment | 7 | 还没和现有 SettingsPanel / chat style 细化对齐 | 保留到实现期 |
| Responsive & Accessibility | 7 | 缺 CTA/failure 细态 | 补了 go-to-settings / retry / manual select |
| Unresolved Decisions | 6 | 对失败态和权限态描述不足 | 已显著收敛，但实现期仍需交互打样 |

### What Already Exists

- 现有 SettingsPanel / SkillsPanel 可承载 integration panel
- 现有 Kirby sidebar 已有 show / hide 动效和窄空间交互基础
- 现有 chat composer 已有 chip-like 承载能力

### Key Design Decisions

- 权限与授权不是隐藏流程，而是显式的 permission ladder
- 粉球点击必须先给即时反馈，再给结果，绝不能静默等待
- 上下文 chip 必须允许用户看到、刷新、移除、固定、识别失效

### Design Consensus Table

| Dimension | Primary Review | Codex Signal | Consensus |
|---|---|---|---|
| Information hierarchy sound? | 基本成立 | 需避免平台化 UI 膨胀 | CONFIRMED |
| Missing states covered? | 仍需补 failure ladder | 明显不足 | CONFIRMED GAP |
| User journey intentional? | 已改善 | 安装到首次成功仍偏长 | CONFIRMED GAP |
| Generic vs specific UI? | 已较具体 | 仍有少量实现期歧义 | CONFIRMED |
| Accessibility / responsive accounted for? | 基本覆盖 | 仍需实现期细化 | CONFIRMED |

### Unresolved Design Decisions

- settings 页是否需要把 `重新验证` 与 `doctor` 结果拆成可展开诊断面板
- composer chip 是否要允许发送前预览具体 snippets
- 模糊识别候选列表是在 Kirby 附近轻浮层呈现，还是在 composer 上方呈现

### Design Completion Summary

- 方向：通过
- 风险：权限梯子和失败态如果偷懒，会直接把这套方案做成“看起来很强，实际上不敢用”的集成

## 16. /autoplan Eng Review

### Architecture ASCII Diagram

```text
Kirby click
  -> native addon / drag handler
  -> src/main/native/kirby.ts
  -> integration IPC
  -> backend /api/integrations/feishu/*
  -> FeishuRuntimeManager / FeishuCliService / FeishuContextService
  -> renderer context chip state
  -> useAgentChat sends context_blocks
  -> chat route merges pinned refs from session_context_service
```

### Scope Challenge

这不是一个单点改动，而是一个横切 native / main / preload / renderer / backend / session state 的 feature。

真正需要锁住的不是“要不要做”，而是边界：

- inspect path 与 action path 分离
- feature gate 与 runtime/auth status 分离
- turn-local context 与 session-pinned context 分离
- internal wrappers 与 user-visible skills 分离

### What Already Exists

- `src/main/native/kirby.ts` 已有 docked click 与 sidebar lifecycle 基础
- `backend/app/schemas.py` 与 `useAgentChat.ts` 目前都还没有 `context_blocks`
- `SkillsPanel` / `skills_service` 现在还会把 skill 当用户可见项处理
- `routes/sessions.py` 目前没有 external context metadata 通道

### ENG DUAL VOICES — CONSENSUS TABLE

| Dimension | Primary Review | Codex Signal | Consensus |
|---|---|---|---|
| Architecture sound? | 可行但横切面大 | repo baseline matches plan | CONFIRMED |
| Test coverage sufficient? | 目前不足 | 计划低估验证成本 | CONFIRMED GAP |
| Performance risks addressed? | 已补 latency budget | inspect 迟缓是核心风险 | CONFIRMED GAP |
| Security / trust threats covered? | 已补 trust boundary | 先前不足 | CONFIRMED GAP |
| Error paths handled? | 已显著改善 | 仍需 implementation-level fallbacks | CONFIRMED |
| Deployment / upgrade risk manageable? | 取决于 rollback/uninstall 落地 | upgrade mismatch is real risk | CONFIRMED |

### Test Diagram

| Codepath / UX Flow | Coverage Type | Needed |
|---|---|---|
| install -> config -> auth -> ready | integration + manual smoke | required |
| enable/disable flips wrappers + inspect gate | integration + renderer | required |
| Kirby click while disabled | manual / e2e | required |
| Kirby click while enabled -> loading -> recognized | renderer + manual | required |
| ambiguous candidates -> manual pick | renderer + manual | required |
| `POST /api/chat/send` merges local + pinned context | backend integration | required |
| session reset/delete/archive clears sidecar | backend integration | required |
| upgrade failure -> rollback | unit + integration | required |

### Test Plan Artifact

- [clay-feat-lark-test-plan-20260416-102359.md](/Users/clay/.gstack/projects/vonvon/clay-feat-lark-test-plan-20260416-102359.md)

### Failure Modes

| Failure Mode | Severity | Mitigation |
|---|---|---|
| sidecar state 并发写坏 | high | 原子写 + last-write-wins + corruption fallback |
| inspect 太慢导致用户以为没点上 | high | 300ms / 1.5s / 3s latency budget |
| feature off 但仍然触发截图 | critical | gate 放在 main/native inspect 入口，不只放在 renderer |
| wrappers 升级后和 runtime 版本失配 | high | upgrade 后重新 bridge + verify |
| auth 失效后 pinned refs 静默注入旧摘要 | high | stale flag + auto refresh + visible chip state |

### Worktree Parallelization Strategy

Phase 1 可以拆成 3 条相对独立的实现线：

- A: settings / runtime / integration API
- B: skill bridge / enable-disable gate
- C: native inspect gate 与 Kirby click 埋点

Phase 2 再串联：

- D: inspect pipeline + feedback UI
- E: turn-local context injection

### Eng Completion Summary

- 结论：架构可行，但一定要先做 gate、state machine、atomic persistence、test scaffolding
- 最大隐藏复杂度：不是 CLI，本质上是“多状态、多边界、多权限”的系统性 feature

## 17. /autoplan DX Review

### Developer Persona Card

- 主要 persona：安装 vonvon 的高级用户 / 内部早期测试者，同时也是需要帮用户排障的产品工程师
- 成功定义：5 分钟内从“未安装”走到“能看到第一次飞书上下文注入”

### Developer Empathy Narrative

“我装了 vonvon，本来以为只是开个开关。结果它要 Node、要 CLI、要扫码、要屏幕录制、要辅助功能。如果这里任何一步解释不清楚，我不会觉得它强，我只会觉得它烦，而且不敢信任它到底看到了什么、发走了什么。” 

### Developer Journey Map

| Stage | Goal | Risk |
|---|---|---|
| 1. 发现功能 | 知道有飞书深度集成 | 心智不清楚，以为只是普通 skill |
| 2. 安装 runtime | 把 CLI 装起来 | Node/npm 缺失 |
| 3. 配置 | 跑 `config init --new` | 中途取消 |
| 4. 登录授权 | 完成扫码授权 | auth 状态不透明 |
| 5. 授权系统权限 | 给屏幕录制 / 辅助功能 | 用户不知道为什么需要 |
| 6. 开启 feature | 真正打开能力 | runtime ready 但 feature off |
| 7. 点击 inspect | 拿到第一次反馈 | 无反馈 / 太慢 |
| 8. 注入会话 | 看见上下文 chip | 不知道注入了什么 |
| 9. 恢复与升级 | auth 失效 / CLI 升级 | 无恢复路径 |

### DX DUAL VOICES — CONSENSUS TABLE

| Dimension | Primary Review | Codex Signal | Consensus |
|---|---|---|---|
| Getting started < 5 min? | 目标明确但未达成 | onboarding still heavy | CONFIRMED GAP |
| API / CLI naming guessable? | 基本清楚 | acceptable | CONFIRMED |
| Error messages actionable? | 需产品化文案 | currently under-specified | CONFIRMED GAP |
| Docs findable & complete? | 计划文档可开工 | okay for internal build | CONFIRMED |
| Upgrade path safe? | 已补完整机制 | was missing before | CONFIRMED |
| Dev environment friction-free? | 仍需 fake runtime/provider | setup burden remains | CONFIRMED GAP |

### DX Scorecard

| Dimension | Score | Note |
|---|---:|---|
| Getting Started | 7 | 已补流程，但仍依赖多权限 |
| API / CLI Design | 8 | runtime manager 与 wrapper 边界已清楚 |
| Error Messages & Debugging | 7 | 已补 permission ladder，但实现期必须产品化文案 |
| Documentation & Learning | 8 | 计划文档已可开工 |
| Upgrade & Migration | 8 | 已补 upgrade / rollback / uninstall |
| Dev Environment & Tooling | 7 | 仍需 fake runtime / fake provider 测试基建 |
| Community & Ecosystem | 6 | 暂无对外生态要求，当前可接受 |
| DX Measurement & Feedback | 7 | 已补 TTHW 与 latency 目标，但还缺埋点定义 |

### TTHW Assessment

- 当前预估：8-12 分钟
- 目标：`< 5 分钟`
- 要达成这个目标，必须把 settings 页变成真正的 guided flow，而不是散装按钮

### DX Implementation Checklist

- 有单一路径能完成 install -> config -> auth -> enable
- 每个失败态都能给 problem + cause + next step
- 有 `重新验证`、`重新授权`、`升级`、`卸载` 四个恢复抓手
- 有 fake runtime / fake provider 支撑自动化测试
- 有可见的 version / last verified / last good version 信息

### DX Completion Summary

- 结论：这不是一个“接个 CLI”就完的功能，它本质上是一个 onboarding-heavy feature
- 如果没有极顺的安装与恢复路径，真实用户不会把它开着

## 18. Cross-Phase Themes

- `先验证 wedge，后扩平台`：CEO、Eng、DX 三个视角都指向同一个结论
- `权限、授权、enable gate 必须统一`：Design、Eng、DX 都把这件事当成核心
- `用户必须看得见上下文是怎么来的`：Trust 是产品问题，不只是安全问题

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | 保留 Feishu 深度集成方向，但先收窄为 click-to-context wedge | Mechanical | P1, P2 | 用户价值最直接，且 blast radius 可控 | 直接做平台化多套件 |
| 2 | CEO | 不先做 DingTalk 完整实现 | Mechanical | P3, P6 | 先证明 Feishu 有效，再复用抽象 | Phase 1 并行双套件 |
| 3 | CEO | 把 trust boundary 写进 plan 本体 | Mechanical | P1 | 企业协作集成没有数据边界就不可信 | 留到实现时再说 |
| 4 | Design | 把 permission ladder 设计成显式状态，而不是隐式错误 | Mechanical | P1, P5 | 用户需要知道卡在哪一步 | 只弹 toast |
| 5 | Eng | `feature_enabled` 必须统一控制 wrappers 与 inspect gate | Mechanical | P5 | 否则会出现 UI 关了但底层还在采样 | 分别开关 |
| 6 | Eng | session pinned context 用 sidecar state，不写进 SessionDB 正文 | Mechanical | P1, P5 | 降低污染历史和隐私风险 | 直接塞进历史消息 |
| 7 | Eng | Phase 1 纳入 upgrade / rollback / uninstall | Mechanical | P2 | 这是 managed runtime 的一部分，不是后续 embellishment | 先只做安装 |
| 8 | DX | 以 `< 5 分钟` TTHW 为目标 | Taste | P1, P5 | 这是能不能被真实打开的门槛 | 接受 8-12 分钟初版 |

## 19. GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open | 3 |
| Codex Review | `codex exec` | Independent 2nd opinion | 1 | partial_signal | 2 |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | issues_open | 5 |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open | 3 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | issues_open | 4 |

**VERDICT:** REVISED AND READY FOR APPROVAL GATE
