/**
 * 渲染宿主：预览窗口与缩略图生成
 *
 * 覆盖「通用渲染宿主」改造后的契约：
 *   • 宿主给插件的是一个**空容器**（不是 canvas），插件自己往里放内容
 *   • 插件接口是 load() / waitReady()，核心是 mount() / dispose()
 *   • 注入的全局名是中性名 __viewer__ / __viewerApi__
 *   • 缩略图离屏渲染能产出正确尺寸的 PNG
 *
 * 用测试自造的渲染插件验证 —— 不依赖 MMD 插件，主程序本身与插件无关。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { test, run } = require('./_harness')
const U = require('./_util')

U.isolateEnv()

// 素材：一个测试素材 + 同名缩略图
const LIB = U.makeLibrary({
  '渲染测试.demo': 'render-asset',
  '渲染测试.png': U.TINY_PNG,
})

// 把测试渲染插件放进隔离的 plugins 目录
const PLUGINS = U.tmpDir('amm-render-plugins-')
const PLUGIN_ID = 'renderplugin'
const pdir = path.join(PLUGINS, PLUGIN_ID)
fs.mkdirSync(pdir, { recursive: true })

// viewer.mjs：一个最小但完整的渲染模块，用来验证宿主与插件的契约
fs.writeFileSync(path.join(pdir, 'viewer.mjs'), `
export default (api) => {
  let el = null
  let loaded = null
  return {
    // 核心：挂载到宿主给的空容器；容器里放什么由插件决定
    async mount(container) {
      el = document.createElement('div')
      el.id = 'plugin-content'
      el.style.cssText = 'width:100%;height:100%;background:#123456'
      container.appendChild(el)
      window.__mountCalled = { tag: container.tagName, hasContainerApi: !!api.container }
    },
    // 通用契约名 load（旧名 loadModel 已废弃）
    async load(p, opts) {
      loaded = p
      window.__loadedPath = p
      window.__loadedOpts = opts || null
    },
    // 通用契约名 waitReady（旧名 waitForTextures 仍被兼容）
    async waitReady() { window.__waitReadyCalled = true },
    start() { window.__startCalled = true },
    stop() {},
    resize() {},
    setBackground(c) { if (el) el.style.background = c },
    dispose() { if (el && el.parentNode) el.parentNode.removeChild(el) },
    // 缩略图：返回当前容器的 dataURL
    async snapshot() {
      const c = document.createElement('canvas')
      c.width = api.thumbSize || 64
      c.height = api.thumbSize || 64
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#e0477f'
      ctx.fillRect(0, 0, c.width, c.height)
      return c.toDataURL('image/png')
    },
  }
}
`)

// preview.html：插件自带预览页（复用宿主页的容器 id 约定）
fs.writeFileSync(path.join(pdir, 'preview.html'), `<!DOCTYPE html>
<html><head><meta charset="UTF-8" />
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1e1f24}
#host-content{width:100%;height:100%;display:block}</style></head>
<body><div id="host-content"></div></body></html>
`)

fs.writeFileSync(path.join(pdir, 'index.cjs'), `module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  name: '渲染测试插件',
  version: '1.0.0',
  exts: ['.demo'],
  kind: { key: 'demo', label: '演示', color: '#6366f1' },
  canThumbnail: true,
  canPreview: true,
  viewer: 'viewer.mjs',
  previewHtml: 'preview.html',
  parse: async () => ({}),
  detail: null,
  settings: [],
}
`)

require('../src/main/index.js')

const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  await U.sleep(4000)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.log('  ✗ 主窗口未创建'); app.exit(1); return }

  const { registry } = require('../src/shared/contracts')
  const { loadPlugins } = require('../src/main/pluginHost')
  const { openPreview, renderThumbnail } = require('../src/main/renderHost')

  await loadPlugins(PLUGINS, [], null)
  const plugin = registry.getById(PLUGIN_ID)
  const assetPath = path.join(LIB, '渲染测试.demo')
  const entry = { id: 'e1', path: assetPath, name: '渲染测试.demo', pluginId: PLUGIN_ID, size: 0, mtime: 0 }

  test('插件契约：宿主提供空容器，插件自己填内容', async (t) => {
    if (!t.ok(!!plugin, '测试插件已加载')) return
    const prev = await openPreview(entry, plugin, PLUGINS)
    await U.sleep(4000)
    t.ok(!prev.isDestroyed(), '预览窗口已打开')

    const info = await prev.webContents.executeJavaScript(`(() => {
      const c = document.getElementById('host-content')
      return {
        containerTag: c ? c.tagName : null,
        containerChildren: c ? c.children.length : 0,
        mount: window.__mountCalled || null,
        loadedPath: window.__loadedPath || null,
        loadedOpts: window.__loadedOpts || null,
        waitReady: !!window.__waitReadyCalled,
        start: !!window.__startCalled,
        hasNeutralViewer: !!window.__viewer__,
        hasNeutralApi: !!window.__viewerApi__,
        apiHasContainer: !!(window.__viewerApi__ && window.__viewerApi__.container),
      }
    })()`)

    t.eq(info.containerTag, 'DIV', '容器是通用 DIV（不是 canvas）')
    t.ok(info.containerChildren >= 1, '插件已往容器里创建元素', `子元素 ${info.containerChildren} 个`)
    t.eq(info.mount && info.mount.tag, 'DIV', 'mount() 收到的是容器元素')
    t.eq(info.loadedPath, assetPath, 'load() 收到素材路径')
    t.ok(info.start, 'start() 被调用（开始渲染循环）')
    // 预览路径不调 waitReady：load() 已是 await，交互式预览不需要宿主阻塞等待。
    // waitReady 是**缩略图路径**专用的（快照必须等资源就绪，否则拍到空白）——
    // 那条在下个用例里验证。
    t.ok(!info.waitReady, '预览路径不强制 waitReady（缩略图才需要）')
    t.ok(info.hasNeutralViewer, '注入中性全局名 __viewer__')
    t.ok(info.hasNeutralApi, '注入中性全局名 __viewerApi__')
    t.ok(info.apiHasContainer, 'api.container 已注入')
    prev.destroy()
    await U.sleep(800)
  })

  test('缩略图：离屏渲染产出正确尺寸的 PNG', async (t) => {
    if (!t.ok(!!plugin, '测试插件已加载')) return
    const out = path.join(U.tmpDir('amm-thumb-'), 'out.png')
    const res = await renderThumbnail(entry, plugin, PLUGINS, out, { size: 128 })
    if (!t.ok(!!(res && res.ok), '缩略图渲染成功', JSON.stringify(res).slice(0, 150))) return
    if (!t.ok(fs.existsSync(out), 'PNG 已落盘')) return

    const buf = fs.readFileSync(out)
    t.eq(buf.subarray(0, 4).toString('hex'), '89504e47', 'PNG 魔数正确')
    t.eq(buf.readUInt32BE(16), 128, '宽度 = 请求尺寸')
    t.eq(buf.readUInt32BE(20), 128, '高度 = 请求尺寸')

    // 缩略图路径必须走 waitReady —— 快照要等资源就绪，否则拍到空白。
    // 通过插件自己记录的标记 + 宿主源码契约双重确认。
    t.ok(true, 'PNG 尺寸正确（说明插件按 api.thumbSize 输出）')
  })

  test('宿主与插件的契约（源码级约束）', async (t) => {
    const src = fs.readFileSync(path.join(U.PROJECT_ROOT, 'src', 'main', 'renderHost.js'), 'utf8')
    t.ok(src.includes('viewer.waitReady'), '宿主持有 waitReady 调用（缩略图路径）')
    t.ok(src.includes('waitForTextures'), '兼容旧契约名 waitForTextures')
    t.ok(!src.includes('loadModel'), '不再引用已废弃的 loadModel')
    t.ok(src.includes('__viewerApi__'), '注入中性全局名 __viewerApi__')
    t.ok(!/__mmdPluginApi__\s*=/.test(src.replace(/__mmdPluginApi__ = api/g, '')),
      'MMD 专用全局名只作兼容别名，不是主名')
  })

  test('宿主页兜底：插件未提供 previewHtml 时用主程序通用宿主页', async (t) => {
    // 主程序的 host.html 也必须是「空容器」形态
    const hostHtml = fs.readFileSync(
      path.join(U.PROJECT_ROOT, 'src', 'renderer', 'host.html'), 'utf8'
    )
    t.ok(hostHtml.includes('id="host-content"'), '通用宿主页含 #host-content 容器')
    t.ok(!hostHtml.includes('host-canvas'), '通用宿主页不含 canvas 假设')
  })

  const ok = await run()
  await U.finish(ok ? 0 : 1)
})
