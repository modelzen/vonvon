# vonvon kirby 交接文档

此文档是上一个 session 结束时的交接。新 session 接手请从这里读,然后按"TODO"执行。

## 当前状态

上一个 session 已经完成:

1. **原生层状态机改造**(已编译通过)
   - `native/src/kirby_window.{h,mm}`:NSPanel 改 **120×120**,取消圆形 cornerRadius 裁剪,新增 `setForm:` 方法,枚举新增 `KirbyStateDockedExpanded` / `KirbyStateDockedCollapsed`
   - `native/src/snap_engine.{h,mm}`:新增 `dockedTopRightOriginForFeishuBounds:` 坐标换算,tracking timer 从 0.5s → 33ms,`_tick` 改为"飞书移动/被遮挡 → 保持吸附跟随",飞书消失才 detach
   - `native/src/animator.mm`:吸附目标改为飞书右上角锚点,完成后不再 hide panel,状态置 dockedExpanded
   - `native/src/drag_handler.{h,mm}`:**圆形命中检测**(center 60,60 / r 40),**8px drag 阈值**区分 click vs drag,新增 `onDockedClick` / `onDragLeave` callback
   - `native/src/addon.mm` + `native/index.d.ts`:新增 N-API 导出 `onDockedClick` / `onDragLeave` / `onCollapseSidebar` / `setKirbyForm` / `collapseSidebar`
   - 编译通过:`cd native && npx cmake-js build`

2. **Electron 主进程**(TypeScript 编译通过)
   - `src/main/native/kirby.ts`:`applySidebarBounds()` / `releaseSidebar()` 工具,`onSnapComplete` 不再 hide panel,新增 `onDockedClick` / `onDragLeave` / `onCollapseSidebar` 处理,新增 `kirby:close-sidebar` IPC handler
   - `src/preload/index.ts`:新增 `closeKirbySidebar()` 频道 + `kirby:sidebar-show` / `kirby:sidebar-hide` 监听白名单
   - `src/renderer/App.tsx`:✕ 按钮从 `detachKirby` 改成 `closeKirbySidebar`,新增 CSS 入场动画 `transform-origin: top right` + scale 0.85→1 + fade 200ms(**这个方向要改成从 top left 生长,见下面 TODO**)

3. **静态原型已确认**
   - `docs/vonvon-forms-prototype.html` 是三态 + 4 帧吸附动画的静态原型,用户已经确认 **OK 开干**
   - 用户的设计约束和视觉样式**以这个原型为准**,不要自己改

## 用户确认的设计原则(不可改)

1. **vonvon 是软体** — slime / mochi 质感,可以贴合飞书窗口外表面,**绝对不侵入飞书窗口内部**(严格不进入 Q3 区 `x<60 && y>60`)
2. **吸附触发** = 接近飞书**右边线**(不是右上角),vonvon 可以在右边线任意高度被吸附
3. **松开后两段动画**:先滑到飞书右上角 → 然后 sidebar 从 vonvon 里长出来
4. **已吸附稳态**:vonvon 身体中线 x=60 对齐飞书右边线,底部 y=60 贴飞书顶边,左半在飞书上方,右半在 sidebar 上方(D 形坐姿)
5. **sidebar 入场/退场动画** = `transform-origin: top left` + `scaleX(0→1)` 从 vonvon 位置向右"长"出 / 向左"收"回(**不是** top right 抖出来)
6. **收缩态 dockedCollapsed**:vonvon = **基本上纯圆 + 缺左下角**(不是 L 形方块,不是软体 blob),缺口是直角尖角精确对齐 (60, 60)

## TODO(按顺序执行)

### Step 1. 同步原型的 SVG 到 kirby.html

- 从 `docs/vonvon-forms-prototype.html` 里把 **4 个 SVG 形态** 复制出来,写入 `src/renderer/components/Kirby/kirby.html`:
  - `floating` — 纯粉色圆球(SVG id 前缀原型里是 `f1`,搬到 kirby.html 里用 `floating`)
  - `snapping` — 梨形被吸住(原型 id 前缀 `sn`,搬过来用 `snapping`)
  - `dockedExpanded` — D 形坐姿 + 两只小手撑桌(原型 id `ds`,搬过来用 `docked-expanded`)
  - `dockedCollapsed` — 纯圆缺左下角(原型 id `dc`,搬过来用 `docked-collapsed`)
- kirby.html 的框架已经写好(三态容器 + `__setKirbyForm` 切换函数),只需要把 SVG 内容替换掉。**不要动**外层 HTML 结构,只替换 `<svg>` 和里面的 `<defs>` + `<g>` 内容。
- 特别注意:`__setKirbyForm` 现在需要支持 **4 个 form**(加上 `snapping`),当前 kirby.html 里 `snapping` 被 fallback 到 `floating`,要改成真正切到 snapping SVG。更新 CSS class map 和 script 里的 switch。

### Step 2. 原生层在 snap 阶段调 setForm

- `native/src/snap_engine.mm` 的 `checkSnapProximity:` 里:
  - 当前进入吸附区时调的是 `[[KirbyWindow shared] setForm:@"snapping"]` — 已经对
  - 确认离开吸附区时调的是 `setForm:@"floating"` — 已经对
- 不需要改代码,只是验证 kirby.html 的 snapping 形态能被 `__setKirbyForm('snapping')` 正确显示

### Step 3. sidebar 入场动画方向改成从 top left 生长

- `src/renderer/App.tsx` 里的 CSS 关键帧现在是:
  ```css
  @keyframes kirby-sidebar-entry {
    from { opacity: 0; transform: scale(0.85); }
    to   { opacity: 1; transform: scale(1); }
  }
  .kirby-sidebar-entry {
    animation: kirby-sidebar-entry 200ms ease-out;
    transform-origin: top right;
  }
  ```
- 改成:
  ```css
  @keyframes kirby-sidebar-entry {
    from { opacity: 0; transform: scaleX(0); }
    to   { opacity: 1; transform: scaleX(1); }
  }
  .kirby-sidebar-entry {
    animation: kirby-sidebar-entry 240ms cubic-bezier(0.2, 0.8, 0.3, 1);
    transform-origin: top left;
  }
  ```
- `transform-origin: top left` 让 sidebar 的左边(= vonvon 位置 = 飞书右上角)固定,`scaleX(0→1)` 让它向右"长"出,视觉上就是"从 vonvon 里长出 sidebar"

### Step 4. sidebar 退场动画(可选但推荐)

- 现在关 sidebar 是 `_mainWin.hide()` 直接消失,没有动画
- 目标:收起时先播放 scaleX(1→0) + fade 240ms,然后再真正 hide
- 实现路径:
  1. 主进程 `src/main/native/kirby.ts` 里的 `releaseSidebar()` 在 hide 之前先发 `kirby:sidebar-hide` 给 renderer
  2. renderer 收到 `kirby:sidebar-hide` 后,在根 div 上加一个 `.kirby-sidebar-exit` class 播放动画
  3. 主进程 hide 延迟 240ms 等动画播完(或用 animation 结束回调)
- 如果做不完可以先跳过,不影响核心功能

### Step 5. 重新编译 + 冒烟测试

- 原生层已编译过,除非改了 `.mm` 文件否则不用再跑 `cmake-js build`
- 完整重启 Electron dev(**不要依赖 HMR**,HMR 不会重载 `.node` 二进制):
  ```
  Ctrl+C 结束 dev server → npm run dev
  ```
- 跑 6 条路径:
  1. 拖球接近飞书右边线(任意高度) → 球变梨形(snapping)
  2. 松开 → 球滑到飞书右上角 + sidebar 从球里长出 + 球变 D 形坐姿
  3. 点 sidebar ✕ → sidebar 缩回 vonvon + 球变缺角圆(dockedCollapsed)
  4. 点缺角圆 vonvon → sidebar 从球里长出 + 球变 D 形
  5. 从 docked 拖球走 → sidebar 收回 + 球变粘性拉丝形态 → 继续拖变 floating
  6. 移动飞书窗口 → 球和 sidebar 一起跟随右上角
  7. 用其它窗口遮住飞书右上角 → 仍保持吸附,sidebar 不收起
  8. 最小化飞书 → 球动画飞回屏幕中心 floating

## 关键约束(实现时容易踩坑)

- **dockedCollapsed 的咬角直线严格贴合** — path 里必须有 `L 20 60`(或类似)和 `Z`(闭合到 x=60)两段直线,**不能**用曲线代替。用曲线会侵入 Q3(x<60 && y>60 = 飞书内部)
- **dockedExpanded D 形的底部 y=60 严格不越过** — 用 `L 98 60 L 22 60 Z` 的真平底,不要用 bezier 底部(bezier 容易下凸越过 y=60 进入飞书内部)
- **snap 距离计算** — `snap_engine.mm` 里用 `visualBallLeft = kirbyOrigin.x + 20`(panel 120×120 中心 60,球半径 40,左边缘 panel local 20 = panel origin + 20),**不是** `kirbyOrigin.x`(那是 panel 左边缘不是球左边缘)。已经对了
- **命中检测圆形** — drag_handler `PointInBallHitArea` 用中心 (panel 左下 + 60, panel 左下 + 60) 半径 40 的圆形。已经对了
- **docked 状态下右键不响应** — `drag_handler` 的 rightClickHandler 用 `KirbyStateIsDocked(k.state)` 返回早退。已经对了

## 文件清单(改过的 + 要改的)

**已改完**(不用再动,除非发现 bug):
- `native/src/kirby_window.h`
- `native/src/kirby_window.mm`
- `native/src/snap_engine.h`
- `native/src/snap_engine.mm`
- `native/src/animator.mm`
- `native/src/drag_handler.h`
- `native/src/drag_handler.mm`
- `native/src/addon.mm`
- `native/index.d.ts`
- `src/main/native/kirby.ts`
- `src/preload/index.ts`

**要动**:
- `src/renderer/components/Kirby/kirby.html` — Step 1(替换 4 个 SVG 形态 + 更新 `__setKirbyForm`)
- `src/renderer/App.tsx` — Step 3(CSS 关键帧 transform-origin 改 top left + scaleX)
- `src/main/native/kirby.ts` — Step 4(可选,sidebar 退场动画延迟 hide)

**参考**:
- `docs/vonvon-forms-prototype.html` — 所有视觉样式的来源,SVG 直接从这里复制

## 新 session 启动方式

在新 session 里说:

> 读 `docs/vonvon-kirby-handoff.md` 然后按 TODO 顺序开干,不要改用户确认过的设计原则

或者直接 `@docs/vonvon-kirby-handoff.md` 引用这个文档。
