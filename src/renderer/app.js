window.addEventListener('error', (ev) => console.error('GLOBAL_ERROR', ev.message, ev.error?.stack))
window.addEventListener('unhandledrejection', (ev) => {
  console.error('UNHANDLED_REJECTION', ev.reason?.stack || ev.reason)
})

/**
 * 渲染进程逻辑（原生 JS，无框架）
 * 视图状态机：all | favorites + 目录浏览
 */
const bridge = window.api
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

/**
 * 双击素材的默认行为（插件未声明、用户也没覆盖时用它）。
 * 与主程序 pluginHost.DBLCLICK_DEFAULT 保持一致：**默认不做任何操作**。
 *
 * 「未声明」只说明插件作者没表达意图，而双击会开窗口/拉起外部程序，
 * 属于有副作用的动作 —— 拿不准就不动。想开放的插件显式声明 dblclick 即可。
 */
const DBLCLICK_DEFAULT = 'none'

/** 双击行为的显示名（设置页下拉 + 提示文案共用） */
const DBLCLICK_LABELS = {
  preview: '打开预览窗口',
  open: '用系统默认程序打开',
  none: '不做任何操作',
}

const state = {
  roots: [],
  activeView: 'all', // all | favorites
  activeRootId: null, // null = 全部根
  activeDir: null, // 目录浏览路径（null = 根）
  search: '',
  sort: 'name',
  sortOrder: 'asc',
  /*
   * 全局排序是**默认值**；具体目录可以用自己的排序覆盖它。
   * 进入目录时若该目录有记录，就用记录值填进 sort/sortOrder（见 applyFolderSort），
   * 于是渲染逻辑不必区分「这是默认还是目录自己的」—— 顶层只有一份当前生效的排序。
   */
  viewMode: 'grid', // grid | list
  gridSize: 150, // 网格最小宽度 px
  items: [], // 当前视图条目
  folder: null, // 文件夹视图数据（{chain, folders, assets, total}）
  selected: new Map(), // path -> entry
  detail: null, // 详情面板当前条目
  dirTree: null,
  rootTrees: new Map(), // rootId -> 该库目录树（缓存：多库并显 + 切换不重建）
  dirTreeKey: null, // 上次构建的库集合（roots 顺序拼接），用于判断是否需要重建
  dirTreeDirty: false, // 某库扫描完成/内容变化 → 下次刷新重建其树
  expandedPaths: new Set(), // 目录树展开状态
  stats: { total: 0, favorites: 0 },
  plugins: [], // 插件注册表（当前为空 → 不显示任何素材）
  pluginLoadErrors: [], // 最近一次插件加载失败清单 [{dir, error}]（插件为何没出现在列表里）
  settingsOpen: false, // 设置独立页是否打开
}

/** 重拉插件状态：生效列表 + 加载失败清单（失败清单用于回答「插件为何不见了」） */
async function reloadPluginState() {
  state.plugins = await bridge.listPlugins()
  state.pluginLoadErrors = (await bridge.pluginLoadErrors()) || []
}

/* ── 工具 ─────────────────────────────── */
function fmtSize(n) {
  if (n == null) return '-'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
function fmtTime(ms) {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* ── 卡片标注：类别图标 / 类型角标 ───────────────────────────
   网格卡片中间 = 「素材类别图标」（只显示图标，不显示文字），左下角 = 「文件类型」。
   • 一种文件类型 → 一个图标：图标由插件 manifest.icon 提供
   • 插件未指定 → 主程序内置的默认占位图标（文件轮廓，泛指各类素材）
   • 文件夹的图标由主程序规定，与插件无关 */
const ICON_PATHS = {
  // 通用素材默认占位图标（文件轮廓 —— 泛指各类素材，不是方块）
  default:
    '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/>' +
    '<path d="M14 3v3.8A1.2 1.2 0 0 0 15.2 8H19"/>' +
    '<path d="M8.6 12.6h6.8M8.6 16.2h4.4"/>',
  // 文件夹图标
  folder:
    '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.7L11 8.2h7.5A1.5 1.5 0 0 1 20 9.7V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z"/>',
}
const FALLBACK_KIND_COLOR = '#8a8f98'
/** 合法十六进制色（3/6 位）—— 插件填的色会直接进 style，必须先验格式 */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** 内置线性图标 → 内联 SVG（颜色随类别色） */
function iconSvg(name, color) {
  const d = ICON_PATHS[name] || ICON_PATHS.default
  return `<svg class="kind-svg" viewBox="0 0 24 24" fill="none" stroke="${esc(color)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
}

const _iconCache = new Map()
function defaultIconSvg(color) {
  const key = String(color || FALLBACK_KIND_COLOR)
  if (!_iconCache.has(key)) _iconCache.set(key, iconSvg('default', key))
  return _iconCache.get(key)
}

/** 角标文字色：按底色亮度选深/浅，保证任意插件色下都可读 */
function badgeTextColor(color) {
  const hex = String(color || '').trim()
  if (!HEX_COLOR_RE.test(hex)) return '#ffffff'
  let h = hex.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#1a1d22' : '#ffffff'
}

/**
 * 素材的类别图标与类别色：{ icon, color }。
 * • icon：可直接插入的 HTML —— 一种文件类型一个图标；由插件 manifest.icon 提供，
 *   插件未指定则回退主程序内置的默认占位图标
 * • color：插件 kind.color（合法十六进制才采用，否则 null → 走中性样式），
 *   用于给左下角「文件类型」角标上色
 *
 * ── extIcons：同一个插件里按扩展名给不同图标 ──────────────
 * 一个插件可能管理差别很大的几种素材（例如 MMD 动作插件同时管
 * 动作 .vmd/.vpd 和音频 .mp3/.wav），共用一个图标会让人分不清。
 * 插件可以额外声明 `extIcons: { '.mp3': 'audio.svg', ... }`，
 * 这里优先按条目自己的扩展名取图标，取不到再退回插件级 icon。
 * 封面用哪个图标也和卡片一致 —— 否则列表和封面会显示不同的图。
 */
function kindInfoOf(entry) {
  const plugin = pluginOf(entry)
  const raw = plugin && plugin.kind && plugin.kind.color
  const color = raw && HEX_COLOR_RE.test(String(raw).trim()) ? String(raw).trim() : null

  let iconFile = plugin && plugin.icon
  /*
   * 按扩展名覆盖（大小写不敏感；插件声明时一般写小写）。
   * 扩展名从 entry.path 取 —— 与 pluginOf() 同一套规则
   * （条目没有独立的 ext 字段，渲染层的约定就是看路径后缀）。
   */
  const ext = (entry && entry.path ? (entry.path.match(/\.[^.]+$/) || [''])[0] : '').toLowerCase()
  if (plugin && plugin.extIcons && ext && plugin.extIcons[ext]) {
    iconFile = plugin.extIcons[ext]
  }

  let icon
  if (iconFile && plugin && plugin.dir) {
    const sep = /[\\/]$/.test(plugin.dir) ? '' : '\\'
    const iconPath = plugin.dir + sep + iconFile
    icon = `<img class="kind-img" alt="" data-color="${esc(color || FALLBACK_KIND_COLOR)}" src="asset://thumb/${encodeURIComponent(iconPath)}" />`
  } else {
    icon = defaultIconSvg(color || FALLBACK_KIND_COLOR)
  }
  return { icon, color }
}

/** 左下角「文件类型」角标：插件声明了类别色 → 用该色填充，否则中性胶囊 */
function typeBadgeHtml(text, color) {
  if (!color) return `<span class="type-badge" title="文件类型">${esc(text)}</span>`
  const fg = badgeTextColor(color)
  return `<span class="type-badge filled" title="文件类型" style="background:${esc(color)};color:${esc(fg)}">${esc(text)}</span>`
}

/** 左下角「文件类型」角标文字：.pmx → pmx */
function extBadgeOf(entry) {
  const m = String((entry && entry.path) || '').match(/\.([^.\\/]+)$/)
  return m ? m[1].toLowerCase() : '?'
}

/** 插件图标加载失败 → 换成主程序默认图标（不留破图） */
function bindKindIconFallback(root) {
  root.querySelectorAll('img.kind-img').forEach((img) => {
    img.addEventListener('error', () => {
      const box = img.parentElement
      if (box) box.innerHTML = defaultIconSvg(img.dataset.color || FALLBACK_KIND_COLOR)
    })
  })
}

/* ── 初始化 ───────────────────────────── */
async function init() {
  bindEvents()
  setupPanelResizers()
  setupDetailClose()
  installClickShield() // 防「双击文件夹时第二下穿透到素材卡」
  installBlankAreaDblclick() // 空白处双击 → 返回上一级
  applyPanelWidths()
  // 详情栏常驻：启动即显示占位，保证首次渲染时左侧宽度就是最终宽度
  renderDetailPlaceholder()
  await reloadPluginState()
  state.roots = await bridge.listRoots()
  await loadGridSize() // 网格大小是持久化设置，须在首次渲染前应用
  await refreshStats()
  renderRoots()
  if (state.roots.length) {
    state.activeRootId = state.roots.find((r) => r.enabled)?.id || state.roots[0].id
  }
  await refreshAll()
}

/** 读取持久化的网格大小并应用（顶栏滑块 + CSS 变量） */
async function loadGridSize() {
  try {
    const s = await bridge.getSettings()
    const v = Number(s && s.gridSize)
    if (Number.isFinite(v) && v > 0) {
      state.gridSize = v
      const slider = $('#grid-size-slider')
      if (slider) slider.value = String(v)
    }
  } catch { /* 读不到设置就用默认值，不影响启动 */ }
  document.documentElement.style.setProperty('--grid-min', `${state.gridSize}px`)
}

async function refreshStats() {
  state.stats = await bridge.getStats()
  renderStats()
}

async function refreshAll() {
  await Promise.all([refreshAssets(), refreshStats()])
  renderQuickViews()
  refreshDirTree()
  refreshThumbPending()
}

/**
 * 刷新顶栏「缩略图」按钮括号里的数字：当前目录内「插件可生成、但还没有缩略图」的素材数。
 * 插件不支持生成的素材、已有缩略图的素材都不计入（统计口径与生成范围完全一致）。
 */
async function refreshThumbPending() {
  const btn = $('#thumb-btn')
  if (!btn) return
  const label = btn.querySelector('.btn-label')
  try {
    const res = await bridge.getThumbPending({
      rootId: state.activeRootId || undefined,
      dir: state.activeDir || undefined,
    })
    const n = res && res.ok ? res.pending : 0
    if (label) label.textContent = `缩略图 (${n})`
    btn.title = n
      ? `当前目录还有 ${n} 个素材可生成缩略图（插件支持且尚未生成）`
      : '当前目录没有待生成缩略图的素材'
  } catch {
    if (label) label.textContent = '缩略图'
  }
}

/** 找出包含某目录的已启用素材库根（绝对路径前缀匹配） */
function rootOfPath(dirPath) {
  if (!dirPath) return null
  const norm = (p) => String(p).replace(/[\\/]+$/, '')
  return state.roots.find((r) => {
    const rp = norm(r.path)
    return dirPath === rp || dirPath.startsWith(rp + '\\') || dirPath.startsWith(rp + '/')
  }) || null
}

/**
 * 取上一级目录的绝对路径；已经是素材库根（或没有父级）时返回 null。
 *
 * 用于「用作父文件夹封面」—— 根目录没有父文件夹，不该出现这一项。
 * 判断「是不是根」要跟 rootOfPath 用同一套归一化，否则 E:\MMD 与 E:\MMD\
 * 这种尾部分隔符差异会让根目录被误判成有父级。
 */
function parentDirOf(dirPath) {
  if (!dirPath) return null
  const p = String(dirPath).replace(/[\\/]+$/, '')
  const root = rootOfPath(p)
  if (root && p === String(root.path).replace(/[\\/]+$/, '')) return null // 就是根，没有父级
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (i <= 0) return null
  return p.slice(0, i)
}

/* ── 任务进度条区（扫描 / 缩略图；每个任务一条，新的追加在最下面、旧条上移） ── */
function taskBarEl(taskId) {
  return document.querySelector(`.task-bar[data-task="${taskId}"]`)
}

/** 找到/创建某任务的进度条；新任务追加到 #task-bars 末尾 → 视觉上在最下面 */
function ensureTaskBar(taskId) {
  let el = taskBarEl(taskId)
  if (el) return el
  el = document.createElement('div')
  el.className = 'task-bar'
  el.dataset.task = taskId
  el.innerHTML = `
      <span class="task-label">排队中…</span>
      <div class="scan-bar"><div class="scan-fill"></div></div>
      <span class="task-count"></span>
      <button class="btn small task-stop" title="停止当前任务（已完成的部分会保留）">■ 停止</button>
    `
  el.querySelector('.task-stop').addEventListener('click', () => stopTask(taskId))
  $('#task-bars').appendChild(el) // 追加到末尾 = 最下面，旧条自然上移
  return el
}

/**
 * 更新一条任务的进度条（按 taskId 区分，互不影响）。
 * @param {number} taskId
 * @param {{queued?:boolean,current?:number,total?:number,message?:string}} p
 */
function updateTaskBar(taskId, p = {}) {
  if (taskId == null) return
  const el = ensureTaskBar(taskId)
  const total = Number(p.total) || 0
  const current = Number(p.current) || 0
  const scanBar = el.querySelector('.scan-bar')
  const fill = el.querySelector('.scan-fill')
  el.querySelector('.task-stop').style.visibility = 'visible'
  if (total) {
    // 有确定总量：显示百分比与计数
    scanBar?.classList.remove('indet')
    fill.style.width = `${Math.round((current / total) * 100)}%`
    el.querySelector('.task-count').textContent = `${current}/${total}`
  } else {
    // 总量未知（遍历目录 ／ 排队中）：流动条表示“正在运行/等待”
    scanBar?.classList.add('indet')
    fill.style.width = '0%'
    el.querySelector('.task-count').textContent = ''
  }
  el.querySelector('.task-label').textContent = p.message || '处理中…'
}

/**
 * 任务结束：该条进度条切到结果态、收起「停止」按钮；完成时进度条变绿
 * （停留期间可见），随后延时自动移除整条。
 */
function finishTaskBar(taskId, r = {}, hideAfterMs = 3000) {
  if (taskId == null) return
  const el = taskBarEl(taskId)
  if (!el) return
  el.querySelector('.task-stop').style.visibility = 'hidden' // 保留占位：隐藏不改变行的位置/长短
  if (r.message) el.querySelector('.task-label').textContent = r.message
  if (r.complete) {
    // 完成 → 蓝色变绿色（任务结束后、进度条消失前的这 3 秒停留期）
    el.querySelector('.scan-bar')?.classList.remove('indet')
    const fill = el.querySelector('.scan-fill')
    fill.style.width = '100%'
    fill.classList.add('done')
  }
  if (r.cancelled) el.querySelector('.task-count').textContent = ''
  setTimeout(() => {
    taskBarEl(taskId)?.remove()
  }, hideAfterMs)
}

/** 点某条进度条的「停止」：只取消该任务（正在跑 → 协作式中断；排队中 → 直接移除） */
async function stopTask(taskId) {
  const el = taskBarEl(taskId)
  if (!el) return
  const btn = el.querySelector('.task-stop')
  if (btn) btn.disabled = true
  try {
    // 只发取消请求，不写最终文案 —— 完成/取消文案由主进程随 DONE 事件给出
    // （否则这里写入的「正在停止…」会把「已取消（未开始）」覆盖掉）。
    await bridge.cancelTask({ taskId })
  } catch (err) {
    el.querySelector('.task-label').textContent = '停止失败：' + (err && err.message || err)
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false }, 1200)
  }
}

/* ── 素材查询刷新 ─────────────────────── */
let _assetsReqSeq = 0 // 查询序号：防止慢请求返回时覆盖新查询结果
async function refreshAssets() {
  const seq = ++_assetsReqSeq
  // 停用的素材库：不查询、不操作 —— 主界面只显示「该素材库已停用」提示
  if (state.activeRootId) {
    const activeRoot = state.roots.find((r) => r.id === state.activeRootId)
    if (activeRoot && !activeRoot.enabled) {
      if (seq !== _assetsReqSeq) return
      state.folder = null
      state.items = []
      showRootDisabledNotice(activeRoot.name)
      return
    }
  }
  // 文件夹视图：全部素材视图 + 无搜索词时按文件夹浏览；其他情况平铺
  const folderMode = state.activeView === 'all' && !state.search && state.activeRootId

  if (folderMode) {
    const view = await bridge.folderView(state.activeRootId, state.activeDir || '')
    if (seq !== _assetsReqSeq) return
    state.folder = view
    // 该目录上次用的排序（folderView 顺路带回来，省一次往返）；没有记录则回落全局默认
    resolveSortForDir(view && view.sort)
    // 排序在渲染层做（folderView 不接受排序参数），这里也保持一致，
    // 免得 state.items 的顺序与界面显示的顺序不同（会影响 shift 连选的范围）
    state.items = view ? sortAssetList(view.assets || []) : []
    renderFolderView()
    renderAssets()
    return
  }

  const q = {
    favoritesOnly: state.activeView === 'favorites',
    search: state.search || undefined,
    sort: state.sort,
    order: state.sortOrder,
    dir: state.activeDir || undefined,
    rootId: state.activeRootId || undefined,
  }
  const res = await bridge.queryAssets(q)
  if (seq !== _assetsReqSeq) return // 已有更新的查询，丢弃过期结果
  state.items = res.items
  state.folder = null
  renderFolderView() // 清空文件夹视图容器
  renderAssets()
}

/* ── 渲染：统计 ───────────────────────── */
function renderStats() {
  document.querySelectorAll('.qv-item').forEach((el) => {
    const v = el.dataset.view
    const cnt = v === 'all' ? state.stats.total : v === 'favorites' ? state.stats.favorites : ''
    const span = el.querySelector('.qv-count')
    if (!span) {
      const s = document.createElement('span')
      s.className = 'qv-count'
      s.style.cssText = 'margin-left:auto;font-size:11px;color:var(--text-dim)'
      s.textContent = cnt
      el.appendChild(s)
    } else span.textContent = cnt
  })
}

/* ── 渲染：素材库列表 ─────────────────── */
/** 面板宽度拖拽（侧栏 / 详情栏）：拖动时改 inline width，松手后持久化 */
function setupPanelResizers() {
  const bind = (handleSel, targetSel, key, minW, maxW) => {
    const handle = document.querySelector(handleSel)
    const target = document.querySelector(targetSel)
    if (!handle || !target) return
    let dragging = false
    handle.addEventListener('mousedown', (e) => {
      dragging = true
      handle.classList.add('active')
      document.body.style.cursor = 'col-resize'
      e.preventDefault()
    })
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const rect = document.querySelector('#main').getBoundingClientRect()
      const w = targetSel === '#sidebar'
        ? e.clientX - rect.left // 侧栏：左边固定，右边随鼠标
        : rect.right - e.clientX // 详情栏：右边固定，左边随鼠标
      target.style.width = `${Math.max(minW, Math.min(maxW, Math.round(w)))}px`
    })
    document.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      handle.classList.remove('active')
      document.body.style.cursor = ''
      const w = Math.round(target.getBoundingClientRect().width)
      bridge.setSettings({ [key]: w }).catch(() => {})
    })
  }
  bind('#sidebar-resizer', '#sidebar', 'sidebarWidth', 140, 480)
  bind('#detail-resizer', '#detail-panel', 'detailWidth', 200, 700)
}

/**
 * 详情栏的「取消选择」入口：右上角 ✕ 按钮 + Esc 键。
 *
 * 注意语义已经变了：详情栏改成**常驻**后，这两个入口不再隐藏面板，
 * 而是清掉选中、回到占位态。面板隐藏会让左侧素材区凭空多出 280px，
 * 点一下素材整个列表就重排 —— 那正是"常驻"要消除的抖动。
 *
 * 保留 ✕ 是为了给"看完了、不想留着高亮"提供一个明确出口；
 * 想临时看宽一点应该拖分隔条，而不是让面板消失。
 */
function setupDetailClose() {
  $('#detail-close')?.addEventListener('click', () => closeDetail())
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    // 弹窗优先：有模态框时 Esc 关弹窗，不动详情栏
    const modal = $('#modal-root')
    if (modal && modal.innerHTML.trim()) {
      modal.innerHTML = ''
      return
    }
    // 详情栏常驻，Esc 一律回到占位态（清掉选中）。
    // 这里不再判断面板是否隐藏 —— 它已经不会隐藏了，
    // 保留旧判断只会让读代码的人以为还有"隐藏"这个状态。
    closeDetail()
  })
}

/** 应用保存过的面板宽度 */
function applyPanelWidths() {
  bridge.getSettings().then((s) => {
    if (s && s.sidebarWidth) $('#sidebar').style.width = `${s.sidebarWidth}px`
    if (s && s.detailWidth) $('#detail-panel').style.width = `${s.detailWidth}px`
  }).catch(() => {})
}

/** 选中某个素材库（侧栏根项 / 目录树根节点共用）：切库并刷新 */
function selectRoot(rootId) {
  if (!state.roots.some((r) => r.id === rootId)) return
  state.activeRootId = rootId
  state.activeDir = null
  state.selected.clear()
  closeDetail() // 切换素材库 → 详情栏属于上一个库的条目，必须关闭
  ensureBrowseVisible() // 若在设置页，先回到浏览
  renderRoots()
  refreshAll()
}

function renderRoots() {
  const box = $('#roots-list')
  box.innerHTML = ''
  for (const root of state.roots) {
    const el = document.createElement('div')
    el.className = 'root-item' + (root.id === state.activeRootId ? ' active' : '') + (root.enabled ? '' : ' off')
    el.innerHTML = `
      <span class="name" title="${esc(root.path)}">${esc(root.name)}</span>
      <span class="count">${root.enabled ? '' : '已停用'}</span>
    `
    el.addEventListener('click', () => selectRoot(root.id))
    box.appendChild(el)
  }
}

/* ── 渲染：目录树 ─────────────────────── */
// 目录树渲染代号：新一轮构建会让旧分块循环立刻停手（防过期数据追加进新树）
let _dirTreeRenderSeq = 0

/** 只刷新目录树高亮/展开，不重建 DOM（切换素材库不再卡顿） */
function updateTreeHighlights(box) {
  const activePath = state.activeDir || (state.dirTree ? state.dirTree.path : null)
  box.querySelectorAll('.dir-row.active').forEach((r) => r.classList.remove('active'))
  if (activePath) {
    /*
     * 同步活动路径的祖先链到 DOM。
     * 这里**不能**用 exclusive：它只是「把当前路径补展开」，
     * 用户手动展开的其它分支要留着（本函数在每次刷新时都会跑，
     * 用独占会导致手动展开的目录刷一下就没了）。
     * 真正的收起由 navigateTo / revealDirInTree 负责。
     */
    const chain = expandAncestors(activePath)
    for (const dir of chain) {
      const row = box.querySelector(`.dir-row[data-path="${cssEsc(dir)}"]`)
      if (!row) continue
      row.querySelector('.dir-arrow')?.classList.add('open')
      const kids = row.parentElement.querySelector(':scope > .dir-children')
      if (kids) kids.style.display = 'block'
    }
    box.querySelector(`.dir-row[data-path="${cssEsc(activePath)}"]`)?.classList.add('active')
    // 定位到目录树可视区中间（#dir-tree 内部滚动，标题不动）
    box.querySelector(`.dir-row[data-path="${cssEsc(activePath)}"]`)?.scrollIntoView({ block: 'center' })
  }
  if (state.dirTree) {
    const rootRow = box.querySelector(`.dir-row[data-path="${cssEsc(state.dirTree.path)}"]`)
    if (rootRow) {
      rootRow.querySelector('.dir-arrow')?.classList.add('open')
      const kids = rootRow.parentElement.querySelector(':scope > .dir-children')
      if (kids) kids.style.display = 'block'
    }
  }
  /*
   * 收掉 DOM 上「展开了但 state 里没有」的行。
   *
   * 为什么需要这一步：DOM 与 state 是两套记录 —— 上面的根行强制展开、
   * 以及 revealDirInTree 的纯 DOM 操作，都只改样式不改 state。
   * 于是 state.expandedPaths.clear() 之后，DOM 上仍留着之前展开的样子，
   * 表现为"跳转后别的分支还开着"。以 state 为准把 DOM 拉平，两边就不会漂移。
   */
  const keep = new Set(state.expandedPaths)
  if (state.dirTree) keep.add(state.dirTree.path)
  if (activePath) for (const d of expandChainPaths(activePath)) keep.add(d)
  collapseTreeExcept(box, [...keep])
}

async function refreshDirTree() {
  const box = $('#dir-tree')
  const seq = ++_dirTreeRenderSeq
  const roots = state.roots.filter((r) => r.enabled)
  if (!roots.length) {
    box.innerHTML = '<div class="dir-row muted" style="color:var(--text-dim)">添加素材库后显示目录</div>'
    return
  }
  const key = roots.map((r) => r.id).join('|')
  // 取/缓存各库的目录树（只 fetch 缺失的；扫描完成时会把对应库从缓存剔除并标记 dirty）
  for (const root of roots) {
    if (!state.rootTrees.has(root.id)) {
      const tree = await bridge.getDirTree(root.id)
      state.rootTrees.set(root.id, tree)
    }
  }
  if (seq !== _dirTreeRenderSeq) return // 等待期间已触发新一轮刷新

  // 当前浏览目录的祖先链保持展开（基于活动库的树）
  const activeTree = state.rootTrees.get(state.activeRootId) || state.rootTrees.get(roots[0].id)
  if (activeTree) state.dirTree = activeTree
  // 注意**不加** exclusive：这里是「重建后恢复展开状态」，不是跳转。
  // 用独占会把用户手动展开的其它目录一起收掉 —— 刷新一下就没了，很恼人。
  // 真正的收起只发生在两处：navigateTo（进目录）与 revealDirInTree（点素材定位）。
  expandAncestors(state.activeDir)

  // 快路径：同一组库 + 未标记脏 + 已有内容 → 只更新高亮，不重建（切换素材库瞬间完成）
  if (!state.dirTreeDirty && state.dirTreeKey === key && box.childElementCount > 0) {
    updateTreeHighlights(box)
    return
  }

  box.innerHTML = ''
  if (!box.isConnected) return // 视口已被切走（设置页等），不再白建
  state.dirTreeKey = key
  state.dirTreeDirty = false

  // 预收集全部库的任务（每个库一个顶层节点，先序，父在前）
  const tasks = []
  for (const root of roots) {
    const tree = state.rootTrees.get(root.id)
    const rootNode = tree || { path: root.path, name: root.name, count: 0, total: 0, children: [] }
    ;(function collect(node, depth, isRoot, parentPath, rootId) {
      tasks.push({ node, depth, isRoot, parentPath, rootId })
      for (const c of node.children || []) collect(c, depth + 1, false, node.path, rootId)
    })(rootNode, 0, true, null, root.id)
  }
  const wrapByPath = new Map() // path -> childrenWrap（供子节点挂载）
  let i = 0
  const buildNext = () => {
    if (seq !== _dirTreeRenderSeq) return // 已有更新的渲染请求 → 停手
    const end = Math.min(i + RENDER_CHUNK, tasks.length)
    for (; i < end; i++) {
      const t = tasks[i]
      const { wrap, childrenWrap, path } = renderDirNode(t.node, t.depth, t.isRoot, state.expandedPaths, { rootId: t.rootId })
      wrapByPath.set(path, childrenWrap)
      if (t.parentPath && wrapByPath.has(t.parentPath)) wrapByPath.get(t.parentPath).appendChild(wrap)
      else box.appendChild(wrap)
    }
    if (i < tasks.length) {
      setTimeout(buildNext, 0)
    } else if (seq === _dirTreeRenderSeq && box.isConnected) {
      // 全部构建完成：高亮行滚动到可见区域（目录树很长时，选中的目录可能不在视口内）
      updateTreeHighlights(box)
      box.querySelector('.dir-row.active')?.scrollIntoView({ block: 'center' })
    }
  }
  setTimeout(buildNext, 0)
}

/**
 * 目录树的每层缩进（px）。
 *
 * 线性缩进在深目录下会失控：侧栏只有 220px，按每层 14px 算，
 * 到第 8 层就吃掉 112px，名字区域只剩 ~90px，稍长的名字全被截断。
 * 但缩进又不能取消 —— 它承担着"这是谁的子节点"这个唯一视觉线索。
 *
 * 所以用**趋于饱和**的曲线：浅层（≤4 层）保持 14px，层级分明、一眼看得到从属关系；
 * 超过之后每层只加 6px。第 8 层从 112px 降到 80px，名字多出约 3 个汉字。
 *
 * 那为什么深层可以用更小的步进？因为**越深的节点，它的兄弟越少**，
 * 靠"和上一行的相对位置"就能看出层级，不需要那么宽的缩进；
 * 而浅层节点多、兄弟密集，缩进不足会分不清谁属于谁。
 */
function dirIndent(depth) {
  const BASE = 6 // 与行左侧内边距留白
  const STEP = 14 // 浅层每层缩进
  const FLAT = 6 // 深层每层缩进（放缓后）
  const KNEE = 4 // 从第几层开始放缓
  const d = Math.max(0, depth | 0)
  if (d <= KNEE) return BASE + d * STEP
  return BASE + KNEE * STEP + (d - KNEE) * FLAT
}

function renderDirNode(node, depth, isRoot, expandedSet, opts = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'dir-node'
  const row = document.createElement('div')
  // 高亮当前浏览目录；停在素材库根层时高亮根节点
  const activePath = state.activeDir || (state.dirTree ? state.dirTree.path : null)
  row.className = 'dir-row' + (activePath === node.path ? ' active' : '')
  row.dataset.path = node.path // 供 revealDirInTree 定位
  row.style.paddingLeft = `${dirIndent(depth)}px`
  // 只有「还挂有可展开子项」的节点才显示小三角；叶子节点（没有子文件夹，
  // 或子文件夹里没有可识别文件）的展开按钮没有任何作用，直接不放 ▶。
  const hasKids = !!(node.children && node.children.length)
  const arrow = document.createElement('span')
  arrow.className = 'dir-arrow' + (hasKids && isRoot ? ' open' : '')
  if (hasKids) arrow.textContent = '▶'
  const name = document.createElement('span')
  name.className = 'dir-name'
  name.textContent = isRoot ? (node.name || node.path) : node.name
  /*
   * 深层目录的名字常被缩进挤到截断（`.dir-name` 是 ellipsis），
   * 光看省略号没法知道全名。补 title 让悬停能看全 ——
   * 根节点额外显示完整路径，因为它代表整个素材库的位置。
   */
  name.title = isRoot ? node.path : node.name
  const cnt = document.createElement('span')
  cnt.className = 'dir-count'
  // 显示「子孙合计」（与文件夹视图的 count 口径一致）：中间层目录自己没有素材时
  // 也能看出它下面一共挂着多少个素材，不会出现「父目录没数字、子目录有数字」的割裂感。
  const countValue = node.total != null ? node.total : node.count
  cnt.textContent = countValue || ''
  cnt.title = node.count === countValue
    ? `${countValue} 个素材`
    : `${countValue} 个素材（本目录 ${node.count} 个，其余在子目录）`
  /*
   * 整行也挂 title（完整路径）—— 名字被截断时鼠标不用精准停在文字上。
   * 注意 cnt 自带 title，悬停在计数上会显示计数说明（子元素的 title 优先），
   * 这是想要的效果：指名字看路径，指数字看数量。
   */
  row.title = node.path
  row.append(arrow, name, cnt)
  wrap.appendChild(row)

  const childrenWrap = document.createElement('div')
  childrenWrap.className = 'dir-children'
  const isExpanded = hasKids && (isRoot || expandedSet.has(node.path))
  childrenWrap.style.display = isExpanded ? 'block' : 'none'
  // 箭头图标与展开状态一致（重建后展开的节点箭头保持 open）
  if (hasKids) arrow.classList.toggle('open', isExpanded)

  // 点击箭头：展开/收起（仅叶子节点没有可展开内容，不绑）
  arrow.addEventListener('click', (e) => {
    if (!hasKids) return
    e.stopPropagation()
    arrow.classList.toggle('open')
    const willShow = childrenWrap.style.display === 'none'
    childrenWrap.style.display = willShow ? 'block' : 'none'
    if (willShow) state.expandedPaths.add(node.path)
    else state.expandedPaths.delete(node.path)
  })
  // 点击整行（不只是文字）：选中该目录浏览（保持该目录展开，避免重建后收起）
  // 箭头有自己的 handler 且 stopPropagation，不会触发本行导航
  row.addEventListener('click', () => {
    // 素材库根行 → 切到该库（多库并显时点根即换库，不再重建整棵树）
    if (isRoot && opts.rootId) {
      selectRoot(opts.rootId)
      return
    }
    // 点的是「另一个素材库」的文件夹 → 先切库再导航，否则主界面会显示「暂无素材」
    if (opts.rootId && opts.rootId !== state.activeRootId) {
      state.activeRootId = opts.rootId
      state.activeDir = null
      state.selected.clear()
      closeDetail()
      renderRoots()
      navigateTo(node.path)
      return
    }
    navigateTo(node.path === state.dirTree.path ? null : node.path)
  })
  // 右键菜单：基础操作 + 「该文件夹」范围内的缩略图生成/清除
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    showFolderContextMenu(e.clientX, e.clientY, node.path)
  })

  // 子节点由 renderDirTree 分块挂载到 childrenWrap（避免大库整树一次同步建 DOM 卡死渲染进程）
  wrap.appendChild(childrenWrap)
  return { wrap, childrenWrap, path: node.path }
}

// 目录树渲染代号：见 refreshDirTree（统一入口，本模块唯一）

/* ── 文件夹视图 ─────────────────────── */
function renderFolderView() {
  const fv = $('#folder-view')
  const bc = $('#breadcrumb')
  const fs2 = $('#folder-section')
  const fas = $('#folder-assets-section')

  if (!state.folder) {
    fv.classList.add('hidden')
    bc.innerHTML = ''
    fs2.innerHTML = ''
    fas.innerHTML = ''
    return
  }
  fv.classList.remove('hidden')

  // 面包屑
  // 注意：这里必须用绝对路径（absPath）——node.path 是「相对素材根」的路径，
  // 而 state.activeDir 全链路（缩略图范围 isWithinPath、目录树定位 expandAncestors /
  // revealDirInTree、扫描时的根匹配）都按绝对路径处理，传相对路径会导致这些功能全部失效。
  const chain = state.folder.chain || []
  bc.innerHTML = `
    <button class="breadcrumb-item" data-nav="">素材库</button>
    ${chain.filter((n) => n.path).map((n) => `
      <span class="breadcrumb-sep">/</span>
      <button class="breadcrumb-item" data-nav="${esc(n.absPath)}" title="${esc(n.absPath)}">${esc(n.name)}</button>
    `).join('')}
  `
  bc.querySelectorAll('.breadcrumb-item').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.nav || null))
  })

  // 子文件夹（排序与顶栏排序键一致；文件夹聚合 mtime/size）
  // 用 chunkAppend 渐进构建：目录特别多（数千）时也不会一次 build 卡死渲染进程
  const folders = sortFolderList(state.folder.folders || [])
  if (folders.length) {
    if (state.viewMode === 'list') {
      // 列表视图：文件夹行
      fs2.innerHTML = `
        <div class="section-label">子文件夹（${folders.length}）</div>
        <div class="folder-list"></div>
      `
      chunkAppend(fs2.querySelector('.folder-list'), folders,
        (f) => `
          <div class="folder-row" data-path="${esc(f.absPath)}" title="${esc(f.absPath)}\n单击进入">
            <span class="folder-row-ico">📁</span>
            <span class="folder-row-name" title="${esc(f.name)}">${esc(f.name)}</span>
            <span class="folder-row-meta">${f.count} 个素材 · ${fmtSize(f.size)}${f.childrenCount ? ` · ${f.childrenCount} 子目录` : ''}</span>
          </div>`,
        (els) => {
          for (const el of els) {
            el.addEventListener('click', () => navigateTo(el.dataset.path))
            el.addEventListener('contextmenu', (e) => {
              e.preventDefault()
              showFolderContextMenu(e.clientX, e.clientY, el.dataset.path)
            })
          }
        })
    } else {
      // 网格视图：文件夹卡片
      fs2.innerHTML = `
        <div class="section-label">子文件夹（${folders.length}）</div>
        <div class="folder-grid"></div>
      `
      chunkAppend(fs2.querySelector('.folder-grid'), folders,
        (f) => {
          const hasRep = !!f.representative
          return `
          <div class="folder-card" data-path="${esc(f.absPath)}" title="${esc(f.absPath)}\n单击进入">
            <div class="folder-thumb${hasRep ? ' has-img' : ''}">
              ${hasRep ? `<img class="folder-thumb-img" alt="" data-rep="${esc(f.representative.path)}" />` : ''}
              <div class="cover-kind">
                <span class="kind-ico">${iconSvg('folder', FALLBACK_KIND_COLOR)}</span>
              </div>
              <span class="type-badge" title="文件类型">文件夹</span>
              ${f.childrenCount > 0 ? `<span class="folder-badge">${f.childrenCount} 子目录</span>` : ''}
            </div>
            <div class="folder-body">
              <div class="folder-name" title="${esc(f.name)}">${esc(f.name)}</div>
              <div class="folder-meta">${f.count} 个素材 · ${fmtSize(f.size)}</div>
            </div>
          </div>`
        },
        (els) => {
          for (const el of els) {
            el.addEventListener('click', () => navigateTo(el.dataset.path))
            el.addEventListener('contextmenu', (e) => {
              e.preventDefault()
              showFolderContextMenu(e.clientX, e.clientY, el.dataset.path)
            })
            // 代表缩略图：只有存在带 .preview. 的缩略图才用图片，否则回退「文件夹图标 + 文件夹」
            const repImg = el.querySelector('img[data-rep]')
            if (repImg) {
              const thumbBox = el.querySelector('.folder-thumb')
              const pathKey = repImg.dataset.rep
              const rep = (state.folder.folders.find((f) => f.representative && f.representative.path === pathKey) || {}).representative
              const fallback = () => {
                repImg.remove()
                if (thumbBox) thumbBox.classList.remove('has-img')
              }
              if (!rep) {
                fallback()
              } else {
                bridge.getThumbUrl(rep).then((t) => {
                  if (!repImg.isConnected) return
                  if (t.ph) return fallback()
                  repImg.src = t.url
                })
              }
            }
          }
        })
    }
  } else {
    fs2.innerHTML = ''
  }

  // 本目录素材（网格/列表跟随 viewMode）
  // 排序必须在这里做：文件夹视图走的是 bridge.folderView（不接受排序参数），
  // 主进程按名称给默认序，顶栏的排序键得由渲染层补上。
  const assets = sortAssetList(state.folder.assets || [])
  if (assets.length) {
    state.items = assets
    if (state.viewMode === 'list') {
      fas.innerHTML = `
        <div class="section-label" style="margin-top:${folders.length ? 18 : 0}px">本目录下的素材（${assets.length}）</div>
        <div id="folder-asset-list"></div>
      `
      const listEl = fas.querySelector('#folder-asset-list')
      listEl.classList.add('asset-list')
      listEl.style.cssText = 'flex:none;height:auto;overflow:visible'
      renderList(listEl)
    } else {
      fas.innerHTML = `
        <div class="section-label" style="margin-top:${folders.length ? 18 : 0}px">本目录下的素材（${assets.length}）</div>
        <div class="asset-grid" id="folder-asset-grid"></div>
      `
      const grid = fas.querySelector('#folder-asset-grid')
      renderGrid(grid)
    }
  } else {
    fas.innerHTML = ''
  }

  // 空目录
  if (!folders.length && !assets.length) {
    fas.innerHTML = `<div class="empty-folder">这个目录是空的</div>`
  }
}

/**
 * 顶栏排序键 → 素材/文件夹的比较函数。
 *
 * ── 为什么要有这个统一入口 ─────────────────────────────
 * 排序键此前散落在两处各写了一遍，结果键名对不上：
 *   • 主进程 queryAssets 用 `'time'`（和 index.html 的 <option value> 一致）
 *   • 渲染层 sortFolderList 用 `'mtime'`
 * 于是选「按修改时间」时渲染层三个分支全不命中，静默退化成按名称排序 ——
 * 界面上看起来就是「排序没反应」。统一到这里，键名只有一份。
 */
const SORT_KEYS = ['name', 'time', 'size']

/** 全局默认排序：目录没有自己的记录时用它 */
const DEFAULT_SORT = 'name'
const DEFAULT_SORT_ORDER = 'asc'

/** 比较两个条目（素材或文件夹聚合项都适用：都有 name / mtime / size） */
function compareBySort(a, b) {
  const key = SORT_KEYS.includes(state.sort) ? state.sort : 'name'
  let cmp
  if (key === 'time') cmp = (a.mtime || 0) - (b.mtime || 0)
  else if (key === 'size') cmp = (a.size || 0) - (b.size || 0)
  else cmp = String(a.name || '').localeCompare(String(b.name || ''), 'zh')
  if (cmp !== 0) return state.sortOrder === 'desc' ? -cmp : cmp
  // 主键相等时按名称兜底，保证顺序稳定（否则同体积/同时间的条目会乱跳）
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
}

/** 文件夹排序：顶栏排序键作用于文件夹聚合值 */
function sortFolderList(folders) {
  return [...folders].sort(compareBySort)
}

/** 素材排序：文件夹视图里的「本目录素材」走这条（此前漏了，导致排序键对素材无效） */
function sortAssetList(assets) {
  return [...assets].sort(compareBySort)
}

/* ── 每个文件夹各自的排序方案 ────────────── */

/**
 * 把顶栏排序控件同步成 state 里的值。
 * 进目录后 state.sort/sortOrder 可能被该目录的记录改写，控件必须跟着变，
 * 否则会出现「列表按体积排好了，下拉框还显示按名称」的不一致。
 */
function syncSortControls() {
  const sel = $('#sort-select')
  if (sel && sel.value !== state.sort) sel.value = state.sort
  const btn = $('#sort-order-btn')
  if (btn) btn.textContent = state.sortOrder === 'asc' ? '↑' : '↓'
}

/** 应用某个目录记录下来的排序（进入目录时调用） */
function applyFolderSort(saved) {
  if (!saved) return false
  let changed = false
  if (SORT_KEYS.includes(saved.sort) && state.sort !== saved.sort) {
    state.sort = saved.sort
    changed = true
  }
  if ((saved.order === 'asc' || saved.order === 'desc') && state.sortOrder !== saved.order) {
    state.sortOrder = saved.order
    changed = true
  }
  syncSortControls()
  return changed
}

/**
 * 进入某目录时决定用哪套排序。
 *
 * 语义是「每个文件夹各自独立」：
 *   • 该目录有记录     → 用记录（用户上次在这个目录的选择）
 *   • 该目录没有记录   → 回落到**全局默认**（按名称升序）
 *
 * 为什么没有记录时要「重置为默认」而不是「沿用上一个目录的排序」：
 * 后者会让排序看起来像随机泄漏过来的 —— 用户在 A 目录选了「按体积」，
 * 进到从没排过序的 B 目录发现也是按体积，会以为软件记错了。
 * 明确回落默认，行为才是可预期的。
 */
function resolveSortForDir(saved) {
  if (saved && (SORT_KEYS.includes(saved.sort) || saved.order === 'asc' || saved.order === 'desc')) {
    applyFolderSort(saved)
    return
  }
  state.sort = DEFAULT_SORT
  state.sortOrder = DEFAULT_SORT_ORDER
  syncSortControls()
}

/**
 * 记住当前目录的排序方案。
 *
 * 只在**文件夹视图**下记录：搜索/收藏这类是跨目录的临时结果集，
 * 把排序挂到「当前所在目录」上会很别扭（用户下次进这个目录会被搜索结果里的
 * 一次排序影响）。宁可只在语义明确的地方记。
 *
 * 排序变化不是高频操作（用户点一下才触发一次），直接写盘即可，不必做防抖。
 */
async function rememberFolderSort() {
  if (!state.activeRootId) return
  if (state.activeView !== 'all' || state.search) return
  try {
    await bridge.setFolderSort(state.activeRootId, state.activeDir || '', state.sort, state.sortOrder)
  } catch {
    // 记不住不影响本次排序生效，静默即可（下次进目录回落到默认而已）
  }
}

/* ── 渲染：素材网格/列表 ──────────────── */
/** 停用素材库的占位提示：替换整个素材区，禁止浏览与操作 */
function showRootDisabledNotice(name) {
  const grid = $('#asset-grid')
  const list = $('#asset-list')
  const empty = $('#empty-state')
  const fv = $('#folder-view')
  if (fv) fv.classList.add('hidden')
  grid.classList.add('hidden')
  list.classList.add('hidden')
  empty.classList.remove('hidden')
  const ico = empty.querySelector('.empty-ico')
  const p1 = empty.querySelector('.empty-p1')
  const p2 = empty.querySelector('.empty-p2')
  if (ico) ico.textContent = '🔒'
  if (p1) p1.textContent = '该素材库已停用'
  if (p2) p2.textContent = `“${name}”已在设置中停用，启用后即可浏览与操作`
  const countEl = $('#browse-count')
  const dirEl = $('#current-dir')
  if (countEl) countEl.textContent = '0 个素材'
  if (dirEl) dirEl.textContent = ''
}

function renderAssets() {
  const grid = $('#asset-grid')
  const list = $('#asset-list')
  const empty = $('#empty-state')
  const countEl = $('#browse-count')
  const dirEl = $('#current-dir')
  const fv = $('#folder-view')

  if (state.folder) {
    // 文件夹视图：计数与目录信息由 folder-view 内呈现
    countEl.textContent = `${state.folder.total} 个素材`
    dirEl.textContent = state.folder.absPath ? `当前：${state.folder.absPath}` : ''
    grid.classList.add('hidden')
    list.classList.add('hidden')
    empty.classList.add('hidden')
    return
  }

  countEl.textContent = `${state.items.length} 个素材`
  dirEl.textContent = state.activeDir ? `当前目录：${state.activeDir}` : state.activeRootId
    ? `素材库：${state.roots.find((r) => r.id === state.activeRootId)?.name || ''}` : ''

  empty.classList.toggle('hidden', !(state.items.length === 0))
  grid.classList.toggle('hidden', state.viewMode !== 'grid')
  list.classList.toggle('hidden', state.viewMode !== 'list')

  // 空状态提示：无插件（框架级）与有插件但无素材（业务级）区分
  if (state.items.length === 0) {
    const ico = empty.querySelector('.empty-ico')
    const p1 = empty.querySelector('.empty-p1')
    const p2 = empty.querySelector('.empty-p2')
    if (state.plugins.length === 0) {
      ico.textContent = '🧩'
      p1.textContent = '未安装任何插件'
      p2.textContent = '当前没有插件声明文件类型，素材库将不会显示任何文件。安装插件后，对应类型的素材即可被索引与浏览。'
    } else {
      ico.textContent = '📁'
      p1.textContent = '暂无素材'
      p2.textContent = '当前筛选条件下没有素材，试试调整目录或搜索词'
    }
  }

  renderGrid(grid)
  renderList(list)
}

/**
 * 取条目缩略图。
 * 缩略图靠文件名区分（`<素材名>.preview.png`），界面上不再额外标注。
 */
async function thumbFor(entry) {
  const t = await bridge.getThumbUrl(entry)
  return { url: t.url, ph: t.type !== 'image' }
}

// 分块渲染代号：新一轮 renderGrid/renderList 会让旧的分块循环立刻停手（防过期数据追加进新网格）
let _gridRenderSeq = 0
let _listRenderSeq = 0
const RENDER_CHUNK = 120 // 每帧最多新建的卡片/行数

/** 分块把 HTML 片段插入容器并逐块绑定事件，避免超大数据一次性 build 卡死渲染进程 */
function chunkAppend(container, items, htmlOf, bind) {
  if (!items.length) return
  const frag = document.createElement('div')
  const push = (list) => {
    frag.innerHTML = list.map(htmlOf).join('')
    const nodes = []
    while (frag.firstChild) {
      // 只收集元素节点：模板字符串前导空白会被解析成文本节点，不能绑事件
      if (frag.firstChild.nodeType === 1) nodes.push(frag.firstChild)
      container.appendChild(frag.firstChild)
    }
    bind(nodes)
  }
  if (items.length <= RENDER_CHUNK) {
    push(items)
    return
  }
  let i = 0
  const next = () => {
    const end = Math.min(i + RENDER_CHUNK, items.length)
    push(items.slice(i, end))
    i = end
    if (i < items.length) setTimeout(next, 0)
  }
  setTimeout(next, 0)
}

function renderGrid(grid) {
  const seq = ++_gridRenderSeq
  grid.innerHTML = ''
  // 非网格视图不建网格 DOM（历史版本即使列表视图也把整张网格建一遍，浪费且卡）
  if (state.viewMode !== 'grid' || !state.items.length) return
  const items = state.items
  const buildOne = (entry) => {
    const card = document.createElement('div')
    card.className = 'asset-card' + (state.selected.has(entry.path) ? ' selected' : '')
    card.dataset.path = entry.path
    const fav = entry.favorite ? '<span class="card-fav">★</span>' : ''
    const tags = (entry.tags || []).slice(0, 3).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')
    const kind = kindInfoOf(entry)
    card.innerHTML = `
      <div class="card-cover">
        <img class="thumb" alt="" />
        <div class="cover-kind">
          <span class="kind-ico">${kind.icon}</span>
        </div>
        ${typeBadgeHtml(extBadgeOf(entry), kind.color)}
      </div>
      <div class="card-body">
        <div class="card-name" title="${esc(entry.path)}">${esc(entry.name)}</div>
        <div class="card-sub">${fmtSize(entry.size)}</div>
        ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      </div>
      ${fav}
    `
    bindKindIconFallback(card)
    // 有缩略图 → 用图片盖住「类别图标」层；没有 → 保留类别图标
    thumbFor(entry).then((t) => {
      const img = card.querySelector('.thumb')
      if (!img || t.ph) return
      img.src = t.url
      const cover = card.querySelector('.card-cover')
      if (cover) cover.classList.add('has-img')
    })
    bindCardClick(card, entry)
    return card
  }

  // 小批量同步建完（保持既有时间线，避免 rAF 抖动）；大批量才分块渐进，
  // 大库（数千卡片）一次性同步建 DOM 会把渲染进程卡成「未响应」。
  if (items.length <= RENDER_CHUNK) {
    for (const entry of items) grid.appendChild(buildOne(entry))
    return
  }
  let i = 0
  const buildNext = () => {
    if (seq !== _gridRenderSeq) return // 已有更新的渲染请求 → 停手
    const end = Math.min(i + RENDER_CHUNK, items.length)
    for (; i < end; i++) grid.appendChild(buildOne(items[i]))
    if (i < items.length) setTimeout(buildNext, 0)
  }
  setTimeout(buildNext, 0)
}

function renderList(list) {
  const seq = ++_listRenderSeq
  if (state.viewMode !== 'list') return
  list.innerHTML = `<table>
    <thead><tr><th></th><th>名称</th><th>体积</th><th>修改时间</th><th>标签</th></tr></thead>
    <tbody></tbody></table>`
  const tbody = list.querySelector('tbody')
  const items = state.items
  const buildOne = (entry) => {
    const tr = document.createElement('tr')
    tr.dataset.path = entry.path
    tr.className = state.selected.has(entry.path) ? 'selected' : ''
    const tags = (entry.tags || []).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')
    const kind = kindInfoOf(entry)
    tr.innerHTML = `
      <td style="width:30px;text-align:center">${entry.favorite ? '★' : ''}</td>
      <td><div class="cell-name">
        <span class="mini-cover">
          <img class="mini-thumb" alt="" />
          <span class="cover-kind"><span class="kind-ico">${kind.icon}</span></span>
        </span>
        <span title="${esc(entry.path)}">${esc(entry.name)}</span>
      </div></td>
      <td>${fmtSize(entry.size)}</td>
      <td>${fmtTime(entry.mtime)}</td>
      <td>${tags || '-'}</td>
    `
    bindKindIconFallback(tr)
    // 与网格同一套规则：有缩略图用图片，没有则显示类别图标
    thumbFor(entry).then((t) => {
      const img = tr.querySelector('.mini-thumb')
      if (!img || t.ph) return
      img.src = t.url
      const cover = tr.querySelector('.mini-cover')
      if (cover) cover.classList.add('has-img')
    })
    tr.addEventListener('click', (e) => {
      handleSelect(e, entry)
    })
    tr.addEventListener('dblclick', () => runDblclick(entry))
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!state.selected.has(entry.path)) {
        state.selected.clear()
        state.selected.set(entry.path, entry)
        renderSelection()
      }
      showContextMenu(e.clientX, e.clientY, [...state.selected.values()])
    })
    return tr
  }

  // 小批量同步建完（保持既有时间线）；大批量分块渐进，避免大库列表卡死渲染进程
  if (items.length <= RENDER_CHUNK) {
    for (const entry of items) tbody.appendChild(buildOne(entry))
    return
  }
  let i = 0
  const buildNext = () => {
    if (seq !== _listRenderSeq) return // 已有更新的渲染请求 → 停手
    const end = Math.min(i + RENDER_CHUNK, items.length)
    for (; i < end; i++) tbody.appendChild(buildOne(items[i]))
    if (i < items.length) setTimeout(buildNext, 0)
  }
  setTimeout(buildNext, 0)
}

function bindCardClick(card, entry) {
  card.addEventListener('click', (e) => {
    if (e.target.closest('.tag-chip')) return
    handleSelect(e, entry)
  })
  card.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tag-chip')) return
    runDblclick(entry)
  })
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!state.selected.has(entry.path)) {
      state.selected.clear()
      state.selected.set(entry.path, entry)
      renderSelection()
    }
    showContextMenu(e.clientX, e.clientY, [...state.selected.values()])
  })
}

/**
 * 双击行为的分发。
 *
 * 优先级：设置页里用户为「该插件」设的覆盖 > 插件自己声明的 dblclick > 全局默认。
 * 主程序已把前两者合并成 plugin.dblclick（见 applyOverrides），
 * 界面拿到的就是最终值，null 表示都声明 → 用默认。
 *
 * 'preview' 在素材不支持预览时自动退化为「用系统程序打开」——
 * 否则用户双击一个没有 viewer 的素材会完全没反应，像是软件坏了。
 */
function runDblclick(entry) {
  const plugin = pluginOf(entry)
  const action = (plugin && plugin.dblclick) || DBLCLICK_DEFAULT
  if (action === 'none') return
  if (action === 'open') return openEntry(entry)
  // 'preview'
  if (plugin && plugin.canPreview) return previewEntry(entry)
  return openEntry(entry)
}

/* ── 右键菜单（含插件自定义操作） ────── */
let ctxMenuEl = null
function showContextMenu(x, y, entries) {
  hideContextMenu()
  const single = entries.length === 1 ? entries[0] : null
  const plugin = single ? pluginOf(single) : null

  // 插件 single 操作（针对该类型）
  const pluginActions = (plugin && plugin.actions || []).filter((a) => a.scope !== 'multi')
  // 插件 multi 操作（多选时）
  const pluginMulti = entries.length > 1
    ? [...new Set(entries.map((e) => pluginOf(e)).filter(Boolean).map((p) => p.id))]
        .flatMap((pid) => (state.plugins.find((p) => p.id === pid)?.actions || [])
          .filter((a) => a.scope === 'multi')
          .map((a) => ({ ...a, _pid: pid })))
    : []

  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.style.cssText = `position:fixed;left:${Math.min(x, innerWidth - 240)}px;top:${Math.min(y, innerHeight - 320)}px;z-index:200;
    background:#2c2f37;border:1px solid #454a54;border-radius:8px;min-width:200px;padding:4px;box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:12px`
  // 预览仅单选且插件声明 canPreview 时提供
  const canPreview = single && plugin && plugin.canPreview
  // 重建缩略图：仅单选、且插件声明支持生成缩略图（canThumbnail + 有 viewer）
  const canRebuild = single && plugin && plugin.canThumbnail && plugin.viewer
  /*
   * 「用作文件夹封面」：仅单选、且该素材**已有缩略图**时提供。
   *
   * 为什么要求已有缩略图：封面显示的就是缩略图，没有缩略图的素材设上去也没东西
   * 可显示（folderTree 那边同样要求 thumbPath，会直接回落自动规则）。
   * 与其让用户设一个"没反应"的封面，不如不给这个入口 ——
   * 想用某张图当封面，先用「重建缩略图」把它渲出来。
   *
   * 注意当前目录自己的节点在 chain 的**最后一项**，不在 folders 里
   * （folders 是子文件夹列表，永远不含自己）。
   */
  const curDir = state.activeDir || ''
  const curNode = (state.folder.chain || [])[(state.folder.chain || []).length - 1]
  // 记录可能是 `sub:xxx`（用子文件夹的封面），那种不算「当前素材是封面」
  const isCurCover = !!(single && curNode && !curNode.manualThumbIsSub && curNode.manualThumb === single.name)
  const canSetCover = !!(single && single.thumbPath && curDir)
  // 注意：这里**刻意不提供任何删除/修改素材的操作** —— 软件只被允许增删缩略图，
  // 素材文件本身只能由用户在文件管理器里处理。
  // 「预览」排在「打开」上面：它是本程序的主打操作，双击默认也走它。
  /*
   * 文案约定：所有右键菜单项都**不带前置图标**，且**一律精简到 2~4 个字** ——
   * 菜单宽度由最长的一项决定，长句会把菜单撑得很宽、扫视也慢。
   * 完整意思放进 title（悬停可见），需要解释的项（如封面）在 title 里说清楚。
   */
  menu.innerHTML = `
    ${canPreview ? `<div class="ctx-item" data-act="preview" title="用插件预览这个素材">预览</div>` : ''}
    <div class="ctx-item" data-act="open" title="用系统默认程序打开">打开</div>
    <div class="ctx-item" data-act="reveal" title="在文件管理器中显示（定位到这个文件）">定位</div>
    ${canRebuild ? `<div class="ctx-item" data-act="rebuild-thumb" title="删掉旧缩略图并重新生成">重建缩略图</div>` : ''}
    ${canSetCover ? (isCurCover
    ? `<div class="ctx-item" data-act="set-cover" title="取消后这个文件夹恢复为自动挑选封面">取消封面</div>`
    : `<div class="ctx-item" data-act="set-cover" title="把这个素材的缩略图作为所在文件夹的封面">设为封面</div>`) : ''}
    <div class="ctx-item" data-act="fav" title="${single?.favorite ? '取消收藏这个素材' : '收藏这个素材'}">${single?.favorite ? '取消收藏' : '收藏'}</div>
    ${(pluginActions.length || pluginMulti.length) ? `<div class="ctx-sep"></div>` : ''}
    ${pluginActions.map((a) => `<div class="ctx-item plugin-act" data-plugin="${esc(plugin.id)}" data-action="${esc(a.id)}">${esc(a.label)}</div>`).join('')}
    ${
  /*
   * 插件批量操作。标签由插件自己给（本程序不能替它精简），
   * 但「（批量）」这个后缀是本程序加的 —— 用「×N」代替，短得多且信息量更大
   * （直接说明会影响几个素材）。
   */
  pluginMulti.length
    ? `<div class="ctx-sep"></div>` + pluginMulti.map((a, i) =>
      `<div class="ctx-item plugin-multi" data-idx="${i}" title="${esc(a.label)}（对选中的 ${entries.length} 个素材执行）">${esc(a.label)} ×${entries.length}</div>`).join('')
    : ''}
  `
  // 动态绑定 pluginMulti 的 plugin 映射
  menu._pluginMulti = pluginMulti
  menu.addEventListener('click', async (e2) => {
    const item = e2.target.closest('.ctx-item')
    if (!item) return
    hideContextMenu()
    const act = item.dataset.act
    if (act === 'open') { single && openEntry(single) }
    else if (act === 'preview') { single && previewEntry(single) }
    else if (act === 'reveal') { entries.forEach((en) => bridge.revealFile(en.path)) }
    else if (act === 'rebuild-thumb') {
      // 重建缩略图：主进程负责删旧（移入回收站）+ 重新生成；进度条与刷新由事件驱动
      if (single) bridge.rebuildThumb(single.rootId, single.path).catch(() => {})
    }
    else if (act === 'set-cover') {
      /*
       * 用作/取消文件夹封面。
       *
       * 传的是**绝对路径** curDir + 素材名：主进程负责转相对路径并存盘
       * （键怎么拼的只有主进程知道，渲染层不掺和 —— 这个坑在排序上踩过一次）。
       * 素材名用 single.name（不是 path），与 folderThumb 的存储口径一致。
       */
      if (single) {
        const res = isCurCover
          ? await bridge.clearFolderThumb(single.rootId, curDir)
          : await bridge.setFolderThumb(single.rootId, curDir, single.name)
        if (res && res.ok === false && res.error) alert('设置封面失败: ' + res.error)
        await refreshAll() // 刷新后本目录与上级目录的封面一起更新
      }
    }
    else if (act === 'fav') { batchPatch({ favorite: single ? !single.favorite : false }) }
    else if (item.classList.contains('plugin-act')) {
      const res = await bridge.runPluginAction(item.dataset.plugin, item.dataset.action, entries.map((en) => en.path))
      if (res.message) alert(res.message)
      if (!res.ok && res.error) alert('操作失败: ' + res.error)
    } else if (item.classList.contains('plugin-multi')) {
      const a = menu._pluginMulti[+item.dataset.idx]
      const pid = a._pid
      const res = await bridge.runPluginAction(pid, a.id, entries.map((en) => en.path))
      if (res.message) alert(res.message)
      if (!res.ok && res.error) alert('操作失败: ' + res.error)
    }
  })
  document.body.appendChild(menu)
  ctxMenuEl = menu
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true })
  }, 0)
}

function hideContextMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null }
}

/* ── 右键菜单（文件夹）：基础操作 + 生成/清除缩略图（范围限该文件夹） ── */
/**
 * @param {number} x @param {number} y
 * @param {string} dirPath 文件夹绝对路径
 */
function showFolderContextMenu(x, y, dirPath) {
  hideContextMenu()
  const root = rootOfPath(dirPath)
  const scope = { rootId: root ? root.id : undefined, dir: dirPath }

  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.style.cssText = `position:fixed;left:${Math.min(x, innerWidth - 240)}px;top:${Math.min(y, innerHeight - 320)}px;z-index:200;
    background:#2c2f37;border:1px solid #454a54;border-radius:8px;min-width:200px;padding:4px;box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:12px`
  /*
   * 文案约定：不带前置图标，且**所有项一律 2~4 个字** ——
   * 菜单宽度由最长的一项决定，长句既撑宽菜单又拖慢扫视。
   * 完整含义统一放进 title（悬停可见）。
   *
   * 「生成缩略图 / 清除缩略图」压到「生成图 / 清除图」：
   * 上下文已由菜单本身限定（这是**文件夹**的右键菜单），title 里写明作用对象；
   * 「清除图」保留 danger 样式 + 独立的确认弹窗（会真的删文件，进回收站），
   * 不会误触。
   */
  menu.innerHTML = `
    <div class="ctx-item" data-act="open" title="用系统默认程序打开这个文件夹">打开</div>
    <div class="ctx-item" data-act="reveal" title="在文件管理器中显示这个文件夹">定位</div>
    <div class="ctx-item" data-act="scan" title="只扫描这个文件夹">扫描</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-act="thumb-gen" title="生成缩略图：给这个文件夹内所有可生成的素材生成缩略图">生成图</div>
    <div class="ctx-item danger" data-act="thumb-clear" title="清除缩略图：把这个文件夹内带 .preview. 命名的缩略图移入回收站（会弹出确认）">清除图</div>
  `  /*
   * 封面相关的两项按需出现（异步查一次）。
   *
   * 必须查主进程、不能从内存里读：这个菜单有三个来源（左侧目录树、
   * 网格里的文件夹卡片、面包屑），其中左侧目录树走的是 dir:tree 那条链路，
   * 数据里没有 manualThumb 字段。统一问主进程最省心，也顺带保证状态不过期。
   *
   *   • 「用作父级封面」—— 把**本文件夹当前显示的封面**拿去给父文件夹用。
   *     一个父目录下有多个子文件夹时，不用进去挑图，右键一下就换父级封面。
   *   • 「取消封面」—— 只在本目录确实手动设过时出现。
   *
   * 两项都精简到 4 个字（当前用的是谁，放进 title 说明）。
   */
  if (root) {
    bridge.getFolderThumb(root.id, dirPath).then((name) => {
      if (!menu.isConnected) return
      const anchor = menu.querySelector('[data-act="thumb-gen"]')
      if (name) {
        // 记录可能是 `sub:xxx`（用子文件夹的封面），显示时去掉前缀更好读
        const label = name.startsWith('sub:') ? `子文件夹 ${name.slice(4)}` : name
        const clear = document.createElement('div')
        clear.className = 'ctx-item'
        clear.dataset.act = 'clear-cover'
        clear.textContent = '取消封面'
        clear.title = `当前封面：${label}\n取消后该文件夹恢复为自动挑选封面`
        if (anchor) menu.insertBefore(clear, anchor)
        else menu.appendChild(clear)
      }
      // 根目录（素材库本身）没有父文件夹，不给这一项
      if (parentDirOf(dirPath)) {
        const use = document.createElement('div')
        use.className = 'ctx-item'
        use.dataset.act = 'use-as-parent-cover'
        use.textContent = '用作父级'
        use.title = '把本文件夹当前显示的封面，设为上一级文件夹的封面（父文件夹的封面）'
        if (anchor) menu.insertBefore(use, anchor)
        else menu.appendChild(use)
      }
    }).catch(() => {})
  }
  menu.addEventListener('click', async (e2) => {
    const item = e2.target.closest('.ctx-item')
    if (!item) return
    hideContextMenu()
    const act = item.dataset.act
    if (act === 'open') bridge.openFile(dirPath)
    else if (act === 'reveal') bridge.revealFile(dirPath)
    else if (act === 'scan') { if (root) bridge.scan(root.id, { rootId: root.id, path: dirPath }) }
    else if (act === 'thumb-gen') runGenerateThumbs(scope)
    else if (act === 'thumb-clear') runClearThumbs(scope, dirPath)
    else if (act === 'clear-cover') {
      if (!root) return
      const res = await bridge.clearFolderThumb(root.id, dirPath)
      if (res && res.ok === false && res.error) alert('取消失败: ' + res.error)
      else await refreshAll() // 父文件夹的封面会跟着变，一起刷新
    }
    else if (act === 'use-as-parent-cover') {
      if (!root) return
      const res = await bridge.useChildFolderThumb(root.id, dirPath)
      if (res && res.ok === false) alert('设置失败: ' + (res.error || '未知原因'))
      else await refreshAll()
    }
  })
  document.body.appendChild(menu)
  ctxMenuEl = menu
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true })
  }, 0)
}

/* ── 选中 / 打开 ─────────────────────── */
function handleSelect(e, entry) {
  if (e.ctrlKey || e.metaKey) {
    if (state.selected.has(entry.path)) state.selected.delete(entry.path)
    else state.selected.set(entry.path, entry)
  } else if (e.shiftKey && state.lastSelected) {
    const paths = state.items.map((i) => i.path)
    const a = paths.indexOf(state.lastSelected.path)
    const b = paths.indexOf(entry.path)
    const [lo, hi] = a < b ? [a, b] : [b, a]
    state.selected.clear()
    for (let i = lo; i <= hi; i++) state.selected.set(state.items[i].path, state.items[i])
  } else {
    state.selected.clear()
    state.selected.set(entry.path, entry)
  }
  state.lastSelected = entry
  state.detail = entry
  renderSelection()
  showDetail(entry)
  // 左侧目录栏同步定位到该素材所在目录（展开祖先 + 高亮 + 滚动可见）
  revealDirInTree(entry.dir)
}

function renderSelection() {
  $$('.asset-card.selected, .asset-list tr.selected').forEach((el) => el.classList.remove('selected'))
  state.selected.forEach((entry, path) => {
    const card = $(`.asset-card[data-path="${cssEsc(path)}"]`)
    if (card) card.classList.add('selected')
    const tr = $(`.asset-list tr[data-path="${cssEsc(path)}"]`)
    if (tr) tr.classList.add('selected')
  })
  const n = state.selected.size
  const bar = $('#bulk-bar')
  if (n > 1) {
    bar.classList.remove('hidden')
    $('#bulk-count').textContent = `已选 ${n} 项`
  } else if (n === 1) {
    bar.classList.add('hidden')
  } else {
    bar.classList.add('hidden')
  }
}

function cssEsc(s) {
  return s.replace(/["\\]/g, '\\$&')
}

/* ── 导航 / 详情面板开关 ───────────────── */

/**
 * 详情栏的占位内容（未选中素材时显示）。
 *
 * 为什么要有占位：详情栏现在是**常驻**的 —— 它在布局里始终占着宽度，
 * 开关只切换内容、不切换宽度。这样左侧素材区的可用宽度是恒定的，
 * 点选素材时不会因为右侧突然多出 280px 而整体重排、卡片跳位。
 *
 * 内容本身不承载功能，只说明"这里是什么、怎么用"，
 * 免得整块空白让人以为界面坏了。
 */
function renderDetailPlaceholder() {
  const box = $('#detail-content')
  if (!box) return
  box.innerHTML = `
    <div class="detail-placeholder">
      <div class="detail-placeholder-ico">🗂</div>
      <div class="detail-placeholder-title">未选择素材</div>
      <div class="detail-placeholder-hint">点击左侧任意素材查看详情</div>
      <div class="detail-placeholder-hint">可在此查看缩略图、标签、备注与插件字段</div>
      <div class="detail-placeholder-keys">
        <span><kbd>Esc</kbd> 取消选择</span>
        <span><kbd>双击</kbd> 按插件声明执行</span>
      </div>
    </div>`
}

/** 关闭详情面板（切换目录、切换视图、搜索时调用，避免残留上一个目录的条目） */
function closeDetail() {
  state.detail = null
  // 详情栏**不再隐藏**，只清空内容回到占位态 —— 隐藏会让左侧布局变宽
  renderDetailPlaceholder()
}

/**
 * 统一的「进入某目录」入口：目录树 / 面包屑 / 文件夹卡片都走这里，
 * 保证选中态、详情栏、展开态三者一致。
 * @param {string|null} dirPath 目录绝对路径；null = 素材库根
 */
/**
 * 导航到某目录（文件夹视图里点击文件夹卡片/行，或面包屑跳转）。
 *
 * ── 为什么要「吞掉导航后的下一次点击」────────────────────────
 * 用户双击文件夹卡片时会出事：第一下 click 触发本函数 → 异步 refreshAll()
 * 重建整个列表 → **同一屏幕坐标**下的元素从「文件夹卡片」变成了「素材卡片」，
 * 于是双击的第二下按坐标派发时打在素材卡上 → 直接把那个素材打开了。
 * 这是典型的点击穿透（click-through），用户看到的现象是
 * 「在上一级双击文件夹，第一下进文件夹，第二下打开了里面的素材」。
 *
 * 注意不能靠 `e.preventDefault()` 或给文件夹绑 dblclick 来解决 ——
 * 第二次点击的目标元素在事件派发时**已经是新元素**了，与文件夹毫无关系，
 * 所以只能在「导航刚发生」这个时间窗内，于**捕获阶段**把落到列表区域的
 * 点击拦下来。窗口取 350ms：比双击判定间隔（系统默认 500ms 内）短，
 * 又比 refreshAll 的耗时（本地通常 < 100ms）长，够覆盖重渲染的那一下。
 */
let clickShieldUntil = 0

/**
 * 清掉页面上残留的文字选中。
 *
 * 为什么必须有这个：双击的**浏览器默认行为是选中一个词**，
 * 而后紧接着的重渲染会把带选中的那些节点换掉。选中锚点还指着旧节点，
 * Chromium 会顺着新内容把选中范围**一路扩大** ——
 * 用户看到的就是"双击一下，整页文字全变蓝了"。
 * 光靠 CSS 的 user-select 挡不住所有位置（比如嵌在卡片里的文字），
 * 所以导航前统一清一次，保证无论选中从哪来都不会带进新页面。
 */
function clearTextSelection() {
  try {
    const s = window.getSelection()
    if (s && s.rangeCount > 0 && !s.isCollapsed) s.removeAllRanges()
  } catch {
    /* 某些环境下 getSelection 不可用，忽略即可 —— 清选中失败不影响导航 */
  }
}

function navigateTo(dirPath) {
  state.activeDir = dirPath || null
  state.selected.clear()
  closeDetail()
  // 清选中要放在重渲染**之前**，否则扩大的选中范围会跟着新内容渲染出来
  clearTextSelection()
  /*
   * 展开状态改成"独占"：导航到哪，树就只展开到哪。
   * 原来这里是 `expandedPaths.add(activeDir)` —— 只增不减，
   * 于是逛过几个分支后整棵树被撑开一大片，当前位置反而不显眼。
   * 这里清空重设，其它目录一并收起（根目录导航时传 null → 只剩根那条链）。
   */
  expandAncestors(state.activeDir || null, { exclusive: true })
  // 开盾：接下来这一小段时间内，落在素材列表区域的点击一律丢弃
  clickShieldUntil = Date.now() + 350
  ensureBrowseVisible()
  refreshAll()
}

/**
 * 拦截导航后短时间内落在列表区域的点击（捕获阶段，早于卡片自己的监听器）。
 * 只拦「列表/网格容器内的鼠标点击」，不影响拖拽、右键、键盘等其它交互。
 */
function installClickShield() {
  const swallow = (e) => {
    if (Date.now() > clickShieldUntil) return
    if (!e.isTrusted) return // 只拦真实鼠标；程序化点击（测试/内部调用）不受影响
    const t = e.target
    if (!t || typeof t.closest !== 'function') return
    // 只有落在素材卡片 / 列表行上的才算「穿透受害者」，其它地方（如顶栏、侧栏）放行
    if (!t.closest('.asset-card') && !t.closest('.asset-list tr')) return
    e.stopPropagation()
    e.preventDefault()
  }
  // 捕获阶段：必须比卡片自身的 click / dblclick 更早拿到事件
  document.addEventListener('click', swallow, true)
  document.addEventListener('dblclick', swallow, true)
}

/**
 * 在空白位置双击 → 返回上一级目录。
 *
 * ── 边界处理（这些才是这个功能的主要难点）────────────────────
 * ① 已在素材库根目录 → 无处可去，直接不动（不跳到库外）
 * ② 上一级越过库根 → 同样视为到顶。用「父目录是否还在库内」判断，
 *    而不是比字符串长度，避免 `C:\lib` 与 `C:\library` 这类前缀误判
 * ③ 搜索/收藏视图 → 没有"当前目录"的概念，不响应
 * ④ 双击必须落在**真正的空白处**：卡片、文件夹、面包屑、按钮、
 *    输入框上都算"有内容"，不能触发返回
 *
 * 用 dblclick 而不是 click：单击空白处目前**没有绑定任何行为**（不会取消选中，
 * 取消选中只能靠点别的卡片或按 Esc），所以单击是块"空地"——
 * 保留给它，将来想加「单击空白取消选中」之类的操作还有位置；
 * 而双击是个明确、不易误触的手势，适合承载"返回上一级"这种会改变视图的动作。
 */
function goUpOneLevel() {
  // 搜索/收藏是跨目录的结果集，没有"上一级"可言
  if (state.activeView !== 'all' || state.search) return false
  if (!state.activeRootId) return false

  const cur = state.activeDir
  if (!cur) return false // 已经在库根，到顶了

  const root = state.roots.find((r) => r.id === state.activeRootId)
  if (!root) return false

  const sep = cur.includes('\\') ? '\\' : '/'
  const normRoot = String(root.path).replace(/[\\/]+$/, '')
  const normCur = cur.replace(/[\\/]+$/, '')

  // 当前目录必须在库内，否则状态异常，别乱跳
  if (normCur !== normRoot && !normCur.startsWith(normRoot + '\\') && !normCur.startsWith(normRoot + '/')) {
    return false
  }

  const i = normCur.lastIndexOf(sep)
  if (i <= 0) return false
  const parent = normCur.slice(0, i)

  /*
   * 父目录若比库根还浅（或等于库根的上一层）→ 视为到顶，回到库根。
   * 用 path.relative 式的判断而不是纯 startsWith：必须确保父目录
   * 就是库根本身、或是库根的真子孙，才允许跳过去。
   */
  const insideRoot = parent === normRoot ||
    parent.startsWith(normRoot + '\\') ||
    parent.startsWith(normRoot + '/')
  navigateTo(insideRoot ? parent : null)
  return true
}

/**
 * 绑定「空白处双击返回上一级」。
 *
 * 判定"空白"用 `closest()` 白名单：只要双击点落在任何一个有内容的容器里
 * 就不算空白。这比"判断是否等于某个容器元素本身"稳得多 ——
 * 网格里有大量内边距和间隙，点在 padding 上时 target 就是容器本身，
 * 而点在卡片边缘时 target 是卡片的子元素。
 */
function installBlankAreaDblclick() {
  // 这些容器内的双击都算"点在内容上"
  const CONTENT_SELECTOR = [
    '.asset-card',
    '.asset-list tbody tr',
    '.folder-card',
    '.folder-row',
    '.breadcrumb',
    '.section-label',
    'button',
    'a',
    'input',
    'select',
    'textarea',
    '.ctx-menu',
    '.task-bar',
    '.bulk-bar',
  ].join(', ')

  const onDblclick = (e) => {
    if (!e.isTrusted) return // 程序化双击（测试/内部）不接管
    if (e.button !== 0) return // 只认左键
    const t = e.target
    if (!t || typeof t.closest !== 'function') return
    if (t.closest(CONTENT_SELECTOR)) return // 点在内容上 → 不是空白
    // 只在浏览器区域生效（设置页、详情栏里双击空白不该触发导航）
    if (!t.closest('#browse-view')) return
    if (state.settingsOpen) return
    goUpOneLevel()
  }
  document.addEventListener('dblclick', onDblclick)
}

/**
 * 算出从素材库根到某目录的路径链（含根与目标自身），**不修改任何状态**。
 *
 * 单独抽出来是因为有两处需要它：一处要顺手写进展开状态（expandAncestors），
 * 一处只想拿来算"哪些路径该保持展开"（updateTreeHighlights）。
 * 混在一起写会变成"为了知道链上有谁，被迫改了状态"。
 *
 * 关于用哪个库：**不能只认 activeRootId**。目录树会同时渲染多个已启用的库，
 * 用户点的那一行可能属于另一个库（那个库的根在树里也列着）。
 * 所以遍历所有已启用库，找出真正包含该路径的那个 ——
 * 只认活动库会导致"点别的库里的目录，链算不出来 → 树里不展开"。
 * 优先匹配活动库，其次匹配路径最长的（最具体的）库，避免嵌套库选错。
 *
 * @param {string} absDir 目标目录绝对路径
 * @returns {string[]} 根 → 目标的路径链；不在任何库内或参数为空时返回 []
 */
function expandChainPaths(absDir) {
  if (!absDir) return []
  const sepOf = (p) => (String(p).includes('\\') ? '\\' : '/')
  const norm = (p) => String(p).replace(/[\\/]+$/, '')
  const target = norm(absDir)

  // 找出所有「包住」该路径的已启用库，选最具体的那个
  const owning = state.roots
    .filter((r) => r.enabled !== false)
    .map((r) => ({ root: r, base: norm(r.path) }))
    .filter(({ base }) => target === base ||
      target.startsWith(base + '\\') || target.startsWith(base + '/'))
    .sort((a, b) => b.base.length - a.base.length)
  if (!owning.length) return []

  const own = owning.find((o) => o.root.id === state.activeRootId) || owning[0]
  const sep = sepOf(own.root.path)
  const chain = []
  let cur = target
  while (cur && (cur === own.base || cur.startsWith(own.base + '\\') || cur.startsWith(own.base + '/'))) {
    chain.unshift(cur)
    if (cur === own.base) break
    const i = cur.lastIndexOf(sep)
    if (i <= 0) break
    cur = cur.slice(0, i)
  }
  return chain
}

/**
 * 展开某目录在目录树上的全部祖先（含自身），供定位/跳转使用。
 *
 * ── exclusive = true：**独占展开**（跳转定位时用）────────────────
 * 把展开状态重置成"只有这一条链"，其余目录全部收起。
 *
 * 为什么跳转要独占：跳转是"我现在要去这里"，不是"再多展开一处"。
 * 累积展开的话，连续点几个不同分支的素材后，树会被撑成一大片，
 * 真正当前位置反而淹没在里面 —— 这正是不好用来源。
 *
 * 手动点箭头展开（exclusive = false）则照旧只增不减：
 * 用户主动展开是"我想看看这里有什么"，不该被下一次跳转之外的操作清掉；
 * 但下一次**跳转**仍会把它收起来 —— 因为跳转表达的是"我换地方了"。
 *
 * @param {string} absDir 目标目录绝对路径
 * @param {{exclusive?: boolean}} [opts] exclusive：是否重置为只展开这一条链
 * @returns {string[]} 从根到目标的路径链（含根、含目标自身）
 */
function expandAncestors(absDir, opts = {}) {
  const chain = expandChainPaths(absDir)
  if (opts.exclusive) {
    // 先清空再放入这一条链 —— 其它分支的展开状态就此收起
    state.expandedPaths.clear()
  }
  for (const dir of chain) state.expandedPaths.add(dir)
  return chain
}

/**
 * 收起目录树上所有展开的目录，只保留给定路径链（含根与目标自身）。
 *
 * 为什么不只改 state：`updateTreeHighlights` / `revealDirInTree` 是**纯 DOM 操作**，
 * 有些展开只体现在 DOM（比如根行总被强制展开）。所以除了重置 state，
 * 还要把 DOM 上多出来的展开一并收掉，两边保持同步。
 *
 * @param {HTMLElement} box 目录树容器
 * @param {string[]} keepChain 需要保持展开的路径
 */
function collapseTreeExcept(box, keepChain) {
  if (!box) return
  const keep = new Set(keepChain || [])
  for (const row of box.querySelectorAll('.dir-row')) {
    const p = row.dataset.path
    if (!p || keep.has(p)) continue
    row.querySelector('.dir-arrow')?.classList.remove('open')
    const kids = row.parentElement.querySelector(':scope > .dir-children')
    if (kids) kids.style.display = 'none'
  }
}

/**
 * 在左侧目录树中定位到某目录：**只展开这一条链** + 高亮 + 滚动到可见区域。
 *
 * 纯 DOM 操作（不重建树），因此可以在每次点击素材时安全调用。
 * 展开采用独占模式：定位到哪，树就只展开到哪，其它分支收起 ——
 * 避免连续浏览后整棵树被撑开一大片、当前位置反而找不到。
 */
function revealDirInTree(absDir) {
  const box = $('#dir-tree')
  if (!box || !absDir || !state.dirTree) return
  const chain = expandAncestors(absDir, { exclusive: true })
  // 先把不在链上的展开全部收起，再展开链上的（顺序反了会把刚展开的又收掉）
  collapseTreeExcept(box, chain)
  for (const dir of chain) {
    const row = box.querySelector(`.dir-row[data-path="${cssEsc(dir)}"]`)
    if (!row) continue
    row.querySelector('.dir-arrow')?.classList.add('open')
    const kids = row.parentElement.querySelector(':scope > .dir-children')
    if (kids) kids.style.display = 'block'
  }
  box.querySelectorAll('.dir-row.active').forEach((r) => r.classList.remove('active'))
  const target = box.querySelector(`.dir-row[data-path="${cssEsc(absDir)}"]`)
  if (target) {
    target.classList.add('active')
    // 定位到目录树可视区**中间**（滚动只发生在 #dir-tree 内部，上方「目录」标题不动）
    target.scrollIntoView({ block: 'center' })
  }
}

/** 打开：系统默认应用打开（所有素材都支持） */
async function openEntry(entry) {
  await bridge.openFile(entry.path)
}

/** 预览：内置预览宿主（仅插件声明 canPreview 时可用） */
async function previewEntry(entry) {
  const p = pluginOf(entry)
  if (!p || !p.canPreview) {
    alert('该素材类型未启用预览能力（插件未声明 canPreview）')
    return
  }
  await bridge.previewFile(entry)
}

/* ── 详情面板 ─────────────────────────── */
function pluginOf(entry) {
  if (!entry || !state.plugins) return null
  if (entry.pluginId) return state.plugins.find((p) => p.id === entry.pluginId) || null
  const ext = (entry.path.match(/\.[^.]+$/) || [''])[0].toLowerCase()
  return state.plugins.find((p) => p.exts.includes(ext)) || null
}

async function showDetail(entry) {
  const panel = $('#detail-panel')
  const box = $('#detail-content')
  // 详情栏常驻（布局里始终占位），选中素材只换内容、不动宽度
  panel.classList.remove('hidden')
  const t = await thumbFor(entry)
  const plugin = pluginOf(entry)
  const tags = (entry.tags || []).map((tag) =>
    `<span class="tag-edit-chip">${esc(tag)}<span class="x" data-tag="${esc(tag)}">×</span></span>`
  ).join('')

  // 插件 detail 声明字段 → 通用键值（值来自条目或 parse 元数据）
  //
  // 字段形态由 type 决定：
  //   • 普通（text/color/badge）    —— 一行一键值，值右对齐
  //   • long                       —— 独占一行、左对齐、保留原文换行、超高可滚动
  //   • long + style.button        —— 与 long 相同，并在正文下方挂一个按钮，
  //                                   点它把完整内容弹出来（正文只显示摘要）
  //                                   按钮 id 即 detail.buttons 里声明的那个
  let pluginFields = ''
  if (plugin && plugin.detailFields > 0) {
    const detail = plugin.detail // detailDef 需从主进程透传
    const meta = entry.meta || {}
    const fieldRows = (detail && detail.fields ? detail.fields : []).map((f) => {
      let value = meta[f.key]
      if (value === undefined) value = entry[f.key]
      if (value === undefined) return ''
      const isLong = f.type === 'long' || (f.style && f.style.block)
      if (f.type === 'color') value = `<span class="color-swatch" style="background:${esc(value)}"></span>`
      else value = esc(value)
      if (!isLong) {
        return `<div class="field-row"><span class="k">${esc(f.label)}</span><span class="v">${value}</span></div>`
      }
      // 长文本：标题一行，正文一段（white-space:pre-wrap 让原文换行生效）
      const rows = f.style && Number(f.style.rows) > 0 ? Number(f.style.rows) : 0
      const style = rows ? ` style="max-height:${rows * 1.5}em"` : ''
      // style.button = 同名字段正文下方挂按钮，用于「只显示一部分 + 查看完整」
      const btn = f.style && typeof f.style.button === 'string' && f.style.button
        ? `<button class="btn small plugin-btn" data-plugin-btn="${esc(f.style.button)}">查看完整</button>`
        : ''
      return `<div class="field-block"><div class="k">${esc(f.label)}</div>`
        + `<div class="v long"${style}>${value}</div>${btn}</div>`
    }).filter(Boolean).join('')
    pluginFields = fieldRows
  }

  // 插件 parse 元数据（未在 detail.fields 中列出的）→ 通用键值展示
  let metaRows = ''
  if (plugin && entry.meta && typeof entry.meta === 'object') {
    const declared = new Set((plugin.detail && plugin.detail.fields || []).map((f) => f.key))
    metaRows = Object.entries(entry.meta)
      .filter(([k]) => !declared.has(k))
      .map(([k, v]) => {
        if (v === null || v === undefined) return ''
        if (typeof v === 'object') v = JSON.stringify(v)
        return `<div class="field-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`
      }).filter(Boolean).join('')
  }

  const previewBtn = plugin && plugin.canPreview
    ? '<button class="btn small" id="detail-preview" title="使用内置预览窗口">👁 预览</button>'
    : ''

  // 详情页封面：与网格卡片同一套规则 —— 有缩略图用图片，没有则显示类别图标
  // （插件 manifest.icon 优先，未指定回退主程序默认占位图标；不再是旧的扩展名占位图）
  const kind = kindInfoOf(entry)

  box.innerHTML = `
    <div class="detail-cover${t.ph ? '' : ' has-img'}">
      <img class="detail-thumb" alt=""${t.ph ? '' : ` src="${t.url}"`} />
      <div class="cover-kind"><span class="kind-ico">${kind.icon}</span></div>
    </div>
    <div class="detail-title">${esc(entry.name)}</div>
    <div class="detail-dir">${esc(entry.dir)}</div>
    <div class="detail-actions">
      <button class="btn small detail-fav ${entry.favorite ? 'on' : ''}">${entry.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
      ${previewBtn}
      <button class="btn small" id="detail-open" title="使用系统默认应用打开">打开</button>
      <button class="btn small" id="detail-reveal">所在目录</button>
    </div>
    <div class="detail-fields">
      <div class="field-row"><span class="k">大小</span><span class="v">${fmtSize(entry.size)}</span></div>
      <div class="field-row"><span class="k">修改时间</span><span class="v">${fmtTime(entry.mtime)}</span></div>
      ${entry.kind ? `<div class="field-row"><span class="k">类别</span><span class="v">${esc(entry.kind)}</span></div>` : ''}
      ${plugin ? `<div class="field-row"><span class="k">类型插件</span><span class="v">${esc(plugin.name)}</span></div>` : ''}
      ${pluginFields}
      ${metaRows}
    </div>
    <div class="detail-tags">
      <div style="color:var(--text-dim);font-size:11px">标签</div>
      <div class="tags-edit">${tags || '<span class="muted small">暂无标签</span>'}</div>
      <div class="tag-input-row">
        <input type="text" id="tag-input" placeholder="输入标签后回车" />
        <button class="btn small" id="tag-add">添加</button>
      </div>
    </div>
    <div class="detail-note">
      <div style="color:var(--text-dim);font-size:11px">备注</div>
      <textarea id="note-input" placeholder="写点备注…">${esc(entry.note || '')}</textarea>
    </div>
    ${isImageExt(entry.path) ? `<div class="preview-box"><img src="asset://file/${encodeURIComponent(entry.path)}" alt="preview" /></div>` : ''}
  `
  bindKindIconFallback(box)
  bindDetailEvents(entry)
}

function isImageExt(p) {
  return /\.(png|jpe?g|gif|bmp|webp)$/i.test(p)
}

function bindDetailEvents(entry) {
  $('#detail-open')?.addEventListener('click', () => openEntry(entry))
  $('#detail-preview')?.addEventListener('click', () => previewEntry(entry))
  $('#detail-reveal')?.addEventListener('click', () => bridge.revealFile(entry.path))
  // 插件详情栏按钮
  document.querySelectorAll('.plugin-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.pluginBtn
      const pid = entry.pluginId || (pluginOf(entry) || {}).id
      if (pid && id) runPluginButton(pid, id, entry, btn)
    })
  })
  $('.detail-fav')?.addEventListener('click', async () => {
    const v = !entry.favorite
    entry.favorite = v
    await bridge.patchAsset(entry.rootId, entry.path, { favorite: v })
    await refreshAll() // 收藏计数即时 ±1（含统计）
    showDetail(entry)
  })
  $('#tag-add')?.addEventListener('click', () => addTagFromInput(entry))
  $('#tag-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTagFromInput(entry)
  })
  $$('#detail-content .tag-edit-chip .x').forEach((el) => {
    el.addEventListener('click', async () => {
      const tag = el.dataset.tag
      const tags = (entry.tags || []).filter((t) => t !== tag)
      entry.tags = tags
      await bridge.patchAsset(entry.rootId, entry.path, { tags })
      await refreshAll()
      showDetail(entry)
    })
  })
  $('#note-input')?.addEventListener('change', async (e) => {
    entry.note = e.target.value
    await bridge.patchAsset(entry.rootId, entry.path, { note: entry.note })
    await refreshAll()
  })
}

async function addTagFromInput(entry) {
  const input = $('#tag-input')
  const v = (input.value || '').trim()
  if (!v) return
  const tags = [...new Set([...(entry.tags || []), v])]
  entry.tags = tags
  input.value = ''
  await bridge.patchAsset(entry.rootId, entry.path, { tags })
  await refreshAll()
  showDetail(entry)
}

/* ── 快速视图切换 ─────────────────────── */
function renderQuickViews() {
  $$('.qv-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === state.activeView)
  })
}

/* ── 批量操作 ─────────────────────────── */
async function batchPatch(patch) {
  const byRoot = new Map()
  state.selected.forEach((entry) => {
    if (!byRoot.has(entry.rootId)) byRoot.set(entry.rootId, [])
    byRoot.get(entry.rootId).push(entry.path)
  })
  for (const [rootId, paths] of byRoot) {
    await bridge.batchPatch(rootId, paths, patch)
  }
  await refreshAll()
}

/* ── 模态框 ───────────────────────────── */
function openModal(html, { onMount } = {}) {
  // 打开弹窗前收起可能残留的右键菜单/下拉，避免其盖住弹窗输入框（z-index 比弹窗低也不行，双保险）
  hideContextMenu()
  const root = $('#modal-root')
  root.innerHTML = `<div class="modal-mask">
    <div class="modal">
      <div class="modal-header"><h2></h2><span class="modal-close">✕</span></div>
      <div class="modal-body"></div>
      <div class="modal-footer"></div>
    </div>
  </div>`
  const mask = root.querySelector('.modal-mask')
  const close = () => { root.innerHTML = '' }
  mask.addEventListener('click', (e) => { if (e.target === mask) close() })
  root.querySelector('.modal-close').addEventListener('click', close)
  return { root, mask, close, body: root.querySelector('.modal-body'), footer: root.querySelector('.modal-footer') }
}

/**
 * 长文本弹窗：把插件返回的整段文字按原文排版展示。
 *
 * 详情栏宽度有限、值又是右对齐，几百字的条款挤进去没法读；
 * 这里用弹窗 + `white-space: pre-wrap` 保留原始换行与缩进。
 */
function showTextModal({ title, text }) {
  const m = openModal()
  m.body.innerHTML = '<pre class="text-block"></pre>'
  // 用 textContent 赋值：原文可能含 & < >，不能拼进 HTML
  m.body.querySelector('.text-block').textContent = text
  m.root.querySelector('.modal-header h2').textContent = title || '完整内容'
  m.root.querySelector('.modal').classList.add('modal-wide')
  m.footer.innerHTML = '<button class="btn" id="text-modal-close">关闭</button>'
  m.footer.querySelector('#text-modal-close').addEventListener('click', m.close)
  return m
}

/**
 * 执行插件详情栏按钮。
 *
 * 返回值约定（见 docs 第 6 节）：
 *   • 字符串          → 长文本弹窗
 *   • { title, text } → 带标题的长文本弹窗
 *   • 其它            → 只提示完成
 */
async function runPluginButton(pluginId, buttonId, entry, btnEl) {
  if (btnEl) btnEl.disabled = true
  try {
    const res = await bridge.runPluginButton(pluginId, buttonId, entry.rootId, entry.path)
    if (!res || !res.ok) {
      alert('执行失败：' + ((res && res.error) || '未知错误'))
      return
    }
    const r = res.result
    if (typeof r === 'string' && r) {
      showTextModal({ title: entry.name, text: r })
    } else if (r && typeof r === 'object' && typeof r.text === 'string') {
      showTextModal({ title: r.title || entry.name, text: r.text })
    } else if (r !== undefined && r !== null && r !== '') {
      showTextModal({ title: entry.name, text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) })
    }
  } catch (err) {
    alert('执行失败：' + (err && err.message ? err.message : err))
  } finally {
    if (btnEl) btnEl.disabled = false
  }
}

/* ── 设置页面（独立页，非弹窗） ─────────── */
async function openSettings() {
  const settings = await bridge.getSettings()
  state.settingsOpen = true
  // 进度条在顶栏下方、主界面上方，不会被设置页覆盖，无需隐藏（仍可观察/停止任务）
  // 隐藏详情面板，设置页覆盖整个内容区
  $('#detail-panel').classList.add('hidden')
  // 切换主内容区到设置页
  $('#browse-view').classList.add('hidden')
  $('#settings-view').classList.remove('hidden')

  const body = $('#settings-page-body')
  const thumbSizes = settings.thumbSizes || [128, 256, 512, 1024, 2048]
  const curThumbSize = Number(settings.thumbSize) || 256
  body.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">通用</div>
      <div class="form-row"><label>扫描并发</label>
        <input type="number" id="set-concurrency" min="1" max="16" value="${settings.scanConcurrency}" />
      </div>
      <div class="form-row"><label>缩略图尺寸</label>
        <select id="set-thumb-size" style="flex:1;max-width:180px">
          ${thumbSizes.map((s) => `<option value="${s}" ${curThumbSize === s ? 'selected' : ''}>${s} × ${s}</option>`).join('')}
        </select>
        <span class="muted small">生成缩略图时使用的渲染分辨率</span>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">素材库管理</div>
      <div id="settings-roots"></div>
      <button class="btn small" id="settings-add-root" style="margin-top:8px">＋ 添加素材库</button>
    </div>
    <div class="settings-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span class="settings-section-title" style="margin:0">插件管理</span>
        <div style="display:flex;gap:6px">
          <button class="btn small" id="settings-create-plugin" title="新建一个只声明文件类型的最小插件（无缩略图/预览能力）">＋ 新建插件</button>
          <button class="btn small primary" id="settings-install-plugin">＋ 安装插件</button>
        </div>
      </div>
      <div id="settings-plugins"></div>
    </div>
  `
  // 保存按钮在页面头部（HTML 静态存在）
  const saveBtn = $('#settings-save-btn')
  const backBtn = $('#settings-back-btn')
  if (saveBtn) saveBtn.classList.remove('hidden')
  if (backBtn) backBtn.classList.remove('hidden')

  const rootsBox = body.querySelector('#settings-roots')
  const renderRootItems = () => {
    rootsBox.innerHTML = state.roots.map((r) => `
      <div class="root-manage-item">
        <label class="switch">
          <input type="checkbox" data-root="${r.id}" ${r.enabled ? 'checked' : ''} />
          <span class="track"></span>
        </label>
        <div class="info">
          <div class="rname">${esc(r.name)}</div>
          <div class="rpath">${esc(r.path)}</div>
        </div>
        <button class="btn small danger" data-remove="${r.id}">移除</button>
      </div>
    `).join('')
    rootsBox.querySelectorAll('[data-root]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        await bridge.setRootEnabled(cb.dataset.root, cb.checked)
        state.roots = await bridge.listRoots()
        // 停用后该库素材立即消失（列表+统计+目录树）
        await refreshAll()
        if (!cb.checked && state.activeRootId === cb.dataset.root) {
          state.activeRootId = state.roots.find((r) => r.enabled)?.id || null
          state.activeDir = null
          await refreshAll()
        }
      })
    })
    rootsBox.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`确定移除素材库「${state.roots.find((r) => r.id === btn.dataset.remove)?.name}」？\n仅移除索引，不会删除磁盘文件。`)) return
        await bridge.removeRoot(btn.dataset.remove)
        state.roots = await bridge.listRoots()
        if (state.activeRootId === btn.dataset.remove) { state.activeRootId = null; state.activeDir = null }
        renderRoots()
        renderRootItems()
        await refreshAll()
      })
    })
  }
  renderRootItems()

  // ── 插件管理 ──────────────────────────────
  const pluginsBox = body.querySelector('#settings-plugins')
  /** 「加载失败」提示块：插件为何没出现在下面的列表里（以前只写控制台，界面完全看不到） */
  const renderLoadErrors = () => {
    const errs = state.pluginLoadErrors || []
    if (!errs.length) return ''
    return `
      <div style="margin-bottom:10px;padding:10px 12px;border:1px solid #b45309;border-radius:8px;background:rgba(180,83,9,.12)">
        <div style="font-size:12px;font-weight:600;color:#f59e0b;margin-bottom:4px">⚠ ${errs.length} 个插件未能加载</div>
        ${errs.map((e) => `
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px">
            <span style="color:var(--text)">plugins/${esc(e.dir)}</span> —— ${esc(e.error)}
          </div>`).join('')}
        <div style="font-size:11px;color:var(--text-dim);margin-top:6px">
          清单需写成平铺对象字面量形式：<code>module.exports = { id: '插件名', name: '显示名', exts: ['.abc'] }</code>，且 <code>id</code> 要是字符串字面量。修正 <code>index.cjs</code> 后重启软件即可。
        </div>
      </div>`
  }
  const renderPlugins = () => {
    const plugins = state.plugins
    const errHtml = renderLoadErrors()
    if (!plugins.length) {
      pluginsBox.innerHTML = errHtml + `
        <div style="padding:14px;border:1px dashed var(--border);border-radius:8px;text-align:center;color:var(--text-dim);font-size:12px">
          🧩 未安装任何插件<br/>
          <span style="font-size:11px">当前没有插件声明文件类型，素材库不会显示任何文件。点击「安装插件」选择插件 zip 压缩包（内含 index.cjs）。</span>
        </div>`
      return
    }
    pluginsBox.innerHTML = errHtml + plugins.map((p) => `
      <div class="root-manage-item" style="align-items:flex-start">
        <label class="switch">
          <input type="checkbox" data-plugin-enabled="${esc(p.id)}" ${p.enabled ? 'checked' : ''} />
          <span class="track"></span>
        </label>
        <div class="info">
          <div class="rname">${esc(p.name)} ${p.version ? `<span style="font-size:10px;color:var(--text-dim)">v${esc(p.version)}</span>` : ''}
            ${p.simple ? '<span class="plugin-flag" title="由本软件「新建插件」生成：只声明文件类型，可在插件设置里增删支持的类型">简易插件</span>' : ''}</div>
          <div class="rpath">${esc(p.description || (p.exts || []).join(' / '))}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
            ${(p.exts || []).slice(0, 6).map((e) => `<span class="tag-chip">${esc(e)}</span>`).join('')}
          </div>
          <div style="margin-top:5px;font-size:11px;color:var(--text-dim)">
            ${p.kind ? `<span style="color:${esc(p.kind.color || '#8a8f98')}">● ${esc(p.kind.label || p.kind.key)}</span> · ` : ''}
            🖼 缩略图 ·
            ${p.canPreview ? '👁 实时预览' : '◻ 系统打开'} ·
            ${p.actionCount ? `⚡ ${p.actionCount} 个操作` : '无自定义操作'}
            ${p.detailFields ? ` · 📋 ${p.detailFields} 个详情字段` : ''}
          </div>
          ${(() => {
            /*
             * 内联设置区只在**确实有可内联的字段**时才渲染。
             *
             * `dir` / `file` 这两种「资源型」设置已经移到「插件设置」弹窗里
             * （见 renderPluginSettingsInputs 里的说明），这里返回空串。
             * 于是只声明这两种类型的插件（如 MMD 动作插件）内联区是空的 ——
             * 若仍无条件渲染，就会剩一个「插件设置」标题下面什么都没有，
             * 看着像坏了。所以先渲染一遍、去掉空白后仍有内容才输出。
             */
            const inner = renderPluginSettingsInputs(p)
            if (!inner.trim()) return ''
            return `
            <div data-plugin-settings="${esc(p.id)}" style="margin-top:6px;border-top:1px dashed var(--border);padding-top:6px">
              <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">插件设置</div>
              ${inner}
            </div>`
          })()}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn small" data-plugin-settings="${esc(p.id)}" title="插件设置：名称 / 文件夹名 / 类型图标 / 类型颜色">设置</button>
          <button class="btn small danger" data-plugin-uninstall="${esc(p.id)}" title="卸载（删除插件文件夹，不可还原）">卸载</button>
        </div>
      </div>
    `).join('')

    pluginsBox.querySelectorAll('[data-plugin-settings]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = state.plugins.find((x) => x.id === btn.dataset.pluginSettings)
        if (p) openPluginSettingsModal(p)
      })
    })

    pluginsBox.querySelectorAll('[data-plugin-enabled]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const id = cb.dataset.pluginEnabled
        await bridge.setPluginEnabled(id, cb.checked)
        // 即时生效（无确认弹窗；主进程已立即注销/注册并重扫）
        await reloadPluginState()
        await refreshAll()
        renderPlugins()
      })
    })
    pluginsBox.querySelectorAll('[data-plugin-uninstall]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('确定卸载该插件？插件文件夹将被整个删除（不可还原）。')) return
        const res = await bridge.uninstallPlugin(btn.dataset.pluginUninstall)
        if (!res.ok) { alert(res.error || '卸载失败'); return }
        // 即时生效：素材立即消失
        await reloadPluginState()
        await refreshAll()
        renderPlugins()
      })
    })
    // 插件设置输入绑定（保存后即时生效：重拉素材与缩略图）
    pluginsBox.querySelectorAll('[data-plugin-settings]').forEach((box2) => {
      box2.addEventListener('change', async () => {
        const pluginId = box2.dataset.pluginSettings
        const manifest = state.plugins.find((p) => p.id === pluginId)
        if (!manifest) return
        const values = collectPluginSettings(box2, manifest.settingsDef)
        await bridge.savePluginSettings(pluginId, values)
        await reloadPluginState()
        await refreshAll()
      })
    })
  }

  const renderPluginSettingsInputs = (p) => (p.settingsDef || []).map((s) => {
    if (s.type === 'dir' || s.type === 'file') return ''
    const val = p.settings[s.key]
    if (s.type === 'boolean') {
      return `<label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:2px 0">
        <input type="checkbox" data-ps="${esc(s.key)}" ${val ? 'checked' : ''} /> ${esc(s.label)}</label>`
    }
    if (s.type === 'select') {
      return `<div style="margin:2px 0;font-size:12px">${esc(s.label)}:
        <select data-ps="${esc(s.key)}">${(s.options || []).map((o) => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`
    }
    return `<div style="margin:2px 0;font-size:12px">${esc(s.label)}:
      <input type="${s.type === 'number' ? 'number' : 'text'}" data-ps="${esc(s.key)}" value="${esc(val ?? s.default ?? '')}"
        style="width:100%;background:var(--panel-2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:3px 6px;font-size:12px" /></div>`
  }).join('')

  const collectPluginSettings = (box2, def) => {
    const values = {}
    for (const s of def || []) {
      const el = box2.querySelector(`[data-ps="${s.key}"]`)
      if (!el) continue
      if (s.type === 'boolean') values[s.key] = el.checked
      else if (s.type === 'number') values[s.key] = parseFloat(el.value) || 0
      else values[s.key] = el.value
    }
    return values
  }

  renderPlugins()
  body.querySelector('#settings-install-plugin').addEventListener('click', installPluginFlow)
  body.querySelector('#settings-create-plugin').addEventListener('click', openCreatePluginModal)
  body.querySelector('#settings-add-root').addEventListener('click', () => chooseRootDir())

  // 保存按钮（页面头部，openSettings 开头已取 saveBtn/backBtn 并解除隐藏）
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const patch = {
        scanConcurrency: +body.querySelector('#set-concurrency').value || 8,
        thumbSize: +body.querySelector('#set-thumb-size').value || 256,
      }
      await bridge.setSettings(patch)
      closeSettings()
    }
  }
}

/**
 * 插件设置弹窗（设置页每个插件行的「设置」按钮）。
 *
 * 可改：插件名 / 插件文件夹名（= 插件 id，会真的重命名插件目录）/ 类型图标 / 类型颜色；
 * 「简易插件」还可以增删支持的文件类型（手写插件的 exts 是它自身实现的契约，不给改）。
 *
 * 所有改动都由主进程记进数据目录的 plugin-overrides.json —— **不写回插件文件**，
 * 手写插件永远保持原样。
 */
function openPluginSettingsModal(plugin) {
  const inputStyle = 'width:100%;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:12px;box-sizing:border-box'
  const labelStyle = 'display:block;font-size:11px;color:var(--text-dim);margin:10px 0 4px'
  const asHex6 = (c) => (/^#[0-9a-f]{3}$/i.test(c)
    ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
    : c)
  const declared = String((plugin.kind && plugin.kind.color) || '').trim()
  let curColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(declared) ? asHex6(declared) : '#8a8f98'

  // 双击行为：plugin.dblclick 已是「用户覆盖 > 插件声明」的结果（主程序合并过），
  // 所以这里要区分「插件自己声明的值」才能让「跟随插件声明」这一项显示准确。
  // plugin.declaredDblclick 由主程序另外下发（未合并的原始声明）。
  const declaredDbl = plugin.declaredDblclick || ''
  const curDbl = plugin.dblclick || 'default'

  let exts = [...(plugin.exts || [])]
  let iconPath // undefined = 不改；'' = 恢复默认；其它 = 新选的图片路径（已在插件目录内）
  let pickedTempFile = '' // 本次新选图标的临时文件名（放弃/换图时要清掉）
  let iconUrl = plugin.icon
    ? 'asset://thumb/' + encodeURIComponent(plugin.dir + '\\' + plugin.icon)
    : ''
  // 插件**自己声明的**图标。「恢复默认」要回到的是这个（插件没声明才轮到主程序的内置占位图标），
  // 所以预览必须显示它 —— 否则看起来像是「恢复到全局默认」。
  const declaredIconUrl = plugin.declaredIcon
    ? 'asset://thumb/' + encodeURIComponent(plugin.dir + '\\' + plugin.declaredIcon)
    : ''

  /*
   * 按扩展名的图标覆盖。
   *
   * 一个插件管着差别很大的几种素材时（MMD 动作插件同时管动作与音频），
   * 光有一个「类型图标」不够 —— 用户可能想把动作换成自己的图、音频保留默认。
   * 这里给每个扩展名各留一行：选图 / 恢复默认，互不影响。
   *
   * extIconState[ext] 的三种取值：
   *   undefined = 本次不改（保存时不带这个键）
   *   ''        = 恢复插件声明的图标
   *   绝对路径   = 新选的图（保存时由主进程拷进插件目录）
   */
  const extIconExts = [...new Set(plugin.exts || [])]
  const extIconState = {}
  const extIconOverride = { ...(plugin.extIcons || {}) } // 当前生效的图标（含插件声明的）
  /*
   * 只有**用户覆盖过**的扩展名才允许「恢复」。
   * 不能用 extIconOverride 判断 —— 它含插件自己声明的值（.mp3 → icon-audio.svg），
   * 那样每个声明过的扩展名都会显示成「可恢复」，而其实没什么可恢复的。
   * 主程序下发的 plugin.extIcons 是合并结果，这里靠「声明值」反推出覆盖集合。
   */
  const extIconDeclared = { ...(plugin.declaredExtIcons || {}) }
  const extIconIsOverridden = (ext) => {
    const cur = extIconOverride[ext]
    if (!cur) return false
    return cur !== extIconDeclared[ext]
  }
  const extIconUrlOf = (ext) => {
    const f = extIconOverride[ext]
    return f ? 'asset://thumb/' + encodeURIComponent(plugin.dir + '\\' + f) : ''
  }

  const m = openModal()
  m.root.querySelector('.modal-header h2').textContent = '插件设置'
  // 关闭弹窗时若图标还没保存，把刚拷进插件目录的临时图清掉（不留垃圾）
  const closeModalRaw = m.close
  m.close = () => {
    if (pickedTempFile) {
      bridge.discardPluginIcon(plugin.id || plugin.folderName, pickedTempFile)
      pickedTempFile = ''
    }
    closeModalRaw()
  }
  m.root.querySelector('.modal-close').onclick = m.close
  m.mask.onclick = (e) => { if (e.target === m.mask) m.close() }
  m.body.innerHTML = `
    <div style="font-size:12px;color:var(--text-dim)">
      ${plugin.simple ? '<span class="plugin-flag">简易插件</span> ' : ''}${esc(plugin.name)}
      <div style="font-size:11px;margin-top:3px">改动保存在软件数据目录，不会修改插件自身的文件</div>
    </div>

    <label style="${labelStyle}">插件名</label>
    <input type="text" id="ps-name" value="${esc(plugin.name)}" style="${inputStyle}" />

    <label style="${labelStyle}">插件文件夹名（即插件 id，改名会移动插件目录）</label>
    <input type="text" id="ps-folder" value="${esc(plugin.id)}" style="${inputStyle}" />
    <div style="font-size:11px;color:var(--text-dim);margin-top:3px">支持中文；不能含路径分隔符，不能是 . / .. 或 Windows 保留设备名</div>

    <label style="${labelStyle}">类型图标（显示在素材卡片中间）</label>
    <div style="display:flex;align-items:center;gap:10px">
      <div class="ps-icon-box" id="ps-icon-box"></div>
      <button class="btn small" id="ps-icon-pick">选择图片…</button>
      <button class="btn small" id="ps-icon-reset">恢复默认</button>
    </div>
    <div style="font-size:11px;color:var(--text-dim);margin-top:3px">「恢复默认」= 回到插件自己声明的图标（插件没声明时，才用主程序内置的占位图标）</div>

    ${extIconExts.length ? `
      <label style="${labelStyle}">按文件类型单独设图标（留空则用上面的通用图标）</label>
      <div id="ps-exticons"></div>` : ''}

    <label style="${labelStyle}">类型颜色（填充素材卡片左下角的文件类型角标）</label>
    <div style="display:flex;align-items:center;gap:8px">
      <input type="color" id="ps-color" value="${curColor}" style="width:46px;height:32px;background:none;border:1px solid var(--border);border-radius:6px;cursor:pointer;padding:2px" />
      <input type="text" id="ps-color-hex" value="${curColor}" style="${inputStyle};max-width:130px" />
    </div>

    <label style="${labelStyle}">双击素材时的行为</label>
    <select id="ps-dblclick" style="${inputStyle}">
      <option value="default">跟随插件声明${declaredDbl ? `（当前：${DBLCLICK_LABELS[declaredDbl]}）` : '（插件未声明 → 预览）'}</option>
      <option value="preview">打开预览窗口</option>
      <option value="open">用系统默认程序打开</option>
      <option value="none">不做任何操作</option>
    </select>
    <div style="font-size:11px;color:var(--text-dim);margin-top:3px">
      这里的选择会覆盖插件自己的声明。素材不支持预览时，「打开预览窗口」会自动改用系统程序打开。
    </div>

    ${plugin.simple ? `
      <label style="${labelStyle}">支持的文件类型（简易插件可增删）</label>
      <div class="ps-exts" id="ps-exts"></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="text" id="ps-ext-add" placeholder="例如 .abc（回车添加）" style="${inputStyle}" />
        <button class="btn small" id="ps-ext-add-btn">添加</button>
      </div>` : `
      <div style="margin-top:12px;font-size:11px;color:var(--text-dim)">
        支持的文件类型：${(plugin.exts || []).map((e) => esc(e)).join(' / ') || '（无）'}<br/>
        手写插件的扩展名由插件自身的实现决定，不能在界面里改。
      </div>`}

    ${(plugin.settingsDef || []).length ? `
      <label style="${labelStyle}">插件资源</label>
      <div id="ps-res" style="border:1px solid var(--border);border-radius:8px;padding:10px"></div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:3px">
        选中的文件夹会被复制进插件目录，插件预览时直接用这里的副本 —— 换机器、打包分发都不受影响。
      </div>` : ''}
  `

  const renderIconBox = () => {
    const box = m.body.querySelector('#ps-icon-box')
    if (!box) return
    box.innerHTML = iconUrl
      ? `<img src="${iconUrl}" alt="" />`
      : '<span class="muted small">未声明（用内置占位图标）</span>'
  }
  const renderExts = () => {
    const box = m.body.querySelector('#ps-exts')
    if (!box) return
    box.innerHTML = exts.length
      ? exts.map((e) => `<span class="ps-ext">${esc(e)}<span class="x" data-del="${esc(e)}" title="删除">×</span></span>`).join('')
      : '<span class="muted small">（至少保留一个）</span>'
    box.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', () => {
        exts = exts.filter((e) => e !== el.dataset.del)
        renderExts()
      })
    })
  }
  renderIconBox()
  if (plugin.simple) renderExts()

  /** 渲染「按文件类型单独设图标」那张表 */
  const renderExtIcons = () => {
    const box = m.body.querySelector('#ps-exticons')
    if (!box) return
    box.innerHTML = extIconExts.map((ext) => {
      const url = extIconState[ext] !== undefined
        ? (extIconState[ext] === '' ? '' : 'asset://file/' + encodeURIComponent(extIconState[ext]))
        : extIconUrlOf(ext)
      const hasOwn = extIconState[ext] !== undefined ? extIconState[ext] !== '' : extIconIsOverridden(ext)
      return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <span style="font-size:11px;color:var(--text-dim);width:52px;flex:none">${esc(ext)}</span>
        <div class="ps-icon-box" style="width:30px;height:30px">${
          url ? `<img src="${url}" alt="" />` : '<span style="font-size:10px;color:var(--text-dim)">通用</span>'
        }</div>
        <button class="btn small" data-exticon-pick="${esc(ext)}">选择…</button>
        <button class="btn small" data-exticon-reset="${esc(ext)}" ${hasOwn ? '' : 'disabled'}>恢复</button>
      </div>`
    }).join('')
    box.querySelectorAll('[data-exticon-pick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await bridge.pickPluginIcon(plugin.id)
        if (!res || !res.ok) return
        extIconState[btn.dataset.exticonPick] = res.path
        renderExtIcons()
      })
    })
    box.querySelectorAll('[data-exticon-reset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        extIconState[btn.dataset.exticonReset] = '' // '' = 恢复插件声明的图标
        renderExtIcons()
      })
    })
  }
  if (extIconExts.length) renderExtIcons()

  /*
   * ── 插件资源（settingsDef 里 type:'dir' / type:'file' 的设置项）──
   *
   * 为什么放在这个弹窗、而不是设置页插件行里内联：
   *  ① 内联渲染时，点「浏览…」触发的 change 会冒泡到插件设置区，
   *     引起一次「保存 → 重渲染设置页」，用户会看到设置页闪一下 ——
   *     弹窗是独立层，重绘只影响弹窗内部，不会有这个观感问题；
   *  ② 「类型图标」「类型颜色」这些针对插件本身的配置本来就在这儿，
   *     「这个插件用哪个模型」属于同一类，放一起才符合直觉。
   *
   * 值仍然写进 plugin-settings.json（与设置页同一份存储），插件侧读法不变。
   */
  const resValues = { ...(plugin.settings || {}) }
  const resSaved = () => ({
    ...(state.plugins.find((p) => p.id === plugin.id) || {}).settings,
    ...resValues,
  })

  /** 渲染整个资源区（按 settingsDef 顺序） */
  const renderRes = async () => {
    const box = m.body.querySelector('#ps-res')
    if (!box) return
    const defs = (plugin.settingsDef || [])

    box.innerHTML = defs.map((s) => {
      const val = String(resValues[s.key] ?? '')
      if (s.type === 'dir') {
        return `<div style="margin-bottom:10px" data-res-row="${esc(s.key)}">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">${esc(s.label)}</div>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" readonly value="${esc(val)}" placeholder="尚未选择"
              data-res-val="${esc(s.key)}"
              style="${inputStyle};flex:1;min-width:0;color:var(--text-dim)" />
            <button class="btn small" data-res-pick="${esc(s.key)}">浏览…</button>
            ${val ? `<button class="btn small danger" data-res-clear="${esc(s.key)}">清除</button>` : ''}
          </div>
        </div>`
      }
      if (s.type === 'file') {
        return `<div style="margin-bottom:10px" data-res-row="${esc(s.key)}">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">${esc(s.label)}</div>
          <select data-res-val="${esc(s.key)}" style="${inputStyle}">
            <option value="${esc(val)}">${val ? esc(val.split('/').pop()) : '（先选择文件夹）'}</option>
          </select>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px" data-res-hint="${esc(s.key)}"></div>
        </div>`
      }
      return ''
    }).join('') || '<div class="muted small">这个插件没有可配置的资源</div>'

    // 事件绑定
    box.querySelectorAll('[data-res-pick]').forEach((btn) => {
      btn.addEventListener('click', () => pickResDir(btn.dataset.resPick))
    })
    box.querySelectorAll('[data-res-clear]').forEach((btn) => {
      btn.addEventListener('click', () => clearResDir(btn.dataset.resClear))
    })
    box.querySelectorAll('[data-res-val]').forEach((el) => {
      el.addEventListener('change', () => {
        resValues[el.dataset.resVal] = el.value
        saveRes()
      })
    })
    // 填充 file 下拉框的候选
    await fillResFiles()
  }

  /** 填充 type:'file' 的下拉候选（一个候选就自动选中） */
  const fillResFiles = async () => {
    for (const s of plugin.settingsDef || []) {
      if (s.type !== 'file') continue
      const sel = m.body.querySelector(`[data-res-val="${cssEsc(s.key)}"]`)
      if (!sel) continue
      const hint = m.body.querySelector(`[data-res-hint="${cssEsc(s.key)}"]`)
      const dirVal = String(resValues[s.from] || '')
      if (!dirVal) {
        sel.innerHTML = `<option value="">（先选择文件夹）</option>`
        if (hint) hint.textContent = ''
        continue
      }
      const res = await bridge.listPluginFiles(plugin.id, {
        dir: dirVal, match: s.match || [], recursive: s.recursive !== false,
      })
      const files = (res && res.files) || []
      const cur = String(resValues[s.key] || '')
      sel.innerHTML = files.length
        ? files.map((f) => `<option value="${esc(f.rel)}" ${f.rel === cur ? 'selected' : ''}>${esc(f.name)}</option>`).join('')
        : `<option value="">（这个文件夹里没有匹配的文件）</option>`
      if (files.length && !files.some((f) => f.rel === cur)) {
        // 原来选的没了（或没选过）→ 自动落到第一个
        sel.value = files[0].rel
        resValues[s.key] = files[0].rel
        await saveRes()
      } else if (files.length) {
        sel.value = cur
      }
      if (hint) {
        hint.textContent = files.length === 0 ? '没有找到匹配的文件'
          : files.length === 1 ? '文件夹里只有这一个，已自动选中'
            : `共 ${files.length} 个候选，请选择要套用的那个`
      }
    }
  }

  /** 保存资源设置（只写 plugin-settings.json，不动插件文件） */
  const saveRes = async () => {
    const vals = {}
    for (const s of plugin.settingsDef || []) vals[s.key] = resValues[s.key] ?? ''
    await bridge.savePluginSettings(plugin.id, vals)
    // 让本地 state 跟上，弹窗内后续判断才准
    const p = state.plugins.find((x) => x.id === plugin.id)
    if (p) p.settings = { ...(p.settings || {}), ...vals }
  }

  /** 选文件夹 → 复制进插件目录 → 写设置（同名冲突问一句） */
  const pickResDir = async (key) => {
    const first = await bridge.pickPluginDir(plugin.id, {})
    if (!first || first.canceled) return
    let res = first
    if (!res.ok && res.needConfirm) {
      if (!confirm(`插件目录里已经有「${res.name}」了。\n\n覆盖会先删除旧文件夹（不可还原），确定覆盖吗？`)) return
      res = await bridge.pickPluginDir(plugin.id, { overwrite: true })
      if (!res || res.canceled) return
    }
    if (!res.ok) { alert(res.error || '选择文件夹失败'); return }

    resValues[key] = res.relPath
    // 换了文件夹，之前选的模型文件大概率失效 —— 清掉，由 fillResFiles 重新挑
    for (const s of plugin.settingsDef || []) {
      if (s.type === 'file' && s.from === key) resValues[s.key] = ''
    }
    await saveRes()
    await renderRes() // 就地重绘弹窗内这一块（不碰设置页）
  }

  /** 清除：删掉拷进插件目录的资源文件夹 */
  const clearResDir = async (key) => {
    const cur = String(resValues[key] || '')
    if (!cur) return
    if (!confirm(`删除插件目录下的「${cur}」文件夹？（不可还原）`)) return
    const del = await bridge.deletePluginDir(plugin.id, cur)
    if (!del.ok) { alert(del.error || '删除失败'); return }
    resValues[key] = ''
    for (const s of plugin.settingsDef || []) {
      if (s.type === 'file' && s.from === key) resValues[s.key] = ''
    }
    await saveRes()
    await renderRes()
  }

  if ((plugin.settingsDef || []).length) renderRes()

  // 下拉初值：用户已覆盖 → 显示覆盖值；没有覆盖 → 停在「跟随插件声明」
  const dblSel = m.body.querySelector('#ps-dblclick')
  if (dblSel) dblSel.value = ['preview', 'open', 'none'].includes(curDbl) ? curDbl : 'default'

  m.body.querySelector('#ps-icon-pick').addEventListener('click', async () => {
    // 主进程会把选中的图**拷进插件目录**再返回路径 —— 渲染层只读得到
    // 素材库/插件目录内的文件（asset:// 允许范围），所以预览的就是最终生效的那张。
    const res = await bridge.pickPluginIcon(plugin.id || plugin.folderName)
    if (!res || !res.ok) return
    // 上一张临时图没保存就换新的 → 让主进程清掉，别在插件目录里留垃圾
    if (pickedTempFile && pickedTempFile !== res.fileName) {
      bridge.discardPluginIcon(plugin.id || plugin.folderName, pickedTempFile)
    }
    iconPath = res.path
    pickedTempFile = res.fileName
    iconUrl = 'asset://file/' + encodeURIComponent(res.path)
    renderIconBox()
  })
  m.body.querySelector('#ps-icon-reset').addEventListener('click', () => {
    iconPath = '' // 保存时清除覆盖 → 回到插件自己声明的图标
    iconUrl = declaredIconUrl
    renderIconBox()
  })

  const colorEl = m.body.querySelector('#ps-color')
  const hexEl = m.body.querySelector('#ps-color-hex')
  colorEl.addEventListener('input', () => { hexEl.value = colorEl.value })
  hexEl.addEventListener('input', () => {
    const v = hexEl.value.trim()
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) colorEl.value = asHex6(v)
  })

  if (plugin.simple) {
    const addExt = () => {
      const input = m.body.querySelector('#ps-ext-add')
      const t = String(input.value || '').trim().toLowerCase()
      if (!t) return
      const e = t.startsWith('.') ? t : '.' + t
      if (/^\.[a-z0-9]+$/.test(e) && !exts.includes(e)) exts.push(e)
      input.value = ''
      renderExts()
    }
    m.body.querySelector('#ps-ext-add-btn').addEventListener('click', addExt)
    m.body.querySelector('#ps-ext-add').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addExt() }
    })
  }

  m.footer.innerHTML = `
    <button class="btn small" id="ps-cancel">取消</button>
    <button class="btn small primary" id="ps-ok">保存</button>
  `
  m.footer.querySelector('#ps-cancel').addEventListener('click', m.close)
  m.footer.querySelector('#ps-ok').addEventListener('click', async () => {
    const payload = {
      id: plugin.id,
      name: m.body.querySelector('#ps-name').value,
      folderName: m.body.querySelector('#ps-folder').value,
      kindColor: m.body.querySelector('#ps-color-hex').value,
      dblclick: m.body.querySelector('#ps-dblclick').value,
    }
    if (plugin.simple) payload.exts = exts
    if (iconPath !== undefined) payload.iconPath = iconPath
    // 本次改过的按扩展名图标（没动过的扩展名不带，避免无谓地重写覆盖）
    const extIconPatch = {}
    for (const [ext, v] of Object.entries(extIconState)) extIconPatch[ext] = v
    if (Object.keys(extIconPatch).length) payload.extIcons = extIconPatch
    const btn = m.footer.querySelector('#ps-ok')
    btn.disabled = true
    btn.textContent = '保存中…'
    try {
      const res = await bridge.updatePlugin(payload)
      if (!res.ok) {
        alert(res.error || '保存失败')
        btn.disabled = false
        btn.textContent = '保存'
        return
      }
      // 改文件夹名会顺手把插件入口里声明的 id 一起改掉；没能改（入口里没声明、或格式认不出来）
      // 不影响使用，但打包成 zip 重新安装会装回旧名字的目录，所以要说一声。
      if (res.idSync && !res.idSync.changed) {
        alert(`文件夹已改名为「${res.id}」。\n\n但插件入口里声明的 id 没能同步修改：${res.idSync.reason}。\n（不影响使用；只是把该目录打包成 zip 重新安装时，落地目录名仍按声明的 id。）`)
      }
      // 临时图标已在主进程定稿改名（不再是 tmp），别再当垃圾清理
      pickedTempFile = ''
      m.close()
      await reloadPluginState()
      await refreshAll()
      if (state.settingsOpen) openSettings()
    } catch (err) {
      alert('保存失败：' + (err && err.message || err))
      btn.disabled = false
      btn.textContent = '保存'
    }
  })
}

/* 关闭设置页，回到浏览 */
function closeSettings() {
  state.settingsOpen = false
  $('#settings-view').classList.add('hidden')
  const sb = $('#settings-save-btn')
  if (sb) sb.classList.add('hidden')
  const bb = $('#settings-back-btn')
  if (bb) bb.classList.add('hidden')
  // 设置页是整页覆盖（开时把详情栏藏了），回来必须恢复常驻占位 ——
  // 否则打开过一次设置后，详情栏就再也不出现了。
  const panel = $('#detail-panel')
  if (panel) panel.classList.remove('hidden')
  renderDetailPlaceholder()
  ensureBrowseVisible()
  refreshAll()
}

/** 确保浏览区可见（设置页已关闭）；供浏览入口（quick-view/素材库/目录树/面包屑）调用 */
function ensureBrowseVisible() {
  $('#settings-view').classList.add('hidden')
  $('#browse-view').classList.remove('hidden')
}

/* ── 添加素材库 ───────────────────────── */
async function chooseRootDir() {
  const res = await bridge.pickDir()
  if (!res.ok || !res.path) return
  const add = await bridge.addRoot(res.path)
  if (!add.ok) { alert(add.error || '添加失败'); return }
  state.roots = await bridge.listRoots()
  state.activeRootId = add.root.id
  state.activeDir = null
  renderRoots()
  await refreshAll()
  refreshDirTree()
}

/* ── 安装插件（zip 压缩包） ─────────────── */
async function installPluginFlow() {
  const res = await bridge.pickPluginZip()
  if (!res.ok || !res.path) return
  const inst = await bridge.installPlugin(res.path)
  if (inst.canceled) return // 用户在风险提示里选了「取消」
  if (!inst.ok) { alert(inst.error || '安装失败'); return }
  // 即时生效：刷新插件列表 + 素材 + 设置页（无需重启）
  await reloadPluginState()
  await refreshAll()
  if (state.settingsOpen) openSettings()
}

/* ── 新建简单插件（仅声明文件类型，无缩略图/预览能力） ── */
/** 解析扩展名输入（逗号/空格分隔，自动补「.」、转小写、去重） */
function parseExtInput(raw) {
  return [...new Set(String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : '.' + s).toLowerCase()))]
}

function openCreatePluginModal() {
  const inputStyle = 'width:100%;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:12px;box-sizing:border-box'
  const labelStyle = 'display:block;font-size:11px;color:var(--text-dim);margin:10px 0 4px'
  const m = openModal()
  m.root.querySelector('.modal-header h2').textContent = '新建插件（简单类型）'
  m.body.innerHTML = `
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">
      创建一个只声明文件类型的插件：主程序即可识别/索引这类素材。
      不支持生成缩略图、不支持预览。
    </div>
    <label style="${labelStyle}">插件名 *</label>
    <input type="text" id="cp-name" placeholder="例如：自定义模型插件" style="${inputStyle}" />
    <label style="${labelStyle}">插件文件夹名（将作为插件 id）*</label>
    <input type="text" id="cp-folder" placeholder="例如：mymodel（仅字母/数字/下划线/中划线）" style="${inputStyle}" />
    <label style="${labelStyle}">文件扩展名 *（逗号或空格分隔）</label>
    <input type="text" id="cp-exts" placeholder="例如：.abc, .xyz（或 abc xyz）" style="${inputStyle}" />
    <label style="${labelStyle}">素材类型标签（可选，默认=插件名）</label>
    <input type="text" id="cp-kind" placeholder="例如：自定义模型" style="${inputStyle}" />
    <label style="${labelStyle}">标签颜色（可选，十六进制）</label>
    <input type="text" id="cp-color" placeholder="例如：#6366f1（不填自动取色）" style="${inputStyle}" />
    <label style="${labelStyle}">说明（可选）</label>
    <input type="text" id="cp-desc" placeholder="一句话说明这个插件支持的素材" style="${inputStyle}" />
  `
  m.footer.innerHTML = `
    <button class="btn small" id="cp-cancel">取消</button>
    <button class="btn small primary" id="cp-ok">创建</button>
  `
  m.footer.querySelector('#cp-cancel').addEventListener('click', m.close)
  m.footer.querySelector('#cp-ok').addEventListener('click', async () => {
    const opts = {
      name: m.body.querySelector('#cp-name').value,
      folderName: m.body.querySelector('#cp-folder').value,
      exts: parseExtInput(m.body.querySelector('#cp-exts').value),
      kindLabel: m.body.querySelector('#cp-kind').value,
      kindColor: m.body.querySelector('#cp-color').value,
      description: m.body.querySelector('#cp-desc').value,
    }
    const btn = m.footer.querySelector('#cp-ok')
    btn.disabled = true
    btn.textContent = '创建中…'
    try {
      const res = await bridge.createPlugin(opts)
      if (!res.ok) { alert(res.error || '创建失败'); btn.disabled = false; btn.textContent = '创建'; return }
      m.close()
      await reloadPluginState()
      await refreshAll() // 新扩展名 → 重扫 + 素材即时生效
      if (state.settingsOpen) openSettings() // 设置页同步显示新插件
      alert(res.warn ? `插件已创建，但：${res.warn}` : `插件「${opts.name}」创建成功`)
    } catch (err) {
      alert('创建失败：' + (err && err.message || err))
      btn.disabled = false
      btn.textContent = '创建'
    }
  })
}

/* ── 顶栏扫描：当前目录 / 全部 ─────────── */
async function runScan(mode) {
  const roots = state.roots.filter((r) => r.enabled)
  if (!roots.length) { alert('请先添加并启用素材库'); return }

  if (mode === 'all') {
    // 扫描全部素材库（增量，未变化自动跳过）
    for (const r of roots) bridge.scan(r.id)
    return
  }

  // 扫描当前目录：activeDir 所属根 + 路径子树；未浏览具体目录则扫整根
  const dir = state.activeDir
  if (dir) {
    const root = roots.find((r) => dir === r.path || dir.startsWith(r.path + '\\') || dir.startsWith(r.path + '/'))
    if (root) {
      bridge.scan(root.id, { rootId: root.id, path: dir })
      return
    }
  }
  // 停在库顶层：扫当前激活根（增量）
  const activeRoot = roots.find((r) => r.id === state.activeRootId) || roots[0]
  bridge.scan(activeRoot.id)
}

/* ── 缩略图：对范围内插件支持生成缩略图的素材生成缩略图 ── */
/**
 * @param {{rootId?:string, dir?:string}} [scope] 范围；缺省 = 当前浏览的目录
 *   （文件夹右键菜单会显式传入被点击的那个文件夹，顶栏按钮则用当前目录）
 */
async function runGenerateThumbs(scope) {
  const useScope = scope || {
    rootId: state.activeRootId || undefined,
    dir: state.activeDir || undefined,
  }
  try {
    // 进度条完全由主进程事件驱动（排队/进度/完成/失败都带 taskId）；
    // 这里只等待结果返回（串行队列里轮到它才真正开始）。
    // 不做「正在生成就不响应」的守卫：连续对多个文件夹操作时，后发的自然入队，
    // 新进度条出现在旧条下面，前一个完成后再执行 —— 不会被吞。
    await bridge.generateThumbnails(useScope)
  } catch (err) {
    // 失败信息由主进程广播 THUMB_ERROR 事件负责显示，这里不重复处理
    console.warn('[thumb] 生成失败：', err && err.message || err)
  } finally {
    refreshThumbPending()
  }
}

/* ── 清除缩略图：把范围内 `<素材名>.preview.*` 命名的缩略图移入回收站 ── */
async function runClearThumbs(scope, dirPath) {
  const where = dirPath || '全部启用的素材库'
  if (!confirm(`确定清除缩略图？\n\n范围：${where}\n\n只有名字里带「.preview.」的缩略图会被移入回收站（可还原）；\n其它图片和素材本身都不受影响。`)) return
  try {
    // 进度条由主进程事件驱动；等清除完成（串行队列轮到它才执行）后刷新
    await bridge.clearThumbnails(scope)
    await refreshAll()
  } catch (err) {
    console.warn('[thumb] 清除失败：', err && err.message || err)
  } finally {
    refreshThumbPending()
  }
}

/* ── 批量标签弹窗 ─────────────────────── */
function openBulkTags() {
  const m = openModal()
  m.root.querySelector('.modal-header h2').textContent = '批量打标签'
  m.body.innerHTML = `
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px">
      为已选 ${state.selected.size} 个素材添加标签（多个标签用空格分隔）
    </div>
    <input type="text" id="bulk-tags-input" placeholder="例如: 角色 武器 高精度" style="width:100%;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:12px" />
  `
  m.footer.innerHTML = `<button class="btn" id="bt-cancel">取消</button><button class="btn primary" id="bt-ok">添加</button>`
  m.footer.querySelector('#bt-cancel').addEventListener('click', () => m.close())
  m.footer.querySelector('#bt-ok').addEventListener('click', async () => {
    const v = m.body.querySelector('#bulk-tags-input').value.trim()
    if (v) {
      const newTags = v.split(/\s+/)
      const byRoot = new Map()
      state.selected.forEach((e) => {
        if (!byRoot.has(e.rootId)) byRoot.set(e.rootId, [])
        byRoot.get(e.rootId).push(e)
      })
      for (const [rootId, entries] of byRoot) {
        const paths = entries.map((e) => e.path)
        const merged = entries.map((e) => [...new Set([...(e.tags || []), ...newTags])])
        for (let i = 0; i < paths.length; i++) {
          await bridge.patchAsset(rootId, paths[i], { tags: merged[i] })
        }
      }
      await refreshAll()
    }
    m.close()
  })
}

/* ── 事件绑定 ─────────────────────────── */
function bindEvents() {
  $('#sidebar-add-root').addEventListener('click', chooseRootDir)
  $('#settings-btn').addEventListener('click', openSettings)
  $('#settings-back-btn').addEventListener('click', closeSettings)
  $('#settings-close-btn').addEventListener('click', closeSettings)
  $('#search-input').addEventListener('input', debounce(() => {
    state.search = $('#search-input').value.trim()
    state.selected.clear()
    closeDetail() // 结果集已变，详情栏里的条目可能已不在列表中
    refreshAssets()
  }, 250))
  $('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value
    rememberFolderSort() // 记住这个目录的选择（仅文件夹视图下记录）
    refreshAssets()
  })
  $('#sort-order-btn').addEventListener('click', () => {
    state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc'
    $('#sort-order-btn').textContent = state.sortOrder === 'asc' ? '↑' : '↓'
    rememberFolderSort()
    refreshAssets()
  })
  $('#view-grid-btn').addEventListener('click', () => {
    state.viewMode = 'grid'
    $('#view-grid-btn').classList.add('active')
    $('#view-list-btn').classList.remove('active')
    refreshAssets()
  })
  $('#view-list-btn').addEventListener('click', () => {
    state.viewMode = 'list'
    $('#view-list-btn').classList.add('active')
    $('#view-grid-btn').classList.remove('active')
    refreshAssets()
  })

  // 网格大小滑块 → CSS 变量（并持久化，避免每次启动回到默认值）
  const applyGridSize = (v) => {
    document.documentElement.style.setProperty('--grid-min', `${v}px`)
  }
  // 拖动过程只改样式，停下 400ms 后落盘一次 —— 避免每移一格都写一次设置
  const persistGridSize = debounce(() => {
    bridge.setSettings({ gridSize: state.gridSize }).catch(() => {})
  }, 400)
  $('#grid-size-slider').addEventListener('input', (e) => {
    state.gridSize = +e.target.value
    applyGridSize(state.gridSize)
    persistGridSize()
  })
  applyGridSize(state.gridSize)

  // ── 顶栏扫描按钮：当前目录 / 全部 ──────────
  $('#scan-btn').addEventListener('click', () => runScan('current'))
  $('#scan-arrow-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    $('#scan-menu').classList.toggle('hidden')
  })
  $$('#scan-menu .scan-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      runScan(el.dataset.scan)
      $('#scan-menu').classList.add('hidden')
    })
  })
  document.addEventListener('click', () => $('#scan-menu').classList.add('hidden'))

  // 缩略图生成（进度/完成复用同一条任务进度条）
  // 必须用箭头函数包一层：直接传 runGenerateThumbs 会把 MouseEvent 当成 scope 参数，
  // 序列化后 rootId/dir 全丢 → 退化成「全库生成」，与按钮上显示的数字口径不一致。
  $('#thumb-btn').addEventListener('click', () => runGenerateThumbs())

  // 进度条上的「停止」按钮
  $$('.qv-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeView = el.dataset.view
      state.selected.clear()
      state.detail = null
      // 只回占位态，不隐藏面板（隐藏会让左侧素材区变宽）
      renderDetailPlaceholder()
      ensureBrowseVisible()
      renderQuickViews()
      refreshAssets()
    })
  })
  $('#bulk-fav').addEventListener('click', () => batchPatch({ favorite: true }))
  $('#bulk-unfav').addEventListener('click', () => batchPatch({ favorite: false }))
  $('#bulk-tags').addEventListener('click', openBulkTags)
  $('#bulk-close').addEventListener('click', () => {
    state.selected.clear()
    renderSelection()
  })

  // 扫描进度（每个任务一条进度条，按 taskId 区分）
  bridge.onScanProgress((p) => {
    if (p && p.taskId != null) updateTaskBar(p.taskId, p || {})
  })
  bridge.onScanDone(async (r) => {
    // 该库内容已变 → 目录树缓存失效，下次刷新重建（多库并显下不影响其他库）
    if (r && r.rootId) {
      state.rootTrees.delete(r.rootId)
      state.dirTreeDirty = true
    }
    if (r && r.taskId != null) {
      let msg
      if (r && r.cancelled) {
        // 未开始即取消：只有 message（无统计字段）；运行中被取消：有统计字段
        msg = r.added != null
          ? `扫描已停止：+${r.added} 新增 / ${r.updated} 更新 / ${r.removed} 删除`
          : (r.message || '已取消')
      } else {
        msg = `扫描完成：+${r.added} 新增 / ${r.updated} 更新 / ${r.removed} 删除（${(r.durationMs / 1000).toFixed(1)}s）`
      }
      finishTaskBar(
        r.taskId,
        { cancelled: !!(r && r.cancelled), complete: !(r && r.cancelled), message: msg },
        r && r.cancelled ? 4000 : 3000 // 完成 → 进度条变绿停留 3s 后消失
      )
    }
    state.roots = await bridge.listRoots()
    renderRoots()
    await refreshAll()
    refreshDirTree()
  })
  bridge.onScanError((e) => {
    if (e && e.taskId != null) finishTaskBar(e.taskId, { message: `扫描失败：${e.message}` }, 4000)
  })

  // 缩略图任务进度（生成 / 清除；按 taskId 区分，与扫描条目互不影响）
  bridge.onThumbProgress((p) => {
    if (p && p.taskId != null) updateTaskBar(p.taskId, p || {})
  })
  bridge.onThumbDone(async (r) => {
    if (r && r.taskId != null) {
      finishTaskBar(
        r.taskId,
        {
          cancelled: !!(r && r.cancelled),
          complete: !(r && r.cancelled),
          message: (r && r.message) || '缩略图完成',
        },
        r && r.cancelled ? 4000 : 3500 // 完成 → 进度条变绿停留 3.5s 后消失
      )
    }
    await refreshAll() // 新生成的缩略图即时生效（无需重启）
  })
  bridge.onThumbError((e) => {
    if (e && e.taskId != null) finishTaskBar(e.taskId, { message: '缩略图任务失败：' + (e && e.message) }, 4000)
  })

  /*
   * 预览窗口里点了「生成预览图」→ 就地刷新那一个素材的缩略图。
   *
   * 为什么不直接 refreshAll()：
   *   • 用户可能正在预览窗口里连续微调（截图 → 调角度 → 再截图），
   *     每次都整表重渲染会让主界面不停闪、还会丢掉滚动位置和选中态；
   *   • 受影响的只有一个文件，代价应该只付在一个文件上。
   * 所以按路径精确找到卡片/列表行，只换它自己那张 <img>。
   */
  bridge.onThumbChanged(async (info) => {
    if (!info || !info.path) return
    await refreshThumbForPath(info.path)
  })
}

/**
 * 只刷新某个素材的缩略图显示（卡片 + 列表行 + 详情栏）。
 *
 * 找不到该素材时静默返回 —— 它可能不在当前视图里（别的目录/被搜索过滤掉），
 * 那种情况下用户看不到，也就无所谓刷新。
 */
async function refreshThumbForPath(assetPath) {
  const entry = findLoadedEntry(assetPath)
  if (!entry) return
  const { url, ph } = await thumbFor(entry)
  // 卡片与列表行都用 data-path 定位；复用已有的 cssEsc 转义属性值
  const sel = `[data-path="${cssEsc(assetPath)}"]`

  document.querySelectorAll(`.asset-card${sel}`).forEach((card) => {
    const img = card.querySelector('.thumb')
    if (!img) return
    const cover = card.querySelector('.card-cover')
    if (ph) {
      // 新图没生成出来（异常情况）→ 退回类别图标，别留一张破图
      img.removeAttribute('src')
      cover?.classList.remove('has-img')
      return
    }
    /*
     * 关键是**同时**做两件事：换 src + 补上 has-img。
     * 原来没有缩略图的卡片走的是「不设 src、保留类别图标」那条路，
     * 只改 src 的话图被类别图标层盖着，看起来还是没变。
     */
    img.src = url
    cover?.classList.add('has-img')
  })

  document.querySelectorAll(`.asset-list tr${sel}`).forEach((tr) => {
    const img = tr.querySelector('img.thumb')
    if (img && !ph) img.src = url
  })

  // 详情栏开着且正是这个素材 → 同步（元素本身就是 img.detail-thumb）
  if (state.detail && state.detail.path === assetPath) {
    const t = document.querySelector('#detail-content img.detail-thumb')
    if (t && !ph) t.src = url
  }
}

/** 从当前已加载的列表里按路径找条目 */
function findLoadedEntry(assetPath) {
  const pools = [state.items, state.folder && state.folder.assets, state.detail]
  for (const p of pools) {
    if (!p) continue
    if (Array.isArray(p)) {
      const hit = p.find((e) => e && e.path === assetPath)
      if (hit) return hit
    } else if (p.path === assetPath) {
      return p
    }
  }
  return null
}

function debounce(fn, ms) {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

init()
