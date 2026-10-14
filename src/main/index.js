/**
 * 主进程入口（纯净框架）
 *  - 创建主窗口（原生 HTML/JS 渲染，无框架构建）
 *  - 注册 asset:// 自定义协议（提供素材文件/缩略图读取，受控路径）
 *  - 注册 IPC 处理器
 *  - 不加载任何插件、不含任何文件类型逻辑
 */
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs')
const { Store } = require('./store')
const { scanRoot, reparsePlugin } = require('./scanner')
const { cachedResolve, clearThumbCache, placeholderSvg, findSiblingImage, thumbOutPathFor, isPreviewFile, normalizeThumbSize, thumbVersionOf, THUMB_SIZES } = require('./thumbs')
const { IpcChannels, IpcEvents } = require('../shared/ipcChannels')
const { registry } = require('../shared/contracts')
const folderTree = require('../shared/folderTree')
const { buildFolderTree, findFolder, breadcrumbOf, nodeToView, slimEntry } = folderTree
const { loadPlugins, installPlugin, uninstallPlugin, PluginSettingsStore, PluginOverridesStore, clearRequireCache, validateManifest, applyOverrides, locateDeclaredId, ICON_FILE_PREFIX, DBLCLICK_ACTIONS, normalizeDblclick } = require('./pluginHost')
const { openPreview, renderThumbnail, destroyAllHostWindows, setThumbSavedNotifier } = require('./renderHost')
const { safeAction, safeButton } = require('./pluginGuard')
// 无人值守自检（测试代码集中在 smoke.js，正式入口不混入任何测试逻辑/示例类型名）
const { isUiSmoke, isStartupSmoke, isTestMode, isolateUserData, isolateDataDir, smokePluginsDir, attachStartupSmoke, attachUiSmoke } = require('./smoke')

// 测试模式必须在 DATA_DIR 求值前把数据目录指向沙箱，否则测试会往用户的
// 真实素材库里塞临时根目录（并污染 settings.json）。
// UI 测试同样需要沙箱。
if (isTestMode() || isUiSmoke()) isolateDataDir()

let store = null

/**
 * 数据目录（settings.json + index/ 索引）：
 * 默认放在软件主目录下（便携、随程序走）；可用环境变量 AMM_DATA_DIR 覆盖
 * （验证探针/冒烟用它指向独立沙箱，避免污染真实数据）。
 */
const DATA_DIR = process.env.AMM_DATA_DIR || path.join(__dirname, '..', '..', 'data')

/**
 * 启动迁移：把历史数据目录（%APPDATA%\<app>\data）里的 settings.json 与 index/ 复制到新位置。
 * 仅当新位置不存在时执行（绝不覆盖可能在目标目录已有的数据）；旧目录保留作备份。
 */
function migrateDataDirIfNeeded() {
  const legacy = path.join(app.getPath('userData'), 'data')
  // 插件自定义设置：userData 根下的 plugin-settings.json → 主目录数据区（便携）
  const legacyPlg = path.join(app.getPath('userData'), 'plugin-settings.json')
  const newPlg = path.join(DATA_DIR, 'plugin-settings.json')
  if (fs.existsSync(legacyPlg) && !fs.existsSync(newPlg)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.copyFileSync(legacyPlg, newPlg)
      console.log(`[store] 插件设置已迁移：${legacyPlg} → ${newPlg}（旧文件保留备份）`)
    } catch (err) {
      console.warn('[store] 插件设置迁移失败：', err && err.message || err)
    }
  }
  if (path.resolve(legacy) === path.resolve(DATA_DIR)) return
  // 仅当目标里已有实际数据（settings.json / index）才跳过；预建的空目录不算「已迁移」，
  // 否则先建目录再启动会把历史数据吞掉
  if (fs.existsSync(path.join(DATA_DIR, 'settings.json')) || fs.existsSync(path.join(DATA_DIR, 'index'))) return
  try {
    if (!fs.existsSync(legacy)) return // 旧位置本就没有数据 → 无需迁移
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.cpSync(legacy, DATA_DIR, { recursive: true, force: false })
    console.log(`[store] 数据目录已迁移：${legacy} → ${DATA_DIR}（旧目录保留备份）`)
  } catch (err) {
    console.warn('[store] 数据目录迁移失败（将按新位置空库启动）：', err && err.message || err)
  }
}
let mainWindow = null
let pluginSettings = null
let pluginOverrides = null
let pluginsDir = null

// ── 窗口 ─────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#1e1f24',
    title: '素材管理器',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  // 关掉主窗口 = 关掉整个软件。必须主动收掉「渲染宿主的全部窗口」：
  //   • 离屏缩略图窗口（show:false）
  //   • 所有独立的插件预览窗口
  // 它们都是 BrowserWindow，**同样计入「还有窗口没关」**——只要还剩一个，
  // window-all-closed 就不会触发，主进程连同 GPU / 渲染子进程会一直残留。
  mainWindow.on('closed', () => {
    mainWindow = null
    destroyAllHostWindows()
    // 兜底：宿主窗口全部销毁后若已无任何窗口，window-all-closed 会触发；
    // 这里再显式确认一次，不依赖事件先后顺序。
    setImmediate(() => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit()
    })
  })

  // 无人值守自检（--smoke-test / UI_SMOKE）全部实现在 src/main/smoke.js：
  // 正式路径这里只做一次「是否处于冒烟模式」的判断，测试代码与本文件分离。
  if (isStartupSmoke()) attachStartupSmoke(mainWindow)
  return mainWindow
}

// ── 自定义协议 asset:// ─────────────────────────────
// 统一走主进程校验路径后返回文件，避免渲染进程任意 file:// 访问
//
// ── 路径归属校验（安全边界）──────────────────────────────
// 渲染进程（含插件代码）只能读取**已注册素材库根目录内**或 **plugins 目录内**
// 的文件。渲染层本身没有 fs 权限，asset:// 是它唯一的文件读取通道，所以这里
// 就是主进程的信任边界：没有这道校验，一段被注入的渲染层脚本可以借
// `asset://file/C:\Users\...\id_rsa` 读走任意外部文件。
//
// 为什么按「素材库根目录」而不是「索引条目」校验：
//   插件读素材的**附属文件**（例如 MMD 模型旁的 .tga/.png 贴图）并不会进入索引，
//   按条目校验会把正常渲染打坏。根目录粒度既能挡住库外任意路径，
//   又不影响插件读取素材的同目录资源。
function registerAssetProtocol() {
  protocol.handle('asset', async (request) => {
    const url = new URL(request.url)
    const kind = url.host // 'file' | 'thumb'
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
    try {
      const resolved = path.resolve(filePath)

      if (!isPathAllowed(resolved)) {
        return new Response('Forbidden', { status: 403 })
      }

      const stat = fs.statSync(resolved)
      if (!stat.isFile()) return new Response('Not a file', { status: 404 })

      if (kind === 'thumb') {
        // 缩略图：仅允许通用图片扩展名
        const ext = path.extname(resolved).toLowerCase()
        const imgExts = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.svg']
        if (!imgExts.includes(ext)) return new Response('Not allowed', { status: 403 })
      }
      const mime = mimeOf(path.extname(resolved))

      /*
       * ── Range 请求（视频/音频 seek 的基础）──────────────────────
       * 早先这里无脑 `readFile` 整个文件再返回：
       *   • 一个 2 GB 的视频会被整块读进内存
       *   • 不返回 Accept-Ranges / 不认 Range → <video> 无法跳转时间点，
       *     进度条拖不动（HTML5 播放器靠 206 分段响应做 seek）
       * 现在按标准实现：解析 Range → 流式返回该区间（206 + Content-Range）。
       *
       * 用 createReadStream 而不是读成 Buffer，长视频才不会撑爆内存。
       */
      const range = parseRange(request.headers.get('range'), stat.size)
      if (range === 'invalid') {
        // 请求区间越界：标准要求回 416 并带上实际长度
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'content-range': `bytes */${stat.size}` },
        })
      }

      const baseHeaders = {
        'content-type': mime,
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
      }

      if (range) {
        const { start, end } = range
        return new Response(nodeStreamToWeb(fs.createReadStream(resolved, { start, end })), {
          status: 206,
          headers: {
            ...baseHeaders,
            'content-range': `bytes ${start}-${end}/${stat.size}`,
            'content-length': String(end - start + 1),
          },
        })
      }

      // 无 Range：仍然流式返回，避免大文件整块进内存
      return new Response(nodeStreamToWeb(fs.createReadStream(resolved)), {
        status: 200,
        headers: { ...baseHeaders, 'content-length': String(stat.size) },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/**
 * 解析 HTTP Range 头，返回可用的字节区间。
 *
 * 只支持单区间的 `bytes=a-b` 形式（浏览器对媒体请求就是这么发的）：
 *   'bytes=0-'      → 从 0 到结尾
 *   'bytes=100-200' → 100..200
 *   'bytes=-500'    → 最后 500 字节
 *
 * @returns {{start:number,end:number}|null|'invalid'}
 *   null      = 没有 Range（或语法不认识），按整体 200 返回
 *   'invalid' = 区间越界，调用方应回 416
 */
function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null

  let start, end
  if (rawStart === '') {
    // `bytes=-N`：最后 N 字节
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
    if (end >= size) end = size - 1
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/** Node 可读流 → Web 可读流（protocol.handle 只接受标准 Response） */
function nodeStreamToWeb(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)))
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (err) => controller.error(err))
    },
    cancel() {
      // 播放器提前切换（例如拖动进度条）时会取消上一个请求，必须释放文件句柄
      nodeStream.destroy()
    },
  })
}

/** plugins 目录（主程序启动时赋值；素材库根由 store 提供） */
let pluginsDirForProtocol = null

/**
 * 判断绝对路径是否在允许范围内。
 *
 * 允许：任一声明的素材库根目录内（含其所有子目录）
 *       plugins 目录内（插件自带图标、用户选定的图标副本）
 *
 * 用 path.relative 判断包含关系而不是字符串前缀：
 * 前缀比较会被 `E:\素材库-evil` 这类同前缀目录绕过。
 */
function isPathAllowed(absPath) {
  const roots = []
  if (store) for (const r of store.listRoots()) if (r && r.path) roots.push(r.path)
  if (pluginsDirForProtocol) roots.push(pluginsDirForProtocol)

  for (const root of roots) {
    const rel = path.relative(path.resolve(root), absPath)
    // rel 为空 = 路径就是根目录本身；不以 .. 开头且非绝对路径 = 确实在根内
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true
  }
  return false
}

function mimeOf(ext) {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    // 视频 / 音频：MIME 供 <video>/<audio> 判断容器类型（能否解码由 Chromium 决定，
    // 主程序不判断 —— 它只知道扩展名，不知道内容能不能播）
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.ogv': 'video/ogg',
    '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  }
  return map[ext.toLowerCase()] || 'application/octet-stream'
}

/** 网格最小宽度（px）：与顶栏滑块的 min/max/step 对齐，越界值吸附回合法区间 */
const GRID_SIZE_MIN = 100
const GRID_SIZE_MAX = 320
function normalizeGridSize(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 150
  return Math.min(GRID_SIZE_MAX, Math.max(GRID_SIZE_MIN, Math.round(n)))
}

/**
 * 素材条目查询（框架级全文检索 + 筛选 + 排序 + 分页）
 * @param {Object} q
 *   { rootId?, dir?, recursive?, search?, tags?, favoritesOnly?, status?,
 *     sort?('name'|'time'|'size'), order?('asc'|'desc'), offset?, limit? }
 */
function queryEntries(q = {}) {
  const roots = q.rootId ? [store.getRoot(q.rootId)].filter(Boolean) : store.listRoots()
  const list = []
  for (const root of roots) {
    if (!root.enabled) continue
    const idx = store.getIndex(root.id)
    for (const entry of idx.entries.values()) {
      // 实时过滤：条目的插件已停用/卸载（不在注册表）→ 该类型素材从所有视图消失，无需重扫
      if (entry.pluginId && !registry.getById(entry.pluginId)) continue
      if (q.favoritesOnly && !entry.favorite) continue
      if (q.dir && q.dir !== '/') {
        if (q.recursive === false) {
          if (entry.dir !== q.dir) continue
        } else if (!entry.path.startsWith(q.dir + path.sep) && entry.path !== q.dir) {
          continue
        }
      }
      if (q.tags && q.tags.length) {
        const has = q.tags.every((t) => (entry.tags || []).includes(t))
        if (!has) continue
      }
      if (q.search) {
        const s = q.search.toLowerCase()
        const hay = `${entry.name} ${entry.path} ${(entry.tags || []).join(' ')} ${entry.note || ''}`.toLowerCase()
        if (!hay.includes(s)) continue
      }
      list.push(entry)
    }
  }

  const sort = q.sort || 'name'
  const order = q.order === 'desc' ? -1 : 1
  list.sort((a, b) => {
    let cmp = 0
    if (sort === 'name') cmp = a.name.localeCompare(b.name, 'zh')
    else if (sort === 'time') cmp = a.mtime - b.mtime
    else if (sort === 'size') cmp = a.size - b.size
    return cmp * order
  })

  const total = list.length
  const offset = Math.max(0, q.offset || 0)
  const limit = q.limit && q.limit > 0 ? q.limit : total
  return { items: list.slice(offset, offset + limit), total }
}

// ── IPC ──────────────────────────────────────────────
function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

async function handleScan(rootId, scope = null, opts = {}) {
  const root = store.getRoot(rootId)
  if (!root) return { ok: false, error: '根目录不存在' }
  if (!root.enabled) return { ok: false, error: '根目录已停用' }
  const force = !!(opts && opts.force)

  // 缓存命中（仅启动自动扫描：非手动 + 无子树限定 + 插件签名未变 + 根 mtime 未变）
  // → 完全不入队、不弹进度条，直接返回「无变化」。深层改动由手动扫描（force）兜底。
  if (!force && !scope) {
    try {
      const idx = store.getIndex(rootId)
      const rootMtime = (await fs.promises.stat(root.path)).mtimeMs
      if (idx.sig === registry.version() && idx.rootMtime != null && idx.rootMtime === rootMtime) {
        return { ok: true, result: { rootId, cached: true, durationMs: 0, message: '素材库无变化，跳过扫描' } }
      }
    } catch { /* 根不可读 → 照常入队扫描 */ }
  }

  return submitTask('scan', async (task) => {
    const ch = taskChannels('scan')
    try {
      // 首帧进度先让「进度条 + 停止按钮」立即出现；遍历/ diff 阶段会持续广播进度。
      broadcast(ch.progress, { taskId: task.id, rootId, current: 0, total: 0, message: '正在遍历目录…' })
      const result = await scanRoot(store, root, {
        concurrency: store.settings.scanConcurrency || 8,
        exclude: [store.dataDir], // 索引数据目录不入库
        scope, // { rootId, path } 限定扫描子树（增量复用指纹）
        force, // 手动扫描强制真实遍历；启动自动扫描可走缓存跳过
        shouldAbort: () => task.cancelled, // 协作式取消：扫描在每个可中断点自行退出
        onProgress: (rid, p) => broadcast(ch.progress, { taskId: task.id, rootId: rid, ...p }),
      })
      // 扫描后清空缩略图缓存：手动放入/删除旁挂图片、生成缩略图后即时生效（无需重启）
      clearThumbCache()
      /*
       * 目录结构可能变了 → 清掉已不存在目录的排序记录。
       *
       * 只做「失效清理」不做「重建」：排序记录是用户意图，不该被扫描覆盖。
       * 判据用**索引里当前真实存在的目录集合**而不是扫描结果的 removed 计数 ——
       * removed 只给个数、拿不到路径，而且「删了素材」不等于「目录没了」。
       * 这样即便目录是被改名、换盘符、手工删掉的，记录也能自愈清掉。
       */
      if (!result || !result.cancelled) {
        try {
          pruneFolderSortForRoot(rootId)
        } catch (err) {
          console.warn('[sort] 清理失效目录排序记录失败：', err && err.message || err)
        }
      }
      broadcast(ch.done, { taskId: task.id, ...result })
      return { ok: true, result }
    } catch (err) {
      broadcast(ch.error, { taskId: task.id, message: String(err && err.message || err) })
      return { ok: false, error: String(err && err.message || err) }
    }
  }, `扫描：${root.name}`)
}

// ── 长任务串行队列 ───────────────────────────────────
/**
 * 长任务（扫描 / 缩略图清除与生成）**严格串行执行**：新任务先进队列，
 * 上一个完成收尾后下一个才开始（用户明确要求：不会同时去做）。
 * 每条任务有独立 taskId，渲染层按 taskId 维护各自的进度条 ——
 * 新任务入队即广播「排队中」首帧，它的进度条立在最下面，旧条自然上移。
 *
 * 取消仍是协作式：正在执行的在可中断点自查 shouldAbort；排队中的直接移除。
 */
let taskSeq = 0
const taskQueue = [] // FIFO：{ id, kind, cancelled, run, resolve, reject }
let currentTask = null

const taskChannels = (kind) => ({
  progress: kind === 'thumb' ? IpcEvents.THUMB_PROGRESS : IpcEvents.SCAN_PROGRESS,
  done: kind === 'thumb' ? IpcEvents.THUMB_DONE : IpcEvents.SCAN_DONE,
  error: kind === 'thumb' ? IpcEvents.THUMB_ERROR : IpcEvents.SCAN_ERROR,
})

/** 提交长任务到串行队列；返回的 Promise 在该任务实际执行完毕并 resolve/reject 后收敛 */
function submitTask(kind, run, label = '') {
  return new Promise((resolve, reject) => {
    const task = { id: ++taskSeq, kind, cancelled: false, run, resolve, reject }
    taskQueue.push(task)
    // 入队即广播「排队中」首帧（带具体任务名）：渲染层立即在最下面立起它的进度条
    broadcast(taskChannels(kind).progress, {
      taskId: task.id, current: 0, total: 0, queued: true,
      message: label ? `${label}（排队中）` : '排队中…',
    })
    drainTasks()
  })
}

async function drainTasks() {
  if (currentTask) return // 有任务在跑 → 后面的继续排队
  const task = taskQueue.shift()
  if (!task) return
  currentTask = task
  try {
    task.resolve(await task.run(task))
  } catch (err) {
    task.reject(err)
  } finally {
    currentTask = null
    // 收尾后立刻让下一个任务开始（同一周转，任务间无 gap）
    setImmediate(drainTasks)
  }
}

/** 请求停止某类任务（kind 缺省 = 全部）：正在跑与排队的都标记；返回命中数 */
function cancelTasks(kind) {
  let count = 0
  if (currentTask && (!kind || currentTask.kind === kind)) {
    currentTask.cancelled = true
    count++
  }
  for (const t of taskQueue) {
    if (kind && t.kind !== kind) continue
    t.cancelled = true
    count++
  }
  return count
}

/** 按 taskId 取消某一条任务（每条进度条自己的「停止」按钮）。排队中的直接移除并广播已取消 */
function cancelTaskById(taskId) {
  if (currentTask && currentTask.id === taskId) {
    currentTask.cancelled = true
    return 1
  }
  const i = taskQueue.findIndex((t) => t.id === taskId)
  if (i >= 0) {
    const [t] = taskQueue.splice(i, 1)
    broadcast(taskChannels(t.kind).done, { taskId: t.id, cancelled: true, message: '已取消（未开始）' })
    t.resolve({ ok: false, cancelled: true, cancelledBeforeStart: true })
    return 1
  }
  return 0
}

/** target 是否位于 base 目录内（或等于 base） */
function isWithinPath(target, base) {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 收集「可生成缩略图」的素材任务（供「生成」与「统计待生成数量」共用）。
 *
 * 只有同时满足以下条件的素材才算任务：
 *   • 插件声明了 canThumbnail 且提供了 viewer（否则主程序不知道该让谁渲染）
 *   • 当前还没有缩略图（同目录没有对应的 `<素材文件名>.<图片扩展名>`）—— 已有的绝不覆盖
 * 插件不支持生成的素材计入 unsupported、已有缩略图的计入 already，两者都不进 jobs。
 *
 * @param {{rootId?:string, dir?:string}} scope 范围（缺省 = 全部启用的素材库）
 *   dir 为**绝对路径**，按子树匹配（含该目录自身及其所有子目录）
 * @returns {{roots:Array, jobs:Array, already:number, unsupported:number, total:number}}
 */
function collectThumbJobs(scope = {}) {
  const roots = scope.rootId
    ? [store.getRoot(scope.rootId)].filter(Boolean).filter((r) => r.enabled)
    : store.listRoots().filter((r) => r.enabled)

  const jobs = []
  let already = 0 // 已有缩略图 → 跳过（可能是本程序生成的，也可能是用户自己放的）
  let unsupported = 0 // 插件未声明 canThumbnail / 未提供 viewer → 跳过

  for (const root of roots) {
    const idx = store.getIndex(root.id)
    for (const entry of idx.entries.values()) {
      if (scope.dir && !isWithinPath(entry.path, scope.dir)) continue
      const plugin = entry.pluginId
        ? registry.getById(entry.pluginId)
        : registry.getByExt(path.extname(entry.path))
      if (!plugin || !plugin.canThumbnail || !plugin.viewer) { unsupported++; continue }
      if ((entry.thumbPath && fs.existsSync(entry.thumbPath)) || findSiblingImage(entry.path)) { already++; continue }
      jobs.push({ rootId: root.id, entry, plugin })
    }
  }
  return { roots, jobs, already, unsupported, total: jobs.length }
}

/**
 * 解析条目的缩略图文件（可能不存在）：优先索引里的 thumbPath，否则按命名规则查找。
 * 返回的路径形如 `<素材文件名>.<图片扩展名>`（例如 `a.blend.png`）。
 */
function resolveThumbFile(entry) {
  if (entry.thumbPath && fs.existsSync(entry.thumbPath)) return entry.thumbPath
  const sib = findSiblingImage(entry.path)
  return sib && fs.existsSync(sib) ? sib : null
}

/**
 * 统计范围内「可以生成、但还没有缩略图」的素材数量（顶栏按钮括号里的数字）。
 * 插件不支持生成的素材、已有缩略图的素材都不计入。
 * @param {{rootId?:string, dir?:string}} scope
 */
function handleThumbPending(scope = {}) {
  const { total, already, unsupported } = collectThumbJobs(scope)
  return { ok: true, pending: total, already, unsupported }
}

/**
 * 清除缩略图（文件夹右键菜单）
 *
 * **只清除本程序生成的**缩略图（索引里记了 thumbPath 的那些），移入回收站以便还原，
 * 并清掉索引里的 thumbPath，之后「生成缩略图」就能重新渲染。
 *
 * 用户自己放在素材旁的图片**一律不碰** —— 那是用户的文件，删了不可恢复，
 * 而且我们无从判断他为什么放、还有没有别的用途。
 *
 * 安全闸（任一命中即跳过）：候选文件与素材自身同路径、候选文件本身就是索引里的素材、
 * 候选不是本程序生成的（entry.thumbPath 与该文件不一致）。
 *
 * @param {{rootId?:string, dir?:string}} scope 范围（缺省 = 全部启用的素材库）
 */
async function handleClearThumbs(scope = {}) {
  const roots = scope.rootId
    ? [store.getRoot(scope.rootId)].filter(Boolean).filter((r) => r.enabled)
    : store.listRoots().filter((r) => r.enabled)
  if (!roots.length) return { ok: false, error: '请先添加并启用素材库' }

  return submitTask('thumb', async (task) => {
    const ch = taskChannels('thumb')
    let cleared = 0
    let failed = 0
    let skipped = 0
    const touchedRoots = new Set()
    try {
      outer: for (const root of roots) {
        const idx = store.getIndex(root.id)
        for (const entry of idx.entries.values()) {
          if (task.cancelled) break outer
          if (scope.dir && !isWithinPath(entry.path, scope.dir)) continue
          const thumb = resolveThumbFile(entry)
          if (!thumb) continue
          // 安全闸：绝不动素材自身，也不动「本身就是素材」的同名文件
          if (thumb === entry.path || idx.entries.has(thumb)) { skipped++; continue }
          // 只清除符合 `.preview.` 命名约定的缩略图。
          // 用户自己命名的图片不碰 —— 那是用户的文件，清掉不可恢复。
          if (!isPreviewFile(thumb)) { skipped++; continue }
          try {
            await shell.trashItem(thumb)
            entry.thumbPath = null
            touchedRoots.add(root.id)
            cleared++
            if (cleared % 25 === 0) {
              broadcast(ch.progress, { taskId: task.id, current: cleared, total: 0, message: `清除缩略图（${cleared} 张）…` })
            }
          } catch (err) {
            failed++
            console.warn('[thumb] 清除失败', thumb, err && err.message || err)
          }
        }
      }
    } finally {
      for (const rootId of touchedRoots) store.saveIndex(rootId)
    }
    clearThumbCache()
    const prefix = task.cancelled ? '已停止：' : ''
    // skipped 里含两类：用户自己放的图片（不碰）+ 本身就是素材的文件（安全闸）
    const skippedNote = skipped ? `，跳过 ${skipped} 张（非本程序生成或属于素材）` : ''
    const message = cleared
      ? `${prefix}已清除 ${cleared} 张缩略图${failed ? `（失败 ${failed}）` : ''}${skippedNote}，已移入回收站`
      : failed
        ? `清除失败 ${failed} 张`
        : skipped
          ? `没有本程序生成的缩略图可清除（跳过 ${skipped} 张你自己放置的图片）`
          : '当前范围内没有可清除的缩略图'
    broadcast(ch.done, { taskId: task.id, cleared, failed, skipped, cancelled: task.cancelled, message })
    return { ok: true, cleared, failed, skipped, cancelled: task.cancelled, message }
  }, '清除缩略图')
}

/**
 * 按需生成缩略图（顶栏「缩略图」按钮 / 文件夹右键菜单）
 *
 * 渲染结果写到素材同目录的 `<原名>.png`，并写入索引的 thumbPath；
 * 渲染分辨率由设置项 thumbSize 决定，通过既有 viewer 接口传给插件。
 * 主程序侧不包含任何类型知识：能否生成完全由插件的 canThumbnail 决定。
 * @param {{rootId?:string, dir?:string}} scope 生成范围（缺省 = 全部启用的素材库）
 */
/**
 * 重建单个素材的缩略图（素材右键菜单入口）：
 *   - 已有缩略图 → 先移入回收站（旧图作废），再重新生成
 *   - 没有缩略图 → 直接生成
 * 与生成/清除共用 thumb 串行队列（自己的进度条，任务名「重建缩略图：<文件名>」）。
 * @param {string} rootId @param {string} assetPath 素材绝对路径
 */
async function handleRebuildThumb(rootId, assetPath) {
  const root = store.getRoot(rootId)
  if (!root) return { ok: false, error: '根目录不存在' }
  const entry = store.getEntry(rootId, assetPath)
  if (!entry) return { ok: false, error: '素材不存在' }
  const plugin = entry.pluginId
    ? registry.getById(entry.pluginId)
    : registry.getByExt(path.extname(entry.path))
  if (!plugin || !plugin.canThumbnail || !plugin.viewer) {
    return { ok: false, error: '该素材类型不支持生成缩略图' }
  }

  return submitTask('thumb', async (task) => {
    const ch = taskChannels('thumb')
    const size = normalizeThumbSize(store.settings.thumbSize)
    const name = entry.name
    try {
      // 删除旧缩略图（如有）——安全闸：只删符合 `.preview.` 命名的，用户自己的图片不动
      const oldThumb = resolveThumbFile(entry)
      if (oldThumb && oldThumb !== entry.path && isPreviewFile(oldThumb)) {
        try { await shell.trashItem(oldThumb) } catch (e) { /* 回收失败不阻塞：生成会覆盖旧图 */ }
      }
      entry.thumbPath = null

      broadcast(ch.progress, { taskId: task.id, current: 0, total: 1, message: `重建缩略图：${name}` })
      const outPng = thumbOutPathFor(entry.path)
      const res = await renderThumbnail(entry, plugin, pluginsDir, outPng, { size })
      if (res.ok) {
        entry.thumbPath = outPng
        store.saveIndex(rootId)
      }
      clearThumbCache()
      const message = res.ok
        ? `缩略图已重建：${name}`
        : `重建缩略图失败：${name}${res.error ? `（${res.error}）` : ''}`
      broadcast(ch.done, {
        taskId: task.id, total: 1, generated: res.ok ? 1 : 0, failed: res.ok ? 0 : 1,
        already: 0, unsupported: 0, cancelled: task.cancelled, message,
      })
      return { ok: res.ok, generated: res.ok ? 1 : 0, failed: res.ok ? 0 : 1, message, error: res.ok ? undefined : (res.error || '渲染失败') }
    } catch (err) {
      broadcast(ch.error, { taskId: task.id, message: `重建缩略图失败：${String(err && err.message || err)}` })
      return { ok: false, error: String(err && err.message || err) }
    }
  }, `重建缩略图：${entry.name}`)
}

async function handleGenerateThumbs(scope = {}) {
  const { roots, jobs, already, unsupported } = collectThumbJobs(scope)
  if (!roots.length) return { ok: false, error: '请先添加并启用素材库' }
  const size = normalizeThumbSize(store.settings.thumbSize)

  return submitTask('thumb', async (task) => {
    const ch = taskChannels('thumb')
    const t0 = Date.now()
    const total = jobs.length
    broadcast(ch.progress, {
      taskId: task.id, current: 0, total,
      message: total ? `生成缩略图（${size}×${size}）…` : '没有需要生成的素材',
    })

    let generated = 0
    let failed = 0
    let processed = 0 // 已处理（含失败）的任务数 —— 用于报告「还剩多少张没处理」
    const touchedRoots = new Set()
    let lastSave = 0
    // 节流落盘：大库几千张缩略图若逐个全量写索引，主进程 CPU 会被序列化 5-6MB 索引打到爆。
    // 每 ≥500ms 合并写一次，循环结束/中断时再兜底一次（saveIndex 异步+排队，快照取当刻内存态）
    const throttledSave = (rootId) => {
      const now = Date.now()
      if (now - lastSave >= 500) {
        lastSave = now
        store.saveIndex(rootId)
      }
    }
    try {
      for (let i = 0; i < jobs.length; i++) {
        if (task.cancelled) break
        const job = jobs[i]
        broadcast(ch.progress, {
          taskId: task.id, current: i, total, message: `生成缩略图（${size}×${size}）：${job.entry.name}`,
        })
        const outPng = thumbOutPathFor(job.entry.path)
        const res = await renderThumbnail(job.entry, job.plugin, pluginsDir, outPng, { size })
        if (res.ok) {
          const cur = store.getEntry(job.rootId, job.entry.path)
          if (cur) {
            cur.thumbPath = outPng
            touchedRoots.add(job.rootId)
            throttledSave(job.rootId)
          }
          generated++
        } else {
          failed++
          console.warn('[thumb] 生成失败', job.entry.path, res.error)
        }
        processed = i + 1
      }
    } finally {
      // 兜底落盘：把本次生成/中断时已写入内存的 thumbPath 全部持久化
      for (const rid of touchedRoots) store.saveIndex(rid)
    }

    clearThumbCache()
    const cancelled = task.cancelled
    const durationMs = Date.now() - t0
    const message = cancelled
      ? `已停止：本次生成 ${generated} 张${failed ? ` / 失败 ${failed}` : ''}，剩余 ${total - processed} 张未处理`
      : total
        ? `缩略图完成：生成 ${generated} 张${failed ? ` / 失败 ${failed}` : ''}（${(durationMs / 1000).toFixed(1)}s）`
        : unsupported
          ? '没有可生成缩略图的素材（需插件声明 canThumbnail，且素材当前没有缩略图）'
          : '当前范围内的素材都已有缩略图，无需生成'
    const payload = { taskId: task.id, total, generated, failed, already, unsupported, size, durationMs, cancelled, message }
    broadcast(ch.done, payload)
    return { ok: true, ...payload }
  }, `生成缩略图（${size}×${size}）`)
}

/** 名称 → 稳定配色（新建插件未指定颜色时用，按名哈希取色） */
function defaultPluginColor(name) {
  const palette = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b']
  let h = 0
  for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

/**
 * 插件文件夹名校验（新建插件 / 改文件夹名 共用）。
 * 支持中文等任意文字/数字/下划线/中划线/点/空格；排除路径分隔、非法字符、
 * Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式）、. / .. 、
 * 首尾空白与结尾点。返回错误文案，合法则返回 null。
 */
function validateFolderName(folderName) {
  if (!folderName) return '请填写插件文件夹名（将作为插件 id）'
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_\-. ]{0,62}$/u.test(folderName)
    || folderName.trim() !== folderName
    || folderName.endsWith('.')
    || /^\.{1,2}$/.test(folderName)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(folderName)) {
    return '文件夹名只能包含文字（支持中文）、数字、下划线、中划线、点与空格；不能含路径分隔符，不能是 . / .. 或 Windows 保留设备名'
  }
  return null
}

/**
 * 改写插件入口文件里**声明的** id，使其与新文件夹名一致（「改文件夹名」时调用）。
 *
 * 为什么需要：插件 id 以**目录名**为准（加载时用目录名覆盖声明值，见 pluginHost.loadPlugins），
 * 所以声明值过时不影响运行；但**把插件目录打包成 zip 重新安装**时，落地目录名是用
 * **声明的** id 决定的（见 installPlugin 的 dest）。两者不一致就会装出一个旧名字的目录，
 * 与现有目录并存 —— 所以界面改了文件夹名，声明 id 要跟着改。
 *
 * 做法：只替换 `module.exports = {…}` 里那一处 id 字符串字面量，其余字节原样保留
 * （不解析成 AST、不重排、不美化，避免把插件源码写坏 —— 写坏会让插件加载不了）。
 * 定位交给 `pluginHost.locateDeclaredId()`（与「清单规范校验」共用同一份实现）。
 * 定位不到就**不改**并返回原因 —— 正常情况不会发生：不合规范的清单在加载时就已经被拒了。
 *
 * @param {string} file  插件入口文件（index.cjs）的绝对路径
 * @param {string} newId 新文件夹名
 * @returns {{changed:boolean, from?:string, reason?:string}}
 */
function rewriteDeclaredId(file, newId) {
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { changed: false, reason: `读取插件入口失败：${String((err && err.message) || err)}` }
  }

  // 定位与「清单规范校验」共用同一份实现（pluginHost.locateDeclaredId）——
  // 加载时能通过校验的清单，这里必然定位得到；反之这里定位不到就说明清单不合规范。
  const loc = locateDeclaredId(src)
  if (!loc.ok) return { changed: false, reason: loc.reason }
  const valStart = loc.start - 1 // 值的左引号下标
  const quote = src[valStart]
  const valEnd = loc.end // 闭合引号下标
  const from = loc.value
  if (from === newId) return { changed: false, reason: '声明的 id 已是新名字' }

  try {
    fs.writeFileSync(file, src.slice(0, valStart + 1) + newId + src.slice(valEnd), 'utf8')
  } catch (err) {
    return { changed: false, reason: `写入插件入口失败：${String((err && err.message) || err)}` }
  }
  return { changed: true, from }
}

/**
 * 把扩展名输入规范化：'foo' / '.foo' / 'FOO' → '.foo'；非法项丢弃。
 * **不做去重** —— 重复要不要报错由调用方决定（新建插件要报错，改插件时静默去重）。
 */
function normalizeExts(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => {
      const t = String(s).trim().toLowerCase()
      return t && !t.startsWith('.') ? '.' + t : t
    })
    .filter((e) => /^\.[a-z0-9]+$/.test(e))
}

/** 规范化 + 去重（保持首次出现顺序） */
function uniqueExts(list) {
  return [...new Set(normalizeExts(list))]
}

/** 规范化后「重复填写」的扩展名（如同时填 .a 与 .A）；无重复返回空数组 */
function duplicateExts(list) {
  const all = normalizeExts(list)
  return [...new Set(all.filter((e, i) => all.indexOf(e) !== i))]
}

/** 某扩展名是否被「除 selfId 之外的」插件占用；返回占用者 */
function extOwnerOtherThan(ext, selfId) {
  const owner = registry.getByExt(ext)
  return owner && owner.id !== selfId ? owner : null
}

/**
 * 新建简单插件（设置页「新建插件」按钮）：
 * 在 plugins/<folderName>/index.cjs 生成一个最小清单 —— 只声明支持的文件扩展名，
 * **不支持**生成缩略图（canThumbnail:false）、**不支持**预览（canPreview:false）；
 * 可指定插件名 / 文件夹名 / 扩展名 / 类型标签与颜色 / 说明。
 * 生成的文件带 simple:true —— 主程序据此在插件列表里打「简易插件」标识，
 * 并允许在「插件设置」里增删支持的扩展名。
 * 创建成功即加载进注册表并触发全量重扫（新扩展名需要重新索引）。
 */
async function handleCreatePlugin(opts = {}) {
  const name = String(opts.name || '').trim()
  const folderName = String(opts.folderName || '').trim()
  const exts = normalizeExts(opts.exts)
  const kindLabel = String(opts.kindLabel || name || '').trim()
  const kindColor = String(opts.kindColor || '').trim() || defaultPluginColor(name || folderName)
  const description = String(opts.description || '').trim()

  if (!name) return { ok: false, error: '请填写插件名' }
  const folderErr = validateFolderName(folderName)
  if (folderErr) return { ok: false, error: folderErr }
  // 与任何已注册插件 id 冲突（含内置 blender / mmd模型 等）都拒绝
  const idOwner = registry.getById(folderName)
  if (idOwner) {
    return { ok: false, error: `文件夹名「${folderName}」已被插件「${idOwner.name}」占用，请换一个` }
  }
  if (!exts.length) return { ok: false, error: '请至少填写一个文件扩展名（如 .abc 或 abc,xyz）' }
  // 同一批里重复填写（.a 与 .A 规范化后是同一个）→ 拒绝，别让用户以为填了两个
  const dupExts = duplicateExts(opts.exts)
  if (dupExts.length) return { ok: false, error: `扩展名 ${dupExts.join('、')} 重复填写了，请去重` }
  // 扩展名不得与其他已注册插件重复（getByExt 是单匹配，重复会让新插件该扩展名静默失效）
  const extClash = exts.map((e) => ({ e, owner: extOwnerOtherThan(e, folderName) })).filter((x) => x.owner)
  if (extClash.length) {
    return { ok: false, error: `扩展名 ${extClash.map((x) => x.e).join('、')} 已被插件「${extClash[0].owner.name}」声明，请换其他扩展名` }
  }

  const dir = path.join(pluginsDir, folderName)
  if (fs.existsSync(dir)) return { ok: false, error: `插件文件夹「${folderName}」已存在` }

  const code = `/**
 * ${name}（${folderName}）—— 由「新建插件」创建的最小插件
 *
 * 职责：声明支持的文件类型（exts），让主程序能识别并索引这类素材；
 * 不支持生成缩略图（canThumbnail:false）、不支持预览（canPreview:false）。
 *
 * simple: true —— 标记为「简易插件」（主程序生成，只有声明没有实现）。
 * 显示名 / 文件夹名 / 扩展名 / 图标 / 颜色都可以在主程序的「插件设置」里改，
 * 那些改动记在数据目录的 plugin-overrides.json，不会写回本文件。
 */
module.exports = {
  id: ${JSON.stringify(folderName)},
  name: ${JSON.stringify(name)},
  version: '1.0.0',
  description: ${JSON.stringify(description)},
  icon: '',
  simple: true,
  exts: ${JSON.stringify(exts.map((e) => e.toLowerCase()))},
  kind: { key: ${JSON.stringify(folderName)}, label: ${JSON.stringify(kindLabel)}, color: ${JSON.stringify(kindColor)} },
  canThumbnail: false,
  canPreview: false,
  viewer: null,
  previewHtml: null,
  parse: null,
  actions: [],
  detail: { fields: [], showMeta: true },
}
`
  try {
    fs.mkdirSync(dir, { recursive: false })
    fs.writeFileSync(path.join(dir, 'index.cjs'), code, 'utf-8')
  } catch (err) {
    return { ok: false, error: `创建插件文件失败：${String(err && err.message || err)}` }
  }

  // 加载插件（清 require 缓存 + 注册），并触发全量重扫（插件签名已变 → 新扩展名的素材重新索引）
  try {
    clearRequireCache(dir)
    const raw = require(path.join(dir, 'index.cjs'))
    const manifest = validateManifest(raw)
    if (manifest) {
      manifest.id = folderName // id 以文件夹名为准
      applyOverrides(manifest, pluginOverrides.get(folderName))
      registry.register(manifest)
      console.log(`[plugin] 新建并加载: ${manifest.name} (${manifest.exts.join(', ')})`)
      rescanAllRoots()
      return { ok: true, id: manifest.id, name: manifest.name, exts: manifest.exts }
    }
    return { ok: true, warn: '插件已创建但清单校验失败：' + folderName }
  } catch (err) {
    console.error('[plugin] 新建后加载失败:', err)
    return { ok: true, warn: '插件已创建但加载失败：' + (err && err.message || err) }
  }
}

/**
 * 卸载插件后的索引整理（替代全量重扫）：
 * 只处理「该插件类型」的条目 —— 按新注册表重新归属：
 *   - 有别的插件认领同一扩展名 → 迁移 pluginId / kind（归属转移）
 *   - 没有任何插件认领 → 该文件不再是素材 → 移出索引（「无插件不显示该类型」的落点）
 * 并把受影响目录的指纹作废（否则被删文件会在下次增量扫描时被当成「新出现」而复活）。
 * 纯内存操作，毫秒级；不遍历文件系统、不排队、不弹进度条。
 * @param {string} pluginId 被卸载的插件 id（调用方须已从 registry 注销）
 */
function reconcileAfterPluginRemoved(pluginId) {
  for (const root of store.listRoots()) {
    const idx = store.getIndex(root.id)
    let dirty = false
    const touchedDirs = new Set()
    for (const [p, entry] of idx.entries) {
      if (entry.pluginId !== pluginId) continue
      touchedDirs.add(entry.dir || path.dirname(entry.path))
      const plugin = registry.getByExt(path.extname(entry.path))
      if (plugin) {
        // 归属迁移：别的插件认领同一扩展名
        entry.pluginId = plugin.id
        entry.kind = plugin.kind && plugin.kind.key ? plugin.kind.key : null
        entry.meta = null // 旧插件解析的元数据作废（详情按需重新解析）
      } else {
        idx.entries.delete(p)
      }
      dirty = true
    }
    if (dirty) {
      for (const d of touchedDirs) idx.fingerprints.delete(d)
      store.saveIndex(root.id)
    }
  }
}

/**
 * 插件改名（= 改文件夹名）后的索引整理：把旧 id 的条目迁到新 id 上。
 * 与「卸载整理」不同：插件还在、扩展名没变、元数据仍然有效，所以只改 pluginId/kind，
 * 不动 meta（避免大库把全部条目重新解析一遍）。
 */
function reconcilePluginIdChange(oldId, newId) {
  const plugin = registry.getById(newId)
  for (const root of store.listRoots()) {
    const idx = store.getIndex(root.id)
    let dirty = false
    const touchedDirs = new Set()
    for (const [p, entry] of idx.entries) {
      if (entry.pluginId !== oldId) continue
      touchedDirs.add(entry.dir || path.dirname(entry.path))
      entry.pluginId = newId
      // 插件当前不在注册表里（例如已禁用）→ 保留原 kind，别把它抹掉
      if (plugin) entry.kind = plugin.kind && plugin.kind.key ? plugin.kind.key : null
      dirty = true
    }
    if (dirty) {
      for (const d of touchedDirs) idx.fingerprints.delete(d)
      store.saveIndex(root.id)
    }
  }
}

/**
 * 把各根目录索引里记的「插件签名」对齐为当前注册表的签名。
 *
 * 为什么需要：签名 = 插件 id + exts 拼串。改插件文件夹名会改 id → 签名变 →
 * 索引里记的旧签名与当前不符 → 下次启动 force=false 的缓存跳过判断失效 →
 * 白白全量遍历一遍（用户最反感的那件事）。改名后条目归属已由
 * reconcilePluginIdChange 整理好，索引与插件集是一致的，直接对齐签名即可（不碰文件系统）。
 */
function refreshAllIndexSig() {
  const sig = registry.version()
  for (const root of store.listRoots()) {
    const idx = store.getIndex(root.id)
    if (idx.sig === sig) continue
    idx.sig = sig
    store.saveIndex(root.id)
  }
}

/**
 * 最近一次插件加载的失败清单（`{dir, error}[]`）。
 * 以前这份清单只写 console，界面上完全看不到 —— 插件会「静默消失」，
 * 用户只会觉得「我的插件怎么不见了」。现在由设置页的插件区展示出来。
 */
let pluginLoadFailures = []

/** 从磁盘重新加载全部插件（改插件设置/改名后调用；保留禁用状态与覆盖） */
async function reloadAllPlugins() {
  registry.clear()
  const res = await loadPlugins(pluginsDir, store.settings.disabledPlugins || [], pluginOverrides.all())
  pluginLoadFailures = (res && res.failed) || []
}

/**
 * 插件设置更新（设置页「插件设置」弹窗）。
 * 可改：显示名 / 文件夹名（= 插件 id，会真的重命名目录）/ 类型颜色 / 支持的扩展名 /
 *       类型图标 / 双击行为。
 * 显示名 / 颜色 / 扩展名 / 图标 / 双击都记进 plugin-overrides.json，**不写回插件文件**
 * （手写插件保持原样）；唯一例外是「改文件夹名」——会顺手把插件入口里声明的 id
 * 改成新目录名（见 rewriteDeclaredId）。
 *
 * @param {{id:string,name?:string,folderName?:string,kindColor?:string,exts?:string[],
 *          iconPath?:string|null,dblclick?:string}} payload
 *        dblclick 取 'preview'|'open'|'none'，或 'default' 表示「跟随插件声明」
 */
async function handlePluginUpdate(payload = {}) {
  const oldId = String(payload.id || '').trim()
  if (!oldId) return { ok: false, error: '缺少插件 id' }
  const dir = path.join(pluginsDir, oldId)
  if (!fs.existsSync(path.join(dir, 'index.cjs'))) {
    return { ok: false, error: `插件「${oldId}」不存在（缺少 index.cjs）` }
  }

  // 磁盘上的真实声明 + 既有覆盖 = 当前生效值
  let cur = null
  try {
    clearRequireCache(dir)
    cur = applyOverrides(validateManifest(require(path.join(dir, 'index.cjs'))), { ...(pluginOverrides.get(oldId) || {}) })
  } catch (err) {
    return { ok: false, error: `插件声明加载失败：${String(err && err.message || err)}` }
  }
  if (!cur) return { ok: false, error: '插件声明无效（需 id/name/exts）' }
  const isSimple = !!cur.simple
  const ov = { ...(pluginOverrides.get(oldId) || {}) }

  const name = payload.name === undefined ? cur.name : String(payload.name || '').trim()
  if (!name) return { ok: false, error: '请填写插件名' }

  const newFolder = payload.folderName === undefined ? oldId : String(payload.folderName || '').trim()
  const renaming = newFolder !== oldId
  if (renaming) {
    const err = validateFolderName(newFolder)
    if (err) return { ok: false, error: err }
    if (fs.existsSync(path.join(pluginsDir, newFolder))) {
      return { ok: false, error: `插件文件夹「${newFolder}」已存在，请换一个` }
    }
  }

  // 扩展名：只有简易插件能增删（手写插件的 exts 是它 parse/viewer 的契约，改了就解析不了）
  let exts = null
  if (payload.exts !== undefined) {
    if (!isSimple) return { ok: false, error: '只有「简易插件」可以增删支持的文件类型' }
    exts = uniqueExts(payload.exts)
    if (!exts.length) return { ok: false, error: '请至少保留一个文件扩展名' }
    const clash = exts.map((e) => ({ e, owner: extOwnerOtherThan(e, oldId) })).filter((x) => x.owner)
    if (clash.length) {
      return { ok: false, error: `扩展名 ${clash.map((x) => x.e).join('、')} 已被插件「${clash[0].owner.name}」声明` }
    }
  }

  // 颜色：空串 = 清除覆盖（回到插件自己声明的颜色）
  let kindColor
  if (payload.kindColor !== undefined) {
    const c = String(payload.kindColor || '').trim()
    if (c && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return { ok: false, error: '颜色需为十六进制，如 #6366f1' }
    kindColor = c
  }

  const extsChanged = exts !== null && exts.join(',') !== (cur.exts || []).join(',')

  // ── 1) 图标：拷进插件目录（用 amm-icon- 前缀，清理旧图标时只删自己生成的文件）──
  let iconFile
  if (payload.iconPath !== undefined) {
    const prevIcon = ov.icon
    if (payload.iconPath === null || payload.iconPath === '') {
      iconFile = '' // 清除覆盖 → 回到插件自带图标（没有则用主程序默认占位图标）
      // 顺手删掉之前由我们拷进来的图标文件，别在插件目录里留垃圾
      if (prevIcon && prevIcon.startsWith(ICON_FILE_PREFIX)) {
        try { fs.rmSync(path.join(dir, prevIcon), { force: true }) } catch {}
      }
    } else {
      // 拷进插件目录并定稿（源已是本目录临时文件时只改名，不重复拷）
      const copied = copyIconInto(dir, payload.iconPath)
      if (!copied.ok) return copied
      const fileName = copied.fileName
      const prev = ov.icon
      if (prev && prev.startsWith(ICON_FILE_PREFIX) && prev !== fileName) {
        try { fs.rmSync(path.join(dir, prev), { force: true }) } catch {}
      }
      iconFile = fileName
    }
  }
  // ── 2) 改文件夹名：真的重命名目录，并把覆盖/插件设置/禁用状态一起迁过去 ──
  let idSync = null
  if (renaming) {
    try {
      fs.renameSync(dir, path.join(pluginsDir, newFolder))
    } catch (err) {
      return { ok: false, error: `重命名插件文件夹失败：${String(err && err.message || err)}` }
    }
    // 声明 id 一并改掉：id 以目录名为准（不改也能跑），但 zip 重装是用声明 id 定落地目录名，
    // 不改就会装出一个旧名字的目录。改写失败只警告、不回滚重命名（改名本身已经成功）。
    idSync = rewriteDeclaredId(path.join(pluginsDir, newFolder, 'index.cjs'), newFolder)
    pluginOverrides.rename(oldId, newFolder)
    pluginSettings.rename(oldId, newFolder)
    const disabled = store.settings.disabledPlugins || []
    if (disabled.includes(oldId)) {
      store.updateSettings({ disabledPlugins: [...new Set(disabled.map((x) => (x === oldId ? newFolder : x)))] })
    }
  }

  // ── 3) 写覆盖（值为 null/'' 表示清除该项覆盖）──
  const patch = {}
  if (payload.name !== undefined) patch.name = name
  if (exts !== null) patch.exts = exts
  if (payload.kindColor !== undefined) patch.kindColor = kindColor || null
  if (iconFile !== undefined) patch.icon = iconFile
  /*
   * 按扩展名的图标覆盖（extIcons）。
   *
   * 值形态：{ '.mp3': '/abs/picked.png' | '' | null }
   *   • 绝对路径 → 拷进插件目录，存成 ICON_FILE_PREFIX 开头的新文件名
   *   • ''/null  → 该项恢复插件声明的图标（把键删掉）
   * 与主图标同一套约定，只是每个扩展名各存一份。
   */
  if (payload.extIcons && typeof payload.extIcons === 'object' && !Array.isArray(payload.extIcons)) {
    const prevOv = ov.extIcons || {}
    const next = {}
    for (const [rawKey, rawVal] of Object.entries(payload.extIcons)) {
      const key = String(rawKey).toLowerCase()
      if (!/^\.[a-z0-9]+$/.test(key)) continue // 键必须是 .xxx 形式
      if (rawVal === null || rawVal === '') {
        // 恢复默认：把键删掉（next 里不放），并清掉之前拷进来的旧文件
        const prevFile = prevOv[key]
        if (prevFile && String(prevFile).startsWith(ICON_FILE_PREFIX)) {
          try { fs.rmSync(path.join(dir, prevFile), { force: true }) } catch {}
        }
        continue
      }
      const copied = copyIconInto(dir, rawVal)
      if (!copied.ok) return copied
      next[key] = copied.fileName
      // 换图时删掉该扩展名的上一张，别在插件目录里堆垃圾
      const prevFile = prevOv[key]
      if (prevFile && prevFile !== copied.fileName && String(prevFile).startsWith(ICON_FILE_PREFIX)) {
        try { fs.rmSync(path.join(dir, prevFile), { force: true }) } catch {}
      }
    }
    patch.extIcons = next
  }
  // 双击行为：'default' → 清掉覆盖、跟随插件声明；合法值 → 存覆盖；非法值忽略
  if (payload.dblclick !== undefined) {
    const db = String(payload.dblclick || '')
    if (db === 'default') patch.dblclick = null
    else if (DBLCLICK_ACTIONS.includes(db)) patch.dblclick = db
  }
  pluginOverrides.set(newFolder, patch)

  // ── 4) 重新加载插件（覆盖立即生效）──
  await reloadAllPlugins()
  const applied = registry.getById(newFolder)

  // ── 5) 索引整理 ──
  if (renaming) reconcilePluginIdChange(oldId, newFolder)
  // 改名改了插件签名 → 对齐索引里记的签名，免得下次启动白扫一遍；
  // 扩展名变了则必须真扫一遍（新扩展名可能有尚未索引的文件）。
  if (renaming && !extsChanged) refreshAllIndexSig()
  if (extsChanged) rescanAllRoots()
  clearThumbCache()

  return {
    ok: true,
    id: newFolder,
    renamed: renaming,
    idSync, // { changed, from?, reason? }：声明 id 是否跟着改了（renaming 时才非 null）
    name: applied ? applied.name : name,
    exts: applied ? applied.exts : (exts || cur.exts),
    simple: !!(applied && applied.simple),
    rescan: extsChanged,
  }
}

/**
 * 选择类型图标（图片文件）
 *
 * 选定后**立即拷进插件目录**再返回拷贝路径：
 *   • 渲染层只读得到插件目录内的文件（asset:// 的允许范围），不必为库外路径开口子
 *   • 预览看到的就是保存后真正生效的那张图，不会出现「预览和结果不一致」
 *   • 用户点取消/关窗时刚拷进来的临时文件由调用方（取消路径）清掉
 *
 * @param {string} pluginId 目标插件文件夹名
 */
async function handlePluginPickIcon(pluginId) {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择类型图标',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'svg'] }],
    buttonLabel: '选择',
  })
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }

  const src = path.resolve(res.filePaths[0])
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return { ok: false, error: '所选图标文件不存在' }
  const ext = path.extname(src).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.svg'].includes(ext)) {
    return { ok: false, error: '图标需为图片文件（png / jpg / jpeg / bmp / webp / gif / svg）' }
  }

  // 插件目录由 pluginId 决定；不允许越出 plugins 根（防目录穿越）
  const dir = pluginDirOf(pluginId)
  if (!dir) return { ok: false, error: '插件路径无效' }
  if (!fs.existsSync(dir)) return { ok: false, error: '插件文件夹不存在' }

  // 用 amm-icon- 前缀 + 临时标记，保存时再定稿（避免和正式图标重名）
  const fileName = ICON_FILE_PREFIX + 'tmp' + Date.now().toString(36) + ext
  try {
    fs.copyFileSync(src, path.join(dir, fileName))
  } catch (err) {
    return { ok: false, error: `写入图标失败：${String(err && err.message || err)}` }
  }
  return { ok: true, path: path.join(dir, fileName), fileName, dir }
}

/**
 * 把一个图片文件拷进插件目录，返回定稿后的文件名。
 *
 * 保存插件设置时用（主图标与 extIcons 各扩展名的图标都走这里）。
 * 与 handlePluginPickIcon 的区别：那个是「选图时先拷一份临时的」，
 * 这个是「保存时定稿」—— 若源文件已经是本目录里的临时文件，改名即可，不重复拷。
 *
 * @param {string} dir 插件目录绝对路径
 * @param {string|*} src 源图片路径（调用方保证非空）
 * @returns {{ok:true, fileName:string}|{ok:false, error:string}}
 */
function copyIconInto(dir, src) {
  const abs = String(src)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: '所选图标文件不存在' }
  }
  const ext = path.extname(abs).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.svg'].includes(ext)) {
    return { ok: false, error: '图标需为图片文件（png / jpg / jpeg / bmp / webp / gif / svg）' }
  }
  const fileName = ICON_FILE_PREFIX + Date.now().toString(36) + ext
  try {
    const base = path.basename(abs)
    if (base.startsWith(ICON_FILE_PREFIX + 'tmp') && path.resolve(path.dirname(abs)) === path.resolve(dir)) {
      // 选图时已拷进插件目录（临时名）→ 这里只需定稿改名，不重复拷贝
      fs.renameSync(abs, path.join(dir, fileName))
    } else {
      fs.copyFileSync(abs, path.join(dir, fileName))
    }
  } catch (err) {
    return { ok: false, error: `写入图标失败：${String(err && err.message || err)}` }
  }
  return { ok: true, fileName }
}

/**
 * 选择**文件夹**并复制进插件目录（插件设置项 `type: 'dir'` 用）。
 *
 * ── 为什么是「复制进插件目录」而不是记住原路径 ────────────────────
 * ① 渲染层只有 `asset://` 一条文件通道，且只放行「素材库内」与「plugins 目录内」。
 *    库外的模型文件夹读不到，除非为它单独开口子 —— 那等于削弱信任边界。
 * ② 插件目录跟着插件走：用户把插件 zip 拷到另一台机器，模型一起带过去了。
 *    记绝对路径的话换个机器就失效。
 * 所以选完立刻复制，设置里存**相对插件目录的路径**。
 *
 * 同名冲突**不自动覆盖**：模型文件夹动辄几百 MB，默默删掉用户的旧资源代价太大。
 * 返回 `needConfirm` 让界面问一句，确认后再带 `overwrite: true` 调一次。
 *
 * @param {string} pluginId 插件文件夹名
 * @param {{overwrite?: boolean}} [opts]
 */
async function handlePluginPickDir(pluginId, opts = {}) {
  const dir = pluginDirOf(pluginId)
  if (!dir) return { ok: false, error: '插件路径无效' }
  if (!fs.existsSync(dir)) return { ok: false, error: '插件文件夹不存在' }

  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择要复制进插件的文件夹',
    properties: ['openDirectory'],
    buttonLabel: '选择',
  })
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }

  const src = path.resolve(res.filePaths[0])
  let stat
  try {
    stat = fs.statSync(src)
  } catch (err) {
    return { ok: false, error: '所选文件夹不存在：' + String((err && err.message) || err) }
  }
  if (!stat.isDirectory()) return { ok: false, error: '请选择一个文件夹' }

  // 不允许把插件目录自己（或其父目录）拷进自己里面，会无限递归
  const normSrc = src.toLowerCase()
  if (dir.toLowerCase().startsWith(normSrc + path.sep) || dir.toLowerCase() === normSrc) {
    return { ok: false, error: '不能选择插件目录自身或其上级目录' }
  }

  const baseName = path.basename(src)
  if (!baseName) return { ok: false, error: '无法确定文件夹名' }

  let targetName = baseName
  let target = path.join(dir, targetName)
  if (fs.existsSync(target)) {
    if (!opts.overwrite) {
      // 交给界面确认，这里不擅自改名也不擅自删
      return { ok: false, needConfirm: true, conflict: true, name: targetName, dir }
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: '无法删除已有文件夹：' + String((err && err.message) || err) }
    }
  }

  try {
    await fs.promises.cp(src, target, { recursive: true })
  } catch (err) {
    // 复制中途失败：清掉半成品，别在插件目录里留个残缺文件夹
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* 清理失败不掩盖原错误 */ }
    return { ok: false, error: '复制失败：' + String((err && err.message) || err) }
  }

  // 存相对路径：换机器 / 换插件目录仍然有效
  return { ok: true, relPath: targetName, name: targetName, absPath: target }
}

/**
 * 删除插件目录下由本程序拷入的资源文件夹（插件设置项 `type: 'dir'` 的「清除」）。
 *
 * 只允许删**插件目录的直接子目录**：不接受相对路径里的分隔符或 `..`，
 * 因此不可能借这个入口删到插件自己的代码目录之外去。
 */
function handlePluginDeleteDir(pluginId, relPath) {
  const dir = pluginDirOf(pluginId)
  if (!dir) return { ok: false, error: '插件路径无效' }
  const name = String(relPath || '')
  // 只接受单层目录名：挡住 ../、子路径、绝对路径
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name === '.') {
    return { ok: false, error: '资源路径无效' }
  }
  const target = path.join(dir, name)
  if (!target.startsWith(dir + path.sep)) return { ok: false, error: '资源路径无效' }
  if (!fs.existsSync(target)) return { ok: true } // 已经不在了，视为成功
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: '删除失败：' + String((err && err.message) || err) }
  }
}

/**
 * 列出插件目录内某个文件夹下的候选文件（插件设置项 `type: 'file'` 用）。
 *
 * 界面上的「模型文件」下拉框靠它填候选 —— 渲染层没有 fs，
 * 而模型文件夹已经在插件目录里了（由 type:'dir' 拷入），
 * 这里只需在**插件目录范围内**扫一遍。
 *
 * 安全：`relDir` 只接受单层目录名，`relSub` 逐段校验，
 * 因此不可能借这个入口读到插件目录之外。
 *
 * @param {string} pluginId 插件文件夹名
 * @param {{dir?:string, match?:string[], recursive?:boolean}} opts
 * @returns {{ok:boolean, files?:Array<{rel:string,name:string,size:number}>, error?:string}}
 */
function handlePluginListFiles(pluginId, opts = {}) {
  const base = pluginDirOf(pluginId)
  if (!base) return { ok: false, error: '插件路径无效' }

  const dirName = String(opts.dir || '')
  if (!dirName) return { ok: true, files: [] }
  // 与 deleteDir 同一套校验：只接受单层目录名
  if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..') || dirName === '.') {
    return { ok: false, error: '资源路径无效' }
  }

  const root = path.join(base, dirName)
  if (!root.startsWith(base + path.sep)) return { ok: false, error: '资源路径无效' }
  if (!fs.existsSync(root)) return { ok: true, files: [] }

  const match = (Array.isArray(opts.match) ? opts.match : [])
    .map((e) => String(e).toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e))
  const recursive = opts.recursive !== false // 缺省含子目录（模型常把贴图放子目录，但模型文件多在根）

  const files = []
  const walk = (absDir, relPrefix, depth) => {
    let entries
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name
      const abs = path.join(absDir, ent.name)
      if (ent.isDirectory()) {
        // 深度上限防病态目录结构；跳过隐藏目录
        if (recursive && depth < 6 && !ent.name.startsWith('.')) walk(abs, rel, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const ext = path.extname(ent.name).toLowerCase()
      if (match.length && !match.includes(ext)) continue
      let size = 0
      try { size = fs.statSync(abs).size } catch { /* 读不到就当 0 */ }
      // rel 相对**插件目录**，和 dir 设置项存的值形式一致，插件侧可直接拼
      files.push({ rel: dirName + '/' + rel, name: ent.name, size })
    }
  }
  walk(root, '', 0)

  // 按路径排序，保证下拉框顺序稳定（不随文件系统枚举顺序变）
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'))
  return { ok: true, files }
}

/** 插件文件夹名 → 绝对路径；越出 plugins 根时返回 null（防目录穿越） */
function pluginDirOf(pluginId) {
  const dir = path.resolve(pluginsDir, String(pluginId || ''))
  if (!dir.startsWith(path.resolve(pluginsDir) + path.sep)) return null
  return dir
}

/**
 * 丢弃未保存的临时图标。
 *
 * 用户在「插件设置」里选了图又换掉/关掉弹窗时，刚拷进插件目录的那张临时图
 * 应当删掉，避免插件文件夹里堆垃圾。只删带 tmp 标记的、且确实是本程序生成的
 * 文件（amm-icon-tmp 前缀）—— 插件自己的资源一概不碰。
 */
function handlePluginDiscardIcon(pluginId, fileName) {
  const name = String(fileName || '')
  if (!name.startsWith(ICON_FILE_PREFIX + 'tmp')) return { ok: false }
  const dir = path.resolve(pluginsDir, String(pluginId || ''))
  if (!dir.startsWith(path.resolve(pluginsDir) + path.sep)) return { ok: false }
  try {
    fs.rmSync(path.join(dir, name), { force: true })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

function registerIpc() {
  // ── 素材库 ──────────────────────────────────────
  ipcMain.handle(IpcChannels.LIB_LIST, () => store.listRoots())

  ipcMain.handle(IpcChannels.LIB_ADD, async (e, dirPath) => {
    if (typeof dirPath !== 'string' || !dirPath) return { ok: false, error: '路径无效' }
    const res = store.addRoot(dirPath)
    if (res.ok) {
      // 添加后立即做首次扫描
      setImmediate(() => handleScan(res.root.id))
    }
    return res
  })

  ipcMain.handle(IpcChannels.LIB_PICK_DIR, async (e) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择素材库目录',
      properties: ['openDirectory'],
    })
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }
    return { ok: true, path: res.filePaths[0] }
  })

  ipcMain.handle(IpcChannels.LIB_REMOVE, (e, rootId) => store.removeRoot(rootId))
  ipcMain.handle(IpcChannels.LIB_SET_ENABLED, (e, rootId, enabled) =>
    store.setRootEnabled(rootId, !!enabled))
  // scope: { rootId, path } —— 扫描指定目录子树；无 scope 扫整根
  ipcMain.handle(IpcChannels.LIB_SCAN, (e, rootId, scope) => handleScan(rootId, scope, { force: true }))

  // ── 素材查询 ────────────────────────────────────
  ipcMain.handle(IpcChannels.ASSETS_QUERY, (e, query) => {
    const q = query || {}
    const items = queryEntries(q)
    return items
  })

  ipcMain.handle(IpcChannels.ASSETS_STATS, () => {
    const stats = { total: 0, favorites: 0, roots: 0 }
    for (const root of store.listRoots()) {
      const idx = store.getIndex(root.id)
      stats.roots++
      for (const entry of idx.entries.values()) {
        if (entry.pluginId && !registry.getById(entry.pluginId)) continue // 与列表口径一致
        stats.total++
        if (entry.favorite) stats.favorites++
      }
    }
    return stats
  })

  ipcMain.handle(IpcChannels.ASSET_GET_BY_PATH, (e, rootId, absPath) => {
    return store.getEntry(rootId, absPath)
  })

  // ── 标签/收藏/备注 ──────────────────────────────
  ipcMain.handle(IpcChannels.ASSET_PATCH, (e, rootId, absPath, patch) => {
    // 停用库只读：禁止修改（收藏/标签/备注等），杜绝停用后仍可操作
    const root = store.getRoot(rootId)
    if (!root || !root.enabled) return null
    const entry = store.patchEntry(rootId, absPath, patch)
    if (entry) store.saveIndex(rootId)
    return entry
  })

  ipcMain.handle(IpcChannels.ASSET_BATCH_PATCH, (e, rootId, paths, patch) => {
    const root = store.getRoot(rootId)
    if (!root || !root.enabled) return { ok: false, error: '根目录已停用', count: 0 }
    let n = 0
    for (const p of paths) {
      const entry = store.patchEntry(rootId, p, patch)
      if (entry) n++
    }
    store.saveIndex(rootId)
    return { ok: true, count: n }
  })

  // ── 目录树 ──────────────────────────────────────
  ipcMain.handle(IpcChannels.DIR_TREE, (e, rootId) => buildDirTree(rootId))

  ipcMain.handle(IpcChannels.DIR_LIST, (e, rootId, dirPath) => {
    const root = store.getRoot(rootId)
    if (!root) return []
    const target = dirPath && dirPath !== root.path ? dirPath : root.path
    try {
      const dirents = fs.readdirSync(target, { withFileTypes: true })
      return dirents
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    } catch {
      return []
    }
  })

  // ── 文件夹视图：面包屑 + 子文件夹 + 本目录素材 ──
  /**
   * 构建当前素材库的文件夹树（含手动封面记录）。
   *
   * 抽出来是因为 folderView 和「把子文件夹封面提升给父级」都要用同一棵树 ——
   * 必须口径一致，否则算出来的「子文件夹当前显示的图」会和界面看到的不一样。
   */
  const currentFolderTree = () => {
    const roots = store.listRoots()
    const entries = []
    for (const r of roots) {
      const idx = store.getIndex(r.id)
      for (const en of idx.entries.values()) {
        if (en.pluginId && !registry.getById(en.pluginId)) continue // 与列表口径一致：停用/卸载类型不外显
        entries.push(en)
      }
    }
    if (!entries.length) return null
    return { roots, tree: buildFolderTree(roots, entries, store.settings.folderThumb) }
  }

  /** 取某目录的节点视图（nodeToView 结果）；取不到返回 null */
  const nodeViewOfDir = (rootId, dirPath) => {
    const root = store.getRoot(rootId)
    if (!root) return null
    const built = currentFolderTree()
    if (!built) return null
    const node = findFolder(built.tree, rootId, toRelPath(root.path, dirPath || ''))
    return node ? nodeToView(node) : null
  }

  ipcMain.handle(IpcChannels.FOLDER_VIEW, (e, rootId, dirPath) => {
    const root = store.getRoot(rootId)
    if (!root || !root.enabled) return null // 停用库不提供文件夹视图（渲染层另行提示「已停用」）
    const built = currentFolderTree()
    // 无任何素材 → 空（渲染层显示空状态）
    if (!built) return null
    const tree = built.tree
    // 目录树点击传的是绝对路径，需转为相对素材根的路径
    const rel = toRelPath(root.path, dirPath || '')
    const node = findFolder(tree, rootId, rel)
    if (!node) return null

    const chain = breadcrumbOf(tree, rootId, rel).map(nodeToView)
    const folders = node.children.map(nodeToView)
    const assets = node.assets.map(slimEntry)

    // 排序在渲染层做（按顶栏排序键）；这里按名称给默认序
    return {
      rootId,
      path: node.path,
      absPath: node.absPath,
      chain,
      folders,
      assets,
      total: node.subtree.length,
      // 带上该目录上次用的排序方案（没有则 null → 渲染层回落全局默认）。
      // 顺路返回是为了省一次往返：进目录本来就要发这个请求。
      sort: store.getFolderSort(rootId, rel),
    }
  })

  // ── 每个文件夹的排序方案 ────────────────────────
  /*
   * 「记住每个文件夹的排序」的读写口。
   *
   * 关键约定：**入参 dirPath 一律是绝对路径**（渲染层的 state.activeDir 就是绝对的），
   * 由主进程用 toRelPath 转成相对路径后再存取。
   * 之前踩过的坑：渲染层存绝对路径、folderView 按相对路径查，
   * 两边对不上 → 存进去的记录永远读不回来，表现为「记不住」。
   * 把转换收在主进程这一处，渲染层就不需要知道键是怎么拼的。
   *
   * 校验也放在主进程：非法排序值一律退回默认，
   * 免得脏数据写进 settings.json 后每次启动都读出一个坏排序。
   */
  const SORT_KEYS = ['name', 'time', 'size']
  const normalizeSortKey = (v) => (SORT_KEYS.includes(v) ? v : 'name')
  const normalizeSortOrder = (v) => (v === 'desc' ? 'desc' : 'asc')

  /** 绝对目录 → 该根的相对路径（存入键用）；素材库不存在时返回 null */
  const relOfDir = (rootId, dirPath) => {
    const root = store.getRoot(rootId)
    if (!root) return null
    return toRelPath(root.path, String(dirPath || ''))
  }

  ipcMain.handle(IpcChannels.FOLDER_SORT_GET, (e, rootId, dirPath) => {
    const rel = relOfDir(rootId, dirPath)
    if (rel === null) return null
    return store.getFolderSort(rootId, rel)
  })

  ipcMain.handle(IpcChannels.FOLDER_SORT_SET, (e, rootId, dirPath, sort, order) => {
    const rel = relOfDir(rootId, dirPath)
    if (rel === null) return { ok: false, error: '素材库不存在' }
    return store.setFolderSort(rootId, rel, normalizeSortKey(sort), normalizeSortOrder(order))
  })

  // ── 手动指定文件夹封面 ──────────────────────────
  /*
   * 语义：把**某个素材的缩略图**指定为**它所在文件夹**的封面。
   * 只影响这一个文件夹的显示；父文件夹会跟着变，是因为它本来就走
   * 「子文件夹优先」去取子级的 representative（见 folderTree.pickRepresentative）。
   *
   * 入参与 folderSort 完全一致：dirPath 一律是**绝对路径**（渲染层的 state.activeDir
   * 就是绝对的），由主进程用 toRelPath 转相对路径后再存取 —— 转换只在这一处，
   * 渲染层不需要知道键是怎么拼的（这个坑在 folderSort 上踩过一次）。
   */
  ipcMain.handle(IpcChannels.FOLDER_THUMB_SET, (e, rootId, dirPath, assetName) => {
    const rel = relOfDir(rootId, dirPath)
    if (rel === null) return { ok: false, error: '素材库不存在' }
    const name = String(assetName || '').trim()
    if (!name) return { ok: false, error: '素材名不能为空' }
    // 素材名必须是单纯的**文件名**（不含路径分隔符），否则可能指向目录之外
    if (name !== path.basename(name) || name === '.' || name === '..') {
      return { ok: false, error: '素材名非法' }
    }
    /*
     * 校验素材确实存在于该目录，且是**直属**的。
     *
     * 为什么不信任渲染层传来的名字：记录是持久的，一旦写进脏名字（拼错的、
     * 或指向别处的），folderTree 那边只会静默回落到自动规则 —— 用户看到的
     * 是「设了没反应」，很难查。挡在入口，错误就能直接回报到界面。
     *
     * 用 dirPath（渲染层传的绝对路径）而不是拿 rel 去拼，少一次换算。
     */
    const abs = path.join(String(dirPath || ''), name)
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      return { ok: false, error: '素材不存在：' + name }
    }
    if (!st.isFile()) return { ok: false, error: '只能指定文件作为封面：' + name }
    return store.setFolderThumb(rootId, rel, name)
  })

  /*
   * 把**子文件夹当前的封面**用起来，让它成为**父文件夹**显示的封面。
   *
   * 用途：一个文件夹里有好几个子文件夹时，各自已经挑好了封面；
   * 想让父文件夹用其中某一个的图，就右键那个子文件夹选这一项 ——
   * 不需要进到子文件夹里面，也不需要跨级指定后代素材。
   *
   * 实现：记录直接写在**父目录**上，值形如 `sub:00base`（见 folderTree.SUB_PREFIX）。
   * 用「子文件夹的**代表图**」来校验可用性 —— 子文件夹可能从没手动设过
   * （图是自动规则挑出来的），那种情况同样应该能拿来用。
   *
   * 为什么不用「把子文件夹的封面固化」那种做法（试过，有歧义）：
   *   同级有多个手动设过封面的子文件夹时，挑代表图只能退回按名称序取第一个，
   *   于是「先给 A 设、再给 B 设」可能仍然显示 A —— 第二次设看起来没反应。
   *   在父目录自己身上记一个明确的指针就没有这个问题。
   *   子文件夹自身的显示完全不受影响。
   */
  ipcMain.handle(IpcChannels.FOLDER_THUMB_FROM_CHILD, (e, rootId, childDirPath) => {
    const root = store.getRoot(rootId)
    if (!root) return { ok: false, error: '素材库不存在' }
    const childAbs = String(childDirPath || '').replace(/[\\/]+$/, '')
    if (!childAbs) return { ok: false, error: '目录不能为空' }

    // 素材库根没有父文件夹（注意：dirname('E:\\MMD') === 'E:\\'，不能只靠 dirname 判断）
    if (path.resolve(childAbs) === path.resolve(String(root.path).replace(/[\\/]+$/, ''))) {
      return { ok: false, error: '素材库根目录没有父文件夹' }
    }
    const parentAbs = path.dirname(childAbs)
    const parentRel = relOfDir(rootId, parentAbs)
    if (parentRel === null) return { ok: false, error: '父文件夹不在素材库里' }

    const childRel = relOfDir(rootId, childAbs)
    if (childRel === null) return { ok: false, error: '子文件夹不在素材库里' }
    // 子文件夹名（树里的 key 用名称逐级定位，所以取最后一段）
    const childName = childRel.split('/').pop()
    if (!childName) return { ok: false, error: '无法确定子文件夹名' }

    /*
     * 校验该子文件夹当前确实有封面可拿来用（否则记上去父目录会静默回落，
     * 又变成「设了没反应」）。用 nodeViewOfDir 保证与界面所见一致。
     */
    const view = nodeViewOfDir(rootId, childAbs)
    if (!view || !view.representative) return { ok: false, error: '该文件夹当前没有可用的封面图' }

    const r = store.setFolderThumb(rootId, parentRel, folderTree.subRef(childName))
    return { ...r, parent: parentRel, child: childName, asset: view.representative.name }
  })

  ipcMain.handle(IpcChannels.FOLDER_THUMB_CLEAR, (e, rootId, dirPath) => {
    const rel = relOfDir(rootId, dirPath)
    if (rel === null) return { ok: false, error: '素材库不存在' }
    return store.clearFolderThumb(rootId, rel)
  })

  /*
   * 查某目录当前的手动封面。
   *
   * 为什么要单独开这个口，而不是复用 folderView：
   *   • 右侧文件夹右键菜单可能来自**左侧目录树**，那条链路走的是 dir:tree，
   *     数据里根本没有 manualThumb 字段；
   *   • folderView 为了拿一个字符串会把整棵树全量重建一遍，代价不成比例。
   * 这里只查一次 map，O(1)。
   */
  ipcMain.handle(IpcChannels.FOLDER_THUMB_GET, (e, rootId, dirPath) => {
    const rel = relOfDir(rootId, dirPath)
    if (rel === null) return null
    return store.getFolderThumb(rootId, rel)
  })

  // ── 文件操作 ────────────────────────────────────
  ipcMain.handle(IpcChannels.FILE_OPEN, async (e, absPath) => {
    const err = await shell.openPath(absPath)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle(IpcChannels.FILE_REVEAL, async (e, absPath) => {
    shell.showItemInFolder(absPath)
    return { ok: true }
  })

  // 缩略图 URL：`<素材名>.preview.*` 命名的图片 / 类型占位（不使用插件渲染当缩略图）
  ipcMain.handle(IpcChannels.THUMB_URL, (e, entry) => {
    const t = cachedResolve(entry)
    if (t.type === 'image') {
      /*
       * URL 带 `?v=<mtime>` 版本号 —— 这是**给 Chromium 用的缓存失效手段**。
       *
       * 预览窗口里用同名新图覆盖旧图时，路径完全没变；即便响应头是
       * no-cache，<img> 也会沿用内存里那张已解码的旧图，界面看起来「没反应」。
       * 版本号一变就是另一个 URL，Chromium 必然重新取图。
       * （服务端那层缓存见 thumbs.cachedResolve 的签名。）
       */
      const v = thumbVersionOf(t.path)
      return { type: 'image', url: 'asset://thumb/' + encodeURIComponent(t.path) + (v ? '?v=' + v : '') }
    }
    // 没有缩略图 → 只显示文件类型
    return { type: 'placeholder', url: placeholderSvg(t.ext, 320) }
  })

  // 按需生成缩略图（插件 canThumbnail → 素材同目录 <素材文件名>.preview.png）
  ipcMain.handle(IpcChannels.THUMB_GENERATE, (e, scope) => handleGenerateThumbs(scope || {}))
  ipcMain.handle(IpcChannels.THUMB_PENDING, (e, scope) => handleThumbPending(scope || {}))
  ipcMain.handle(IpcChannels.THUMB_CLEAR, (e, scope) => handleClearThumbs(scope || {}))
  ipcMain.handle(IpcChannels.THUMB_REBUILD, (e, rootId, assetPath) => handleRebuildThumb(rootId, assetPath))

  // 预览素材（仅插件声明 canPreview → 预览宿主；无能力返回错误，系统打开走 FILE_OPEN）
  ipcMain.handle(IpcChannels.FILE_PREVIEW, async (e, entry) => {
    const plugin = entry.pluginId ? registry.getById(entry.pluginId) : null
    if (!plugin || !plugin.canPreview) {
      return { ok: false, error: '该素材类型未启用预览能力（插件未声明 canPreview）' }
    }
    try {
      /*
       * 预览前的可选钩子 `preparePreview(filePath)`。
       *
       * ── 为什么需要它 ────────────────────────────────────
       * 预览窗口里的 viewer 没有 fs、也没有 IPC，唯一通道是 asset://，
       * 只能读**已经知道路径**的文件。所以插件若要在预览时用到
       * 「素材旁边有什么」这类信息，必须在主进程侧先查好、写进插件目录。
       *
       * 而 parse() 靠不住：扫描结果有缓存，素材文件没变就不会重新 parse，
       * 于是「插件更新后新加的逻辑」对**已扫描过的老素材**永远不生效。
       * 放到这里就与缓存无关 —— 每次打开预览都恰好在需要之前跑一次。
       *
       * 主程序不知道任何文件类型知识，只是「插件声明了就调一下」；
       * 钩子抛错不影响预览（插件自己的可选功能，不该挡住主流程）。
       */
      if (typeof plugin.preparePreview === 'function') {
        try {
          await plugin.preparePreview(entry.path)
        } catch {
          // 静默：钩子失败只影响插件的附加功能
        }
      }
      await openPreview(entry, plugin, pluginsDir)
      return { ok: true, mode: 'preview' }
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) }
    }
  })

  // ── 设置 ────────────────────────────────────────
  // 缩略图尺寸（生成缩略图时交给插件的渲染分辨率）属于主程序通用设置；
  // 预览背景等仍由插件自行声明/渲染宿主决定，主程序不持有。
  ipcMain.handle(IpcChannels.SETTINGS_GET, () => ({ ...store.settings, thumbSizes: THUMB_SIZES }))
  ipcMain.handle(IpcChannels.SETTINGS_SET, (e, patch) => {
    const allowed = ['scanConcurrency', 'thumbSize', 'gridSize', 'sidebarWidth', 'detailWidth']
    const clean = {}
    for (const k of allowed) if (k in patch) clean[k] = patch[k]
    if ('thumbSize' in clean) clean.thumbSize = normalizeThumbSize(clean.thumbSize)
    if ('gridSize' in clean) clean.gridSize = normalizeGridSize(clean.gridSize)
    if ('sidebarWidth' in clean) clean.sidebarWidth = Math.max(140, Math.min(480, Math.round(clean.sidebarWidth)))
    if ('detailWidth' in clean) clean.detailWidth = Math.max(200, Math.min(700, Math.round(clean.detailWidth)))
    return store.updateSettings(clean)
  })

  // ── 长任务取消（进度条上的「停止」按钮） ────────
  // 支持两种入参：{ taskId } 只停某一条（每条进度条各自）；字符串 kind 停一类（兼容）。
  // 只是「请求停止」——任务在下一个可中断点收尾后自行退出，这里不阻塞等待；
  // 排队中的任务会被直接移除。
  ipcMain.handle(IpcChannels.TASK_CANCEL, (e, arg) => {
    if (arg && typeof arg === 'object' && typeof arg.taskId === 'number') {
      return { ok: true, count: cancelTaskById(arg.taskId) }
    }
    const kind = typeof arg === 'string' && arg ? arg : null
    return { ok: true, count: cancelTasks(kind) }
  })

  // ── 插件 ────────────────────────────────────────────
  /**
   * detail 声明 → 可过 IPC 的副本。
   *
   * `detail` 里现在可能带 buttons[].run（函数），函数无法被结构化克隆，
   * 直接下发会抛错。这里剥掉 run，只留展示信息；界面点按钮时凭 id 回调主进程。
   * （与 actions 的处理方式一致。）
   */
  const sanitizeDetail = (detail) => {
    if (!detail || typeof detail !== 'object') return null
    const out = { ...detail }
    if (Array.isArray(detail.buttons)) {
      out.buttons = detail.buttons.map((b) => ({ id: b.id, label: b.label, icon: b.icon || '' }))
    }
    return out
  }

  // 插件列表：plugins/ 目录中的全部插件（含已禁用的）+ 运行时注入的；带启用状态/设置
  //
  // declaredIcon = 插件**自己声明的**图标（未经界面覆盖）。
  // 弹窗的「恢复默认」要预览「清除覆盖后真实会显示什么」，那正是插件声明的这个；
  // 只给生效值（icon）的话，覆盖存在时就预览不出回退结果。
  const toPluginView = (m, enabled, declaredIcon = '', declaredDblclick = null, declaredExtIcons = null) => ({
    id: m.id,
    name: m.name,
    version: m.version || '',
    description: m.description || '',
    icon: m.icon || '',
    declaredIcon,
    // 按扩展名的图标覆盖（已合并「用户覆盖 > 插件声明」）
    extIcons: m.extIcons || null,
    // 插件**自己声明的**按扩展名图标（未经覆盖），供弹窗的「恢复」回到这里
    declaredExtIcons: declaredExtIcons || null,
    simple: !!m.simple,
    exts: m.exts || [],
    kind: m.kind || null,
    canPreview: !!m.canPreview,
    canThumbnail: !!m.canThumbnail,
    viewer: m.viewer || null,
    previewHtml: m.previewHtml || null,
    // 双击行为：已合并「用户覆盖 > 插件声明」，null 表示两者都没有 → 界面用全局默认
    dblclick: m.dblclick || null,
    // 插件**自己声明的**双击行为（未经覆盖），供设置页显示「跟随插件声明（当前：…）」
    declaredDblclick: declaredDblclick || null,
    actions: (m.actions || []).map((a) => ({ id: a.id, label: a.label, scope: a.scope })), // run 保留在主进程
    actionCount: (m.actions || []).length,
    // detail 要过 IPC，函数不能序列化 —— 与 actions 同理，只下发按钮的展示信息，
    // run 留在主进程，界面点按钮时凭 id 回调 PLUGIN_BUTTON。
    detail: sanitizeDetail(m.detail),
    detailFields: m.detail && m.detail.fields ? m.detail.fields.length : 0,
    detailButtons: m.detail && m.detail.buttons ? m.detail.buttons.length : 0,
    settingsDef: m.settings || [],
    enabled,
    settings: pluginSettings ? pluginSettings.get(m.id, m.settings || []) : {},
    dir: path.join(pluginsDir, m.id),
  })

  /** 读插件「自己声明的」图标（不经界面覆盖）；读不到就返回空串 */
  const declaredIconOf = (id) => {
    const f = path.join(pluginsDir, id, 'index.cjs')
    if (!fs.existsSync(f)) return ''
    try {
      delete require.cache[require.resolve(f)]
      const raw = require(f)
      return typeof raw.icon === 'string' ? raw.icon : ''
    } catch {
      return ''
    }
  }

  /**
   * 读插件「自己声明的」按扩展名图标（不经界面覆盖）。
   * 与 declaredIconOf 同一套理由：弹窗的「恢复」要预览清除覆盖后的真实结果。
   */
  const declaredExtIconsOf = (id) => {
    const f = path.join(pluginsDir, id, 'index.cjs')
    if (!fs.existsSync(f)) return null
    try {
      delete require.cache[require.resolve(f)]
      const raw = require(f)
      const v = validateManifest(raw) // 借用同一套清洗规则，保证形状一致
      return (v && v.extIcons) || null
    } catch {
      return null
    }
  }

  ipcMain.handle(IpcChannels.PLUGIN_LIST, () => {
    const disabled = new Set(store.settings.disabledPlugins || [])
    const seen = new Set()
    const out = []
    // 1) plugins/ 目录下的插件（含禁用的 —— 禁用后仍可在此重新启用）
    try {
      for (const ent of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        const indexFile = path.join(pluginsDir, ent.name, 'index.cjs')
        if (!fs.existsSync(indexFile)) continue
        try {
          // 清单规范校验：与 loadPlugins 同一套规则 —— 不合规范的插件不会加载，
          // 这里也不列进正常列表（它会出现在「加载失败」提示里，避免「列出来了却不能用」）。
          const spec = locateDeclaredId(fs.readFileSync(indexFile, 'utf8'))
          if (!spec.ok) continue
          delete require.cache[require.resolve(indexFile)]
          const raw = require(indexFile)
          const m = validateManifest(raw)
          if (!m) continue
          // 与加载路径同一套规则：id 以文件夹名为准 + 叠加界面覆盖
          m.id = ent.name
          const declaredIcon = typeof raw.icon === 'string' ? raw.icon : ''
          const declaredDbl = normalizeDblclick(raw.dblclick)
          const declaredExt = (m.extIcons && { ...m.extIcons }) || null // 覆盖前的声明值
          applyOverrides(m, pluginOverrides ? pluginOverrides.get(ent.name) : null)
          seen.add(m.id)
          out.push(toPluginView(m, !disabled.has(m.id), declaredIcon, declaredDbl, declaredExt))
        } catch (err) {
          console.warn('[plugin] 读取失败', ent.name, err && err.message || err)
        }
      }
    } catch {}
    // 2) 注册表中但不在目录的（运行时注入，如 UI 冒烟）
    for (const m of registry.list()) {
      if (seen.has(m.id)) continue
      out.push(toPluginView(m, !disabled.has(m.id), declaredIconOf(m.id), m.dblclick || null, declaredExtIconsOf(m.id)))
    }
    return out
  })

  // 最近一次插件加载失败清单（设置页展示「插件为何不见了」）
  ipcMain.handle(IpcChannels.PLUGIN_LOAD_ERRORS, () => pluginLoadFailures.map((f) => ({ ...f })))

  // 选择插件 zip 压缩包（安装用）
  ipcMain.handle(IpcChannels.PLUGIN_PICK_ZIP, async () => {    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择插件压缩包',
      properties: ['openFile'],
      filters: [{ name: '插件压缩包', extensions: ['zip'] }],
      buttonLabel: '选择',
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    return { ok: true, path: res.filePaths[0] }
  })

  // 安装插件（zip 压缩包 → 解压校验 → 复制到 plugins/<id>）
  ipcMain.handle(IpcChannels.PLUGIN_INSTALL, async (e, srcPath) => {
    /*
     * 安装前风险提示 —— 这不是多余的确认框，而是如实告知：
     * 插件在主进程里以完整 Node 权限运行（pluginHost 直接 require），
     * 能读写任意文件、联网、执行子进程。装一个 zip 等于信任它的作者。
     * 用户有权在知情的前提下再决定。
     */
    const confirm = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '我已了解，继续安装'],
      defaultId: 0,
      cancelId: 0,
      title: '安装插件',
      message: '插件会以完整权限在你的电脑上运行',
      detail:
        '素材管理器不限制插件的能力：它可以读写你电脑上的任意文件、访问网络、'
        + '运行其它程序。\n\n'
        + '请只安装来源可信的插件。安装后若出现问题，可在「插件」页停用或卸载。\n\n'
        + `来源：${path.basename(srcPath)}`,
      noLink: true,
    })
    if (confirm.response !== 1) return { ok: false, canceled: true }

    const res = await installPlugin(pluginsDir, srcPath)
    if (res.ok) {
      // 安装后重新加载该插件（清缓存 + 注册），并触发全量重扫
      try {
        clearRequireCache(path.join(pluginsDir, res.id))
        const raw = require(path.join(pluginsDir, res.id, 'index.cjs'))
        const manifest = validateManifest(raw)
        if (manifest) {
          manifest.id = res.id // id 以文件夹名为准
          applyOverrides(manifest, pluginOverrides.get(res.id))
          registry.register(manifest)
          console.log(`[plugin] 安装并加载: ${manifest.name}`)
          res.manifest = manifest
          // 触发所有根目录重扫（插件签名已变）
          rescanAllRoots()
        }
      } catch (err) {
        console.error('[plugin] 安装后加载失败:', err)
        res.warn = '安装成功但加载失败：' + err.message
      }
    }
    return res
  })

  ipcMain.handle(IpcChannels.PLUGIN_CREATE, (e, opts) => handleCreatePlugin(opts || {}))

  // 插件设置更新（改名 / 改文件夹名 / 类型颜色 / 类型图标 / 简易插件增删扩展名）
  ipcMain.handle(IpcChannels.PLUGIN_UPDATE, (e, payload) => handlePluginUpdate(payload || {}))

  // 选择类型图标（图片文件）
  ipcMain.handle(IpcChannels.PLUGIN_PICK_ICON, (e, pluginId) => handlePluginPickIcon(pluginId))
  ipcMain.handle(IpcChannels.PLUGIN_DISCARD_ICON, (e, pluginId, fileName) => handlePluginDiscardIcon(pluginId, fileName))

  // 插件设置项 type:'dir' —— 选文件夹、复制进插件目录、清除
  ipcMain.handle(IpcChannels.PLUGIN_PICK_DIR, (e, pluginId, opts) => handlePluginPickDir(pluginId, opts || {}))
  ipcMain.handle(IpcChannels.PLUGIN_DELETE_DIR, (e, pluginId, relPath) => handlePluginDeleteDir(pluginId, relPath))
  // 插件设置项 type:'file' —— 列出已选文件夹里的候选文件
  ipcMain.handle(IpcChannels.PLUGIN_LIST_FILES, (e, pluginId, opts) => handlePluginListFiles(pluginId, opts || {}))

  // 卸载插件（删除整个插件目录 + 注销，即时生效）
  ipcMain.handle(IpcChannels.PLUGIN_UNINSTALL, async (e, pluginId) => {
    const res = await uninstallPlugin(pluginsDir, pluginId)
    if (res.ok) {
      // 卸载后做受影响条目的内存整理（归属迁移/剔除 + 指纹对齐），不再全量重扫
      reconcileAfterPluginRemoved(pluginId)
    }
    return res
  })

  // 启用/禁用（持久化 + 立即注销/注册 + 重扫，无需重启）
  ipcMain.handle(IpcChannels.PLUGIN_SET_ENABLED, (e, pluginId, enabled) => {
    const disabled = new Set(store.settings.disabledPlugins || [])
    if (enabled) disabled.delete(pluginId)
    else disabled.add(pluginId)
    store.updateSettings({ disabledPlugins: [...disabled] })

    if (!enabled) {
      // 禁用：立即注销 → 该类型素材通过查询层实时过滤从库中消失（零扫描、无需碰索引）。
      // 启用后注册即恢复，同样零扫描（文件始终在索引里）。
      registry.unregister(pluginId)
      return { ok: true, enabled: false }
    }

    // 启用：无论注册表当前是否有该插件（如重启后被跳过加载），都从磁盘重新加载
    try {
      clearRequireCache(path.join(pluginsDir, pluginId))
      const raw = require(path.join(pluginsDir, pluginId, 'index.cjs'))
      const m = validateManifest(raw)
      if (!m) return { ok: false, error: '插件 manifest 无效' }
      m.id = pluginId // id 以文件夹名为准
      applyOverrides(m, pluginOverrides.get(pluginId))
      registry.register(m)
      // 只有「该类型从未被索引过」（如新装扩展名）才需要扫描发现；停用过的插件文件仍在索引里，
      // 注册后由查询层自动恢复显示，无需扫描。
      const hasIndexed = store.listRoots().some((r) => {
        for (const en of store.getIndex(r.id).entries.values()) if (en.pluginId === pluginId) return true
        return false
      })
      if (!hasIndexed) rescanAllRoots()
      return { ok: true, enabled: true }
    } catch (err) {
      console.error('[plugin] 启用失败:', err)
      // 回滚禁用列表，避免状态与文件不一致
      const rb = new Set(store.settings.disabledPlugins || [])
      rb.add(pluginId)
      store.updateSettings({ disabledPlugins: [...rb] })
      return { ok: false, error: String(err && err.message || err) }
    }
  })

  // 插件自定义设置保存（即时生效：重扫使 parse 元数据/详情栏刷新）
  ipcMain.handle(IpcChannels.PLUGIN_SETTINGS_SAVE, (e, pluginId, values) => {
    const manifest = registry.getById(pluginId)
    if (!manifest) return { ok: false, error: '插件不存在' }
    pluginSettings.set(pluginId, values)
    /*
     * 设置可能影响 parse 的输出（入口：插件把设置镜像进自己目录供预览窗口读，
     * 或按设置决定要提取哪些元数据）。而扫描器只在**文件自身**变化时才重跑 parse，
     * 所以这里必须主动重跑该插件的条目 —— 否则「刚改完设置」和「界面上看到的」
     * 会一直对不上，点多少次扫描都没用（文件确实没变，扫描器没错）。
     */
    const reparsed = reparsePlugin(store, pluginId)
    if (!reparsed) rescanAllRoots() // 没有已索引条目（如刚装上还没扫）→ 走一次扫描
    return { ok: true, reparsed }
  })

  // 执行插件自定义操作（single/multi）
  ipcMain.handle(IpcChannels.PLUGIN_ACTIONS, async (e, pluginId, actionId, filePaths) => {
    const manifest = registry.getById(pluginId)
    if (!manifest) return { ok: false, error: '插件不存在' }
    const action = (manifest.actions || []).find((a) => a.id === actionId)
    if (!action) return { ok: false, error: '操作不存在' }
    // 走 safeAction：插件抛异常或卡住都会给用户明确提示，主进程不受影响
    return safeAction(manifest, action, filePaths)
  })

  // 执行插件详情栏按钮（返回值交给界面呈现：长文本弹窗 / 普通提示）
  ipcMain.handle(IpcChannels.PLUGIN_BUTTON, async (e, pluginId, buttonId, rootId, filePath) => {
    const manifest = registry.getById(pluginId)
    if (!manifest) return { ok: false, error: '插件不存在' }
    const detail = manifest.detail
    const button = detail && (detail.buttons || []).find((b) => b.id === buttonId)
    if (!button) return { ok: false, error: '按钮不存在' }
    // 安全闸：只接受「索引里确实存在的素材」，插件拿不到任意路径
    const entry = store.getEntry(rootId, filePath)
    if (!entry) return { ok: false, error: '该素材不在索引中' }
    return safeButton(manifest, button, entry.path)
  })
}

/** 绝对路径 → 相对素材根的路径（含根自身时返回 ''）；分隔符统一为 '/' */
function toRelPath(rootPath, absPath) {
  if (!absPath) return ''
  const sep = rootPath.includes('\\') ? '\\' : '/'
  const normRoot = rootPath.replace(/[\\/]+$/, '')
  if (absPath === normRoot) return ''
  if (absPath.startsWith(normRoot + sep)) {
    return absPath.slice(normRoot.length + 1).split(/[\\/]/).join('/')
  }
  return absPath.split(/[\\/]/).join('/')
}

/**
 * 收集某个素材根下**当前真实存在**的目录相对路径（含空串 = 根目录自身），
 * 用来清理失效的排序记录。
 *
 * 目录来源取索引里每条素材所在目录**及其全部祖先**：
 *   素材在 `a\b\c\x.blend` → a、a/b、a/b/c 都是活着的目录。
 * 只把素材自身目录算进去是不够的 —— 祖先目录同样可能被用户单独排过序，
 * 而如果某目录一篇素材都没有、其子目录也没有，那它确实已经不存在了，
 * 被清掉正是我们想要的。
 *
 * 注意 toRelPath 统一用 `/` 分隔，所以这里也按 `/` 切分，两边口径必须一致。
 */
function liveDirRelPaths(root) {
  const live = new Set([''])
  const idx = store.getIndex(root.id)
  if (!idx || !idx.entries) return live
  for (const en of idx.entries.values()) {
    if (en.status === 'missing') continue
    // 素材所在目录（相对路径，/ 分隔）
    const rel = toRelPath(root.path, en.dir || '')
    if (!rel) continue
    live.add(rel)
    // 逐级补上祖先目录
    const parts = rel.split('/')
    for (let i = parts.length - 1; i >= 1; i--) {
      live.add(parts.slice(0, i).join('/'))
    }
  }
  return live
}

/** 清掉某根下已不存在目录的排序/封面记录（扫描后调用；幂等、可反复执行） */
function pruneFolderSortForRoot(rootId) {
  const root = store.getRoot(rootId)
  if (!root) return { removed: 0 }
  const live = liveDirRelPaths(root)
  // 两种记录用同一份「现存目录」集合：目录都没了，排序和封面都该清掉
  const a = store.pruneFolderSort(rootId, live)
  const b = store.pruneFolderThumb(rootId, live)
  return { removed: a.removed + b.removed }
}

/** 全部根目录重扫（插件变更后调用） */
function rescanAllRoots() {
  const enabledRoots = store.listRoots().filter((r) => r.enabled)
  for (const root of enabledRoots) {
    handleScan(root.id)
  }
}

/**
 * 构建根目录的目录树（含素材计数，供左侧浏览）
 *
 * 只保留「自身或子孙含素材」的目录：完全没有素材的分支整棵剪掉。
 * 素材库里 tex / toon / sph / textures / readme 这类只放贴图或说明的目录很常见，
 * 全量显示会把真正放着模型的目录淹没（与「文件夹视图」的口径保持一致 ——
 * buildFolderTree 只按素材条目建节点，本来就不含无素材目录）。
 */
/**
 * 构建根目录的目录树（含素材计数，供左侧浏览）。
 *
 * 只保留「自身或子孙含素材」的目录：完全没有素材的分支整棵剪掉。
 * 素材库里 tex / toon / sph / textures / readme 这类只放贴图或说明的目录很常见，
 * 全量显示会把真正放着模型的目录淹没（与「文件夹视图」的口径保持一致 ——
 * buildFolderTree 只按素材条目建节点，本来就不含无素材目录）。
 *
 * 历史版本是「对真实文件系统逐目录 readdir」：素材.0（1.4 万目录）要顺序 await 1.4 万次
 * readdir，实测 35s+，启用大库后目录树空白半分钟（虽然渲染进程保持响应）。
 * 改为**纯索引内存重建**：树的内容 = 含素材的目录 + 其全部祖先（counts 只来自索引条目
 * 路径），零文件系统 I/O，语义与原来完全一致，万级库毫秒级出树。
 */
function buildDirTree(rootId) {
  const root = store.getRoot(rootId)
  if (!root) return null
  const idx = store.getIndex(rootId)
  const normRoot = root.path.replace(/[\\/]+$/, '')

  // 目录 -> 直接素材数（只来自索引条目；零 I/O）
  const counts = new Map()
  const sep = root.path.includes('\\') ? '\\' : '/'
  for (const e of idx.entries.values()) {
    const dir = path.dirname(e.path)
    if (!dir.startsWith(normRoot)) continue // 越界条目不参与（防御）
    if (e.pluginId && !registry.getById(e.pluginId)) continue // 停用/卸载插件的类型不外显（与列表口径一致）
    counts.set(dir, (counts.get(dir) || 0) + 1)
  }

  // 含素材目录 + 其全部祖先（中间层即使自己无素材，只要子孙有就保留）
  const keep = new Set([normRoot])
  for (const dir of counts.keys()) {
    let cur = dir
    while (cur && cur.length >= normRoot.length && cur.startsWith(normRoot)) {
      keep.add(cur)
      if (cur === normRoot) break
      const i = cur.lastIndexOf(sep)
      if (i <= 0) break
      cur = cur.slice(0, i)
    }
  }

  // 建节点 + 父子映射
  const nodeOf = (dir) => ({ path: dir, name: path.basename(dir), count: counts.get(dir) || 0, total: 0, children: [] })
  const nodes = new Map()
  for (const dir of keep) nodes.set(dir, nodeOf(dir))
  const childrenOf = new Map() // dir -> [子目录]
  for (const dir of keep) {
    if (dir === normRoot) continue
    const i = dir.lastIndexOf(sep)
    const parent = i > 0 ? dir.slice(0, i) : normRoot
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent).push(dir)
  }

  // 后序累计 total + 挂子节点；同级按名称（中文）排序
  const byName = (a, b) => path.basename(a).localeCompare(path.basename(b), 'zh')
  function accumulate(dir) {
    const node = nodes.get(dir)
    const kids = (childrenOf.get(dir) || []).sort(byName)
    let total = node.count
    for (const k of kids) total += accumulate(k)
    node.total = total
    node.children = kids.map((k) => nodes.get(k))
    return total
  }
  accumulate(normRoot)

  // 素材库根节点始终保留：空库时渲染层要能拿到根（拿到 null 会提示「尚未扫描」）
  return nodes.get(normRoot) || { path: root.path, name: path.basename(root.path), count: 0, total: 0, children: [] }
}



// ── 启动 ────────────────────────────────────────────
/*
 * asset: 必须登记为「特权协议」，且**只能在 app ready 之前登记**。
 *
 * 不登记会怎样（实测踩到过）：
 *   • <video src="asset://..."> 拿不到数据 → 预览窗口一片黑
 *   • fetch('asset://...') 直接抛 "Failed to fetch"，
 *     即使 protocol.handle 已经正确返回了 206 —— 因为渲染层把这些
 *     非标准 scheme 当成跨域资源，压根不会走到协议处理器。
 * 登记后该协议被视为同源、可流式、可被 fetch/XHR 访问。
 *
 * stream: true 是视频拖进度条的关键（配合 Range/206 分段响应）。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,       // 允许流式响应（大视频不整块缓冲）
      bypassCSP: false,
    },
  },
])

// 测试模式：重定向 userData 到临时目录（避免污染真实数据），须在 app ready 前执行
if (isTestMode() || isUiSmoke()) isolateUserData()

app.whenReady().then(async () => {
  migrateDataDirIfNeeded() // 历史数据（%APPDATA%\<app>\data）→ 软件主目录/data（不覆盖新位置）
  store = new Store(DATA_DIR)
  // 测试模式下 plugins 指向临时目录（避免往真实插件目录写测试插件）
  pluginsDir = (isTestMode() || isUiSmoke())
    ? smokePluginsDir()
    : path.join(__dirname, '../../plugins') // 项目根/plugins
  fs.mkdirSync(pluginsDir, { recursive: true })
  pluginSettings = new PluginSettingsStore(DATA_DIR) // 插件设置随数据目录（便携）；旧文件由迁移复制
  pluginOverrides = new PluginOverridesStore(DATA_DIR) // 界面改动（显示名/扩展名/图标/颜色）随数据目录

  // asset:// 的允许范围：素材库根（store 提供）+ plugins 目录（此处赋值）
  pluginsDirForProtocol = pluginsDir
  registerAssetProtocol()
  registerIpc()

  /*
   * 预览窗口存完预览图后，通知主界面就地刷新那一张缩略图。
   *
   * 必须通知，不能只靠「用户再点一次扫描」：
   *   • 覆盖的是同名文件，<img> 的 URL 不变 → Chromium 仍用内存里那张旧图
   *   • 重新扫描重建的是索引，不碰界面上的 <img>，所以扫了也不会变
   * 收到事件后渲染层会把该素材的缩略图重新取一次（URL 带新版本号，必然重取）。
   */
  setThumbSavedNotifier((info) => {
    clearThumbCache() // 服务端那层缓存也要失效，否则取回的还是旧的
    broadcast(IpcEvents.THUMB_CHANGED, info)
  })

  // 加载插件（无插件 → 注册表为空 → 不显示任何文件）
  const bootLoad = await loadPlugins(pluginsDir, store.settings.disabledPlugins || [], pluginOverrides.all())
  pluginLoadFailures = (bootLoad && bootLoad.failed) || []
  for (const f of pluginLoadFailures) console.warn(`[plugin] 未加载 ${f.dir}：${f.error}`)
  // 插件就绪后如有启用根目录且已加载插件 → 全量重扫（插件签名变化）
  if (registry.size > 0) rescanAllRoots()

  createWindow()

  // UI 测试（环境变量触发）：把控制权交给 tests/ui.test.js
  if (isUiSmoke()) attachUiSmoke(mainWindow, pluginsDir, store)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 退出兜底：无论走哪条退出路径（关主窗口 / 菜单退出 / 系统关机），
 * 都在真正退出前把渲染宿主的窗口收干净，并在收尾后强制结束进程。
 *
 * 为什么要 exit(0)：预览窗口里跑着插件的 3D 渲染循环（requestAnimationFrame +
 * WebGL 上下文），一旦有窗口没能正常销毁，主进程会卡在退出流程里 ——
 * 表现为「软件界面没了，但任务管理器里 electron 进程还在」。这里在下一轮
 * 事件循环里直接 exit，保证「关掉主程序 = 所有窗口和进程都不残留」。
 */
let quitting = false
app.on('before-quit', () => {
  if (quitting) return
  quitting = true
  destroyAllHostWindows()
  setImmediate(() => app.exit(0))
})
