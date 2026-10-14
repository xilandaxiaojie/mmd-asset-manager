/**
 * 插件图标「选择即拷入插件目录」流程
 *
 * 背景：asset:// 只允许读素材库内 / plugins 目录内的文件。用户在桌面选图标时，
 * 原图在允许范围之外 —— 所以主程序必须**先把图拷进插件目录**再返回路径，
 * 否则渲染层显示不出预览。
 *
 * 验证：选图 → 拷入 → 可预览 → 保存定稿 / 放弃清理，全程不碰真实插件目录。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { test, run } = require('./_harness')
const U = require('./_util')

U.isolateEnv() // 必须在 require 主程序之前

// 模拟「用户在桌面选的图标」（在允许范围之外）
const OUTSIDE = U.tmpDir('amm-desktop-')
const PICKED = path.join(OUTSIDE, '我的图标.png')
fs.writeFileSync(PICKED, 'icon-bytes')

// 拦住文件对话框，返回准备好的文件（无法自动应答真实对话框）
const { dialog } = require('electron')
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PICKED] })

require('../src/main/index.js')

const { app, BrowserWindow, net } = require('electron')
const PLUGIN_ID = 'icontest'

app.whenReady().then(async () => {
  await U.sleep(4000)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.log('  ✗ 主窗口未创建'); app.exit(1); return }

  // 建测试插件（落在隔离的临时 plugins 目录）
  const created = await win.webContents.executeJavaScript(
    `window.api.createPlugin({ name: '图标测试', folderName: ${JSON.stringify(PLUGIN_ID)}, exts: ['.icontest'] })`
  )
  const info = await win.webContents.executeJavaScript(`window.api.listPlugins()`)
  const me = (info || []).find((p) => p.id === PLUGIN_ID)
  const pdir = me && me.dir
  const listIcons = () => (pdir ? fs.readdirSync(pdir).filter((f) => f.startsWith('amm-icon')) : [])

  test('测试环境隔离（不污染真实插件目录）', async (t) => {
    t.ok(!!(created && created.ok), '测试插件创建成功')
    t.ok(!!pdir && pdir.startsWith(os.tmpdir()), '插件目录在系统临时目录内', pdir)
  })

  test('选择图标：拷入插件目录并可预览', async (t) => {
    const res = await win.webContents.executeJavaScript(
      `window.api.pickPluginIcon(${JSON.stringify(PLUGIN_ID)})`
    )
    if (!t.ok(!!(res && res.ok), '选择成功', (res && res.error) || '')) return

    t.ok(path.resolve(res.path).startsWith(path.resolve(pdir)), '返回路径在插件目录内')
    t.ok(fs.existsSync(res.path), '文件已落盘')
    t.ok(String(res.fileName).startsWith('amm-icon-tmp'), '文件名带临时标记', res.fileName)
    t.eq(fs.readFileSync(res.path, 'utf8'), 'icon-bytes', '内容与所选一致')

    // 渲染层预览通道（asset:// 只放行 plugins 目录内的文件）
    const r = await net.fetch('asset://file/' + encodeURIComponent(res.path))
    t.eq(r.status, 200, '渲染层可预览（asset:// 200）')

    // ── 保存 → 临时名定稿 ──
    const upd = await win.webContents.executeJavaScript(
      `window.api.updatePlugin({ id: ${JSON.stringify(PLUGIN_ID)}, iconPath: ${JSON.stringify(res.path)} })`
    )
    t.ok(!!(upd && upd.ok), '保存成功', (upd && upd.error) || '')
    const after = listIcons()
    t.ok(!after.some((f) => f.includes('tmp')), '保存后无 tmp 残留', after.join(', '))
    t.ok(after.some((f) => !f.includes('tmp')), '保存后有正式图标', after.join(', '))
  })

  test('放弃选择：临时图被清理', async (t) => {
    const res = await win.webContents.executeJavaScript(
      `window.api.pickPluginIcon(${JSON.stringify(PLUGIN_ID)})`
    )
    if (!t.ok(!!(res && res.ok), '第二次选择成功')) return
    t.ok(fs.existsSync(res.path), '放弃前文件存在')

    const disc = await win.webContents.executeJavaScript(
      `window.api.discardPluginIcon(${JSON.stringify(PLUGIN_ID)}, ${JSON.stringify(res.fileName)})`
    )
    t.ok(!!(disc && disc.ok), 'discard 返回 ok')
    t.ok(!fs.existsSync(res.path), '放弃后临时图被清除')
  })

  test('discard 不会误删非临时文件', async (t) => {
    // 只有 amm-icon-tmp 前缀的文件才允许被 discard 删除
    const keep = listIcons().find((f) => !f.includes('tmp'))
    if (!keep) { t.skip('当前无正式图标可测'); return }
    await win.webContents.executeJavaScript(
      `window.api.discardPluginIcon(${JSON.stringify(PLUGIN_ID)}, ${JSON.stringify(keep)})`
    )
    t.ok(fs.existsSync(path.join(pdir, keep)), '正式图标未被误删', keep)

    // 尝试用非法文件名（目录穿越）也不能删到插件目录外的东西
    const victim = path.join(OUTSIDE, 'victim.txt')
    fs.writeFileSync(victim, 'SHOULD-SURVIVE')
    await win.webContents.executeJavaScript(
      `window.api.discardPluginIcon(${JSON.stringify(PLUGIN_ID)}, 'amm-icon-tmp../../victim.txt')`
    )
    t.ok(fs.existsSync(victim), '目录穿越文件名不能删到插件目录外')
  })

  const ok = await run()
  await U.finish(ok ? 0 : 1)
})
