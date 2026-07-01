# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

钢琴/乐器跟谱工具——纯前端单页应用，用于管理和播放曲谱图片。所有数据仅存储在用户本地浏览器（IndexedDB），无需后端，可直接部署到任意静态托管。

## Commands

```bash
# 本地开发服务器（ES Module 必须通过服务器访问）
python -m http.server 8080
# 或 npx serve .

# Windows 一键启动
.\start.bat
# 等价于：python -m http.server 8080 并自动打开 Chrome
```

## 技术栈

- 纯 HTML + CSS + JavaScript（ES Module，无构建工具）
- IndexedDB 操作：`idb` 库（v8.0.0，通过 importmap 从 CDN 加载）
- 动画驱动：`requestAnimationFrame` + delta-time 驱动 `scrollTop`

## 文件架构（跨文件关系）

```
index.html     ← 定义 DOM 结构、importmap（idb CDN）、CSS/JS 引入
style.css      ← 所有样式，含响应式断点 1024px / 768px + 触屏适配
script.js      ← 所有逻辑（~1000 行，单 ES Module，无其他 JS 文件依赖）
```

## 缓存策略

`index.html` 中引用 CSS/JS 时带版本号 query string（`?v=N`）：
```html
<link rel="stylesheet" href="style.css?v=1">
<script type="module" src="script.js?v=1"></script>
```
修改 `style.css` 或 `script.js` 后，**必须同步递增 `index.html` 中对应的 `v` 值**，否则浏览器缓存会导致用户看到旧版本。

所有三个文件在 `script.js:977` 通过 `init()` 启动；`index.html:138` 通过 `<script type="module">` 引入。无框架路由或构建步骤。

## 核心架构（需跨文件理解的部分）

### 1. 全局状态与 DOM 引用的集中管理（`script.js:10-70`）

- `state` 对象（`script.js:10-24`）：所有可变状态集中于此
- `dom` 对象（`script.js:29-70`）：通过 `const $ = (id) => document.getElementById(id)` 一次性获取所有 DOM 引用

**关键约定**：任何方法访问 DOM 或状态都必须通过 `dom.xxx` / `state.xxx`，禁止在方法内重新 `document.getElementById`。

### 2. 双模式系统（`script.js:338-386`）

- **browse 模式**：只读浏览 + 播放/调速/缩放/全屏
- **edit 模式**：编辑名称、增删/旋转图片
- `setEditorMode()`（`script.js:338`）通过切换 `hidden` class 控制 UI 显隐
- `switchToEditMode()` / `switchToBrowseMode()` 封装名称同步逻辑
- 核心规律：browse 下不可编辑，edit 下不可播放

### 3. 数据流：图片 → Blob → Canvas → mergedBlob → Object URL（`script.js:130-185, 485-569`）

```
用户上传/粘贴 → Blob 存入 currentScore.imageBlobs[]
         ↓
rebuildThumbnailUrls() → URL.createObjectURL(每个Blob) → 缩略图渲染
         ↓
mergeBlobs() → Canvas 纵向拼接（居中对齐，按最大宽度） → mergedBlob (Blob/Promise)
         ↓
renderMergedView() → 释放旧 URL → 创建新 URL → 设置 img.src
```

**内存管理陷阱**（`script.js:188-206`）：
- `thumbnailUrls[]` 和 `mergedUrl` 存的是 `Object URL`，切换曲谱前必须调用 `cleanupCurrentScore()` 释放
- `cleanupCurrentScore()`（`script.js:470-477`）做三件事：暂停播放 → 退出全屏 → 释放所有 Object URL
- 缩略图列表渲染时，设置完 `img.src` 后不主动 `revokeObjectURL`（浏览器 `<img>` 持有 Blob 引用，不会泄漏）

### 4. 播放系统（`script.js:642-712`）

```js
SCROLL_BASE_SPEED = 20;  // px/s at 1.0x (script.js:7)
speed 范围: 0.3 ~ 3.0, 步进 0.1
zoom  范围: 0.5 ~ 1.0 (0.5-1.0x, 非 2.0x), 步进 0.1  // 注意上限是 1.0 即 100%
```

- `requestAnimationFrame` 驱动 `scrollAccum` 累加，使用 `performance.now()` 计算 delta-time
- 主视图和全屏视图是两个独立的 `scrollTop`，播放时同步更新（`script.js:667-669`）
- `resetPlayback()` 会暂停、归零，但**不恢复 speed 和 zoom**

### 5. 全屏系统（`script.js:714-800`）

- **非浏览器原生 Fullscreen API**，而是 `fixed` 定位的覆盖层
- 主视图和全屏视图是两个独立的 `<img>` + 滚动容器
- 退出全屏时从全屏容器的 `scrollTop` 拷回主视图（`script.js:770-773`）
- 触屏设备：控制栏常显（`matchMedia('(hover: none)')` 检测），桌面端 3 秒空闲自动隐藏

### 6. 事件绑定模式（`script.js:817-961`）

- **静态事件**（按钮、控制栏）：在 `setupEventListeners()`（`script.js:819`）中一次性绑定
- **动态事件**（曲谱列表项、缩略图操作按钮）：渲染后遍历绑定（`script.js:256-262, 296-313`），非事件委托
- **全屏空闲隐藏**：`mousemove` + `setTimeout` 实现惰性自动隐藏（`resetFsIdleTimer()`, `script.js:792-800`）
- **粘贴**：监听 `document` 的 `paste` 事件（`script.js:881-901`），仅 edit 模式下响应

### 7. IndexedDB 数据流（`script.js:72-103`）

```
DB名: roll-score, 版本: 1, store名: scores, keyPath: id
         ↓
getDB() 懒初始化 (单例缓存到 db 变量, script.js:26)
         ↓
Blob 可直接存入 IDB (无需序列化)
         ↓
写操作 (putScore/deleteScore) 无需手动关闭连接
```

当前版本（v1）无数据库迁移逻辑。如需升级版本号，需在 `upgrade` 回调中处理 schema 变更。

### 8. 响应式布局（跨文件，`style.css:1031-1173` + `script.js` 中无布局逻辑）

- **>1024px**：双栏（sidebar 300px 固定 + 右侧编辑器）
- **768~1024px**：上下布局（列表水平网格排列）
- **<768px**：单栏，列表水平滑动（`overflow-x: auto`），卡片纵向排列

所有响应式逻辑纯 CSS，JS 无需感知断点。

## 关键代码约定（跨文件一致）

1. **Object URL 生命周期**：`URL.createObjectURL()` 的调用者必须 `revokeObjectURL()`。缩略图在 `rebuildThumbnailUrls()` 中先释放旧再创建新。`<img>` 设置完 `src` 后可立即 revoke（浏览器持有内部引用）。
2. **异步加载反馈**：所有异步操作包裹在 `showLoading/hideLoading` 的 `try/finally` 中（`script.js:106-113`）。
3. **Toast 非模态通知**：动态创建/复用 DOM 元素（`script.js:116-127`），`setTimeout` 自动消失。
4. **名称编辑与保存**：名称通过 `dom.scoreName.value` 编辑，保存时 trim 校验非空。`switchToBrowseMode()` 会自动将 edit 模式名称同步回 `state.currentScore.name`。
5. **UUID 生成**：优先 `crypto.randomUUID()`，fallback 纯 JS 实现（`script.js:208-215`）。
6. **触屏检测**：`matchMedia('(hover: none)')`（`script.js:277,798`），影响缩略图操作按钮显示和全屏控制栏自动隐藏。

## 边界情况（代码中已处理，修改时注意保持）

- **空状态**：无曲谱显示 `#emptyList`，无选中曲谱显示 `#emptyEditor`
- **删除确认**：删除曲谱/单张图片前 `confirm()`（`script.js:625`）
- **播放状态保持**：离开全屏时 `isPlaying` 不重置；Escape 退出全屏不暂停
- **全屏双击**：`touchstart` 检测 300ms 内双击则忽略（`script.js:922-931`）
- **beforeunload 自动保存**：保存滚动位置、速度、缩放到 IDB（`script.js:953-961`）

## 修改指南

- 添加新 UI 元素：在 `index.html` 中添加 DOM → `style.css` 中添加样式 → `script.js` 中通过 `$()` 获取引用 → 在 `dom` 对象注册 → 在 `setupEventListeners()` 或渲染函数中绑定事件
- 修改数据模型：需同时更新 `createNewScore()` 的默认值、`beforeunload` 的持久化字段、以及 IDB version（如有 schema 变化）
- 添加模式：需在 `setEditorMode()` 中处理新 UI 的显示/隐藏
- 性能注意：`mergeBlobs()` 重新 Canvas 绘制所有图片，大量图片或超大图片可能卡顿；单张长图建议控制在 50MB 以内
