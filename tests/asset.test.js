/**
 * asset:// 协议的路径归属校验
 *
 * 这是主进程的**信任边界**：渲染层（含插件代码）没有 fs 权限，asset:// 是它
 * 唯一的文件读取通道。没有校验，一段被注入的渲染层脚本就能借
 * `asset://file/C:\Users\...\id_rsa` 读走任意外部文件。
 *
 * 本测试同时验证「该拦的拦住」与「不该拦的别误伤」——
 * 后者同样重要：插件读素材附属文件（如 MMD 模型旁的 .tga 贴图）不该被挡。
 *
 * 用 net.fetch 直接打协议处理器：渲染层 XHR 会被页面 CSP 的 connect-src 拦
 * （那是主程序页面本来的设定，与本校验无关）。
 */
const path = require('path')
const fs = require('fs')
const { test, run } = require('./_harness')
const U = require('./_util')

// 必须在 require 主程序之前隔离环境
U.isolateEnv()

// 准备：库目录（含素材 + 「未索引的纹理」）+ 库外机密
const LIB = U.makeLibrary({
  '模型.demo': 'asset-bytes',
  '纹理.png': 'texture-bytes', // 未进索引：插件读它不该被拦
  '子目录/深.demo': 'deep-bytes',
  '子目录/深层纹理.png': 'deep-texture',
})
const SECRET = path.join(U.tmpDir('amm-outside-'), 'secret.txt')
fs.writeFileSync(SECRET, 'TOP-SECRET-PRIVATE-KEY')

// 同前缀陷阱：库是 ...\lib，evil 是 ...\lib-evil（字符串前缀比较会被绕过）
const LIB_EVIL = LIB + '-evil'
fs.mkdirSync(LIB_EVIL, { recursive: true })
fs.writeFileSync(path.join(LIB_EVIL, 'evil.txt'), 'EVIL')

require('../src/main/index.js')

const { app, BrowserWindow, net } = require('electron')

/** 探测一个 asset:// URL，返回 { status, text } */
async function probe(url) {
  try {
    const r = await net.fetch(url)
    const text = r.status === 200 ? (await r.text()).slice(0, 30) : ''
    return { status: r.status, text }
  } catch (e) {
    return { status: 'THROW', text: String((e && e.message) || e) }
  }
}
const enc = encodeURIComponent
const fileUrl = (p) => `asset://file/${enc(p)}`
const thumbUrl = (p) => `asset://thumb/${enc(p)}`

app.whenReady().then(async () => {
  await U.sleep(4000)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.log('  ✗ 主窗口未创建'); app.exit(1); return }

  // 加一个测试素材库（走真实 IPC 路径）
  await win.webContents.executeJavaScript(`window.api.addRoot(${JSON.stringify(LIB)})`)
  await U.sleep(1200)

  test('拒绝范围外的路径（安全边界）', async (t) => {
    t.eq((await probe(fileUrl(SECRET))).status, 403, '库外文件被拒绝')
    t.eq((await probe(fileUrl(path.join(LIB_EVIL, 'evil.txt')))).status, 403, '同前缀目录被拒绝（防前缀绕过）')
    t.eq((await probe(fileUrl(path.join(LIB, '..', 'secret.txt')))).status, 403, '.. 穿越被拒绝')
    t.eq((await probe(fileUrl('C:\\Windows\\win.ini'))).status, 403, '系统文件被拒绝')
    t.eq((await probe(thumbUrl(SECRET.replace('.txt', '.png')))).status, 403, 'thumb 通道同样受校验')
    t.eq((await probe(fileUrl(path.join(U.PROJECT_ROOT, 'package.json')))).status, 403, '项目文件不在库/插件内，被拒绝')
  })

  test('允许范围内的路径（不误伤正常功能）', async (t) => {
    const r1 = await probe(fileUrl(path.join(LIB, '模型.demo')))
    t.eq(r1.status, 200, '库内素材可读')
    t.eq(r1.text, 'asset-bytes', '内容正确')

    const r2 = await probe(fileUrl(path.join(LIB, '纹理.png')))
    t.eq(r2.status, 200, '库内未索引纹理可读（插件读贴图不被误伤）')

    t.eq((await probe(fileUrl(path.join(LIB, '子目录', '深.demo')))).status, 200, '库内子目录可读')
    t.eq((await probe(thumbUrl(path.join(LIB, '纹理.png')))).status, 200, '库内 thumb 可读')

    // 当前生效的 plugins 目录内的文件必须可读 ——
    // 插件自带图标、用户选定的图标副本都靠这条通道显示。
    // 测试自建一个插件，保证不依赖环境里恰好装了什么。
    const created = await win.webContents.executeJavaScript(
      `window.api.createPlugin({ name: '资源测试', folderName: 'assetres', exts: ['.assetres'] })`
    )
    const info = await win.webContents.executeJavaScript(`window.api.listPlugins()`)
    const me = (info || []).find((p) => p.id === 'assetres') || (info || [])[0]
    if (created && created.ok && me && me.dir) {
      t.eq((await probe(fileUrl(path.join(me.dir, 'index.cjs')))).status, 200, 'plugins 目录内可读（插件资源）')
      // plugins 目录的**父目录**在允许范围之外（白名单只放行 plugins 根及其子项）
      const outsidePlugins = path.join(path.dirname(me.dir), '..', 'outside-plugins.txt')
      fs.writeFileSync(outsidePlugins, 'OUTSIDE')
      t.eq((await probe(fileUrl(outsidePlugins))).status, 403, 'plugins 目录之外仍被拒绝')
    } else {
      t.skip('plugins 目录可读性（无法创建测试插件）')
    }
  })

  test('thumb 通道的扩展名限制', async (t) => {
    // thumb 只允许图片扩展名（与路径校验是两道独立检查）
    t.eq((await probe(thumbUrl(path.join(LIB, '模型.demo')))).status, 403, 'thumb 拒绝非图片扩展名')
  })

  const ok = await run()
  await U.finish(ok ? 0 : 1)
})
