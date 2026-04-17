# Kirby 素材包规范

这份文档描述当前仓库里 Kirby 素材包的真实结构和运行时契约。

以当前 `public/`、加载器和校验器为准。如果本文和实现不一致，优先相信下面这些文件：

- `public/kirby-packs/default/manifest.json`
- `src/main/native/kirbyAssetPack.ts`
- `src/renderer/components/Kirby/kirby.html`
- `scripts/validate-kirby-pack.mjs`
- `native/src/kirby_window.h`

## 当前 `public/` 里的 Kirby 相关内容

```text
public/
  kirby-asset-pack-spec.md
  kirby-pack-preview.html
  kirby-packs/
    default/
      manifest.json
      floating.svg
      snapping.svg
      docked-expanded.svg
      docked-collapsed.svg
      transitions/
        detach-01.svg
        detach-02.svg
        detach-03.svg
        detach-04.svg
```

当前真实存在并可直接运行的素材包只有 `default`。

`kirby-pack-preview.html` 会直接读取 `kirby-packs/<pack-id>/manifest.json` 做预览。

## 运行时如何选包

- 默认包 id 是 `default`
- 可以用环境变量 `VONVON_KIRBY_PACK` 指定其他包
- 如果指定包加载失败，主进程会回退到 `default`
- 开发环境从 `public/kirby-packs/<pack-id>/manifest.json` 读取
- 打包后从 `out/renderer/kirby-packs/<pack-id>/manifest.json` 读取

## 当前硬要求的 4 个状态

原生状态机目前只认 4 个抽象状态，素材包必须全部提供：

| 状态名 | 必需 | 当前默认素材 | 说明 |
| --- | --- | --- | --- |
| `floating` | 是 | `floating.svg` | 自由漂浮时的默认姿态 |
| `snapping` | 是 | `snapping.svg` | 进入吸附区时的预览姿态 |
| `dockedExpanded` | 是 | `docked-expanded.svg` | 吸附到飞书右上角且侧边栏展开 |
| `dockedCollapsed` | 是 | `docked-collapsed.svg` | 吸附到飞书右上角且侧边栏收起 |

`src/main/native/kirbyAssetPack.ts` 会校验这 4 个状态都存在，并且每个状态至少有 `src` 或非空 `frames`。

## 当前默认包的完整结构

`public/kirby-packs/default/manifest.json` 现在长这样：

```json
{
  "meta": {
    "id": "default",
    "name": "Default Pink Ball",
    "version": 1,
    "specVersion": 1,
    "author": "Vonvon"
  },
  "layout": {
    "panel": {
      "width": 120,
      "height": 120
    },
    "anchor": {
      "x": 60,
      "y": 60,
      "description": "Docked states align this anchor to Feishu's top-right corner."
    },
    "hitArea": {
      "type": "circle",
      "cx": 60,
      "cy": 60,
      "r": 40
    }
  },
  "transitions": {
    "formSwitch": {
      "durationMs": 200,
      "scaleFrom": 0.9,
      "scaleTo": 1,
      "easing": "ease"
    },
    "detach": {
      "description": "Peel-off stretch played when the docked ball is dragged away from Feishu.",
      "frames": [
        { "src": "transitions/detach-01.svg", "durationMs": 70 },
        { "src": "transitions/detach-02.svg", "durationMs": 70 },
        { "src": "transitions/detach-03.svg", "durationMs": 70 },
        { "src": "transitions/detach-04.svg", "durationMs": 80 }
      ]
    },
    "panelMove": {
      "durationMs": 300,
      "easing": "ease-in-out"
    },
    "sidebarEnter": {
      "durationMs": 240,
      "origin": "top-left",
      "scaleAxis": "x"
    },
    "sidebarExit": {
      "durationMs": 240,
      "origin": "top-left",
      "scaleAxis": "x"
    }
  },
  "states": {
    "floating": {
      "displayName": "Floating",
      "kind": "single",
      "src": "floating.svg",
      "description": "Default idle pose while the ball is free-floating."
    },
    "snapping": {
      "displayName": "Snapping",
      "kind": "single",
      "src": "snapping.svg",
      "description": "Preview pose shown while the ball enters the snap zone."
    },
    "dockedExpanded": {
      "displayName": "Docked Expanded",
      "kind": "single",
      "src": "docked-expanded.svg",
      "description": "Pose used while docked at Feishu's top-right corner with the sidebar open."
    },
    "dockedCollapsed": {
      "displayName": "Docked Collapsed",
      "kind": "single",
      "src": "docked-collapsed.svg",
      "description": "Pose used while docked with the sidebar collapsed."
    }
  }
}
```

## Manifest 字段的实际含义

### 1. `meta`

纯元数据，当前主要用于标识和展示。

- `id`
- `name`
- `version`
- `specVersion`
- `author`

### 2. `layout`

当前有 3 组字段：

- `layout.panel`
- `layout.anchor`
- `layout.hitArea`

需要注意两件事：

1. `kirby.html` 和预览页会读取这些值来设置渲染尺寸和展示信息
2. 原生层的命中测试、吸附锚点、面板大小目前仍然是硬编码的，见下文“当前仍然硬编码在 native 的约束”

也就是说，`layout` 已经是 manifest 的一部分，但还没有完全成为 native 的动态输入。

### 3. `states`

`states` 是运行时最核心的部分，4 个状态都必须存在。

每个状态当前支持这些字段：

- `displayName`
- `kind`
- `src`
- `frames`
- `frameDurationMs`
- `loop`
- `description`

当前真实行为：

- 如果有 `frames`，渲染器按帧序列播放
- 如果没有 `frames` 但有 `src`，会被当成单帧素材
- `frames` 每项既可以是字符串，也可以是 `{ src, durationMs }`
- 单帧或字符串帧如果没有显式时长，会回退到 `frameDurationMs`，再回退到 `100ms`
- 多帧状态默认循环播放
- 只有显式写 `loop: false` 才会在最后一帧停住
- 当前渲染逻辑并不会根据 `kind` 分支，`kind` 更像描述性字段

可用写法示例：

```json
{
  "states": {
    "floating": {
      "kind": "sequence",
      "loop": true,
      "frameDurationMs": 80,
      "frames": [
        "floating/floating-01.svg",
        "floating/floating-02.svg"
      ]
    }
  }
}
```

### 4. `transitions`

当前 manifest 里出现了 5 类 transition：

- `formSwitch`
- `detach`
- `panelMove`
- `sidebarEnter`
- `sidebarExit`

它们的实际使用范围并不一样：

#### `formSwitch`

`kirby.html` 真实使用这个字段，驱动 4 个主状态切换时的 CSS 淡入淡出和缩放：

- `durationMs`
- `scaleFrom`
- `scaleTo`
- `easing`

#### `detach`

`kirby.html` 真实使用这个字段，播放“从 docked 状态拖离飞书”时的转场序列。

当前默认包有 4 帧：

- `transitions/detach-01.svg`
- `transitions/detach-02.svg`
- `transitions/detach-03.svg`
- `transitions/detach-04.svg`

和状态一样，`detach.frames` 也支持字符串帧或 `{ src, durationMs }`。

#### `panelMove` / `sidebarEnter` / `sidebarExit`

这些字段现在已经写进默认包 manifest，也会在预览页里展示，但当前仓库里并没有把它们作为 Kirby 渲染器的动态输入。

它们更接近“和宿主动画一致的推荐参数”：

- `panelMove`: 原生面板移动
- `sidebarEnter`: 侧边栏展开
- `sidebarExit`: 侧边栏收起

如果以后要完全由素材包驱动宿主动画，可以继续沿用这些字段名。

## 当前资源文件的硬约束

`scripts/validate-kirby-pack.mjs` 现在会按下面的规则校验：

- 必须存在 `manifest.json`
- 必须存在 4 个必需状态
- 每个状态必须有 `src` 或非空 `frames`
- transition 如果声明了帧，也会逐帧校验
- 资源路径不能跳出当前 pack 目录
- 只接受 `.svg` 和 `.png`
- 每个资源的尺寸必须和 `layout.panel.width/height` 一致
- `anchor.x/y` 必须落在 panel 内
- `hitArea.r` 必须大于 0
- `hitArea` 如果超出 panel，会报 warning

当前默认包所有素材都是 `SVG`，并且都是 `120 x 120` 逻辑画布。

## 当前仍然硬编码在 native 的约束

这一段最重要，因为它决定了“换皮”和“改几何契约”是两回事。

虽然 manifest 里已经有 `layout.panel`、`layout.anchor`、`layout.hitArea`，但 native 侧目前仍然写死了这些值：

- 面板尺寸固定 `120 x 120`
- 逻辑画布固定 `120 x 120`
- 主锚点固定 `(60, 60)`
- 命中半径固定 `40`

另外，dock 状态还写死了画布在 panel 内的偏移：

| 状态 | 画布偏移 |
| --- | --- |
| `floating` | `(0, 0)` |
| `snapping` | `(0, 0)` |
| `dockedExpanded` | `(-22, -60)` |
| `dockedCollapsed` | `(-20, -20)` |

这意味着：

- 当前最安全的做法是让新素材包继续沿用 `120 x 120`、`anchor=(60,60)`、`hitArea=(60,60,r=40)`
- 目前更适合“换形态和画风”，不适合随意改几何合同
- 如果想改成完全不同的体型、锚点或点击区，还需要同步修改 native 命中测试和 dock 布局

native 里还有两个额外命中规则：

1. 吸附状态下，锚点左下象限被视为飞书窗口内部，不能算作 mascot 可点击区域
2. `dockedExpanded` 状态里，锚点以下区域也不会算作可点击区域

所以素材即使带透明留白，也不要假设整块 `120 x 120` 面板都可交互。

## 交付新素材包时的最小要求

如果要新增一个包，最小可运行目录应为：

```text
public/kirby-packs/<pack-id>/
  manifest.json
  floating.svg
  snapping.svg
  docked-expanded.svg
  docked-collapsed.svg
```

如果还要支持拖离转场，再加：

```text
public/kirby-packs/<pack-id>/transitions/
  detach-01.svg
  detach-02.svg
  ...
```

当前推荐：

- 静态或少量矢量帧优先用 `SVG`
- 需要复杂逐帧时再用 `PNG`
- 相对路径都写成相对于 pack 根目录的路径

## 校验和预览

### 校验

校验全部素材包：

```bash
npm run validate:kirby
```

只校验单个包：

```bash
node scripts/validate-kirby-pack.mjs public/kirby-packs/default
```

### 预览

预览页路径：

- 开发环境：`http://localhost:5173/kirby-pack-preview.html`
- 构建产物：`out/renderer/kirby-pack-preview.html`

预览页会显示：

- 当前 pack 元信息
- 4 个主状态
- `detach` 转场
- `layout` 信息
- manifest 原文

## 维护规则

后面如果再改 Kirby 素材包协议，建议同时更新这 5 处，避免文档再次过时：

1. `public/kirby-packs/<pack-id>/manifest.json`
2. `src/main/native/kirbyAssetPack.ts`
3. `src/renderer/components/Kirby/kirby.html`
4. `scripts/validate-kirby-pack.mjs`
5. 本文 `public/kirby-asset-pack-spec.md`
