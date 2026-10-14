/**
 * 视频插件测试
 *
 * 覆盖三块：
 *   1. 插件声明与 parse（纯逻辑，可直接 require）
 *   2. asset:// 的 Range 实现（协议层，纯逻辑 + 真实 HTTP 语义）
 *   3. 缩略图抽帧（需要真实窗口 + 真实视频文件，见 tests/.probe-video-thumb.js）
 *
 * ── 为什么 Range 要单独测 ────────────────────────────────
 * 视频拖进度条依赖 206 分段响应。这块出错的表现是「能播但拖不动」，
 * 属于不跑测试很难发现的静默故障，所以边界值要逐个钉住。
 */
const fs = require('fs')
const path = require('path')
const { test, run } = require('./_harness')

const ROOT = path.join(__dirname, '..')
const mod = require(path.join(ROOT, 'plugins', '视频', 'index.cjs'))

// ── 从 index.js 源码里取 parseRange 来测 ──────────────────
// index.js 是 Electron 主进程入口，直接 require 会把 app 拉起来，
// 所以这里用正则抠出函数体再求值 —— 保证测的是**真实实现**，
// 而不是测试里另抄一份（抄一份的话改了源码测试也不会红）。
function loadParseRange() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
  const start = src.indexOf('function parseRange(')
  if (start < 0) throw new Error('index.js 里找不到 parseRange —— 函数被改名或删除了？')
  // 从函数头往后做花括号配对，取完整函数体
  let i = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break } }
  }
  if (end < 0) throw new Error('parseRange 花括号不配对')
  const body = src.slice(start, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return parseRange`)()
}

test('parseRange：完整请求与常规区间', (t) => {
  const pr = loadParseRange()
  t.eq(JSON.stringify(pr('bytes=0-', 1000)), '{"start":0,"end":999}', 'bytes=0- → 整个文件')
  t.eq(JSON.stringify(pr('bytes=0-99', 1000)), '{"start":0,"end":99}', 'bytes=0-99 → 前 100 字节')
  t.eq(JSON.stringify(pr('bytes=100-199', 1000)), '{"start":100,"end":199}', '中段区间')
  t.eq(JSON.stringify(pr('bytes=-100', 1000)), '{"start":900,"end":999}', 'bytes=-100 → 末 100 字节')
})

test('parseRange：越界与非法输入', (t) => {
  const pr = loadParseRange()
  t.eq(pr('bytes=0-99999', 1000).end, 999, 'end 超出文件尾 → 截到末尾（不是 416）')
  t.eq(pr('bytes=5000-6000', 1000), 'invalid', 'start 超出文件尾 → invalid（应回 416）')
  t.eq(pr('bytes=200-100', 1000), 'invalid', 'start > end → invalid')
  t.eq(pr('bytes=-0', 1000), 'invalid', '末尾 0 字节 → invalid')
})

test('parseRange：无 Range / 无法识别的语法 → null（按整体返回）', (t) => {
  const pr = loadParseRange()
  t.eq(pr(null, 1000), null, '没有 Range 头')
  t.eq(pr(undefined, 1000), null, 'undefined')
  t.eq(pr('bytes=abc', 1000), null, '语法不认识 → 不当作 416，回退整体 200')
  t.eq(pr('bytes=', 1000), null, '两头都空')
  t.eq(pr('items=0-99', 1000), null, '非 bytes 单位')
})

test('插件声明：扩展名 / 能力 / 图标', (t) => {
  t.ok(Array.isArray(mod.exts) && mod.exts.length > 0, '声明了扩展名', mod.exts.join(' '))
  t.ok(mod.exts.every((e) => e.startsWith('.')), '扩展名都带点', mod.exts.join(' '))
  t.eq(mod.canPreview, true, '可预览')
  t.eq(mod.canThumbnail, true, '可生成缩略图')
  t.eq(mod.viewer, 'viewer.mjs', '提供渲染模块')
  t.ok(mod.kind && mod.kind.color, '声明了类型颜色', mod.kind && mod.kind.color)
})

test('插件声明：只声明 Chromium 能原生解码的容器', (t) => {
  // mkv/avi/flv/wmv 的容器 Chromium 解不了，声明了只会让用户看到黑窗口
  const bad = ['.mkv', '.avi', '.flv', '.wmv', '.rmvb'].filter((e) => mod.exts.includes(e))
  t.eq(bad.length, 0, '没有声明无法解码的容器', bad.join(' ') || '（无）')
  t.ok(mod.exts.includes('.mp4'), '支持 mp4')
  t.ok(mod.exts.includes('.webm'), '支持 webm')
})

test('插件文件齐全（manifest 引用的文件都真实存在）', (t) => {
  const dir = path.join(ROOT, 'plugins', '视频')
  for (const f of ['index.cjs', 'viewer.mjs', 'preview.html', 'icon.svg']) {
    t.ok(fs.existsSync(path.join(dir, f)), `存在 ${f}`)
  }
  if (mod.icon) t.ok(fs.existsSync(path.join(dir, mod.icon)), `manifest 的 icon 指向的文件存在`, mod.icon)
  if (mod.viewer) t.ok(fs.existsSync(path.join(dir, mod.viewer)), `manifest 的 viewer 指向的文件存在`, mod.viewer)
  if (mod.previewHtml) t.ok(fs.existsSync(path.join(dir, mod.previewHtml)), `manifest 的 previewHtml 存在`, mod.previewHtml)
})

test('parse：正常视频给出格式与大小', async (t) => {
  const tmp = path.join(require('os').tmpdir(), `amm-vid-${Date.now()}.mp4`)
  fs.writeFileSync(tmp, Buffer.alloc(2048))
  try {
    const r = await mod.parse(tmp)
    t.eq(r.format, 'MP4', '识别出格式')
    t.ok(/KB|B/.test(r.fileSize), '给出可读大小', r.fileSize)
    t.ok(!r.状态, '正常文件没有异常状态')
  } finally { fs.unlinkSync(tmp) }
})

test('parse：空文件 / 过小文件给出提示而不是假装正常', async (t) => {
  const os = require('os')
  const empty = path.join(os.tmpdir(), `amm-empty-${Date.now()}.mp4`)
  const tiny = path.join(os.tmpdir(), `amm-tiny-${Date.now()}.mp4`)
  fs.writeFileSync(empty, '')
  fs.writeFileSync(tiny, Buffer.alloc(100))
  try {
    const a = await mod.parse(empty)
    t.ok(/空/.test(a.状态 || ''), '空文件被标出', a.状态)
    const b = await mod.parse(tiny)
    t.ok(/过小|无效/.test(b.状态 || ''), '过小文件被标出', b.状态)
  } finally { fs.unlinkSync(empty); fs.unlinkSync(tiny) }
})

test('parse：文件不存在时不抛异常（只返回错误说明）', async (t) => {
  const r = await mod.parse('Z:\\绝对不存在的\\x.mp4')
  t.ok(r && typeof r === 'object', '返回了对象而不是抛出')
  t.ok(/失败/.test(r.状态 || ''), '说明里指出读取失败', r.状态)
})

test('插件声明：双击行为', (t) => {
  t.eq(mod.dblclick, 'preview', '视频插件声明双击打开预览')
})

test('双击行为：主程序只接受三个合法值', (t) => {
  const H = require(path.join(ROOT, 'src', 'main', 'pluginHost.js'))
  t.eq(H.normalizeDblclick('preview'), 'preview', 'preview 合法')
  t.eq(H.normalizeDblclick('open'), 'open', 'open 合法')
  t.eq(H.normalizeDblclick('none'), 'none', 'none 合法')
  t.eq(H.normalizeDblclick('bogus'), null, '非法值被丢弃（当未声明）')
  t.eq(H.normalizeDblclick(''), null, '空串被丢弃')
  t.eq(H.normalizeDblclick(null), null, 'null 被丢弃')
  t.eq(H.normalizeDblclick(undefined), null, 'undefined 被丢弃')
  t.eq(H.normalizeDblclick(123), null, '非字符串被丢弃')
  t.eq(H.DBLCLICK_DEFAULT, 'none', '未声明时的全局默认是不做任何操作')
  t.ok(H.DBLCLICK_ACTIONS.includes(H.DBLCLICK_DEFAULT), '默认值本身必须是合法动作')
})

test('双击行为：守卫清单所有素材（未声明 → 回落到默认）', (t) => {
  const H = require(path.join(ROOT, 'src', 'main', 'pluginHost.js'))
  // 插件没写 dblclick 时，manifest 上是 null，界面据此用 DBLCLICK_DEFAULT
  const m = H.validateManifest({ id: 'x', name: 'X', exts: ['.x'] })
  t.eq(m.dblclick, null, '未声明 → null（不是硬塞默认值）')
  const m2 = H.validateManifest({ id: 'x', name: 'X', exts: ['.x'], dblclick: 'none' })
  t.eq(m2.dblclick, 'none', '声明 none 被保留（与「未声明」可区分）')
  const m3 = H.validateManifest({ id: 'x', name: 'X', exts: ['.x'], dblclick: '乱写' })
  t.eq(m3.dblclick, null, '乱写的值当未声明')
})

test('双击行为：用户覆盖优先于插件声明', (t) => {
  const H = require(path.join(ROOT, 'src', 'main', 'pluginHost.js'))
  const base = () => H.validateManifest({ id: 'x', name: 'X', exts: ['.x'], dblclick: 'preview' })

  t.eq(H.applyOverrides(base(), { dblclick: 'open' }).dblclick, 'open', '覆盖为 open 生效')
  t.eq(H.applyOverrides(base(), { dblclick: 'none' }).dblclick, 'none', '覆盖为 none 生效')
  t.eq(H.applyOverrides(base(), { dblclick: 'default' }).dblclick, 'preview',
    "'default' = 跟随插件声明（覆盖被清除）")
  t.eq(H.applyOverrides(base(), { dblclick: '乱写' }).dblclick, 'preview', '非法覆盖被忽略')

  // 插件未声明 + 用户没覆盖 → 仍是 null，界面用全局默认
  const none = H.validateManifest({ id: 'x', name: 'X', exts: ['.x'] })
  t.eq(H.applyOverrides(none, {}).dblclick, null, '都没声明 → null')
  t.eq(H.applyOverrides(none, { dblclick: 'open' }).dblclick, 'open', '只有用户覆盖也生效')
})

test('双击行为：界面按「覆盖 > 声明 > 默认」取值且支持全部分支', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  t.ok(/function runDblclick/.test(src), '有 runDblclick 分发函数')
  t.ok(/DBLCLICK_DEFAULT/.test(src), '引用了全局默认值')
  t.ok(/addEventListener\('dblclick'/.test(src), '绑定了 dblclick 事件')
  // 三个分支都要有处理，否则某个设置选了没反应
  t.ok(/action === 'none'/.test(src), "处理 'none'（不操作）")
  t.ok(/action === 'open'/.test(src), "处理 'open'（系统程序打开）")
  t.ok(/previewEntry\(entry\)/.test(src), "处理 'preview'（预览窗口）")

  /*
   * 默认值在两处各写了一份（主进程 pluginHost / 渲染层 app.js），
   * 必须一致 —— 不一致的话「未声明的插件」在主进程看是一个行为、
   * 在界面看是另一个行为，而且很难查。这里直接把两份源码对一遍。
   */
  const H = require(path.join(ROOT, 'src', 'main', 'pluginHost.js'))
  const m = src.match(/const DBLCLICK_DEFAULT\s*=\s*'([^']+)'/)
  t.ok(!!m, '渲染层声明了 DBLCLICK_DEFAULT')
  t.eq(m && m[1], H.DBLCLICK_DEFAULT, '渲染层默认值与主进程一致')
})

test('双击行为：设置页有下拉且随保存提交', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  t.ok(/id="ps-dblclick"/.test(src), '设置弹窗里有双击行为下拉')
  t.ok(/value="default"/.test(src), "有「跟随插件声明」选项")
  t.ok(/value="none"/.test(src), "有「不做任何操作」选项")
  t.ok(/dblclick:\s*m\.body\.querySelector\('#ps-dblclick'\)/.test(src), '保存时提交 dblclick')
})

test('视频播放器：自动播放 / 点击暂停 / 双击全屏', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins', '视频', 'viewer.mjs'), 'utf8')
  t.ok(/await video\.play\(\)/.test(src), '加载后自动播放')
  t.ok(/toggleFullscreen/.test(src), '有全屏切换函数')
  t.ok(/requestFullscreen/.test(src), '调用 requestFullscreen')
  t.ok(/documentElement\.requestFullscreen/.test(src),
    '全屏的是整个页面（否则自绘控制条会消失）')
  t.ok(/clickTimer/.test(src), '单击延迟执行（避免双击时误触发暂停）')
  t.ok(/clearTimeout\(clickTimer\)/.test(src), '双击会取消待执行的单击')
  t.ok(/fullscreenchange/.test(src), '监听全屏变化（Esc 退出后按钮要复位）')

  // 被自动播放策略拦下时的降级：静音再试，保证画面能动
  t.ok(/video\.muted = true/.test(src), '自动播放失败时静音重试')

  const html = fs.readFileSync(path.join(ROOT, 'plugins', '视频', 'preview.html'), 'utf8')
  t.ok(/id="btn-fs"/.test(html), '界面有全屏按钮')
  t.ok(/双击画面|双击.*全屏/.test(html), '界面上有双击全屏的提示')
})

test('视频播放器：时长为未知值时不显示 NaN', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins', '视频', 'viewer.mjs'), 'utf8')
  // 某些 WebM（MediaRecorder 录制 / 缺时长头）duration = Infinity，
  // 直接格式化会显示成「Infinity:NaN:NaN」——必须挡住。
  const m = src.match(/function fmtTime\(sec\)\s*\{[\s\S]*?\n\}/)
  t.ok(m, '找到 fmtTime 实现')
  const fn = new Function('sec', m[0].replace(/^function fmtTime\(sec\)\s*\{/, '').replace(/\}$/, ''))
  t.eq(fn(Infinity), '--:--', 'Infinity → --:--')
  t.eq(fn(NaN), '--:--', 'NaN → --:--')
  t.eq(fn(-5), '--:--', '负数 → --:--')
  t.eq(fn(undefined), '--:--', 'undefined → --:--')
  t.eq(fn(0), '00:00', '0 正常')
  t.eq(fn(65), '01:05', '65 秒 → 01:05')
  t.eq(fn(3725), '1:02:05', '1 小时以上带小时位')
})

test('视频播放器：等元数据用队列（不会漏放等待者）', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins', '视频', 'viewer.mjs'), 'utf8')
  // 旧的单槽 readyResolve 在并发等待时会丢掉前一个等待者 → 抽帧/播放永久挂起
  t.ok(/readyWaiters/.test(src), '等待者存成数组')
  t.ok(/function flushReady/.test(src), '有统一的放行函数')
  t.ok(!/readyResolve\s*=\s*resolve/.test(src), '旧的单槽实现已移除')
  t.ok(/waitCanPlay/.test(src), '播放前等 canplay（只有元数据时 play() 会挂起）')
  t.ok(/preload = 'auto'/.test(src), "preload 用 auto（打开即播需要数据）")
})

test('preview.html：CSP 放开了 asset:（否则视频读不出画面）', (t) => {
  const html = fs.readFileSync(path.join(ROOT, 'plugins', '视频', 'preview.html'), 'utf8')
  const csp = (html.match(/Content-Security-Policy"\s*\n?\s*content="([^"]+)"/) || [])[1]
    || (html.match(/content="(default-src[^"]+)"/) || [])[1] || ''
  t.ok(/media-src[^;]*asset:/.test(csp), 'media-src 含 asset:（<video> 才能读文件）', csp.slice(0, 60))
  t.ok(/script-src 'self'/.test(csp), 'script-src 限制为 self（不写内联脚本）')
})

test('viewer.mjs：契约完整（mount/load/snapshot/dispose）', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins', '视频', 'viewer.mjs'), 'utf8')
  for (const fn of ['mount', 'load', 'snapshot', 'dispose']) {
    t.ok(new RegExp(`\\b${fn}\\s*[(:]`).test(src), `实现了 ${fn}()`)
  }
  t.ok(/export default/.test(src), '默认导出 viewer 工厂')
  t.ok(/opts\.thumbnail|thumbnail/.test(src), '处理缩略图模式（opts.thumbnail）')
})

test('主程序：asset:// 已登记为特权协议（fetch/媒体流的前提）', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
  t.ok(/registerSchemesAsPrivileged/.test(src), '调用了 registerSchemesAsPrivileged')
  t.ok(/scheme:\s*'asset'/.test(src), "登记了 'asset' 方案")
  t.ok(/supportFetchAPI:\s*true/.test(src), '允许 fetch 访问（supportFetchAPI）')
  t.ok(/stream:\s*true/.test(src), '允许流式响应（stream，大视频不整块缓冲）')
})

test('主程序：渲染层 CSP 放行 asset: 的 media/connect', (t) => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
  const csp = (html.match(/content="(default-src[^"]+)"/) || [])[1] || ''
  t.ok(/media-src[^;]*asset:/.test(csp), 'media-src 含 asset:', csp.slice(0, 50))
  t.ok(/connect-src[^;]*asset:/.test(csp), 'connect-src 含 asset:')
})

/** 调度入口（CJS 无顶层 await，必须包一层 async） */
async function main() {
  const ok = await run()
  process.exit(ok ? 0 : 1)
}

main()
