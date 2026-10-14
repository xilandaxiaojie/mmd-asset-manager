/**
 * 视频缩略图集成测试（由主程序拉起：AMM_UI_TEST=video-thumb.test.js）
 *
 * ── 为什么必须走真实管线 ────────────────────────────────
 * 抽帧要三样东西同时正确：插件 viewer 的 snapshot()、主程序的离屏渲染宿主、
 * 以及 asset:// 协议。只测 viewer 的代码逻辑证明不了「点缩略图按钮真能出图」，
 * 所以这里用真实的 renderThumbnail 跑一遍。
 *
 * ── 测试素材从哪来 ──────────────────────────────────────
 * 不假设用户机器上恰好有视频：用一段内嵌的**极小 WebM 样本**（base64）写到临时目录。
 * 它是 Chromium 能原生解码的 VP8 视频，足够验证「加载 → 解码 → 抽帧 → 落盘」全链路。
 *
 * 宿主注入：{ win, pluginsDir, store }
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const LIB = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amm-videolib-'))

/**
 * 最小可解码的 WebM 样本（VP8）。
 *
 * 用内嵌字节而不是外部文件，测试才能在任何机器上独立跑。
 * 这段是标准的 WebM/VP8 最小封装（含 EBML 头 + 一个视频帧）。
 */
const SAMPLE_WEBM_B64 = require('./_sample-webm.json').webm

module.exports = async function runVideoThumb({ win, pluginsDir, store }) {
  const { app, BrowserWindow } = require('electron')
  const { registry } = require('../src/shared/contracts')
  const { scanRoot } = require('../src/main/scanner')
  const renderHost = require('../src/main/renderHost')

  const realPluginsDir = path.join(__dirname, '..', 'plugins')
  const videoPlugin = require(path.join(realPluginsDir, '视频', 'index.cjs'))

  let failures = 0
  const check = (label, cond, detail = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
    if (!cond) failures++
  }

  const lib = LIB()
  const videoFile = path.join(lib, '测试视频.webm')
  const thumbFile = path.join(lib, '测试视频.webm.preview.png')
  fs.writeFileSync(videoFile, Buffer.from(SAMPLE_WEBM_B64, 'base64'))

  console.log('')
  console.log('▸ 准备：临时素材库 + 内嵌视频样本')
  console.log(`  素材库: ${lib}`)
  console.log(`  视频: ${videoFile} (${fs.statSync(videoFile).size} B)`)

  // 扫描器看共享 registry 判断「是不是素材」，所以要把插件注册进去
  registry.register(registry.normalize ? registry.normalize(videoPlugin) : videoPlugin)
  const root = store.addRoot(lib)
  await scanRoot(store, root.root, { concurrency: 2, exclude: [store.dataDir], force: true })
  const entry = [...store.getIndex(root.root.id).entries.values()]
    .find((e) => e.name === '测试视频.webm')

  console.log('')
  console.log('▸ 索引')
  check('视频被识别为素材（插件生效）', !!entry, entry ? entry.path : '未入索引')
  if (!entry) {
    console.log('')
    console.log('  ✗ 无法继续：素材未入索引')
    await new Promise((r) => setTimeout(r, 300))
    app.exit(1)
    return
  }

  if (fs.existsSync(thumbFile)) fs.unlinkSync(thumbFile)

  console.log('')
  console.log('▸ 离屏抽帧（走主程序真实管线）')
  const t0 = Date.now()
  let out
  try {
    out = await renderHost.renderThumbnail(entry, videoPlugin, realPluginsDir, thumbFile, { size: 128 })
  } catch (err) {
    out = { ok: false, error: String((err && err.stack) || err) }
  }
  const ms = Date.now() - t0
  check('renderThumbnail 返回成功', out && out.ok === true, out ? JSON.stringify(out) : '无返回')
  check('抽帧没有卡死（< 20s）', ms < 20000, `${ms} ms`)

  // 落盘检查
  const wrote = fs.existsSync(thumbFile)
  check('缩略图文件已生成', wrote, thumbFile)

  if (wrote) {
    const buf = fs.readFileSync(thumbFile)
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    check('是合法 PNG（魔数正确）', isPng)
    check('文件名符合 <素材名>.preview.png 规范', path.basename(thumbFile).includes('.preview.'))
    check('体积合理（不是空图）', buf.length > 200, `${buf.length} B`)

    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    // 缩略图档位是长边上限：小样本视频本身小于 128，所以只要求不超过档位
    check('尺寸不超过档位（长边 <= 128）', Math.max(w, h) <= 128, `${w}×${h}`)
    check('尺寸有效（宽高都 > 0）', w > 0 && h > 0, `${w}×${h}`)
  }

  // 生成好的缩略图必须能被正常读出来（走 asset://thumb 通道）
  console.log('')
  console.log('▸ 生成的缩略图可被界面读取')
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const url = 'asset://thumb/' + encodeURIComponent(${JSON.stringify(thumbFile)})
    const r = await fetch(url)
    if (!r.ok) return { ok: false, status: r.status }
    const b = await r.arrayBuffer()
    return { ok: true, status: r.status, len: b.byteLength, type: r.headers.get('content-type') }
  })()`)
  check('asset://thumb 能读到缩略图', dataUrl && dataUrl.ok === true, JSON.stringify(dataUrl))
  check('读到的字节数与原文件一致',
    dataUrl && dataUrl.ok && dataUrl.len === fs.statSync(thumbFile).size,
    dataUrl ? `${dataUrl.len} B` : '')

  /*
   * ── 预览窗口：Esc 关闭 + 「生成预览图」按钮 ──────────────
   *
   * 这两项都是**窗口框架**能力（主程序提供），不属于插件业务：
   *   • Esc 关闭：用 before-input-event 在主进程侧拦，与插件页面内容无关
   *   • 生成预览图：按钮由框架注入，落盘路径走主程序的 <素材名>.preview.png 约定
   * 所以这里用真实的 openPreview 验证，而不是只看代码里有没有那几行。
   */
  console.log('')
  console.log('▸ 预览窗口：生成预览图按钮')
  fs.rmSync(thumbFile, { force: true }) // 先删掉，验证「没有预览图就新增」

  /*
   * 先让主界面把这个素材渲染出来，并记下卡片的初始缩略图状态。
   * 这是为了验证用户实测发现的那个 bug：预览窗口改了图，主界面不跟着变。
   */
  win.webContents.reload()
  await new Promise((r) => setTimeout(r, 2500))
  const readCard = () => win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('.asset-card')
    if (!c) return { card: false }
    const img = c.querySelector('.thumb')
    const cover = c.querySelector('.card-cover')
    return {
      card: true,
      src: img ? (img.getAttribute('src') || '') : '(无img)',
      naturalW: img ? img.naturalWidth : -1,
      hasImg: cover ? cover.classList.contains('has-img') : false,
    }
  })()`)
  const cardBefore = await readCard()
  check('主界面已渲染出该素材卡片', cardBefore.card === true)
  check('初始没有预览图（显示类别图标）', cardBefore.hasImg === false, JSON.stringify(cardBefore))

  let prevWin = null
  try {
    prevWin = await renderHost.openPreview(entry, videoPlugin, realPluginsDir)
    await new Promise((r) => setTimeout(r, 2600))
  } catch (err) {
    check('预览窗口能打开', false, String((err && err.message) || err))
  }

  if (prevWin && !prevWin.isDestroyed()) {
    check('预览窗口能打开', true, prevWin.getTitle())

    const btn = await prevWin.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const b = document.getElementById('host-snapshot-btn')
      const bar = document.getElementById('host-topbar')
      const nameEl = document.getElementById('host-asset-name')
      const v = document.querySelector('video')
      if (v) { try { await v.play() } catch {} }
      await sleep(1500)
      const rb = bar ? bar.getBoundingClientRect() : null
      const rn = b ? b.getBoundingClientRect() : null
      return {
        exists: !!b,
        text: b ? b.textContent : '',
        hasBridge: typeof window.__hostSaveSnapshot__ === 'function',
        videoReady: v ? v.readyState : -1,
        // 位置：左上角顶栏，按钮在素材名右侧
        barExists: !!bar,
        barLeft: rb ? Math.round(rb.left) : -1,
        barTop: rb ? Math.round(rb.top) : -1,
        nameText: nameEl ? nameEl.textContent : '',
        nameTitle: nameEl ? nameEl.title : '',
        btnRightOfName: (rb && rn) ? rn.left > rb.left : false,
        btnParentId: b && b.parentElement ? b.parentElement.id : '',
      }
    })()`)
    check('框架注入了「生成预览图」按钮', btn.exists === true, btn.text)
    check('按钮文案正确', btn.text === '生成预览图', btn.text)
    check('存图桥接已暴露（preload 生效）', btn.hasBridge === true)
    check('视频已可抽帧', btn.videoReady >= 2, `readyState=${btn.videoReady}`)

    // 位置要求：左上角顶栏，且按钮紧跟在素材名后面
    check('按钮位于左上角顶栏', btn.barExists === true && btn.barLeft <= 24 && btn.barTop <= 24,
      `bar=(${btn.barLeft},${btn.barTop})`)
    check('顶栏显示了素材名', btn.nameText === '测试视频.webm', btn.nameText)
    check('素材名带完整路径提示', String(btn.nameTitle).includes('测试视频.webm'), btn.nameTitle)
    check('按钮在素材名右侧', btn.btnRightOfName === true)
    check('按钮确实在顶栏内（不是浮在别处）', btn.btnParentId === 'host-topbar', btn.btnParentId)

    // 点按钮 → 没有预览图时应新增
    const click = () => prevWin.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      document.getElementById('host-snapshot-btn')?.click()
      await sleep(2600)
      return (document.getElementById('host-snapshot-toast') || {}).textContent || ''
    })()`)

    const toast1 = await click()
    const made = fs.existsSync(thumbFile)
    check('点按钮在没有预览图时新增了一张', made, `${thumbFile}${toast1 ? ' / ' + toast1 : ''}`)
    if (made) {
      const b = fs.readFileSync(thumbFile)
      check('新增的是合法 PNG',
        b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, `${b.length} B`)
      check('是覆盖而不是跳过（提示为「已生成」）', String(toast1).includes('生成'), toast1)
    }

    // 再点一次 → 应替换（不是报错、也不是跳过）
    const mtimeBefore = made ? fs.statSync(thumbFile).mtimeMs : 0
    await new Promise((r) => setTimeout(r, 1100))
    const toast2 = await click()
    const mtimeAfter = fs.existsSync(thumbFile) ? fs.statSync(thumbFile).mtimeMs : 0
    check('再次点击提示「已替换」', String(toast2).includes('替换'), toast2)
    check('已有预览图被覆盖（mtime 变化）', mtimeAfter > mtimeBefore)

    // 用户自己命名的同名图片不能被碰
    const userPic = path.join(lib, '测试视频.webm.png')
    fs.writeFileSync(userPic, 'user-owned')
    await click()
    check('用户自己命名的同名图片未被删除', fs.existsSync(userPic))

    /*
     * ── 主界面是否同步刷新 ─────────────────────────────────
     *
     * 这是用户实测发现的 bug：改了图，主界面那张 <img> 不变，重新扫描也不变。
     * 两层原因都要覆盖：
     *   • 服务端缓存签名没算缩略图自身 mtime → 仍返回旧结果
     *   · <img> URL 不变 → Chromium 沿用内存里已解码的旧图
     * 所以这里不只看 src 变了，还要看 naturalWidth —— 属性变了但图没解码出来
     * （比如被 has-img 缺失挡住）同样算失败。
     */
    console.log('')
    console.log('▸ 主界面同步刷新')
    let cardAfter = null
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400))
      cardAfter = await readCard()
      if (cardAfter.src && cardAfter.src !== cardBefore.src && cardAfter.naturalW > 0) break
    }
    check('卡片缩略图 URL 已更新', cardAfter.src !== cardBefore.src,
      `${String(cardBefore.src).slice(-28)} → ${String(cardAfter.src).slice(-28)}`)
    check('URL 带版本号（Chromium 才会重新取图）', /\?v=\d+/.test(cardAfter.src), cardAfter.src.slice(-20))
    check('图片真的被解码出来（不是只改了属性）', cardAfter.naturalW > 0, `${cardAfter.naturalW}px`)
    check('卡片已切到图片模式（has-img）', cardAfter.hasImg === true)

    // ── Esc 关闭预览窗口 ──
    console.log('')
    console.log('▸ 预览窗口：Esc 关闭')
    const wcId = prevWin.webContents.id
    prevWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    prevWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await new Promise((r) => setTimeout(r, 1200))
    const alive = BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.webContents.id === wcId)
    check('按 Esc 关闭了预览窗口', alive === false)
  } else {
    check('预览窗口能打开', false, '未拿到窗口对象')
  }

  /*
   * ── snapshot() 在契约里与 canPreview 互相独立 ──────────────
   *
   * `snapshot()` 原本只服务于 canThumbnail。一个插件完全可以「能预览但截不了图」，
   * 所以框架必须做**能力探测**而不是假定存在。
   * 探测不到时按钮仍显示但置灰 —— 不显示的话插件作者不知道有这能力，
   * 显示且可点则是「假承诺」（点了才报错）。这里用真实插件验证置灰行为。
   */
  console.log('')
  console.log('▸ 预览窗口：插件未实现 snapshot() 时按钮置灰')
  const noSnapPlugins = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-nosnap-plug-'))
  const noSnapDir = path.join(noSnapPlugins, 'nosnap')
  fs.mkdirSync(noSnapDir, { recursive: true })
  fs.writeFileSync(path.join(noSnapDir, 'index.cjs'), `module.exports = {
  id: 'nosnap', name: '无快照插件', exts: ['.nosnap'],
  kind: { key: 'nosnap', label: '测试', color: '#888888' },
  canPreview: true, canThumbnail: false,
  viewer: 'viewer.mjs', previewHtml: 'preview.html',
}
`)
  fs.writeFileSync(path.join(noSnapDir, 'preview.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
    '<div id="host-content" style="width:100vw;height:100vh"></div></body></html>')
  fs.writeFileSync(path.join(noSnapDir, 'viewer.mjs'), `export default function createViewer(api) {
  return { async mount(c) { c.textContent = 'no snapshot here' }, async load() {}, start() {}, stop() {} }
}
`)
  const noSnapPlugin = require(path.join(noSnapDir, 'index.cjs'))
  const noSnapLib = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-nosnap-lib-'))
  const noSnapAsset = path.join(noSnapLib, '样例.nosnap')
  fs.writeFileSync(noSnapAsset, 'x')
  registry.register(registry.normalize ? registry.normalize(noSnapPlugin) : noSnapPlugin)
  const noSnapRoot = store.addRoot(noSnapLib)
  await scanRoot(store, noSnapRoot.root, { concurrency: 2, exclude: [store.dataDir], force: true })
  const noSnapEntry = [...store.getIndex(noSnapRoot.root.id).entries.values()]
    .find((e) => e.name === '样例.nosnap')

  if (!noSnapEntry) {
    check('无 snapshot 的插件素材入索引', false, '未入索引')
  } else {
    let w2 = null
    try {
      w2 = await renderHost.openPreview(noSnapEntry, noSnapPlugin, noSnapPlugins)
      await new Promise((r) => setTimeout(r, 2000))
    } catch (err) {
      check('无 snapshot 的插件也能打开预览', false, String((err && err.message) || err))
    }
    if (w2 && !w2.isDestroyed()) {
      const b = await w2.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('host-snapshot-btn')
        if (!el) return { exists: false }
        const st = getComputedStyle(el)
        return { exists: true, disabled: el.disabled, title: el.title,
                 opacity: st.opacity, cursor: st.cursor }
      })()`)
      check('按钮仍然显示（作者能发现缺失）', b.exists === true)
      check('按钮被置灰不可点', b.disabled === true)
      check('提示说明了原因', String(b.title).includes('snapshot'), b.title)
      check('有视觉上的禁用样式',
        b.opacity !== '1' && b.cursor === 'not-allowed', `opacity=${b.opacity} cursor=${b.cursor}`)

      // 点了不该有反应、更不该产出图片
      await w2.webContents.executeJavaScript(`document.getElementById('host-snapshot-btn')?.click()`)
      await new Promise((r) => setTimeout(r, 1000))
      const t = await w2.webContents.executeJavaScript(
        `(document.getElementById('host-snapshot-toast') || {}).textContent || ''`)
      check('点击置灰按钮无任何反应', t === '', JSON.stringify(t))
      check('不会误产出预览图', fs.existsSync(noSnapAsset + '.preview.png') === false)

      // Esc 也应能关掉它
      const id2 = w2.webContents.id
      w2.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      w2.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await new Promise((r) => setTimeout(r, 1200))
      check('无 snapshot 的预览窗口也能按 Esc 关闭',
        BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.id === id2) === false)
    } else {
      check('无 snapshot 的插件也能打开预览', false, '未拿到窗口对象')
    }
  }
  try { fs.rmSync(noSnapPlugins, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(noSnapLib, { recursive: true, force: true }) } catch {}

  // 清理
  await new Promise((r) => setTimeout(r, 400))
  try { fs.rmSync(lib, { recursive: true, force: true }) } catch {}

  console.log('')
  console.log(failures ? `  ✗ 视频缩略图测试失败 ${failures} 项` : '  ✓ 视频缩略图测试全部通过')
  app.exit(failures ? 1 : 0)
}
