# 插件接口契约

> 本文是插件接口的**权威定义**，内容与当前代码一致。
> 契约定义在 `src/shared/contracts.js`，宿主实现在 `src/main/pluginHost.js`
> 与 `src/main/renderHost.js`。
>
> **主程序不含任何文件类型知识。** 「哪些文件算素材」100% 由插件注册表判定；
> 类别、缩略图、预览、右键操作、详情栏、设置项全部来自插件自身声明。

---

## 1. 插件是什么

一个插件就是 `plugins/` 下的**一个文件夹**：

```
plugins/<文件夹名>/
  index.cjs       插件声明（必需）—— 全部能力都在这里声明
  parser.cjs      主进程解析实现（可选，插件自带，被 index.cjs require）
  viewer.mjs      渲染模块（可选，渲染进程动态 import）
  preview.html    预览窗口页面模板（可选）
  icon.svg        插件图标（可选）
  其他文件        插件私有实现，随便放
```

### 文件夹名就是插件 id

加载时主程序**用文件夹名覆盖** `manifest.id`。因此：

- **改名 = 改文件夹名**，不需要（也不允许）主程序去改你的插件代码
- 你在 `index.cjs` 里写的 `id` 只在单独加载该模块时有用
- 打包成 zip 重新安装时，zip 内的顶层目录名决定落地目录名

### 主程序不会修改你的插件文件

用户在界面上改的**显示名 / 文件夹名 / 扩展名 / 图标 / 类别色**都记在数据目录的
`plugin-overrides.json`（键 = 文件夹名），加载时叠加到 manifest 上。
手写插件永远是干净的。

---

## 2. 插件声明（index.cjs）

```js
module.exports = {
  // ────────── 元信息 ──────────
  id: '模型插件',              // 唯一标识。实际以文件夹名为准（见上）
  name: 'MMD 模型插件',        // 显示名（必填）
  version: '1.1.0',           // 版本号
  description: '一句话描述',
  icon: 'icon.svg',           // 图标文件名（相对插件文件夹）
  exts: ['.pmx', '.pmd'],     // 负责的扩展名（必填，小写含点）
  kind: { key: 'mmd-model', label: 'MMD 模型', color: '#a80043' },  // 类别

  // ────────── 能力 ──────────
  canThumbnail: true,         // 能否按需渲染缩略图
  canPreview: true,           // 能否实时预览
  viewer: 'viewer.mjs',       // 渲染模块文件名
  previewHtml: 'preview.html',// 预览窗口模板（缺省回退主程序通用宿主页）
  parse: async (filePath, buf, deep) => ({}),  // 元数据解析（主进程执行）
  dblclick: 'preview',        // 双击卡片的行为：preview | open | none（不写=不做任何操作）

  // ────────── 界面定制 ──────────
  actions: [...],             // 自定义操作（右键菜单 / 批量操作）
  detail: {...},              // 详情栏字段与样式
  settings: [...],            // 插件自定义设置项
}
```

### 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 唯一标识。**实际以文件夹名为准**，这里写的值会被覆盖 |
| `name` | ✅ | 显示名 |
| `exts` | ✅ | 负责的扩展名数组，小写含点。**这就是「什么是素材」的全部依据** |
| `kind` | — | `{ key, label, color }`。缺省时 UI 用「其他」占位 |
| `version` | — | 版本号 |
| `description` | — | 一句话描述 |
| `icon` | — | 图标文件名（相对插件文件夹），主程序用 `asset://` 加载 |
| `extIcons` | — | 按扩展名覆盖图标：`{ '.mp3': 'audio.svg' }`。取不到时回退 `icon` |
| `simple` | — | 标记为「简易插件」。缺省时按「只有声明、无任何实现」自动判定 |

#### `extIcons` —— 一个插件里给不同扩展名配不同图标

一个插件可能管理差别很大的几种素材。例如 MMD 动作插件同时管动作
（`.vmd`/`.vpd`）和音频（`.mp3`/`.wav`），共用一个图标的话，
卡片和列表里根本分不清哪个是动作、哪个是曲子。

```js
icon: 'icon.svg',
extIcons: { '.mp3': 'icon-audio.svg', '.wav': 'icon-audio.svg' },
```

主程序按**条目自己的扩展名**优先取 `extIcons` 里的图标，
没有对应项就退回插件级 `icon`。键必须是小写扩展名（含点），
值必须是字符串文件名 —— 不合规的项会被忽略。

**用户可以在界面里改。** 「插件设置」弹窗的图标区会为插件的每个扩展名
各列一行（选择 / 恢复），互不影响：

- 「类型图标」是通用图标，所有没单独设过的扩展名都用它
- 每个扩展名可以单独选一张图；留空则回退到通用图标
- 「恢复」只对**用户改过**的扩展名可点 —— 插件自己声明的项不算「改过」

用户的覆盖记在数据目录的 `plugin-overrides.json`，图会拷进插件目录
（和主图标同一套机制，`amm-icon-` 前缀，换图时自动清理旧文件）。

> 声明 `extIcons` 是**可选**的。不声明的话，弹窗里仍然会为每个扩展名
> 列出可单独设置的入口（初始都用通用图标），用户想区分就能自己分。

### 能力字段

| 字段 | 说明 |
| --- | --- |
| `canThumbnail` | 能否**按需**渲染缩略图。主程序**不会自动调用**，由顶栏「缩略图」按钮触发 |
| `canPreview` | 能否实时预览。为 `true` 且提供了 `viewer` 才会出现预览入口 |
| `viewer` | 渲染模块文件名，渲染进程动态 `import` |
| `previewHtml` | 预览窗口页面模板。缺省时回退主程序的通用宿主页 `src/renderer/host.html` |
| `parse` | `(filePath, buf, deep) => metadata`，**主进程**执行，返回值进详情栏 |
| `preparePreview` | `(filePath) => void`，**主进程**执行，每次打开预览前调用；见 §3.5 |
| `dblclick` | 双击素材卡片的行为，见下方「双击行为」 |

### 双击行为

插件可以声明**双击自己这类素材时做什么**，取值只有三个：

| 值 | 含义 |
| --- | --- |
| `'preview'` | 打开预览窗口（需要 `canPreview` + `viewer`） |
| `'open'` | 用系统默认程序打开 |
| `'none'` | 双击不做任何事 |

**不声明**（或不写这个字段）= 用全局默认 `'none'`，即**双击不做任何操作**。

默认之所以是「无操作」而不是「打开预览」：双击是有副作用的动作（开窗口 /
拉起外部程序），而「不声明」只代表插件作者没表达意图，不代表同意做某个动作。
拿不准就不动，比替用户做决定更稳妥。**想让双击生效就必须显式写一行**
`dblclick: 'preview'`（或 `'open'`）—— 想清楚要做什么，本来就是插件作者的责任。

注意 `'none'` 和「不声明」在当前默认下**行为相同但语义不同**：
前者是「我明确不要响应双击」，后者是「我没意见」。区分它们是为了以后
万一要改默认值时有据可依，也让插件的意图能写在脸上。

用户在**设置页 → 插件设置 → 双击素材时的行为**里可以按插件单独覆盖，
覆盖值优先于插件声明；下拉里的「跟随插件声明」就是清除覆盖、回到声明值
（此时若插件也没声明，就是「不做任何操作」）。

`'preview'` 在素材实际不支持预览时会**自动退化为 `'open'`**，不会出现
「双击了但什么都没发生」——这条是主程序的保证，插件不必自己处理。
（注意它只对**显式声明了** `'preview'` 的插件生效；没声明的按上面的规则
本来就是「不操作」。）

---

## 3. parse —— 元数据解析

```js
parse: async (filePath, buf, deep) => ({ /* 任意键值对 */ })
```

在**主进程**执行，插件拥有完整 Node 权限（`fs` 等内置模块可直接用）。

- **返回值**：任意键值对，会被写进索引条目的 `meta`，详情栏据此展示
- **键名随意**：中文键名完全可以（自带插件就用 `状态` 这类中文键）
- **执行时机**：扫描时对每个素材调用一次，结果缓存在索引里
- **解析不了不要抛异常**：返回一个状态字段（如 `{ 状态: '无法解析' }`）比让扫描崩掉好
  —— 自带 Blender 插件在文件头损坏时就是这么做的

> ⚠️ `parse` 在主进程里裸跑，**没有沙箱、没有超时保护**。一个未捕获异常或死循环
> 会让整个应用一起挂掉。写解析器时请自己包好 try/catch。

### ⚠️ parse 的结果会被缓存

主程序只在**素材文件本身变了**（大小或 mtime）时才重新调用 `parse`。
这意味着：**你更新了插件、往 `parse` 里加了新逻辑，已扫描过的老素材不会重新走一遍。**

如果新逻辑只是影响详情栏展示，用户重新扫描该素材所在范围即可；
但若新逻辑要**在预览时用到**（把某些信息写到插件目录供 viewer 读取），
靠 `parse` 就会失效 —— 见下面的 `preparePreview`。

---

## 3.5 preparePreview —— 预览前的准备（可选）

```js
preparePreview: async (filePath) => { /* 无返回值 */ }
```

在**主进程**执行，由主程序在**每次打开预览窗口之前**调用。

- 与扫描缓存无关，每次预览都跑，所以适合做「viewer 需要的前置信息」
- 抛异常会被静默忽略，不会挡住预览
- 只对声明了 `canPreview` 的插件有意义
- 主程序不知道任何文件类型知识 —— 它只是「你声明了我就调一下」

### 什么时候需要它

预览窗口里的 viewer **没有 `fs`、没有 IPC**，唯一通道是 `asset://`，
而且只能读**已经知道路径**的文件。所以凡是「素材旁边有什么」这类信息
（同目录的音频、同名贴图、配套文件……），都必须由主进程先查好、
写进**插件目录内**（`plugins/` 在 `asset://` 放行范围内，`data/` 不在）。

**不要把这个逻辑只写在 `parse` 里**：扫描结果有缓存，素材文件没变就不会重新 parse，
于是对已扫描过的老素材永远不生效 —— 自带 MMD 动作插件就踩过这个坑
（同目录音频清单一直没生成，表现为「动作预览没有音乐」）。

```js
// 正例：MMD 动作插件
preparePreview: async (filePath) => {
  if (path.extname(filePath).toLowerCase() !== '.vmd') return
  writeSiblingAudioList(filePath)   // 扫描同目录音频 → 写 _runtime/audio/<哈希>.json
},
```

---

## 4. viewer —— 渲染模块（viewer.mjs）

导出工厂函数，渲染进程动态 `import`：

```js
export default (api) => ({
  // ── 核心（应实现）──
  mount: async (container) => {},   // 挂载到主程序给的容器元素
  dispose: () => {},                // 释放资源（停循环、销毁渲染器、解绑事件）

  // ── 可选：加载与播放 ──
  load: async (path, opts) => {},   // 加载素材主文件
  start: () => {},                  // 开始播放 / 渲染循环
  stop: () => {},                   // 停止播放 / 渲染循环

  // ── 可选：环境响应 ──
  resize: (w, h) => {},             // 容器尺寸变化
  setBackground: (color) => {},     // 背景色

  // ── 可选：截图（缩略图渲染 + 预览窗口的「生成预览图」按钮都用它）──
  snapshot: async () => 'data:image/png;base64,...',  // 返回 dataURL
  waitReady: async () => {},        // 等异步资源就绪后再快照

  // ── 可选：类型专属扩展（主程序不主动调用）──
  loadMotion: async (path) => {},   // 例如 MMD 的动作文件
})
```

### 除 mount / dispose 外全部可选

主程序一律用 `typeof viewer.x === 'function'` 探测，缺了就跳过对应步骤。
**只要实现 `mount` 就能跑起来。**

### 宿主给你一个空容器，内容由你决定

这是本接口最重要的一点：

- 主程序给你的是一个**空的 `<div>`**（`id="host-content"`），**不是 canvas**
- 容器里放什么完全由插件决定：`<canvas>` / `<video>` / `<audio>` / `<iframe>` / 任意 DOM
- 主程序**不假设**内容形态 —— 这样同一个宿主既能跑 3D 模型，也能跑音视频

```js
export default (api) => {
  let canvas
  return {
    async mount(container) {
      canvas = document.createElement('canvas')
      canvas.style.cssText = 'display:block;width:100%;height:100%'
      container.appendChild(canvas)          // ← 自己创建内容
      // ...初始化渲染器 / 播放器
    },
    dispose() {
      canvas?.remove()                        // ← 自己清理
    },
  }
}
```

### api 注入

```js
{
  container,              // 内容容器元素（就是 mount 收到的那个）
  containerSize: () => ({ width, height }),  // 容器当前尺寸
  setBackground: (color) => {},
  thumbSize,              // 缩略图渲染的目标分辨率；预览时为 undefined
}
```

同时注入两个全局名，供插件调试 / 自省：

- `window.__viewer__` —— viewer 实例
- `window.__viewerApi__` —— 上面这个 api 对象

> 旧名 `window.__mmdViewer__` / `window.__mmdPluginApi__` 仍作为别名保留，
> 但新插件请用中性名。

### 两条调用路径不一样

| | 预览 | 缩略图 |
| --- | --- | --- |
| 页面 | 插件 `preview.html`（缺省用主程序宿主页） | **始终**用主程序宿主页 |
| 调用序列 | `mount` → `load(path, {})` → `start` → 注入「生成预览图」按钮 | `mount` → `load(path, {size, thumbnail:true})` → `waitReady` → `snapshot` |
| `api.thumbSize` | `undefined` | 档位尺寸（128/256/512/1024/2048） |

**关键差异**：预览**不调** `waitReady`（`load` 本身已是 `await`，交互式预览不需要宿主阻塞等待）；
缩略图**必须**调 `waitReady` —— 快照要等资源就绪，早一拍就是一张空白图。

`load` 的 `opts` 让插件区分两种场景，据此切换分辨率和构图（如缩略图用正面视角、去背景）：

```js
async load(path, opts) {
  if (opts && opts.thumbnail) {
    renderer.setSize(opts.size, opts.size)
    // 缩略图构图：正面、纯色背景
  }
}
```

### 预览窗口的框架能力（插件无需实现）

这两项由**主程序**提供，对所有插件一律生效，插件什么都不用写：

| 能力 | 说明 |
| --- | --- |
| **Esc 关闭窗口** | 由 `before-input-event` 在主进程侧拦截，与页面内容、焦点位置无关。窗口处于全屏时按 Esc 先退全屏，再按才关窗口 |
| **左上角信息条** | 框架注入的浮层：左侧显示素材文件名（悬停看完整路径，过长自动省略号），右侧是「生成预览图」按钮 |

**只要预览窗口能打开，这条顶栏就一定在** —— 不需要插件声明任何开关。

> 顶栏为什么放左上角：右下角容易和播放器控制条、3D 视角提示这类插件自绘 UI
> 撞在一起；左上角是各插件普遍留白的区域，而且「素材名 + 对该素材的操作」
> 语义上本就该挨在一起。

「生成预览图」的落盘规则完全复用缩略图那一套：文件名 `<素材名>.preview.png`，
只覆盖带 `.preview.` 的文件，用户自己命名的同名图片绝不碰。

点完之后**主界面会立刻刷新那一张缩略图**，不需要重新扫描：

- 主进程存盘成功后广播 `thumb:changed`，并清掉服务端的缩略图缓存
- 缩略图 URL 会带上 `?v=<文件 mtime>` 版本号 —— 覆盖同名文件时路径没变，
  不带版本号的话 Chromium 会一直沿用内存里那张已解码的旧图

> 与顶栏「缩略图」按钮的**覆盖规则不同，这是有意的**：
> 顶栏是批量操作，已有预览图的一律跳过（覆盖会毁掉用户成果）；
> 预览窗口里的按钮是用户明确要求「替换成当前画面」的单文件操作，所以覆盖是预期行为。

#### `snapshot()` 与 `canPreview` 是两件独立的事

`snapshot()` 原本只服务于 `canThumbnail`，两者在契约里**没有依赖关系**：
一个插件完全可以「能预览但截不了图」（例如纯实时播放器，截图没有意义）。

所以按钮会**探测** `snapshot()` 是否存在，而不是假定有：

| 插件情况 | 按钮表现 |
| --- | --- |
| 实现了 `snapshot()` | 正常可点，点击后出图 |
| 没实现 `snapshot()` | **仍然显示，但置灰不可点**，悬停提示「该插件的 viewer 未实现 snapshot()」 |

为什么置灰而不是干脆不渲染：不显示的话，插件作者根本不知道框架有这个能力，
也就不会去补 `snapshot()`；而显示但可点则是「假承诺」——点了才报错，更糟。
置灰 + 说明原因既诚实，又给作者一条明确的改进线索。

**插件想要这个按钮，只需实现 `snapshot()` 并返回 dataURL**，不用碰主程序。

### 缩略图输出尺寸

主程序按 `thumbSize` 设置离屏窗口的内容区尺寸。**只要插件不自己覆写
`canvas.width/height`，`snapshot()` 出来的图就是档位尺寸。**

---

## 5. 详情栏（detail）

```js
detail: {
  fields: [
    { key: 'format',    label: '格式',   type: 'badge', style: { color: '#e0477f' } },
    { key: 'modelName', label: '模型名', type: 'text',  style: { bold: true } },
    { key: 'vertices',  label: '顶点数', type: 'text' },
  ],
  style: { accent: '#e0477f' },  // 详情面板强调色
  showMeta: true,                // 未列出的 parse 元数据是否也展示（默认 true）
}
```

**取值顺序**：先取 `parse` 返回的 `meta[key]`，取不到再取条目自身字段（`name` / `size` / `mtime` 等）。

**`type` 支持**：`'text'` / `'color'`（色块）/ `'link'` / `'badge'`。
`style` 支持 `{ color, bold }`。

**`showMeta: true`** 时，`parse` 返回但**没有**在 `fields` 里列出的键会以通用键值形式
追加展示；值为对象会自动 `JSON.stringify`。

> 字段值取不到时该行**自动隐藏**，不会显示空白行 —— 所以可以放心声明一个
> 只有部分素材才有的字段（如 MMD 的 `englishName`）。

---

## 6. 自定义操作（actions）

```js
actions: [
  {
    id: 'export',
    label: '导出…',
    scope: 'single',                    // 素材右键菜单
    run: async (paths) => '导出完成',    // 返回字符串 → 界面提示
  },
  {
    id: 'batch-convert',
    label: '批量转换',
    scope: 'multi',                     // 多选后的批量操作条
    run: async (paths) => '已转换 ' + paths.length + ' 个',
  },
]
```

- `run(paths)` 收到**绝对路径数组**（`single` 时也是数组，长度为 1）
- 返回值是字符串就作为提示消息；**抛异常会被主程序捕获并转为错误提示**，不会崩
- `scope` 必须是 `'single'` 或 `'multi'`
- `run` 函数保留在主进程执行，不会传给渲染进程

---

## 6.5 详情栏按钮（detail.buttons）

`actions` 走右键菜单、返回值只是一句提示；如果插件需要**把一段内容拿给用户看**
（完整注释、解析报告、校验结果），用 `detail.buttons`。

按钮**挂在字段下方**（不是顶部操作栏）：字段声明 `style.button` 指向按钮 id 即可。

```js
detail: {
  fields: [
    // 正文只显示插件给的预览（这里放开头几行），下方自动出现「查看完整」
    { key: 'comment', label: '注释', type: 'long', style: { button: 'show-comment' } },
  ],
  buttons: [
    {
      id: 'show-comment',
      label: '查看完整',                 // 按钮文案
      run: async (filePath) => {         // 主进程执行，收到单个绝对路径
        return { title: '模型注释', text: '……完整原文……' }
      },
    },
  ],
}
```

字段本身的值由 `parse` 返回（例子里 `comment` 是预览文本），
点按钮时才去读完整内容 —— 这样详情栏不会被长文本撑开。

**返回值决定界面怎么呈现：**

| `run` 返回 | 界面行为 |
|---|---|
| `string` | 长文本弹窗，**保留换行与缩进** |
| `{ title, text }` | 同上，并指定弹窗标题 |
| `undefined` / `null` / `''` | 什么都不做 |
| 其它（对象/数字） | 按 JSON 格式化后弹窗 |

- `run` 与 `actions` 一样**只留在主进程**，不会下发给渲染进程
- 抛异常 / 超时由主程序兜底并提示，不会崩
- 主程序传给 `run` 的路径**必须是索引里已存在的素材**（防止插件被喂任意路径）

### 长文本字段（`type: 'long'`）

详情栏默认一行一个键值、值右对齐，多行文本塞进去没法读。
需要展示多行文本时把字段声明成 `long`：

```js
{ key: 'readme', label: '说明', type: 'long' }                                   // 独占一行、保留换行、可滚动
{ key: 'readme', label: '说明', type: 'long', style: { rows: 4 } }               // 限定 4 行高
{ key: 'readme', label: '说明', type: 'long', style: { button: 'show-readme' } } // 再挂一个按钮
```

`style.block: true` 是不写 `type: 'long'` 时的等价写法。

---

## 7. 插件设置（settings）

```js
settings: [
  { key: 'autoTag', label: '自动加标签', type: 'boolean', default: true },
  { key: 'scale',   label: '缩放',      type: 'select',  options: ['0.5', '1', '2'], default: '1' },
  { key: 'count',   label: '数量',      type: 'number',  default: 5 },
  { key: 'note',    label: '备注',      type: 'text',    default: '' },
  { key: 'modelDir',  label: '模型文件夹', type: 'dir',  default: '' },
  { key: 'modelFile', label: '模型文件',   type: 'file',
    from: 'modelDir', match: ['.pmx', '.pmd'], recursive: true, default: '' },
]
```

`type` 支持：`'text'` / `'number'` / `'boolean'` / `'select'`（必须给 `options`）/ `'dir'` / `'file'`。

用户在设置页改动后持久化到数据目录的 `plugin-settings.json`，保存后触发重扫即时生效。

> **资源类设置在哪个界面**
>
> `'text'` / `'number'` / `'boolean'` / `'select'` 这四种**轻量**类型内联显示在
> 「设置页 → 插件管理」的插件行里。
>
> `'dir'` / `'file'` 这两种**资源类**类型（要弹文件夹对话框、要复制整个文件夹、
> 要扫描候选）显示在**「插件设置」弹窗**的「插件资源」区 —— 就是点插件行
> 那个「设置」按钮弹出的窗口，和「类型图标」「类型颜色」放在一起。
>
> 分开放的原因：内联渲染时点「浏览…」引起的重绘会把整个设置页刷新一下，
> 观感上像设置页被重新打开了一遍；弹窗是独立层，重绘只影响弹窗内部。

### `type: 'dir'` —— 选择文件夹并复制进插件目录

界面渲染成一个**只读输入框 + 「浏览…」按钮**（已选时多一个「清除」）：

1. 点「浏览…」弹出文件夹选择框
2. 选中的文件夹被**整个复制**到插件目录下（递归复制，含子目录）
3. 设置里存的是**相对插件目录的文件夹名**，例如 `'模型'`

插件侧这样定位它：

```js
const settings = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'data', 'plugin-settings.json'), 'utf-8'))
const rel = (settings['<你的插件文件夹名>'] || {}).modelDir   // '模型'
const abs = path.join(__dirname, rel)                          // 插件目录/模型
```

> `__dirname` 就是插件文件夹；`data/` 在软件主目录下（可用 `AMM_DATA_DIR` 覆盖）。

**为什么是「复制」而不是记住原路径**：渲染层读文件只能走 `asset://`，
而它只放行「素材库内」与「plugins 目录内」—— 库外的文件夹读不到。
复制进插件目录后既绕开了这个限制，插件打包分发时资源也跟着走。

**同名冲突不会自动覆盖**：第二次选到同名文件夹时界面会问一句，
确认后才覆盖（旧文件夹会被删除）。「清除」按钮删除该文件夹并清空设置值。

> 路径校验：只接受**单层文件夹名**。`..`、`a/b`、`C:\...` 一律拒绝，
> 所以这个入口不可能删到插件目录之外。

### `type: 'file'` —— 从已选文件夹里挑一个文件

界面渲染成一个**下拉框**。候选来自另一个 `dir` 设置项已经选中的文件夹，
由主进程扫描后填充。用于「一个文件夹里有多个同类文件，用户得挑一个」的场景
（例如模型文件夹里有多个 `.pmx`）。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `from` | ✅ | 候选来源的 `dir` 设置项的 `key` |
| `match` | — | 只列这些扩展名，如 `['.pmx', '.pmd']`。缺省列全部 |
| `recursive` | — | 是否含子目录，缺省 `true` |

值同样是**相对插件目录的路径**（如 `'模型/校服.pmx'`），插件侧照常
`path.join(__dirname, v)` 即可。只有一个候选时会**自动选中**，
多个则必须由用户明确选择 —— 下拉框下方会提示候选数量。

重新选文件夹时会清掉已选的 `file` 值（旧选择多半已失效）。

> ⚠️ 主程序目前**不把设置值传给插件**。插件若要读取自己的设置，需自行读取
> `plugin-settings.json`（位置见第 9 节）。

---

## 8. 主程序如何使用你的声明

- **扫描**：扩展名 → 插件**完全来自注册表**。没有插件声明该扩展名 → 不索引、不显示
- **类别**：来自 `kind`
- **缩略图（显示）**：只取素材同目录、**名为 `<素材文件名>.preview.<图片扩展名>`** 的图片
  （`a.blend` → `a.blend.preview.png`；图片扩展名按 `.png/.jpg/.jpeg/.bmp/.webp/.gif` 优先级）。
  **显示路径不使用插件渲染结果**。没有对应图片就只显示按扩展名取色的占位图标。
  命名里的两段都有用：保留素材扩展名让同目录同主名的不同素材（`a.blend` 与 `a.pmx`）各自独立；
  `.preview.` 标明「这是缩略图」，也让主程序能安全地只清理这一类文件
- **缩略图（生成）**：顶栏「缩略图」按钮 → 对当前范围内「声明 `canThumbnail` + 提供 `viewer`
  + 当前没有缩略图」的素材，用离屏宿主渲染并按上述命名写到素材同目录。
  **已有缩略图的一律跳过，绝不覆盖。** 生成后与手动放置的走完全相同的显示路径；
  「清除缩略图」只删带 `.preview.` 的，用户自己命名的图片一律不动
- **预览**：`canPreview` 且提供 `viewer` → 独立预览窗口；否则用系统默认程序打开
- **双击**：按 `dblclick`（用户覆盖优先）分发到 预览 / 系统打开 / 不操作；
  **未声明时不做任何操作**；显式声明 `'preview'` 但无预览能力时退化为系统打开
- **右键菜单**：`actions` 里 `scope: 'single'` 的项
- **批量操作**：`actions` 里 `scope: 'multi'` 的项
- **详情栏**：`detail.fields` + `parse` 元数据 + `detail.buttons`（按钮，返回值交界面呈现）
- **插件增删**：插件集合的**内容指纹**（id + exts）变化 → 索引全量重扫

---

## 9. 安装 / 卸载 / 启停

| 操作 | 行为 |
| --- | --- |
| **安装** | 选择 **`.zip` 压缩包** → 解压到临时目录 → 定位含 `index.cjs` 的根（容忍单层/两层包裹）→ 校验清单 → 复制到 `plugins/<id>/` → 立即加载 + 重扫 |
| **卸载** | **删除 `plugins/<id>/` 整个目录**（不走回收站，**不可还原**）→ 注销 → 重扫。UI 仅此处有二次确认 |
| **禁用** | 注销注册表 → 该类型条目立即从库中消失。**无二次确认**，选择持久化到 `settings.json` |
| **启用** | 从磁盘重新加载 → 注册 → 重扫 |

- 安装**仅接受 zip**。zip 内文件名优先按 UTF-8 解码，未置 UTF-8 标志时回退 GBK
- 禁用后插件仍保留在设置页列表中，可随时重新启用
- 以上操作**全部即时生效，无需重启**

### 数据位置

都在**软件目录下的 `data/`**（便携；可用 `AMM_DATA_DIR` 覆盖）：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 全局设置、素材库列表、禁用插件列表 |
| `index/index-<rootId>.json` | 索引分片（含 `sig` 插件签名） |
| `plugin-settings.json` | 插件自定义设置 |
| `plugin-overrides.json` | 界面上的插件改动（显示名/扩展名/图标/颜色） |

> 早期版本位于 `%APPDATA%\<app>\`，首次启动会自动迁移。

---

## 10. 写插件时的坑（都是实证踩过的）

### ① 渲染进程读文件只能走 `asset://`，且只能读允许范围内的文件

主程序的 `asset://` 协议**会校验路径归属**，只放行两处：

1. **已注册素材库目录内**的文件（含未索引的附属文件，如模型旁边的贴图）
2. **plugins 目录内**的文件（插件图标等）

越界请求一律返回 **403**。这是刻意设计的信任边界 —— 渲染层没有 fs 权限，
`asset://` 是它唯一的文件通道，不校验就等于把整个硬盘开放给一段被注入的脚本。

### ② 内联脚本会被**静默**拦掉

主页面 CSP（`src/renderer/index.html`）：

```
default-src 'self'; img-src 'self' asset: data:; style-src 'self' 'unsafe-inline'; script-src 'self'
```

**不要写内联 `<script>`** —— `script-src 'self'` 会拦掉它，而且不报错、不提示。
需要感知加载完成就直接改 DOM（`viewer` 模块本身是外部文件，可以正常执行）。

### ③ `asset://` 支持 `fetch()` 与 Range（可直接播视频、可 seek）

主程序已把 `asset://` 登记为**特权协议**（`standard` + `secure` + `supportFetchAPI` +
`stream`），因此：

- `fetch('asset://file/...')` **可以正常使用**（不再需要 XHR 兜底）
- 支持 **Range 请求**：发 `Range: bytes=a-b` 会得到 `206` + `Content-Range`；
  越界返回 `416`；不带 Range 返回 `200`。大文件是**流式**返回的，不会整块读进内存
- `<video>` / `<audio>` 可以直接把 `src` 指向 `asset://`，**进度条可拖动**

> 历史：早期版本没有开启 `supportFetchAPI`，`fetch()` 对该协议不可用（报
> "Failed to fetch"），只能改用 `XMLHttpRequest`。现在两者都可以。
> 如果你的插件里还留着 XHR 兜底代码，那仍然能跑，只是不再必要。

Range 是视频 seek 的前提 —— 没有它，播放器能播但**拖不动进度条**，
且大文件会一次性占满内存。

### ⑤ 插件自己的 `preview.html` 必须显式允许 `asset:`

预览窗口加载的是**你的页面**，它的 CSP 由你定义。要读素材就得自己放开：

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self' asset:; img-src 'self' asset: data: blob:; style-src 'unsafe-inline'; script-src 'self'" />
```

播视频/音频还要加 `media-src 'self' asset: blob:`，否则 `<video src="asset://...">`
会**静默**读不到数据（窗口全黑，控制台只报一个不指向 CSP 的错）。

> 对比：主程序的通用宿主页 `host.html`（缩略图渲染用它）已经把
> `connect-src / img-src / media-src` 放开到 `asset:`，所以那条路径不用你操心。

### ⑥ 预览页面不要声明 `<title>`

一旦声明就会覆盖主程序为预览窗口设置的标题（`插件名 预览 - 文件名`）。

### ⑦ 第三方依赖打包成单文件，插件目录里不要有 `node_modules`

用 esbuild 之类把 three.js / 解析库打包进 `viewer.mjs` / `parser.cjs`，
这样插件可以直接 zip 分发安装。

### ⑦ 缩略图渲染用的是主程序宿主页，不是你的 `preview.html`

`canThumbnail: true` 时按钮触发的渲染加载 `src/renderer/host.html`
（只注入 api + 一个 `#host-content` 空容器），**你的窗口样式和自定义 DOM 不参与**。
所以 `snapshot()` 必须能在这种「没有任何插件样式」的环境下产出正确画面。

---

## 11. 红线

- 主进程 / 渲染进程代码中**不出现具体扩展名常量、解析器实现、类型白名单**
- 主程序只认识「插件声明过的能力」，不自行假设任何格式的行为
- 通用缩略图策略（**`<素材文件名>.preview.<图片扩展名>` 的旁挂图片**）是唯一内建的文件相关行为，与类型无关
- **没有任何插件时软件必须正常运行** —— 只是不能管理任何类型的素材

---

## 12. 参考实现

| 插件 | 扩展名 | 能力 |
| --- | --- | --- |
| `plugins/blender工程/` | `.blend` | 只读文件头识别（版本 / 指针位数 / 字节序 / 是否 gzip 压缩）；无缩略图、无预览。**最小可用示例**，适合照抄起步 |
| `plugins/mmd模型/` | `.pmx` / `.pmd` | 元数据解析 + 生成缩略图 + 独立窗口 3D 实时预览（three.js + MMDLoader 已打包进 `viewer.mjs`）。**全能力示例** |

两个插件都完全自包含，不读取、不修改主程序的任何文件。

---

## 附：最小可用插件

```js
// plugins/我的插件/index.cjs
module.exports = {
  id: '我的插件',
  name: '我的插件',
  version: '1.0.0',
  exts: ['.myext'],
  kind: { key: 'mine', label: '我的类型', color: '#6366f1' },
}
```

只有这么多。主程序会识别 `.myext` 文件、按类别展示、给它们取色占位图标。
想加详情就往 `parse` 里填，想加预览就加 `viewer`。
