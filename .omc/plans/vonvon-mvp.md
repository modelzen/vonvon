# Vonvon MVP Implementation Plan

## Source Spec
- Spec: `.omc/specs/deep-interview-vonvon.md`
- Ambiguity: 19.5% (PASSED)
- Generated: 2026-04-08
- Consensus: Iteration 2 (revised per Architect + Critic review)

---

## RALPLAN-DR Summary

### Principles
1. **MVP-First**: 只实现卡比浮窗 + 吸附 + 对话三个核心能力，所有后续功能（Skill/MCP/Memory/飞书集成）严格排除
2. **Native Where Needed**: 窗口控制（拖拽、吸附检测、变形动画）全部在 native addon 层实现，UI 用 Web 技术（React），各取所长
3. **Secure by Default**: 敏感操作（API Key 持有、LLM 调用）在 main process，renderer 仅负责 UI 渲染，通过 IPC 通信
4. **Distributable from Day 1**: 从一开始就考虑 DMG 打包、代码签名、公证，不留"最后一步"的技术债
5. **Extensible Foundation**: MVP 的架构要为后续 Skill/MCP/Memory 留好扩展点，但不提前实现

### Decision Drivers
1. **开发速度**: 首版需要尽快可用——用户已有明确演示目标（4 条验收标准）
2. **窗口控制能力**: 卡比吸附是核心卖点，必须流畅自然——需要 native 层完全控制拖拽和动画
3. **多模型生态**: 支持 OpenAI + Anthropic（MVP 均用 API Key），参考 opencode 的 Provider 接口设计

### Viable Options

#### Option A: Electron + 自建 N-API Native Addon (Recommended)
- **Approach**: Electron 做主框架，自建 Objective-C++ native addon 控制 NSPanel/窗口行为，Provider 层在 main process，对话 UI 用 React
- **Pros**:
  - Electron 生态成熟，参考项目（Proma/CodePilot）均采用此方案
  - 自建 native addon 完全控制窗口行为，不依赖废弃包
  - electron-builder 打包 DMG 成熟可靠
  - Provider 在 main process，符合 Electron 安全模型
- **Cons**:
  - 应用体积较大（~150MB+）
  - Native addon 编译增加构建复杂度（需要 Xcode + cmake-js）
  - 需维护 TypeScript + Objective-C++ 两种语言

#### Option B: Tauri 2 + Swift Plugin
- **Approach**: Tauri 2 做主框架（Rust 后端 + WebView），Swift plugin 做窗口控制
- **Pros**:
  - 体积小（~15MB），下载体验好 10 倍
  - Swift 比 Objective-C++ 更现代，开发体验更好
  - Tauri 2 (2024.10 稳定版) 原生支持 Swift plugin 和多窗口
- **Cons**:
  - 参考项目（Proma/CodePilot）均为 Electron，无 Tauri 先例可验证
  - 团队需要 Rust + Swift + Web 三端能力
  - 多窗口管理成熟度不如 Electron
- **Invalidation rationale**: 用户已在访谈中选择 Electron 路线；虽然 Tauri 2 已成熟，但无参考项目代码可复用。ADR 中记录：如果 native addon 开发成本超预估 2 倍，重新评估 Tauri 2。

---

## Requirements Summary

构建 Vonvon macOS 桌面应用 MVP：
1. 星之卡比风格粉红色圆形宠物浮窗，可自由拖拽
2. 拖拽到飞书窗口右侧时触发吸附动画，松开后变为侧边栏
3. 侧边栏内嵌 AI 对话界面，支持多模型流式响应
4. 打包为 DMG 安装包分发

## Acceptance Criteria

- [ ] **AC-1**: 启动应用后，桌面出现 ~80px 粉红色圆形卡比浮窗，可在桌面任意位置拖拽移动，拖拽帧率 ≥ 30fps
- [ ] **AC-2**: 拖拽卡比至飞书窗口右边缘 60px 范围内时，出现吸附提示动画（卡比向目标窗口方向微微拉伸/发光），松开前可取消
- [ ] **AC-3**: 松开后卡比执行吸附动画（≤ 300ms），从圆形浮窗变形为 360px 宽的矩形侧边栏窗口，紧贴飞书窗口右侧
- [ ] **AC-4**: 侧边栏顶部显示模型选择器（至少 OpenAI GPT-4o + Claude Sonnet），底部有输入框，发送消息后 ≤ 2s 内开始接收流式回复
- [ ] **AC-5**: 设置页可配置 API Key（Anthropic + OpenAI 均为 API Key），配置持久化到本地，重启后仍在
- [ ] **AC-6**: `npm run build` 产出 DMG 安装包，可在未安装开发环境的 Mac (macOS 13+) 上正常运行
- [ ] **AC-7**: 飞书窗口移动时，侧边栏自动脱离回浮窗模式（降级方案，避免"脱节"体验）

## Implementation Steps

### Stage 1: 项目脚手架 (Team Agent 1)

**目标**: 初始化 Electron + React + TypeScript 项目结构

```
vonvon/
├── package.json              # Electron + React deps
├── electron-builder.yml      # 打包配置
├── CMakeLists.txt            # cmake-js 构建 native addon
├── tsconfig.json
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # 入口，创建窗口
│   │   ├── ipc.ts            # IPC handler 注册
│   │   ├── providers/        # LLM Provider 层 (main process!)
│   │   │   ├── base.ts       # Provider 接口定义
│   │   │   ├── openai.ts     # OpenAI Provider (API Key)
│   │   │   ├── anthropic.ts  # Anthropic Provider (API Key)
│   │   │   └── registry.ts   # Provider 注册表
│   │   ├── store.ts          # 对话状态 source of truth (main process)
│   │   └── native/           # Native addon TypeScript 桥接
│   │       └── kirby.ts      # Kirby 窗口控制 API (调用 native addon)
│   ├── renderer/             # React renderer (仅 UI)
│   │   ├── index.html
│   │   ├── main.tsx          # React 入口
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Chat/         # 对话组件
│   │   │   ├── Kirby/        # 卡比浮窗 UI (HTML/CSS 渲染)
│   │   │   └── Settings/     # 设置页
│   │   ├── hooks/            # IPC 通信 hooks
│   │   │   ├── useChat.ts    # 通过 IPC 发送/接收消息
│   │   │   └── useSettings.ts
│   │   └── styles/           # Tailwind CSS
│   └── preload/
│       └── index.ts          # contextBridge 暴露安全 IPC API
├── native/                   # N-API native addon (Objective-C++)
│   ├── CMakeLists.txt        # cmake-js 构建配置
│   ├── src/
│   │   ├── addon.mm          # N-API 入口，注册所有方法
│   │   ├── kirby_window.mm   # NSPanel 创建、圆形外观
│   │   ├── drag_handler.mm   # NSEvent 监听鼠标事件，手动拖拽
│   │   ├── snap_engine.mm    # CGWindowListCopyWindowInfo 窗口检测
│   │   └── animator.mm       # NSAnimationContext 变形动画
│   └── index.d.ts            # TypeScript 类型定义
└── resources/
    ├── icon.icns             # 应用图标
    └── kirby.png             # 卡比素材
```

**关键依赖**:
```json
{
  "dependencies": {
    "electron": "^33.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "@anthropic-ai/sdk": "^0.70.0",
    "openai": "^4.80.0",
    "electron-store": "^10.0.0"
  },
  "devDependencies": {
    "electron-builder": "^25.0.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "node-addon-api": "^8.0.0",
    "cmake-js": "^7.0.0"
  }
}
```

**实现要点**:
- 参考 Proma 的 Electron main/renderer 分离模式
- 使用 Vite 构建 renderer
- Preload 脚本通过 `contextBridge` 暴露安全的 IPC API
- 使用 `cmake-js` 替代 `node-gyp`（更现代，配置更简洁）
- **Provider 和状态管理在 main process**，renderer 通过 IPC 订阅

### Stage 2: 卡比浮窗 + 吸附引擎 (Team Agent 2)

**目标**: 实现卡比圆形浮窗、自定义拖拽、窗口吸附机制、变形动画

**2a: 卡比浮窗** (`native/src/kirby_window.mm`)

使用 NSPanel (非 BrowserWindow) 创建浮窗，获得完整的原生窗口控制：

```objc
// native/src/kirby_window.mm
// 创建 NSPanel 作为卡比浮窗
NSPanel *panel = [[NSPanel alloc]
    initWithContentRect:NSMakeRect(x, y, 80, 80)
    styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
    backing:NSBackingStoreBuffered
    defer:NO];
[panel setLevel:NSFloatingWindowLevel];  // 悬浮在其他窗口之上
[panel setOpaque:NO];
[panel setBackgroundColor:[NSColor clearColor]];
[panel setHasShadow:NO];

// 加载 Electron 的 BrowserWindow webContents 到 NSPanel
// 或直接渲染粉红色圆形（Core Graphics）
```

- NSPanel + `NSWindowStyleMaskNonactivatingPanel`：悬浮但不抢焦点
- 圆形外观方案：透明 NSPanel + 内嵌 WebView（加载 kirby.html）渲染 CSS 圆形
- 备选：纯 Core Graphics 绘制（更轻量，但 HTML 渲染更灵活）

**2b: 自定义拖拽** (`native/src/drag_handler.mm`)

**不使用 `-webkit-app-region: drag`**（无法在拖拽过程中获取实时坐标），改为 native 层手动拖拽：

```objc
// native/src/drag_handler.mm
// 通过 NSEvent 全局监听鼠标事件
[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
    handler:^NSEvent *(NSEvent *event) {
        // 检查点击是否在卡比窗口内
        if ([self isPointInKirbyWindow:event.locationInWindow]) {
            self.isDragging = YES;
            self.dragOffset = /* 计算偏移 */;
        }
        return event;
    }];

[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDragged
    handler:^NSEvent *(NSEvent *event) {
        if (self.isDragging) {
            NSPoint newOrigin = /* 计算新位置 */;
            [self.kirbyPanel setFrameOrigin:newOrigin];
            
            // 实时吸附检测！
            [self.snapEngine checkSnapProximity:newOrigin];
        }
        return event;
    }];

[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseUp
    handler:^NSEvent *(NSEvent *event) {
        if (self.isDragging) {
            self.isDragging = NO;
            if (self.snapEngine.isInSnapZone) {
                [self.animator performSnapAnimation];
            }
        }
        return event;
    }];
```

优势：拖拽过程中每帧都能检测与飞书窗口的距离，实现实时吸附提示。

**2c: 吸附引擎** (`native/src/snap_engine.mm`)

```objc
// native/src/snap_engine.mm
- (void)checkSnapProximity:(NSPoint)kirbyPosition {
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    
    for (NSDictionary *info in (__bridge NSArray *)windowList) {
        NSString *ownerName = info[(__bridge NSString *)kCGWindowOwnerName];
        // 匹配飞书窗口
        if ([ownerName isEqualToString:@"Lark"] ||
            [ownerName isEqualToString:@"Feishu"] ||
            [ownerName isEqualToString:@"飞书"]) {
            
            CGRect bounds;
            CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds], &bounds);
            
            // 计算卡比与飞书右边缘的距离
            CGFloat rightEdge = bounds.origin.x + bounds.size.width;
            CGFloat distance = fabs(kirbyPosition.x - rightEdge);
            
            if (distance < 60.0) {
                self.isInSnapZone = YES;
                self.targetWindow = bounds;
                // 通过 N-API callback 通知 JS 层显示吸附提示
                [self notifySnapProximity:distance];
            } else {
                self.isInSnapZone = NO;
            }
        }
    }
    CFRelease(windowList);
}
```

**2d: 变形动画** (`native/src/animator.mm`)

使用 **单窗口 + `NSAnimationContext`** 平滑变形（不使用 CSS transition，不使用两窗口切换）：

```objc
// native/src/animator.mm
- (void)performSnapAnimation {
    CGRect targetBounds = self.snapEngine.targetWindow;
    
    // 目标位置：飞书窗口右侧，等高
    NSRect sidebarFrame = NSMakeRect(
        targetBounds.origin.x + targetBounds.size.width,  // 紧贴飞书右侧
        targetBounds.origin.y,                              // 与飞书顶部对齐
        360,                                                // 侧边栏宽度
        targetBounds.size.height                            // 与飞书等高
    );
    
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.3;  // 300ms
        context.timingFunction = [CAMediaTimingFunction
            functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
        
        // 平滑过渡：位置 + 尺寸同时变化
        [[self.kirbyPanel animator] setFrame:sidebarFrame display:YES];
    } completionHandler:^{
        // 动画完成：切换 WebView 内容从卡比 → 侧边栏对话 UI
        [self loadSidebarContent];
        self.currentState = KirbyStateDocked;
    }];
}
```

**2e: 飞书窗口移动检测 + 自动脱离**

```objc
// 定时轮询飞书窗口位置（每 500ms）
self.trackingTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
    repeats:YES block:^(NSTimer *timer) {
        if (self.currentState == KirbyStateDocked) {
            CGRect currentFeishuBounds = [self.snapEngine findFeishuWindow];
            if (!CGRectEqualToRect(currentFeishuBounds, self.lastFeishuBounds)) {
                // 飞书窗口移动了 → 自动脱离，回到浮窗模式
                [self detachToFloatingMode];
            }
            self.lastFeishuBounds = currentFeishuBounds;
        }
    }];
```

**N-API 暴露给 JS 的接口** (`native/index.d.ts`):

```typescript
declare module 'vonvon-native' {
  export function createKirbyWindow(x: number, y: number): void;
  export function destroyKirbyWindow(): void;
  export function getKirbyState(): 'floating' | 'snapping' | 'docked';
  export function loadContent(url: string): void;
  export function onSnapProximity(callback: (distance: number) => void): void;
  export function onSnapComplete(callback: () => void): void;
  export function onDetach(callback: () => void): void;
  export function detachToFloating(): void;
}
```

### Stage 3: 对话 UI + 多模型 Provider (Team Agent 3)

**目标**: 实现侧边栏对话界面和多模型支持

**3a: Provider 层（main process）** (`src/main/providers/`)

Provider 在 main process，renderer 通过 IPC 通信：

```typescript
// src/main/providers/base.ts
export interface Provider {
  id: string;
  name: string;
  models: Model[];
  
  chat(params: {
    messages: Message[];
    model: string;
    onChunk: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  
  validateApiKey(key: string): Promise<boolean>;
}

export interface Model {
  id: string;
  name: string;
  contextWindow: number;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}
```

```typescript
// src/main/providers/openai.ts
import OpenAI from 'openai';

export class OpenAIProvider implements Provider {
  id = 'openai';
  name = 'OpenAI';
  models = [
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
  ];
  
  private client: OpenAI;
  
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }
  
  async chat({ messages, model, onChunk, signal }) {
    const stream = await this.client.chat.completions.create(
      { model, messages, stream: true },
      { signal }
    );
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) onChunk(content);
    }
  }
  
  async validateApiKey(key: string) {
    try {
      const client = new OpenAI({ apiKey: key });
      await client.models.list();
      return true;
    } catch { return false; }
  }
}
```

```typescript
// src/main/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider implements Provider {
  id = 'anthropic';
  name = 'Anthropic';
  models = [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
  ];
  
  private client: Anthropic;
  
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }
  
  async chat({ messages, model, onChunk, signal }) {
    const stream = this.client.messages.stream({
      model, messages, max_tokens: 4096
    });
    if (signal) signal.addEventListener('abort', () => stream.abort());
    stream.on('text', (text) => onChunk(text));
    await stream.finalMessage();
  }
  
  async validateApiKey(key: string) {
    try {
      const client = new Anthropic({ apiKey: key });
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      });
      return true;
    } catch { return false; }
  }
}
```

**3b: IPC 通信层** (`src/main/ipc.ts`)

```typescript
// src/main/ipc.ts
import { ipcMain, BrowserWindow } from 'electron';
import { ProviderRegistry } from './providers/registry';
import { ChatStore } from './store';

export function registerIpcHandlers(registry: ProviderRegistry, store: ChatStore) {
  // 发送消息（renderer -> main）
  ipcMain.handle('chat:send', async (event, { content, providerId, modelId }) => {
    const messageId = store.addUserMessage(content);
    const assistantId = store.addAssistantMessage(''); // 占位
    
    const provider = registry.get(providerId);
    await provider.chat({
      messages: store.getMessages(),
      model: modelId,
      onChunk: (chunk) => {
        store.appendToMessage(assistantId, chunk);
        // 流式推送 chunk 到 renderer
        event.sender.send('chat:chunk', { messageId: assistantId, chunk });
      }
    });
    
    event.sender.send('chat:done', { messageId: assistantId });
    return { messageId: assistantId };
  });
  
  // 获取消息历史
  ipcMain.handle('chat:getMessages', () => store.getMessages());
  
  // 获取可用 Provider 和模型
  ipcMain.handle('providers:list', () => registry.listAll());
  
  // 设置 API Key
  ipcMain.handle('settings:setApiKey', async (_, { providerId, apiKey }) => {
    const valid = await registry.get(providerId).validateApiKey(apiKey);
    if (valid) store.setApiKey(providerId, apiKey);
    return { valid };
  });
  
  // 获取设置
  ipcMain.handle('settings:get', () => store.getSettings());
}
```

**3c: 对话 UI** (`src/renderer/components/Chat/`)

```
Chat/
├── ChatContainer.tsx    # 对话容器
├── MessageList.tsx      # 消息列表
├── MessageBubble.tsx    # 单条消息气泡
├── InputArea.tsx        # 输入框 + 发送按钮
├── ModelSelector.tsx    # 顶部模型选择
└── StreamingText.tsx    # 流式文本渲染
```

```typescript
// src/renderer/hooks/useChat.ts
export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  
  useEffect(() => {
    // 监听 main process 的流式 chunk
    const onChunk = (_: any, { messageId, chunk }: any) => {
      setMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, content: m.content + chunk } : m
      ));
    };
    const onDone = () => setIsStreaming(false);
    
    window.electronAPI.onChatChunk(onChunk);
    window.electronAPI.onChatDone(onDone);
    return () => { /* cleanup listeners */ };
  }, []);
  
  const sendMessage = async (content: string, providerId: string, modelId: string) => {
    setIsStreaming(true);
    setMessages(prev => [...prev, { role: 'user', content, id: crypto.randomUUID() }]);
    await window.electronAPI.chatSend({ content, providerId, modelId });
  };
  
  return { messages, isStreaming, sendMessage };
}
```

**3d: Preload 脚本** (`src/preload/index.ts`)

```typescript
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Chat
  chatSend: (params: any) => ipcRenderer.invoke('chat:send', params),
  getMessages: () => ipcRenderer.invoke('chat:getMessages'),
  onChatChunk: (cb: Function) => ipcRenderer.on('chat:chunk', cb as any),
  onChatDone: (cb: Function) => ipcRenderer.on('chat:done', cb as any),
  
  // Providers
  listProviders: () => ipcRenderer.invoke('providers:list'),
  
  // Settings
  setApiKey: (params: any) => ipcRenderer.invoke('settings:setApiKey', params),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  
  // Kirby
  onSnapProximity: (cb: Function) => ipcRenderer.on('kirby:snap-proximity', cb as any),
  onSnapComplete: (cb: Function) => ipcRenderer.on('kirby:snap-complete', cb as any),
  onDetach: (cb: Function) => ipcRenderer.on('kirby:detach', cb as any),
  detach: () => ipcRenderer.invoke('kirby:detach'),
});
```

### Stage 4: 设置页 + 持久化 (Team Agent 4)

**目标**: 设置页面、状态管理和配置持久化

**4a: 状态管理（main process）** (`src/main/store.ts`)

对话状态的 source of truth 在 main process，使用 `electron-store` 持久化：

```typescript
// src/main/store.ts
import Store from 'electron-store';

interface AppState {
  messages: Message[];
  settings: {
    apiKeys: Record<string, string>;  // { openai: 'sk-...', anthropic: 'sk-ant-...' }
    defaultProvider: string;
    defaultModel: string;
  };
}

export class ChatStore {
  private store: Store<AppState>;
  
  constructor() {
    this.store = new Store<AppState>({
      defaults: {
        messages: [],
        settings: {
          apiKeys: {},  // 注意：API Key 不存储在这里
          defaultProvider: 'openai',
          defaultModel: 'gpt-4o'
        }
      }
      // 非敏感配置用 electron-store 明文存储
    });
  }
  
  // API Key 使用 @electron/safeStorage 加密存储（底层使用 macOS Keychain）
  async setApiKey(providerId: string, apiKey: string) {
    const { safeStorage } = require('electron');
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(apiKey);
      this.store.set(`encryptedKeys.${providerId}`, encrypted.toString('base64'));
    }
  }
  
  async getApiKey(providerId: string): Promise<string | null> {
    const { safeStorage } = require('electron');
    const encrypted = this.store.get(`encryptedKeys.${providerId}`);
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    }
    return null;
  }
}
```

**4b: 设置页 UI** (`src/renderer/components/Settings/`)

```
Settings/
├── SettingsPanel.tsx      # 设置面板容器
├── ProviderSettings.tsx   # API Key 配置（输入框 + 验证状态）
├── ModelSettings.tsx      # 默认模型选择
└── AboutSection.tsx       # 版本信息
```

- Anthropic: API Key 输入框 + "Validate" 按钮（调用 `validateApiKey` IPC）
- OpenAI: API Key 输入框 + "Validate" 按钮（MVP 用 API Key，OAuth 推迟到 v1.1）
- API Key 使用 `@electron/safeStorage`（macOS Keychain）加密存储；非敏感配置用 `electron-store` 存储到 `~/Library/Application Support/Vonvon/config.json`

### Stage 5: 打包分发 (Team Agent 1 复用)

**目标**: DMG 打包 + 代码签名

```yaml
# electron-builder.yml
appId: com.vonvon.app
productName: Vonvon
mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch: [universal]  # x64 + arm64
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
dmg:
  contents:
    - x: 410
      y: 150
      type: link
      path: /Applications
    - x: 130
      y: 150
      type: file
```

**Entitlements** (`build/entitlements.mac.plist`):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <!-- 屏幕录制权限（CGWindowListCopyWindowInfo 需要） -->
    <key>com.apple.security.temporary-exception.mach-lookup.global-name</key>
    <array>
        <string>com.apple.windowserver.active</string>
    </array>
</dict>
</plist>
```

- Universal binary (x64 + arm64) 支持 Intel 和 Apple Silicon
- Native addon 通过 cmake-js 在打包时重编译
- 首次启动需要引导用户授权屏幕录制权限

## Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Native addon 编译在不同 macOS 版本失败 | High | Medium | 使用 prebuild 预编译二进制；CI 矩阵覆盖 macOS 13/14/15；cmake-js 比 node-gyp 更稳定 |
| CGWindowListCopyWindowInfo 需要屏幕录制权限 | High | High | 首次启动引导用户授权；无权限时降级为手动模式（拖拽到屏幕右侧弹出侧边栏） |
| 飞书窗口名称随版本变化 | Medium | Low | 匹配多个变体 "Lark" / "Feishu" / "飞书"；支持用户手动指定目标应用 |
| Electron 应用体积过大 | Low | High | 接受 ~150MB（用户已认可）；ADR 记录如 native addon 成本超预估 2 倍则评估 Tauri |
| NSAnimationContext 变形动画在不同分辨率下不一致 | Medium | Low | 使用相对坐标；测试 Retina 和非 Retina 显示器 |
| Objective-C++ addon 内存管理问题 | Medium | Medium | 使用 ARC (Automatic Reference Counting)；N-API Reference 管理生命周期 |

## Verification Steps

1. **浮窗验证**: 启动应用 → 桌面出现卡比浮窗 → 自定义拖拽移动流畅（≥30fps）→ 释放后不会飘到屏幕外
2. **吸附验证**: 打开飞书 → 拖拽卡比到飞书右侧 → 60px 内实时出现吸附提示 → 松开后 ≤300ms 完成变形动画 → 侧边栏紧贴飞书右侧
3. **脱离验证**: 侧边栏已吸附 → 移动飞书窗口 → 侧边栏 ≤1s 内自动脱离回浮窗模式
4. **对话验证**: 在侧边栏输入消息 → 选择 OpenAI/Claude → 发送 → ≤2s 内开始流式回复 → 回复完整无截断
5. **设置验证**: 打开设置 → 输入 API Key → Validate 显示成功 → 重启应用 → Key 仍在
6. **分发验证**: `npm run build` → 产出 DMG → 在另一台 Mac (macOS 13+) 安装 → 启动正常 → 授权屏幕录制权限后所有功能可用
7. **无权限降级验证**: 不授予屏幕录制权限 → 拖拽卡比到屏幕右侧 → 弹出手动吸附 UI → 可正常进入侧边栏对话
8. **无效 API Key 验证**: 输入无效 API Key → 点击 Validate → 显示验证失败提示 → Key 不被保存 → 提示用户重新输入
9. **网络中断验证**: 流式对话进行中断开网络 → UI 显示错误提示 → 不会卡死或崩溃 → 恢复网络后可重新发送

## Team Agent Work Distribution

| Agent | Scope | Dependencies | Complexity |
|-------|-------|-------------|------------|
| **Agent 1**: 脚手架 + 打包 | Stage 1 + Stage 5 | None | Medium |
| **Agent 2**: 卡比浮窗 + 吸附 | Stage 2 (native addon) | Stage 1 完成 | High |
| **Agent 3**: 对话 + Provider | Stage 3 (main process + renderer) | Stage 1 完成 | Medium-High |
| **Agent 4**: 设置 + 持久化 | Stage 4 (store + settings UI) | Stage 1 完成 | Low-Medium |

**并行策略**: Agent 1 先完成脚手架（Stage 1），然后 Agent 2/3/4 并行开发，最后 Agent 1 负责打包集成（Stage 5）。

---

## ADR: Vonvon MVP Architecture Decision

### Decision
采用 Electron + 自建 N-API Native Addon (Objective-C++) 混合架构。Electron main process 承载 Provider 层（API Key 持有、LLM 调用），React renderer 承载 UI，自建 native addon 承载窗口控制（NSPanel、自定义拖拽、吸附检测、NSAnimationContext 变形动画）。

### Drivers
1. 用户已选择 Electron 路线，参考项目（Proma/CodePilot）验证可行性
2. 卡比吸附需要 macOS 原生 API（CGWindowListCopyWindowInfo、NSPanel、NSAnimationContext），纯 Electron 无法实现
3. 安全模型要求 API Key 和 LLM 调用在 main process
4. DMG 打包分发需求，electron-builder 生态成熟

### Alternatives Considered
- **Tauri 2 + Swift Plugin**: 体积优势 10 倍（~15MB vs ~150MB），Swift 比 Objective-C++ 更现代。但无参考项目验证，且用户已选择 Electron。如 native addon 成本超预估 2 倍，重新评估。
- **纯 Swift (AppKit/SwiftUI)**: 原生性能最佳，但对话 UI 开发成本远高于 React
- **Electron BrowserWindow + CSS transition**: 无需 native addon，但 CSS transition 无法改变操作系统窗口尺寸，技术上不可行
- **electron-nspanel 包**: 已废弃（v0.0.1, 2019年），依赖 node-addon-api@^2.0.0，不兼容现代 Electron

### Why Chosen
Electron 在桌面 AI 应用领域已被验证。自建 native addon 虽增加复杂度，但提供完全的窗口控制能力。Provider 在 main process 符合 Electron 安全最佳实践。cmake-js 替代 node-gyp 降低构建痛苦。

### Consequences
- (+) 快速开发，React/Electron 生态可复用
- (+) 完全控制窗口行为，动画流畅
- (+) API Key 安全存储在 main process
- (-) 应用体积 ~150MB+
- (-) 需维护 TypeScript + Objective-C++ 两种语言
- (-) Native addon 增加构建复杂度（cmake-js + Xcode）
- (-) macOS 版本兼容性需要持续测试

### Follow-ups
- 建立 CI 矩阵覆盖 macOS 13/14/15 的 native addon 编译
- MVP 后评估是否需要迁移到 Tauri 以减小体积
- v1.1 实现 OpenAI OAuth（参考 opencode 的 oauth-provider.ts）
- v1.2 实现飞书窗口跟随（替代当前的自动脱离方案）

---

## Changelog (Architect Review Revisions)

1. **[BLOCKING] Provider 层从 `src/renderer/providers/` 移至 `src/main/providers/`** — API Key 和 LLM 调用必须在 main process，renderer 通过 IPC 通信
2. **[BLOCKING] 移除 `electron-nspanel` 依赖** — 该包已废弃（v0.0.1, 2019），改为自建 Objective-C++ native addon
3. **[BLOCKING] 变形动画从 CSS transition 改为 NSAnimationContext** — CSS 无法改变操作系统窗口尺寸，需要 native 层动画
4. **拖拽从 `-webkit-app-region: drag` 改为 NSEvent 自定义拖拽** — 原方案无法在拖拽中获取实时坐标做吸附检测
5. **新增飞书窗口移动检测 + 自动脱离机制** — 避免吸附后飞书移动导致侧边栏"脱节"
6. **MVP 阶段 OpenAI 也用 API Key** — OAuth 推迟到 v1.1，降低 MVP 复杂度
7. **状态管理 source of truth 移至 main process** — 防止 renderer crash 丢失数据
8. **构建工具从 node-gyp 改为 cmake-js** — 更现代，配置更简洁
9. **新增 AC-7 验收标准** — 飞书窗口移动时侧边栏自动脱离
10. **ADR 更新** — 新增 Tauri 2 成熟度分析、electron-nspanel 废弃记录、CSS transition 不可行分析
11. **[DECISION] 原生模块语言从 spec 的 Swift 改为 Objective-C++** — N-API 与 Objective-C++ 直接互操作，无需 Swift bridging header，降低构建复杂度。如后续迁移到 Tauri 2（Swift plugin），需重写 native 层。
12. **[CRITIC] API Key 存储从 `electron-store` + 硬编码 encryptionKey 改为 `@electron/safeStorage`** — 底层使用 macOS Keychain，避免明文 key 暴露
13. **[CRITIC] 新增 3 条错误路径验证步骤** — 无权限降级、无效 API Key、网络中断场景
