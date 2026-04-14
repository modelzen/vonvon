# 粉球素材包规范

这份文档把当前粉球的状态、形态、动画和技术约束拆开说明，目的是让美术和程序以后可以并行协作。

## 当前已经存在的状态

### 1. 逻辑状态

目前原生状态机里有 4 个正式状态：

| 状态 | 触发条件 | 当前视觉形态 | 说明 |
| --- | --- | --- | --- |
| `floating` | 粉球自由漂浮、未进入吸附区 | 圆球 | 默认待机状态 |
| `snapping` | 拖拽时进入飞书右边线附近的吸附区 | 梨形 / 被吸住的拉扯态 | 只是“预览”状态，松手后才真正吸附 |
| `dockedExpanded` | 已吸附到飞书右上角，侧边栏展开 | D 形 | 粉球和侧边栏一起跟随飞书 |
| `dockedCollapsed` | 已吸附到飞书右上角，但侧边栏收起 | 缺左下角的圆 | 点击后重新展开侧边栏 |

### 2. 当前已经存在的动画

这些动画里，只有“姿态切换”是粉球自身视觉的一部分；其余多数是系统层动画：

| 动画 | 当前实现 | 时长 |
| --- | --- | --- |
| 姿态切换 | `kirby.html` 里 4 个形态之间交叉淡入淡出 + 轻微缩放 | 200ms |
| 拖离吸附态 | 素材包里的 `transitions.detach` 序列，拖着粉球脱离飞书时播放 | 默认 4 帧，约 290ms |
| 吸附移动 | 原生 `NSPanel` 从当前位置移动到飞书右上角 | 300ms |
| 侧边栏展开 | React 容器 `scaleX(0 -> 1)`，锚点在 `top left` | 240ms |
| 侧边栏收起 | React 容器 `scaleX(1 -> 0)`，锚点在 `top left` | 240ms |
| 解除吸附 | 原生 `NSPanel` 飞回屏幕中央 | 300ms |

结论：现在的“美术”和“行为”是耦合的。状态名和代码切换逻辑是对的，但画法是直接写死在 `kirby.html` 里的。

## 当前技术约束

这些约束现在还是代码契约的一部分，设计师出图时必须遵守：

| 项目 | 当前值 | 说明 |
| --- | --- | --- |
| 面板尺寸 | `120 x 120` | 原生层固定的粉球绘制面板 |
| 主锚点 | `(60, 60)` | 吸附时这个点会对齐到飞书右上角 |
| 命中区域 | 圆形，`cx=60 cy=60 r=40` | 原生拖拽/点击命中测试仍然按圆形做 |
| 禁入区 | `x < 60 && y > 60` | 吸附态不能侵入飞书窗口内容区 |
| 输出背景 | 透明 | 方便漂浮和吸附态叠加到系统窗口上 |

### 为什么锚点重要

以后不管换成什么形象，都建议先固定一个“逻辑锚点”，程序只认锚点，不认具体造型。  
当前这个锚点就是 `(60, 60)`：

- `floating` 时，它大致是球的中心。
- `dockedExpanded` 时，它是贴住飞书右上角的接触点。
- `dockedCollapsed` 时，它是缺角尖点。

这就是游戏里常见的 `pivot / origin / socket` 思路。

## 现在的素材包结构

当前代码已经改成按下面的目录结构加载：

```text
public/
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

其中：

- `manifest.json` 负责描述这个包的元数据、尺寸、锚点、命中区、状态素材映射、推荐动画参数。
- 每个状态至少对应一个 SVG。
- 如果以后某个状态需要逐帧动画，可以把单个 `src` 升级成 `frames` 数组。
- 短转场动画可以单独挂在 `transitions.<name>` 下，不必伪装成状态。

## 设计师需要交付哪些素材

### 第一阶段必需素材

建议先只做 4 个主状态，这样最小成本就能换皮：

1. `floating.svg`
2. `snapping.svg`
3. `docked-expanded.svg`
4. `docked-collapsed.svg`

### 当前默认包已经有的动画素材

这次默认包里已经放了一组真实的拖离转场资源：

1. `transitions/detach-01.svg`
2. `transitions/detach-02.svg`
3. `transitions/detach-03.svg`
4. `transitions/detach-04.svg`

它们会在“已吸附状态下，把粉球拖离飞书窗口”时播放。

### 第二阶段推荐补充

如果你对“动画感”不满意，真正值得补的是这些，不一定一上来就做：

1. `floating` 的呼吸/眨眼循环帧
2. `snapping` 的拉伸过程 2 到 4 帧
3. `dockedExpanded -> dockedCollapsed` 的收缩过渡帧
4. `dockedCollapsed -> dockedExpanded` 的弹开过渡帧
5. `detach` 的回弹/拉丝过渡帧

这些都可以继续挂在同一个状态名下，用 `frames` 来表达。

## 设计师出图要求

### 先区分两类格式

这件事最稳的做法，不是让设计师直接在“运行时格式”里工作，而是分成两层：

1. **设计源文件**
   设计师继续用他们熟悉的软件和源文件格式工作。
2. **运行时导出文件**
   程序只消费一套稳定、可版本管理、可打包的导出格式。

### 设计源文件建议

这些都属于“设计师通用”的工作格式，可以正常使用：

- Figma
- Adobe Illustrator `.ai`
- Adobe Photoshop `.psd`
- Sketch
- Affinity Designer `.afdesign`

建议你要求设计师交付两样东西：

1. 源文件或 Figma 链接
2. 一份程序可直接读取的导出包

也就是说，**源文件保留设计自由，导出包遵守技术合同**。

### 推荐格式

程序运行时，建议把素材限制为下面两类，这样最通用：

1. **静态姿态：`SVG` 优先**
2. **逐帧动画：`PNG` 序列 作为兜底**

为什么这样分：

- `SVG` 很适合当前这种偏矢量、轮廓清晰、颜色块明确的角色。
- `PNG` 序列几乎所有设计软件都能导出，做逐帧动画时最通用。

### 静态姿态为什么首选 SVG

首选 `SVG`，原因是：

- 当前粉球是矢量风格，SVG 清晰、轻量、方便微调。
- 多倍屏下不用维护 `@2x / @3x`。
- 后期如果想改配色、加发光、替换局部细节，成本更低。

### 什么情况下改用 PNG 序列

只有在下面两种情况下才建议改用位图序列：

1. 质感非常依赖手绘纹理、复杂光影或逐帧变形。
2. 动画是逐帧绘制而不是形状插值。

如果改用位图，建议运行时统一为：

- 单帧 `PNG`
- 透明背景
- 统一 `120 x 120`
- 命名连续，例如 `floating_0001.png`

### 当前程序实际支持什么

这次的 loader 本质上是按 `<img src>` 读素材，所以运行时并不只支持 SVG：

- 静态图：`svg` / `png` 都可以
- 帧序列：每帧用 `png` 或 `svg` 都可以

但从团队协作角度，我建议你把规范收敛成：

- **静态姿态统一导出 SVG**
- **逐帧动画统一导出 PNG 序列**

这样最接近多数设计师的日常工作方式，也最容易检查。

### 画布要求

所有状态都建议使用同一套坐标系统：

- 画布：`120 x 120`
- 原点：左上角
- 主锚点：`(60, 60)`
- 吸附态禁入区：右下象限以外的外部区域可以画，`x < 60 && y > 60` 不允许侵入

### 中心点 / 锚点要求

交付时请在设计稿里明确标注：

1. `mainAnchor`：当前统一为 `(60, 60)`
2. `hitCenter`：当前统一为 `(60, 60)`
3. `hitRadius`：当前统一为 `40`

如果将来造型不再适合圆形点击区，再做第二阶段，把命中区和锚点同步下放给原生层读取。

## 素材包 manifest 建议字段

当前默认包已经按这个思路组织：

```json
{
  "meta": {
    "id": "default",
    "name": "Default Pink Ball",
    "version": 1,
    "specVersion": 1
  },
  "layout": {
    "panel": { "width": 120, "height": 120 },
    "anchor": { "x": 60, "y": 60 },
    "hitArea": { "type": "circle", "cx": 60, "cy": 60, "r": 40 }
  },
  "transitions": {
    "formSwitch": { "durationMs": 200, "scaleFrom": 0.9, "scaleTo": 1 },
    "detach": {
      "frames": [
        { "src": "transitions/detach-01.svg", "durationMs": 70 },
        { "src": "transitions/detach-02.svg", "durationMs": 70 }
      ]
    }
  },
  "states": {
    "floating": { "kind": "single", "src": "floating.svg" },
    "snapping": { "kind": "single", "src": "snapping.svg" },
    "dockedExpanded": { "kind": "single", "src": "docked-expanded.svg" },
    "dockedCollapsed": { "kind": "single", "src": "docked-collapsed.svg" }
  }
}
```

如果某个状态要做逐帧动画，可以写成：

```json
{
  "kind": "sequence",
  "loop": true,
  "frames": [
    { "src": "floating/floating_0001.svg", "durationMs": 80 },
    { "src": "floating/floating_0002.svg", "durationMs": 80 }
  ]
}
```

如果某个动画不是“状态本身”，而是一个短转场，更推荐写成：

```json
{
  "transitions": {
    "detach": {
      "frames": [
        { "src": "transitions/detach-01.png", "durationMs": 70 },
        { "src": "transitions/detach-02.png", "durationMs": 70 },
        { "src": "transitions/detach-03.png", "durationMs": 70 }
      ]
    }
  }
}
```

## 更接近业界的做法

你想做的方向是对的，业内一般也是把角色系统拆成这几层：

1. **行为层**  
   状态机只关心 `idle / hover / snap / docked / collapse` 这类抽象状态。

2. **表现层**  
   素材包决定每个状态长什么样、播什么帧、节奏多快。

3. **绑定层**  
   用锚点、碰撞盒、socket、safe area 把角色和场景对齐起来。

4. **工具层**  
   最好有一个预览页或校验脚本，检查素材包是否缺图、尺寸不对、锚点越界。

## 我建议的更好方案

### 方案 A：先走固定技术合同

这次已经实现到这个阶段：

- 画布固定 `120 x 120`
- 锚点固定 `(60, 60)`
- 命中区固定圆形
- 代码从素材包里读状态图

优点是最稳，设计师马上可以开始画。

### 方案 B：第二阶段再做“完全解耦”

如果后面粉球不再是圆球系角色，而是比如小动物、带耳朵、拖尾、非对称轮廓，我建议下一步再补：

1. 原生层读取 `manifest.json` 里的 `panel` 尺寸
2. 原生层读取 `anchor`
3. 原生层读取命中区 `hitArea`
4. 加一个素材包预览/校验工具

这样才是真正意义上的“角色包换了，代码几乎不用碰”。

## 这次重构后你可以怎么协作

推荐工作流：

1. 你把这份规范给设计师。
2. 设计师在 Figma / AI / PSD 里画图。
3. 设计师按 `kirby-packs/<pack-id>/` 目录导出一整包运行时素材。
4. 同时保留源文件或设计链接，方便下次改版。
5. 你把新包丢进 `public/kirby-packs/`。
6. 运行时切到对应 `pack-id`。
7. 如果只是换外观，不需要改状态机代码。

推荐交付包长这样：

```text
kirby-pack-handoff/
  source/
    pink-ball.fig-link.txt
    pink-ball.ai
  runtime/
    manifest.json
    floating.svg
    snapping.svg
    docked-expanded.svg
    docked-collapsed.svg
```

其中：

- `source/` 给设计师和后续改版用
- `runtime/` 给程序直接接入

程序仓库里通常只需要放 `runtime/` 这一层。

当前实现里，运行时会优先读取环境变量 `VONVON_KIRBY_PACK`，没设就走 `default`。

## 已经补好的配套工具

为了让“美术和代码解耦”不只是目录约定，这次还补了两类工具：

### 1. 素材包校验器

命令：

```bash
npm run validate:kirby
```

或者校验单个包：

```bash
node scripts/validate-kirby-pack.mjs public/kirby-packs/default
```

当前会检查：

- `manifest.json` 是否可解析
- 4 个必需状态是否齐全
- 每个状态是否有 `src` 或 `frames`
- 引用的素材文件是否存在
- 文件后缀是否为 `svg/png`
- 素材尺寸是否匹配 `panel.width/height`
- `anchor` 和 `hitArea` 是否落在合理范围内

### 2. 本地预览页

预览页路径：

- 开发环境：`http://localhost:5173/kirby-pack-preview.html`
- 构建后：`out/renderer/kirby-pack-preview.html`

用途：

- 查看素材包元信息
- 查看 4 个状态缩略图
- 切换当前预览状态
- 对多帧状态做简单序列播放
- 把 manifest 原文直接展示出来，方便对照检查
