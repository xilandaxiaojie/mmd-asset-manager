/**
 * 渲染宿主（Render Host）
 *
 * 职责：为插件的「渲染能力」提供宿主基础设施 —— 主程序只提供**窗口框架与 API 注入**，
 * 渲染逻辑完全由插件的 viewer 模块实现。对应需求报告 §4.5。
 *
 *   • 缩略图渲染宿主：离屏窗口 + 内容容器，调用插件 viewer.snapshot() 生成 PNG 存盘
 *   • 预览宿主：独立预览窗口 + 内容容器，注入 window.__viewerApi__
 *
 * ── 通用化设计（本宿主不含任何素材类型假设）────────────────────────
 * 主程序不知道素材是 3D 模型、视频、音频还是文档。它只做三件事：
 *   1. 开一个窗口，给插件一个**空的容器元素**（不是画布）
 *   2. 把 API 注进去，让插件自行决定在容器里创建什么
 *      （<canvas>、<video>、<audio>、<iframe>、任意 DOM —— 全凭插件）
 *   3. 按「能力探测」调用插件导出的可选方法
 *
 * viewer 模块（插件提供，渲染进程侧动态 import）导出工厂：
 *   export default (api) => ({ mount, load, start, stop, resize,
 *                              setBackground, snapshot, waitReady, dispose })
 *
 * ── 方法分两层：核心 + 可选（一律 typeof 探测，缺了就跳过）────────
 *   核心： mount(container)  挂载到主程序给的容器元素
 *          dispose()         释放资源
 *   可选： load(path, opts)  加载素材（缩略图渲染时 opts = { size, thumbnail: true }）
 *          start() / stop()  启动、停止播放或渲染循环（视频/音频有意义，静态文档可忽略）
 *          resize(w, h)      容器尺寸变化
 *          setBackground(c)  背景色
 *          snapshot()        返回 dataURL。用在两处：缩略图渲染、预览窗口的
 *                            「生成预览图」按钮。与 canPreview / canThumbnail
 *                            **互相独立** —— 只实现其中一个场景也是合法的
 *          waitReady()       等待异步资源就绪后再快照（旧名 waitForTextures 仍兼容）
 *          loadMotion(path)  MMD 等动画格式的附加资源（可选，主程序不主动调用）
 *
 * 主程序不含任何类型逻辑；能否预览完全由插件的 canPreview 决定，
 * 能否生成缩略图完全由插件的 canThumbnail 决定。
 *
 * 缩略图渲染（renderThumbnail）由顶栏「缩略图」按钮触发：只针对插件声明
 * canThumbnail 且当前没有缩略图的素材，渲染结果落到素材同目录的 `<原名>.png`。
 */
const { BrowserWindow, app, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { normalizeThumbSize, DEFAULT_THUMB_SIZE, thumbOutPathFor, isPreviewFile } = require('./thumbs')

/** 缩略图离屏窗口（复用单例） */
let thumbWindow = null
let thumbReady = false
const THUMB_SIZE = DEFAULT_THUMB_SIZE

/**
 * 本宿主创建的全部窗口登记表（缩略图离屏窗口 + 所有预览窗口）。
 *
 * 为什么要登记：previewWindow 与 thumbWindow 都是独立的 BrowserWindow，
 * 它们**同样计入「还有窗口没关」**——用户关掉主窗口后，只要还有一个预览窗口
 * 活着，window-all-closed 就不会触发，主进程（连同 GPU / 渲染子进程）就一直
 * 残留。所以凡是本模块创建的窗口都要能被「一次性全部收掉」。
 */
const hostWindows = new Set()

/** 登记一个宿主窗口，并在它自行关闭时自动移出登记表（避免持有已销毁对象） */
function trackWindow(win) {
  hostWindows.add(win)
  win.on('closed', () => hostWindows.delete(win))
  return win
}

function getThumbWindow() {
  if (thumbWindow && !thumbWindow.isDestroyed()) return thumbWindow
  thumbWindow = new BrowserWindow({
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    show: false, // 离屏
    // 让 width/height 表示「内容区尺寸」，保证画布是 size × size 的正方形
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  thumbReady = false
  return trackWindow(thumbWindow)
}

/**
 * 渲染缩略图：加载插件 viewer → mount → load → waitReady → snapshot → 存盘
 * @param {Object} entry 素材条目（path/pluginId）
 * @param {Object} plugin 插件 manifest（含 viewer 文件名）
 * @param {string} pluginsDir plugins/ 目录
 * @param {string} outPng 输出 PNG 路径
 * @param {{size?:number}} [opts] size = 渲染分辨率（设置项，五档）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function renderThumbnail(entry, plugin, pluginsDir, outPng, opts = {}) {
  const size = normalizeThumbSize(opts.size)
  const win = getThumbWindow()
  if (!win.isDestroyed()) win.setContentSize(size, size)
  const viewerAbs = path.join(pluginsDir, plugin.id, plugin.viewer || 'viewer.mjs')
  if (!fs.existsSync(viewerAbs)) return { ok: false, error: `缺少渲染模块 ${plugin.viewer || 'viewer.mjs'}` }

  try {
    await win.loadFile(path.join(__dirname, '../renderer/host.html'))
    /*
     * 对齐「离屏渲染尺寸」：设置里选的是 output 档位（128…2048），
     * 宿主窗口内容区已按 size × size 设定，这里把**容器**尺寸显式钉死，
     * 插件据此创建自己的渲染目标（画布/视频等）即可得到档位尺寸。
     * 若插件需要 Canvas 后备缓冲区 = 显示尺寸，应自行按 api.containerSize() 设置
     * canvas.width/height —— 主程序不再替它假设容器里一定是画布。
     */
    await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('host-content')
      if (!el) return null
      const r = el.getBoundingClientRect()
      el.style.width = Math.max(1, Math.round(r.width)) + 'px'
      el.style.height = Math.max(1, Math.round(r.height)) + 'px'
      return { width: r.width, height: r.height }
    })()`)
    // 动态 import viewer + mount + load + snapshot
    const res = await win.webContents.executeJavaScript(`(async () => {
      try {
        const mod = await import('file://${viewerAbs.split('\\').join('/')}')
        const factory = mod.default || mod.createViewer
        if (typeof factory !== 'function') return { ok: false, error: 'viewer 未导出工厂函数' }
        const host = document.getElementById('host-content')
        const api = {
          container: host,
          // 离屏渲染分辨率（设置项）——插件可据此决定内部渲染尺寸
          thumbSize: ${size},
          containerSize: () => { const r = host.getBoundingClientRect(); return { width: r.width, height: r.height } },
        }
        const viewer = factory(api)
        await viewer.mount(host)
        if (typeof viewer.resize === 'function') {
          const s = api.containerSize()
          viewer.resize(s.width, s.height)
        }
        if (typeof viewer.load === 'function') {
          await viewer.load(${JSON.stringify(entry.path)}, { size: ${size}, thumbnail: true })
        }
        // waitReady 优先；兼容旧契约的 waitForTextures
        if (typeof viewer.waitReady === 'function') await viewer.waitReady()
        else if (typeof viewer.waitForTextures === 'function') await viewer.waitForTextures()
        if (typeof viewer.start === 'function') viewer.start()
        await new Promise(r => setTimeout(r, 1200)) // 等渲染稳定
        if (typeof viewer.snapshot !== 'function') return { ok: false, error: 'viewer 未提供 snapshot()，无法生成缩略图' }
        const dataUrl = await viewer.snapshot()
        return { ok: true, dataUrl }
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) }
      }
    })()`)

    if (!res.ok) return { ok: false, error: res.error }
    // dataURL → PNG 存盘
    const b64 = String(res.dataUrl).replace(/^data:image\/\w+;base64,/, '')
    fs.mkdirSync(path.dirname(outPng), { recursive: true })
    fs.writeFileSync(outPng, Buffer.from(b64, 'base64'))
    return { ok: true, outPng, size }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/**
 * 预览素材：独立预览窗口 + 插件 viewer
 * 窗口页面模板：优先插件目录的 previewHtml（样式由插件定义），缺省回退主程序通用宿主页。
 * @param {Object} entry 素材条目
 * @param {Object} plugin 插件 manifest
 * @param {string} pluginsDir plugins/ 目录
 */
async function openPreview(entry, plugin, pluginsDir) {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: `${plugin.name} 预览 - ${path.basename(entry.path)}`,
    backgroundColor: '#1e1f24',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 只给「存预览图」这一件事用的窄 preload；插件页面本身仍无 Node
      preload: path.join(__dirname, 'previewPreload.js'),
      additionalArguments: [`--host-entry=${entry.path}`],
    },
  })
  trackWindow(win)
  win.setMenuBarVisibility(false)

  /*
   * Esc 关闭预览窗口 —— 属于**窗口框架**行为，由主程序统一提供。
   *
   * 为什么不写在插件的 preview.html 里：一是每个插件都得自己实现一遍，
   * 漏了就没有；二是插件内容形态各异（3D canvas / video / audio），
   * 焦点在哪个元素上不确定，页面级 keydown 不一定收得到。
   * 用 before-input-event 在主进程侧拦，与页面内容和焦点无关，一律生效。
   *
   * 全屏时先退全屏、第二次按才关窗口 —— 否则全屏看视频时一按 Esc 窗口就没了。
   * 页面内 HTML5 全屏（如视频双击全屏）由 Chromium 自己接管 Esc 退出，
   * 那一步不会走到这里；这里只处理窗口级全屏。
   */
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    if (win.isDestroyed()) return
    if (win.isFullScreen()) win.setFullScreen(false)
    else win.close()
    event.preventDefault()
  })

  // 页面模板：插件 previewHtml 优先（含窗口样式与容器），否则主程序通用宿主页
  const pluginPage = plugin.previewHtml
    ? path.join(pluginsDir, plugin.id, plugin.previewHtml)
    : null
  const pageFile = pluginPage && fs.existsSync(pluginPage) ? pluginPage : path.join(__dirname, '../renderer/host.html')
  await win.loadFile(pageFile)

  const viewerAbs = path.join(pluginsDir, plugin.id, plugin.viewer || 'viewer.mjs')
  const ok = fs.existsSync(viewerAbs)
  await win.webContents.executeJavaScript(`(async () => {
    try {
      ${ok ? `const mod = await import('file://${viewerAbs.split('\\').join('/')}')` : ''}
      const factory = ${ok ? '(mod.default || mod.createViewer)' : 'null'}
      if (typeof factory !== 'function') { document.body.innerHTML = '<div style="color:#9aa0aa;padding:40px;font-family:sans-serif">该插件未提供预览渲染模块</div>'; return }
      /*
       * 窗口框架由主程序给：一个撑满窗口的空容器 + API。
       * 容器里放什么完全由插件决定（canvas / video / audio / iframe / 任意 DOM），
       * 主程序不假设内容形态 —— 这样同一个宿主既能跑 3D 模型，也能跑音视频。
       */
      const host = document.getElementById('host-content') || document.body
      const api = {
        container: host,
        containerSize: () => { const r = host.getBoundingClientRect(); return { width: r.width, height: r.height } },
        setBackground: (c) => { document.body.style.background = c },
      }
      // 中性全局名（供插件调试/自省）；旧名保留一个别名，避免老插件写死旧名时取不到
      window.__viewerApi__ = api
      window.__mmdPluginApi__ = api
      const viewer = factory(api)
      window.__viewer__ = viewer
      window.__mmdViewer__ = viewer
      await viewer.mount(host)
      if (typeof viewer.load === 'function') await viewer.load(${JSON.stringify(entry.path)}, {})
      if (typeof viewer.start === 'function') viewer.start()

      /*
       * 注入「生成预览图」按钮 —— 属于**窗口框架**职责，不是插件业务。
       *
       * 为什么放框架层（而不是让每个插件自己在 preview.html 里画一个）：
       *   ① 按钮只是调 viewer.snapshot()，而 snapshot() 本来就是插件契约的一部分
       *      （生成缩略图已经在用它）—— 插件零改动就能获得这个能力；
       *   ② 「存到哪、叫什么名字、要不要覆盖」是**主程序的命名约定**
       *      （<素材名>.preview.png），插件不该知道、也不该自己拼路径；
       *   ③ 需要 host-content 之外的浮层 UI，插件的 preview.html 里没有这个位置，
       *      而且插件常把 3D canvas 铺满整屏，按钮必须由框架叠在最上层。
       * 判定：能力来源在插件（snapshot），落盘规则在框架（命名/覆盖）→ 框架实现，
       * 但**只依赖插件已有的 snapshot()，不新增插件必须实现的接口**。
       */
      /*
       * 顶部信息条：左侧显示「素材名」+ 「生成预览图」按钮。
       *
       * 放左上角而不是右下角：右下角容易和播放器的控制条、3D 视角操作提示
       * 之类的插件自绘 UI 撞在一起；左上角是各插件普遍留白的区域，
       * 而且「素材名 + 对该素材的操作」在语义上本来就该挨在一起。
       *
       * 整条用 flex 自适应宽度（不是固定宽度），素材名过长时省略号截断，
       * 按钮永远贴著名右边 —— 名字多长都不会把按钮挤出屏幕。
       */
      const bar = document.createElement('div')
      bar.id = 'host-topbar'
      bar.setAttribute('style', [
        'position:fixed', 'left:12px', 'top:12px', 'z-index:2147483000',
        'display:flex', 'align-items:center', 'gap:10px',
        'max-width:calc(100vw - 24px)',
        'padding:6px 10px',
        'font:12px/1.4 system-ui,sans-serif', 'color:#e8eaed',
        'background:rgba(40,42,48,.86)',
        'border:1px solid rgba(255,255,255,.18)', 'border-radius:8px',
        'backdrop-filter:blur(6px)',
      ].join(';'))

      const nameEl = document.createElement('span')
      nameEl.id = 'host-asset-name'
      nameEl.textContent = ${JSON.stringify(path.basename(entry.path))}
      nameEl.title = ${JSON.stringify(entry.path)}
      nameEl.setAttribute('style', [
        'font-weight:600',
        // 长文件名截断（min-width:0 是 flex 子项能收缩的必要条件）
        'min-width:0', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
        // 给按钮留出空间，名字再长也不会把按钮顶出去
        'max-width:min(52vw, 420px)',
      ].join(';'))
      bar.appendChild(nameEl)

      /*
       * snapshot() 在契约里与 canPreview **互相独立**（原本只服务于 canThumbnail）：
       * 插件可能「能预览但截不了图」，所以这里是能力探测而不是前提假设。
       *
       * 探测不到时**仍然显示按钮，但置灰**，而不是干脆不渲染：
       *   • 不显示 → 插件作者根本不知道框架有这能力，也就不会去补 snapshot()
       *   • 显示但可点 → 点了才报错，是「假承诺」，更糟
       * 置灰 + 说明原因，既诚实又给作者一条明确的改进线索。
       */
      const canSnapshot = typeof viewer.snapshot === 'function'

      const btn = document.createElement('button')
      btn.id = 'host-snapshot-btn'
      btn.type = 'button'
      btn.textContent = '生成预览图'
      btn.disabled = !canSnapshot
      btn.title = canSnapshot
        ? '把当前画面保存为该素材的预览图（已有预览图会被替换）'
        : '该插件的 viewer 未实现 snapshot()，无法生成预览图'
      // 内联样式：插件页面的样式表里没有也不该有框架控件的类名
      btn.setAttribute('style', [
        // 在顶栏里是普通流式元素（不再自己定位）
        'flex:0 0 auto',
        'padding:4px 10px', 'font:12px/1.4 system-ui,sans-serif',
        'color:#e8eaed', 'background:rgba(255,255,255,.10)',
        'border:1px solid rgba(255,255,255,.22)', 'border-radius:6px',
        'cursor:pointer',
        // 置灰态：降透明度 + 禁用光标，一眼看出不可用
        canSnapshot ? '' : 'opacity:.45;cursor:not-allowed',
      ].filter(Boolean).join(';'))

      const toast = document.createElement('div')
      toast.id = 'host-snapshot-toast'
      // 提示紧跟在顶栏下方左侧，与触发它的按钮在同一视觉区域（右下角会让人找不到）
      toast.setAttribute('style', [
        'position:fixed', 'left:12px', 'top:56px', 'z-index:2147483000',
        'padding:7px 12px', 'font:12px/1.4 system-ui,sans-serif',
        'color:#e8eaed', 'background:rgba(40,42,48,.94)',
        'border:1px solid rgba(255,255,255,.18)', 'border-radius:8px',
        'max-width:60vw', 'display:none', 'white-space:pre-wrap',
      ].join(';'))
      const say = (msg, ms) => {
        toast.textContent = msg
        toast.style.display = 'block'
        clearTimeout(say._t)
        say._t = setTimeout(() => { toast.style.display = 'none' }, ms || 2600)
      }

      btn.addEventListener('click', async () => {
        if (btn.disabled) return
        if (typeof viewer.snapshot !== 'function') { say('该插件未提供 snapshot()，无法生成预览图'); return }
        btn.disabled = true
        const label = btn.textContent
        btn.textContent = '生成中…'
        try {
          const dataUrl = await viewer.snapshot()
          if (!dataUrl || typeof dataUrl !== 'string') throw new Error('snapshot() 没有返回图片')
          const r = await window.__hostSaveSnapshot__(dataUrl)
          say(r && r.ok
            ? (r.replaced ? '预览图已替换' : '预览图已生成')
            : ('生成失败：' + ((r && r.error) || '未知错误')))
        } catch (err) {
          say('生成失败：' + String((err && err.message) || err))
        } finally {
          btn.disabled = !canSnapshot
          btn.textContent = label
        }
      })

      document.body.appendChild(bar)
      bar.appendChild(btn)
      document.body.appendChild(toast)
    } catch (err) { document.body.innerHTML = '<div style="color:#e5484d;padding:40px;font-family:sans-serif">预览失败: ' + String(err && err.message || err) + '</div>' }
  })()`)
  return win
}

/**
 * 把预览窗口当前画面的 dataURL 存成该素材的预览图。
 *
 * 命名与「生成缩略图」完全一致（`<素材名>.preview.png`，见 thumbs.thumbOutPathFor），
 * 所以生成出来的图与顶栏按钮产出的图是**同一种东西**，显示、清理、跳过逻辑
 * 全部自动复用 —— 不需要为它新增任何一套规则。
 *
 * 覆盖规则（与顶栏「缩略图」按钮刻意不同，这里是有意的）：
 *   顶栏按钮「已有预览图的跳过，绝不覆盖」——那是批量操作，覆盖会毁掉用户成果；
 *   本按钮是**用户明确要求「按当前画面替换」**的单文件操作，所以覆盖是预期行为。
 *   但只覆盖带 `.preview.` 的文件；用户自己命名的同名图片绝不碰。
 *
 * @param {string} entryPath 素材绝对路径（由 preload 传入，页面改不了）
 * @param {string} dataUrl   data:image/...;base64,...
 */
function saveSnapshotAsThumb(entryPath, dataUrl) {
  try {
    if (typeof entryPath !== 'string' || !entryPath) return { ok: false, error: '缺少素材路径' }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return { ok: false, error: '不是有效的图片数据' }
    }
    if (!fs.existsSync(entryPath)) return { ok: false, error: '素材文件不存在' }

    const out = thumbOutPathFor(entryPath)
    const existed = fs.existsSync(out)
    // 已存在但不是缩略图命名约定的文件 → 拒绝，避免覆盖用户自己的图
    if (existed && !isPreviewFile(out)) {
      return { ok: false, error: `目标文件已存在且不是本程序的预览图：${path.basename(out)}` }
    }

    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(b64, 'base64')
    if (!buf.length) return { ok: false, error: '图片数据为空' }

    // 先写临时文件再改名：避免写一半崩溃留下半张图，把好图也毁了
    const tmp = out + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, out)

    /*
     * 有些缩略图是别的扩展名（jpg/webp）——同主名的旧图要清掉，
     * 否则 findSiblingImage 可能先命中旧的，新生成的图反而不显示。
     * 同样只删带 `.preview.` 的，用户图片不动。
     */
    const stem = path.basename(entryPath) + '.preview'
    const dir = path.dirname(entryPath)
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f === path.basename(out)) continue
        if (!f.startsWith(stem + '.')) continue
        const full = path.join(dir, f)
        if (isPreviewFile(full)) fs.rmSync(full, { force: true })
      }
    } catch { /* 清理失败不影响主流程 */ }

    return { ok: true, out, replaced: existed, size: buf.length }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/**
 * 「预览图已改动」的广播钩子。
 *
 * renderHost 不认识主窗口（那是 index.js 的职责），所以用注册回调解耦：
 * index.js 在启动时把 broadcast 注册进来，这里存盘成功后回喊一声。
 * 没注册也能正常工作 —— 只是界面不会即时刷新。
 */
let onThumbSaved = null
function setThumbSavedNotifier(fn) {
  onThumbSaved = typeof fn === 'function' ? fn : null
}

/**
 * 预览窗口的「生成预览图」按钮 → 主进程落盘。
 *
 * 注册放在模块顶层（与窗口创建同文件），保证只要有预览窗口就一定有这个通道。
 * ipcMain 可能不存在（例如以 ELECTRON_RUN_AS_NODE 做纯 Node 语法检查时），
 * 那种情况下跳过注册即可，不影响模块被 require。
 */
if (ipcMain && typeof ipcMain.handle === 'function') {
  ipcMain.handle('host:save-snapshot', (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    const r = saveSnapshotAsThumb(p.entryPath, p.dataUrl)
    /*
     * 存盘成功后立刻通知主界面刷新那一张缩略图。
     *
     * 不通知的话用户会以为没生效：预览窗口写的是同名文件，主界面
     * <img> 的 URL 不变，内存里那张已解码的旧图就一直显示着。
     * （重新扫描也没用 —— 扫描重建的是索引，不是界面上的 <img>。）
     */
    if (r && r.ok && onThumbSaved) {
      try {
        onThumbSaved({ path: p.entryPath, thumbPath: r.out, replaced: r.replaced })
      } catch { /* 通知失败不影响存盘结果 */ }
    }
    return r
  })
}

/** 清理离屏窗口（退出/卸载插件时） */
function destroyThumbWindow() {
  if (thumbWindow && !thumbWindow.isDestroyed()) thumbWindow.destroy()
  thumbWindow = null
}

/**
 * 关闭本宿主创建的全部窗口（缩略图离屏窗口 + 所有预览窗口）。
 *
 * 主窗口关闭 / 应用退出时调用：只要还有任何一个预览窗口活着，
 * window-all-closed 就不会触发 → 主进程与 GPU / 渲染子进程一起残留。
 * 所以这里一次性全部销毁，一个都不留。
 *
 * 用 destroy() 而非 close()：预览窗口承载的是插件的 3D 渲染循环，
 * close() 可能被页面的 beforeunload 之类逻辑拖住；退出路径要的是确定性。
 */
function destroyAllHostWindows() {
  for (const win of [...hostWindows]) {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch { /* 已销毁/正在销毁：忽略 */ }
  }
  hostWindows.clear()
  // thumbWindow 与登记表指向同一对象；destroy 后统一置空，避免复用已销毁窗口
  thumbWindow = null
  thumbReady = false
}

// 同理 guard：纯 Node 环境下没有 app，跳过注册
if (app && typeof app.on === 'function') app.on('before-quit', destroyAllHostWindows)

module.exports = {
  renderThumbnail,
  openPreview,
  saveSnapshotAsThumb,
  setThumbSavedNotifier,
  destroyThumbWindow,
  destroyAllHostWindows,
}
