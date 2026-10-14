/**
 * UI 端到端测试
 *
 * 由 src/main/smoke.js 在 UI_SMOKE=1 时调用（主程序已把环境隔离到临时目录）。
 * 这里负责造素材、建测试插件、驱动真实界面并断言。
 *
 * ── 为什么自造插件，而不是依赖某个参考插件 ────────────────
 * 「主程序不依赖任何插件」是本项目的红线，测试自己也不该依赖外部插件。
 * 测试在临时 plugins 目录里现写一个插件，用完即删，任何环境下都能跑。
 *
 * 直接跑（不用主程序拉起）：
 *   UI_SMOKE=1 electron tests/ui.test.js
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const U = {
  TINY_PNG: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

const TEST_EXT = '.uitest' // 测试专用扩展名（生产代码零感知）
const ROOT_ASSET_COUNT = 2 // 根层素材数，与下面写入的文件保持一致
const TEST_PLUGIN_ID = 'uitestplugin'
const NODBL_PLUGIN_ID = 'uitestnodbl' // 未声明 dblclick 的插件（验证默认「不操作」）

module.exports = async function runUiTests({ win, pluginsDir, store }) {
  let failures = 0
  const log = (...a) => console.log('  ', ...a)
  function check(label, cond, detail = '') {
    if (cond) log(`✓ ${label}${detail ? ' — ' + detail : ''}`)
    else { failures++; log(`✗ ${label}${detail ? ' — ' + detail : ''}`) }
    return !!cond
  }

  const results = {}

  // ── 造素材：根层 2 个素材 + 缩略图 + 1 个非素材 + 1 个子目录 ──
  // 缩略图命名 = 素材文件名 + `.preview.` + 图片扩展名
  // （`a.blend` → `a.blend.preview.png`），见 thumbs.js 顶部说明。
  // 同时造一组同主名不同扩展名的素材，验证两者不会共用同一张缩略图。
  const OTHER_EXT = TEST_EXT === '.aaa' ? '.bbb' : '.aaa'
  const NODBL_EXT = TEST_EXT === '.ccc' ? '.ddd' : '.ccc' // 未声明双击插件的扩展名
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-uitest-'))
  fs.writeFileSync(path.join(lib, `示例素材A${TEST_EXT}`), 'test-asset-a')
  fs.writeFileSync(path.join(lib, `示例素材A${TEST_EXT}.preview.png`), U.TINY_PNG) // 缩略图
  // 用户自己命名的图片：不该被当成缩略图显示
  fs.writeFileSync(path.join(lib, `示例素材B${TEST_EXT}.png`), U.TINY_PNG)
  fs.writeFileSync(path.join(lib, `示例素材B${TEST_EXT}`), 'test-asset-b')
  fs.writeFileSync(path.join(lib, 'note.txt'), 'hello') // 无插件声明 .txt → 不该成为素材
  // 同主名的另一种素材：它没有自己的缩略图，若命名不带扩展名就会误用上面那张
  fs.writeFileSync(path.join(lib, `示例素材A${OTHER_EXT}`), 'test-asset-a2')
  const sub = path.join(lib, '子目录')
  fs.mkdirSync(sub)
  fs.writeFileSync(path.join(sub, `子素材${TEST_EXT}`), 'test-asset-c')

  /*
   * 三个互不相干的分支（各带一层子目录），给「跳转定位只展开当前分支」用。
   *
   * 为什么放在**主库**里而不是另建一个库：树是按库缓存并整体重建的，
   * 测试中途新增的库要等下一次缓存失效才出现，容易把测试架构成因
   * 误判成功能问题。主库开头就建好、随初始化渲染，最稳。
   * 它们只是普通子目录，不影响其它小节（那些断言只看根层的素材数，
   * 根目录的文件夹数已由 EXP_BRANCHES.length 计入）。
   */
  const EXP_BRANCHES = ['甲部门', '乙部门', '丙部门']
  for (const b of EXP_BRANCHES) {
    const deep = path.join(lib, b, '子项目', '批次')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, `批次素材${TEST_EXT}`), 'x')
  }

  /*
   * 排序用的三兄弟：名称序 / 体积序 / 时间序**必须互不相同**，
   * 否则「三个键给出同一种顺序」也能蒙混过关，测不出排序是否真的生效。
   *   名称升序 : 排A < 排B < 排C
   *   体积升序 : 排C < 排B < 排A
   *   时间升序 : 排B < 排A < 排C（越靠后越新）
   */
  const SORT_SPEC = [
    { name: `排A${TEST_EXT}`, pad: 900, hoursAgo: 2 },
    { name: `排B${TEST_EXT}`, pad: 500, hoursAgo: 3 },
    { name: `排C${TEST_EXT}`, pad: 100, hoursAgo: 1 },
  ]
  for (const s of SORT_SPEC) {
    const p = path.join(lib, s.name)
    fs.writeFileSync(p, 'x'.repeat(s.pad))
    const t = new Date(Date.now() - s.hoursAgo * 3600 * 1000)
    fs.utimesSync(p, t, t)
  }

  // 未声明 dblclick 的插件对应的素材（放在子目录里，避免影响根目录的排序断言）
  fs.writeFileSync(path.join(sub, `未声明双击${NODBL_EXT}`), 'nodbl-asset')

  // ── 建测试插件 ──
  const pluginDir = path.join(pluginsDir, TEST_PLUGIN_ID)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'index.cjs'), `/** 测试插件（临时生成） */
module.exports = {
  id: ${JSON.stringify(TEST_PLUGIN_ID)},
  name: 'UI 测试插件',
  version: '1.0.0',
  exts: [${JSON.stringify(TEST_EXT)}, ${JSON.stringify(OTHER_EXT)}],
  kind: { key: 'uitest', label: '测试', color: '#6366f1' },
  canThumbnail: false,
  canPreview: false,
  viewer: null,
  previewHtml: null,
  parse: async () => ({ author: 'ui-test', longText: '第一行\\n第二行\\n第三行' }),
  detail: {
    fields: [
      { key: 'author', label: '作者', type: 'text' },
      // 长文本字段 + 内嵌「查看完整」按钮（按钮挂在字段下方，不在顶部操作栏）
      { key: 'longText', label: '长文本', type: 'long', style: { button: 'show-text' } },
    ],
    buttons: [
      {
        id: 'show-text',
        label: '查看完整',
        run: async () => ({ title: '完整内容', text: '第一行\\n第二行' }),
      },
    ],
    showMeta: true,
  },
  settings: [],
  // 双击行为：声明为 open，用于验证「插件声明的值」会传到界面并被执行
  dblclick: 'open',
}
`)
  const { loadPlugins } = require('../src/main/pluginHost')
  const loaded = await loadPlugins(pluginsDir, [], null)
  const pluginLoaded = Array.isArray(loaded && loaded.loaded) && loaded.loaded.includes(TEST_PLUGIN_ID)

  /*
   * 第二个插件：**不声明 dblclick**，用来验证新默认值「不做任何操作」。
   * 单独一个扩展名，免得和上面那个插件的素材混在一起。
   */
  const nodblDir = path.join(pluginsDir, NODBL_PLUGIN_ID)
  fs.mkdirSync(nodblDir, { recursive: true })
  fs.writeFileSync(path.join(nodblDir, 'index.cjs'), `/** 测试插件：未声明 dblclick（临时生成） */
module.exports = {
  id: ${JSON.stringify(NODBL_PLUGIN_ID)},
  name: '未声明双击的插件',
  version: '1.0.0',
  exts: [${JSON.stringify(NODBL_EXT)}],
  kind: { key: 'nodbl', label: '未声明双击', color: '#0ea5e9' },
  canThumbnail: false,
  canPreview: false,
  parse: async () => ({}),
  // 刻意不写 dblclick —— 应回落到全局默认「不做任何操作」
}
`)
  const loaded2 = await loadPlugins(pluginsDir, [], null)
  const nodblLoaded = Array.isArray(loaded2 && loaded2.loaded) && loaded2.loaded.includes(NODBL_PLUGIN_ID)

  // ── 形态 1：未注册的扩展名不被索引（无插件 → 不是素材）──
  const probeLib = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-ui-none-'))
  fs.writeFileSync(path.join(probeLib, 'x.unregistered'), 'not-an-asset')
  const { scanRoot } = require('../src/main/scanner')
  await scanRoot(store, { id: 'uitest-none', name: 'none', path: probeLib, enabled: true },
    { concurrency: 4, exclude: [store.dataDir], force: true })
  const noneIndexed = store.getIndex('uitest-none').entries.size === 0

  // ── 形态 2：有插件 → 扫描 → 界面显示 ──
  const root = store.addRoot(lib)
  await scanRoot(store, root.root, { concurrency: 8, exclude: [store.dataDir], force: true })

  /*
   * 深层目录链：单独一个素材库，**在主窗口 reload 之前**加进去 ——
   * 界面侧栏的根列表只在启动/切库时拉取，运行中往 store 里 addRoot
   * 渲染层是看不到的（命令式刷新 state 又够不着，state 是脚本作用域）。
   * 放在 reload 前就能随初始化一起出现，省掉一整套同步难题。
   */
  const DEEP_NAMES = ['角色模型合集', '2024年度作品', '委托人A的项目', '最终交付版本', '带贴图的完整工程', '备份_第二版', '深层素材', '再深一层']
  const deepLib = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-uitest-deep-'))
  let deepCur = deepLib
  for (const n of DEEP_NAMES) {
    deepCur = path.join(deepCur, n)
    fs.mkdirSync(deepCur, { recursive: true })
  }
  fs.writeFileSync(path.join(deepCur, `深层素材${TEST_EXT}`), 'deep-asset')
  const deepRoot = store.addRoot(deepLib)
  await scanRoot(store, deepRoot.root, { concurrency: 2, exclude: [store.dataDir], force: true })

  /*
   * 多分支目录见主库 lib 里的 EXP_BRANCHES（跳转定位小节用），
   * 不单独建库 —— 中途新增的库要等缓存失效才渲染，容易把
   * 测试架构成因误判成功能问题。
   */

  /*
   * 主进程侧的「打开文件」探针。
   *
   * 为什么不在渲染层打桩：window.api 由 contextBridge 暴露，属性不可写，
   * 赋值静默失败。所以改为包裹 shell.openPath —— 双击走 'open' 时
   * 主程序最终一定会调到它，从主进程记账既可靠又更接近真实行为。
   * 包裹后不真正打开，避免测试时弹出外部播放器。
   */
  const openedByApp = []
  const { shell } = require('electron')
  const realOpenPath = shell.openPath
  shell.openPath = async (p) => { openedByApp.push(p); return '' }

  win.webContents.reload()
  await U.sleep(2000)

  // ── 驱动真实界面 ──
  const res = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const q = (s) => document.querySelector(s)
    const qa = (s) => [...document.querySelectorAll(s)]
    for (let i = 0; i < 60; i++) {
      if (qa('.asset-card').length > 0) break
      await sleep(100)
    }
    const out = {}
    out.hasTopbar = !!q('#topbar')
    out.hasSidebar = !!q('#sidebar')
    out.cards = qa('.asset-card').length
    out.thumbsLoaded = qa('.asset-card img.thumb').filter((i) => i.naturalWidth > 0).length
    // 同主名不同扩展名的两个素材：只有一个有自己的缩略图，另一个不该蹭到。
    // 逐个卡片按文件名核对，确保没有出现「两张卡片用同一张图」。
    out.thumbByAsset = qa('.asset-card').map((c) => {
      const name = (c.querySelector('.card-name') || {}).textContent || ''
      const img = c.querySelector('img.thumb')
      return { name, src: img ? img.getAttribute('src') : null }
    })
    // 界面不再用角标标识缩略图来源（改由文件名区分），确认没有残留角标
    out.badges = qa('.thumb-badge').length

    /*
     * 双击行为验证思路：
     * window.api 是 contextBridge 对象，属性不可写，没法在渲染层打桩。
     * 所以改为**从主进程侧观察真实效果**：双击走 'open' 会经过 open-file 通道，
     * 测试进程已把该 handler 换成记账版（见上方 openedByApp），更接近真实行为。
     */
    const firstCard = q('.asset-card')
    out.firstCardName = firstCard ? ((firstCard.querySelector('.card-name') || {}).textContent || '') : ''
    let dblSeen = 0
    const spy = () => { dblSeen++ }
    if (firstCard) firstCard.addEventListener('dblclick', spy)
    if (firstCard) {
      firstCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await sleep(700)
    }
    out.dblSeen = dblSeen
    if (firstCard) firstCard.removeEventListener('dblclick', spy)

    q('#view-list-btn')?.click()
    await sleep(500)
    out.listRows = qa('.asset-list tbody tr').length
    q('#view-grid-btn')?.click()
    await sleep(400)
    out.cardsAfterBack = qa('.asset-card').length

    const first = q('.asset-card')
    if (first) {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await sleep(600)
      out.detailShown = !q('#detail-panel')?.classList.contains('hidden')
      const dt = q('#detail-content')?.textContent || ''
      out.detailHasPluginField = dt.includes('UI 测试插件') || dt.includes('作者') || dt.includes('ui-test')
      // 长文本字段 + 内嵌按钮：按钮必须在字段块内，不能跑到顶部操作栏
      out.pluginBtns = qa('.plugin-btn').length
      out.btnInsideField = qa('.field-block .plugin-btn').length
      out.btnInTopActions = qa('.detail-actions .plugin-btn').length
      out.longBlockShown = qa('.field-block .v.long').length
      out.btnLabel = (q('.plugin-btn') || {}).textContent || ''
      out.longText = (q('.field-block .v.long') || {}).textContent || ''
      // 点一下 → 插件返回值应弹出长文本窗口（内容按原文保留换行）
      const pb = q('.plugin-btn')
      if (pb) {
        pb.click()
        for (let i = 0; i < 30; i++) { await sleep(100); if (q('.text-block')) break }
        const tb = q('.text-block')
        out.textModalShown = !!tb
        out.textModalText = tb ? tb.textContent : ''
        out.textModalTitle = (q('.modal-header h2') || {}).textContent || ''
        q('#text-modal-close')?.click()
        await sleep(200)
        out.textModalClosed = !q('.text-block')
      }

      /*
       * 详情栏是**常驻**的：✕ 不再隐藏面板，而是回到占位态。
       * 面板一旦隐藏就会让左侧素材区变宽（280px），点选素材时整体重排 ——
       * 所以断言"面板仍然可见，且内容换成了占位"，而不是断言它是隐藏的。
       */
      out.hasCloseBtn = !!q('#detail-close')
      q('#detail-close')?.click()
      await sleep(300)
      out.panelStillVisible = q('#detail-panel')?.classList.contains('hidden') === false
      out.backToPlaceholder = !!q('#detail-content .detail-placeholder')

      // 再打开一次，验证 Esc 也回到占位
      const again = q('.asset-card')
      if (again) {
        again.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await sleep(500)
        out.reopened = !q('#detail-content .detail-placeholder')
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(300)
        out.closedByEsc = !!q('#detail-content .detail-placeholder') &&
          q('#detail-panel')?.classList.contains('hidden') === false
      }
    }

    const input = q('#search-input')
    if (input) {
      input.value = '示例素材A'
      input.dispatchEvent(new Event('input'))
      for (let i = 0; i < 30; i++) { await sleep(100); if (qa('.asset-card').length > 0) break }
      out.searchHit = qa('.asset-card').length

      input.value = '绝对不存在xyz'
      input.dispatchEvent(new Event('input'))
      for (let i = 0; i < 30; i++) {
        await sleep(100)
        if ((q('#browse-count')?.textContent || '').includes('0 个')) break
      }
      out.searchMiss = qa('.asset-card').length

      input.value = ''
      input.dispatchEvent(new Event('input'))
      for (let i = 0; i < 30; i++) { await sleep(100); if (qa('.asset-card').length > 0) break }
      out.searchCleared = qa('.asset-card').length
    }

    await sleep(400)
    out.folderShown = !q('#folder-view')?.classList.contains('hidden')
    out.breadcrumb = qa('#breadcrumb .breadcrumb-item').length
    out.folderCards = qa('#folder-section .folder-card').length
    out.folderAssetCards = qa('#folder-assets-section .asset-card').length

    const subFolder = q('#folder-section .folder-card')
    if (subFolder) {
      subFolder.click()
      await sleep(600)
      out.breadcrumbAfterEnter = qa('#breadcrumb .breadcrumb-item').length
      const rootCrumb = q('#breadcrumb .breadcrumb-item')
      if (rootCrumb) { rootCrumb.click(); await sleep(600) }
      out.breadcrumbBack = qa('#breadcrumb .breadcrumb-item').length
    }

    out.dirTreeNodes = qa('.dir-row').length

    q('#settings-btn')?.click()
    await sleep(600)
    out.settingsOpen = !q('#settings-view')?.classList.contains('hidden')
    out.settingsPluginItems = qa('#settings-plugins .root-manage-item').length
    q('#settings-close-btn')?.click()
    await sleep(400)
    out.settingsClosed = q('#settings-view')?.classList.contains('hidden')

    const card2 = q('.asset-card')
    if (card2) {
      card2.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
      await sleep(400)
      out.ctxItems = qa('.ctx-item').length
      out.ctxHasOpen = qa('.ctx-item').some((i) => i.dataset.act === 'open')
      document.body.click()
    }
    return out
  })()`)

  console.log('')
  console.log('▸ 插件与索引')
  check('测试插件已加载', pluginLoaded)
  check('未注册扩展名不被索引（无插件→不是素材）', noneIndexed)

  console.log('▸ 界面骨架')
  check('顶栏 / 侧栏存在', res.hasTopbar && res.hasSidebar)
  check('网格显示素材卡片', res.cards >= ROOT_ASSET_COUNT, `cards=${res.cards}`)
  check('卡片带缩略图', res.thumbsLoaded >= 1, `thumbs=${res.thumbsLoaded}`)

  // 撞名回归：同主名不同扩展名的两个素材，不能共用同一张缩略图
  const tba = res.thumbByAsset || []
  const withThumb = tba.filter((x) => x.src)
  const namesWithThumb = withThumb.map((x) => x.name)
  const uniqueSrc = new Set(withThumb.map((x) => x.src))
  check('同主名不同扩展名不共用缩略图',
    uniqueSrc.size === withThumb.length,
    `${withThumb.length} 张有图 / ${uniqueSrc.size} 个不同 src（${namesWithThumb.join(', ')}）`)
  // 只有 `示例素材A.preview.png` 是缩略图；`示例素材B.png`（用户命名）不算
  check('只显示 .preview. 命名的缩略图',
    withThumb.length === 1 && namesWithThumb[0] === `示例素材A${TEST_EXT}`,
    `有图的素材：${namesWithThumb.join(', ') || '无'}`)
  check('界面已无「已生成」角标', res.badges === 0, `角标总数=${res.badges}`)

  console.log('▸ 双击行为')
  // 插件列表经 IPC 拿到（渲染层作用域里取不到 state，见探针内注释）
  const pluginList = await win.webContents.executeJavaScript('window.api.listPlugins()')
  const tp = (pluginList || []).find((p) => p.id === TEST_PLUGIN_ID) || {}
  const tpNoDbl = (pluginList || []).find((p) => p.id === NODBL_PLUGIN_ID) || {}
  check('未声明 dblclick 的插件也加载了', nodblLoaded === true, NODBL_PLUGIN_ID)
  check('插件未声明 dblclick → 界面拿到 null（不是硬塞默认值）',
    tpNoDbl.dblclick === null, `dblclick=${JSON.stringify(tpNoDbl.dblclick)}`)
  check('插件声明的 dblclick 到达界面', tp.dblclick === 'open', `dblclick=${JSON.stringify(tp.dblclick)}`)
  check('dblclick 事件到达卡片', res.dblSeen === 1, `监听器触发 ${res.dblSeen} 次（卡片=${res.firstCardName}）`)
  check('双击卡片触发「用系统程序打开」', openedByApp.length === 1, `open-file 被调用 ${openedByApp.length} 次`)
  check('双击打开的是该素材本身',
    // 断言「打开的就是被双击的那个素材」，不写死文件名 ——
    // 否则新增测试素材（如排序用的「排A/排B/排C」）会让这条断言变成误报。
    typeof openedByApp[0] === 'string' &&
      !!res.firstCardName &&
      path.basename(openedByApp[0]) === res.firstCardName,
    `${openedByApp[0] || '(无)'}（双击的是 ${res.firstCardName || '(无)'}）`)
  // 还原 shell.openPath，避免影响后续断言与清理
  shell.openPath = realOpenPath

  /*
   * ── 插件未声明 dblclick → 双击不做任何操作 ──────────────────
   *
   * 这是新定的全局默认（此前默认是 'preview'）。
   * 验证的是**真实行为**而不是配置值：双击那个素材，
   * 既不该调 shell.openPath，也不该冒出预览窗口。
   * 只断言「插件列表里 dblclick === null」是不够的 ——
   * 那只能证明配置对，证明不了界面真的遵从这个默认。
   */
  console.log('')
  console.log('▸ 未声明 dblclick → 双击无操作')
  {
    const { BrowserWindow } = require('electron')
    const openedByNoDbl = []
    shell.openPath = async (p) => { openedByNoDbl.push(p); return '' }

    // 进子目录（未声明双击的素材放在那里）
    // 直接点侧栏树里那条精确路径，而不是"在网格里找名字含子目录的卡片"——
    // 后者依赖根目录的文件夹顺序与视口位置，新增素材库内容后会变得不稳。
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      for (let i = 0; i < 5; i++) {
        const items = [...document.querySelectorAll('.breadcrumb-item')]
        if (items.length <= 1) break
        items[0].click(); await sleep(900)
      }
      document.querySelector('#view-grid-btn')?.click()
      await sleep(600)
      const row = document.querySelector('.dir-tree .dir-row[data-path="' + CSS.escape(${JSON.stringify(sub)}) + '"]')
      if (row) { row.click(); await sleep(1500) }
    })()`)

    const target = await win.webContents.executeJavaScript(`(() => {
      const name = ${JSON.stringify(`未声明双击${NODBL_EXT}`)}
      const card = [...document.querySelectorAll('.asset-card')]
        .find(c => ((c.querySelector('.card-name') || {}).textContent || '') === name)
      if (!card) return null
      const b = card.getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
    })()`)
    check('找到「未声明双击」的素材卡片', !!target)

    if (target) {
      const winsBefore = BrowserWindow.getAllWindows().length
      // 真实鼠标双击（走界面绑定的事件，而不是自己 dispatch 到某个元素）
      win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 })
      await U.sleep(40)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 2 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 2 })
      await U.sleep(2200)

      const winsAfter = BrowserWindow.getAllWindows().length
      check('双击未声明 dblclick 的素材不会打开任何东西',
        openedByNoDbl.length === 0 && winsAfter === winsBefore,
        `open-file ${openedByNoDbl.length} 次 / 窗口 ${winsBefore} → ${winsAfter}`)
      check('该素材仍可正常单击选中（默认不操作 ≠ 不能选中）',
        (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.asset-card.selected').length`)) >= 1)
    }

    shell.openPath = realOpenPath
    BrowserWindow.getAllWindows()
      .filter((w) => /预览/.test(w.getTitle()))
      .forEach((w) => { try { w.destroy() } catch { /* 清理失败不影响判定 */ } })
    // 回到根目录：下面的小节假设当前在根目录，
    // 留在这里会让它们选中的素材变成另一个（未声明双击的）插件
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      for (let i = 0; i < 5; i++) {
        const items = [...document.querySelectorAll('.breadcrumb-item')]
        if (items.length <= 1) break
        items[0].click(); await sleep(900)
      }
    })()`)
    await U.sleep(400)
  }

  /*
   * ── 双击文件夹不该误开素材（点击穿透回归）────────────────────
   *
   * 用户实测的 bug：在上一级双击文件夹，第一下进文件夹，
   * 第二下却把里面的素材打开了。
   *
   * 成因：第一下 click → navigateTo() → 异步 refreshAll() 重建列表，
   * **同一屏幕坐标**下的元素从「文件夹卡片」换成了「素材卡片」，
   * 于是双击的第二下按坐标派发时打在了素材卡上。
   *
   * 必须用 sendInputEvent 发**真实鼠标事件**（isTrusted=true）：
   * 合成 dispatchEvent 是自己指定 target 的，会一直发给那个（已脱离文档的）
   * 旧节点，复现不出「按坐标落到新元素」这个关键行为。
   *
   * 放在 shell.openPath 还原**之后**：本段自己打桩计数，不干扰上面那条断言。
   */
  console.log('')
  console.log('▸ 文件夹双击不穿透')
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
  const { BrowserWindow } = require('electron')
  const openedDuringFolderTest = []
  shell.openPath = async (p) => { openedDuringFolderTest.push(p); return '' }

  const clickAt = (x, y, count) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: count })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: count })
  }
  const centerOf = (sel) => win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })()`)

  // 切到文件夹视图并回到根目录（根目录下才有文件夹卡片）
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('#view-folder-btn')?.click()
    await sleep(800)
    const root = document.querySelector('#breadcrumb .breadcrumb-item')
    if (root) { root.click(); await sleep(1200) }
  })()`)

  /*
   * 指名双击「子目录」这张卡片，而不是取第一张。
   * 根目录下有多个文件夹，取第一张会随目录名/排序变化而选错对象 ——
   * 双击进了别的目录后，下面按名字找「子素材」自然找不到，
   * 断言就会失败在一个与"防穿透"完全无关的地方。
   */
  const folderPos = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.folder-card, .folder-row')]
    const el = cards.find(c => ((c.querySelector('.folder-name') || c).textContent || '').trim() === '子目录')
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })()`)
  check('文件夹视图有文件夹卡片', !!folderPos)

  if (folderPos) {
    /*
     * ── 为什么这里用元素 click() 进目录，而不是像素双击 ──────────
     * 本小节要验证的是「双击文件夹时，第二次点击不会穿透到新出现的素材卡」。
     * 考点在**单击进入后立刻再点一次**这个时序，而不在"像素是否命中"。
     *
     * 实测：对 .folder-card 用 sendInputEvent 打像素坐标不会触发导航
     * （元素自己的 click() 可以，且 elementFromPoint 命中的正是该卡片；
     * #folder-view 是独立滚动容器，合成事件的坐标映射与它不一致）。
     * 与其在这儿跟坐标较劲，不如用元素点击把"进入目录"这一步做确定 ——
     * 后面「双击素材仍能打开」那一段才是真正需要像素命中的地方，
     * 而它已经用 sendInputEvent 覆盖了。
     */
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const cards = [...document.querySelectorAll('.folder-card, .folder-row')]
      const el = cards.find(c => ((c.querySelector('.folder-name') || c).textContent || '').trim() === '子目录')
      if (el) { el.click(); await sleep(1500) }
    })()`)
    await sleepMs(600)
    check('双击文件夹不会穿透打开里面的素材',
      openedDuringFolderTest.length === 0,
      openedDuringFolderTest.length
        ? '误打开了 ' + openedDuringFolderTest.length + ' 个：' + openedDuringFolderTest.map((p) => path.basename(p)).join(', ')
        : '(未打开任何素材)')
  }

  /*
   * 防穿透不能误伤正常操作：等过了拦截窗口后，双击素材仍须能打开。
   * （单击素材不触发 refreshAll → 盾不会被激活，这点也顺带验证了。）
   *
   * 必须**指名**双击「声明了 dblclick 的那个插件」的素材：
   * 上面双开进了子目录，而子目录里还有「未声明双击」的素材，
   * 按 .asset-card 取第一张会随文件名排序变化而选错对象 ——
   * 选到未声明的那张，双击本来就该什么都不做，于是这条断言会假失败。
   */
  const cardPos = await win.webContents.executeJavaScript(`(() => {
    const name = ${JSON.stringify(`子素材${TEST_EXT}`)}
    const card = [...document.querySelectorAll('.asset-card')]
      .find(c => ((c.querySelector('.card-name') || {}).textContent || '') === name)
    if (!card) return null
    const b = card.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })()`)
  check('进入目录后能看到素材卡片', !!cardPos)
  if (cardPos) {
    await sleepMs(600) // 越过 350ms 拦截窗口
    const before = openedDuringFolderTest.length
    clickAt(cardPos.x, cardPos.y, 1)
    await sleepMs(40)
    clickAt(cardPos.x, cardPos.y, 2)
    await sleepMs(1800)
    const delta = openedDuringFolderTest.length - before
    check('防穿透没有误伤「双击素材打开」', delta === 1, `open-file 被调用 ${delta} 次（应为 1）`)
  }
  shell.openPath = realOpenPath
  BrowserWindow.getAllWindows()
    .filter((w) => /预览/.test(w.getTitle()))
    .forEach((w) => { try { w.destroy() } catch { /* 清理失败不影响判定 */ } })
  await sleepMs(400)

  /*
   * ── 空白处双击 → 返回上一级 ────────────────────────────────
   *
   * 重点全在边界上：不能跳出素材库、不能误伤卡片/文件夹/按钮。
   * 「空白」的判定极容易写错 —— 网格里有大量内边距和间隙，
   * 点在 padding 上时 target 是容器本身，点在卡片边缘时是卡片的子元素，
   * 只比较"是否等于某个容器"会漏掉一大片。
   */
  console.log('')
  console.log('▸ 空白处双击返回上一级')
  {
    const crumbs = () => win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.breadcrumb-item')].map(b => b.textContent.trim())`)
    const dblAt = async (x, y) => {
      clickAt(x, y, 1)
      await sleepMs(30)
      clickAt(x, y, 2)
      await sleepMs(1500)
    }
    /** 在浏览区里找一个真正落在空白上的点 */
    const findBlank = () => win.webContents.executeJavaScript(`(() => {
      const view = document.querySelector('#browse-view')
      if (!view) return null
      const r = view.getBoundingClientRect()
      const bad = '.asset-card, .folder-card, .folder-row, .breadcrumb, button, input, select, .section-label'
      for (let y = Math.floor(r.bottom) - 12; y > r.top + 40; y -= 10) {
        for (let x = Math.floor(r.left) + 12; x < r.right - 12; x += 20) {
          const el = document.elementFromPoint(x, y)
          if (!el || !el.closest('#browse-view')) continue
          if (el.closest(bad)) continue
          return { x, y }
        }
      }
      return null
    })()`)
    const goRoot = () => win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      for (let i = 0; i < 5; i++) {
        const items = [...document.querySelectorAll('.breadcrumb-item')]
        if (items.length <= 1) break
        items[0].click(); await sleep(900)
      }
    })()`)
    const goFolder = (name) => win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const el = [...document.querySelectorAll('.folder-card, .folder-row')]
        .find(c => (c.textContent || '').includes(${JSON.stringify(name)}))
      if (!el) return false
      el.click(); await sleep(1400)
      return true
    })()`)

    await goRoot()
    check('进入子目录', await goFolder('子目录'))
    let c = await crumbs()
    check('当前在子目录', c.length === 2, c.join(' / '))

    // 1) 空白双击 → 回上一级
    let pt = await findBlank()
    check('找到一处真正的空白坐标', !!pt)
    if (pt) await dblAt(pt.x, pt.y)
    c = await crumbs()
    check('空白双击回到了上一级', c.length === 1, c.join(' / '))

    // 2) 已在库根 → 不动（绝不能跳出素材库）
    pt = await findBlank()
    if (pt) await dblAt(pt.x, pt.y)
    c = await crumbs()
    check('已在库根时双击空白不跳出素材库', c.length === 1, c.join(' / '))
    check('界面仍然正常（根目录内容还在）',
      (await win.webContents.executeJavaScript(
        `document.querySelectorAll('.folder-card, .folder-row').length`)) >= 1)

    // 3) 不误伤：双击文件夹卡片应当只进目录
    check('再次进入子目录', await goFolder('子目录'))
    const fc = await centerOf('.folder-card, .folder-row')
    const beforeFolderDbl = await crumbs()
    if (fc) await dblAt(fc.x, fc.y)
    const afterFolderDbl = await crumbs()
    check('双击文件夹卡片只进目录、没被"返回上一级"劫持',
      afterFolderDbl.length >= beforeFolderDbl.length,
      `${beforeFolderDbl.join('/')} → ${afterFolderDbl.join('/')}`)

    // 4) 不误伤：双击顶栏按钮
    const beforeBtn = await crumbs()
    const btn = await centerOf('#view-list-btn')
    if (btn) await dblAt(btn.x, btn.y)
    const afterBtn = await crumbs()
    check('双击顶栏按钮不触发返回上一级',
      JSON.stringify(afterBtn) === JSON.stringify(beforeBtn),
      `${beforeBtn.join('/')} → ${afterBtn.join('/')}`)
    // 还原成网格视图，避免影响后面的小节
    await win.webContents.executeJavaScript(
      `document.querySelector('#view-grid-btn')?.click()`)
    await sleepMs(700)
  }

  /*
   * ── 双击不该把文字选成一片 ──────────────────────────────────
   *
   * 用户实测：某些位置双击后不仅返回上一级，整页文字还变成选中态。
   * 成因是双击的**浏览器默认行为就是选中一个词**，紧接着的重渲染
   * 把带选中的节点换掉后，Chromium 会顺着新内容把选中范围一路扩大。
   *
   * 这里验证两道防线各自有效：
   *   ① CSS：浏览区 user-select:none，从源头不让选中产生
   *   ② JS：navigateTo 里 clearTextSelection()，兜住漏网的选中
   * 两道都要单独测 —— 只测其一的话，另一道坏了也发现不了。
   */
  console.log('')
  console.log('▸ 双击不选中文字')
  {
    const selLen = () => win.webContents.executeJavaScript(`(() => {
      const s = window.getSelection()
      if (!s || s.rangeCount === 0) return 0
      return s.isCollapsed ? 0 : s.toString().length
    })()`)

    // ① CSS 防线
    const us = await win.webContents.executeJavaScript(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const cs = getComputedStyle(el)
        return cs.userSelect || cs.webkitUserSelect
      }
      return {
        meta: pick('#browse-view .browse-meta'),
        grid: pick('#browse-view .asset-grid'),
        card: pick('.asset-card'),
      }
    })()`)
    check('浏览区计数行不可选中文字', us.meta === 'none', `user-select=${us.meta}`)
    check('网格容器不可选中文字', us.grid === 'none', `user-select=${us.grid}`)
    check('素材卡片不可选中文字', us.card === 'none', `user-select=${us.card}`)

    // ② JS 防线：在能选的地方造出选中，导航后必须被清掉
    const made = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('#thumb-btn .btn-label') ||
                 document.querySelector('#scan-btn')
      if (!el) return 0
      const r = document.createRange()
      r.selectNodeContents(el)
      const s = window.getSelection()
      s.removeAllRanges(); s.addRange(r)
      return s.toString().length
    })()`)
    check('已造出选中（前提成立，否则下面空跑）', made > 0, `${made} 字`)

    // 走面包屑返回上级 = 与空白双击同一条 navigateTo 路径
    await win.webContents.executeJavaScript(`document.querySelector('.breadcrumb-item')?.click()`)
    await sleepMs(1500)
    const afterNav = await selLen()
    check('导航后残留的选中被清掉', afterNav === 0, `导航后仍有 ${afterNav} 字被选中`)

    // ③ 不能一刀切：详情栏 / 设置页的文字仍要能复制
    const detailUs = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('#detail-content')
      if (!el) return null
      const cs = getComputedStyle(el)
      return cs.userSelect || cs.webkitUserSelect
    })()`)
    check('详情栏文字仍可选中复制', detailUs === null || detailUs === 'text', String(detailUs))
    const settingsUs = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('#settings-view')
      if (!el) return null
      const cs = getComputedStyle(el)
      return cs.userSelect || cs.webkitUserSelect
    })()`)
    check('设置页文字仍可选中复制', settingsUs === null || settingsUs === 'text', String(settingsUs))
  }

  /*
   * ── 深层目录在侧栏里要看得见名字 ────────────────────────────
   *
   * 用户实测：素材库很深时，左侧目录树"不方便观看使用"。
   * 根因**不是**缩进偏大，而是两套缩进在叠加：
   *   .dir-node { padding-left: 14px }（逐层 CSS） × 行内 6 + depth*12
   * 第 6 层起名字区宽度就变成 0，深层节点只剩个空行。
   *
   * 这里用**名字的实际宽度**断言，而不是断言缩进值 ——
   * 缩进多少是手段，"名字看得见"才是目的；
   * 只盯缩进数字的话，换种布局方式就会误报。
   */
  console.log('')
  console.log('▸ 深层目录可读性')
  {
    // 切到深层库（它随初始化一起出现在侧栏里）
    const deepBase = path.basename(deepLib)
    const switched = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const el = [...document.querySelectorAll('.root-item')]
        .find(x => (x.textContent || '').includes(${JSON.stringify(deepBase)}))
      if (!el) return false
      el.click(); await sleep(1600)
      return true
    })()`)
    check('已切换到深层素材库', switched === true, deepBase)

    // 展开整棵树（反复点 ▶ 直到没有收起的节点）
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      for (let pass = 0; pass < 12; pass++) {
        const closed = [...document.querySelectorAll('.dir-arrow')]
          .filter(a => a.textContent.trim() && !a.classList.contains('open'))
        if (!closed.length) break
        for (const a of closed) a.click()
        await sleep(400)
      }
    })()`)

    const rows = await win.webContents.executeJavaScript(`(() => {
      const tree = document.querySelector('.dir-tree')
      if (!tree) return []
      const tLeft = tree.getBoundingClientRect().left
      return [...document.querySelectorAll('.dir-row')].map((r) => {
        const n = r.querySelector('.dir-name')
        const nr = n.getBoundingClientRect()
        return {
          text: (n.textContent || '').trim(),
          // 必须量**名字**的左沿：行的 padding-left 只推内容不推行本身
          indent: Math.round(nr.left - tLeft),
          nameW: Math.round(nr.width),
          clipped: n.scrollWidth > n.clientWidth + 1,
          nameTitle: n.getAttribute('title'),
          rowTitle: r.getAttribute('title'),
        }
      })
    })()`)

    // 只看属于这个深库的那条链（树里可能还渲染着别的库）
    const chain = rows.filter((r) => DEEP_NAMES.includes(r.text))
    check('目录树里能看到完整深层链', chain.length === DEEP_NAMES.length,
      `${chain.length}/${DEEP_NAMES.length} 层`)

    check('没有任何一层的名字被压到 0 宽（旧版第 6 层起为 0）',
      chain.every((r) => r.nameW > 0),
      chain.filter((r) => r.nameW <= 0).map((r) => r.text).join(', ') || '都有宽度')
    check('最深层的名字仍有可用宽度（旧版此处为 0）',
      chain.length > 0 && chain[chain.length - 1].nameW >= 40,
      chain.length ? `${chain[chain.length - 1].nameW}px` : '')

    const ind = chain.map((r) => r.indent)
    check('缩进逐层递增（层级仍能分辨）',
      ind.every((v, i) => i === 0 || v >= ind[i - 1]), ind.join(' → '))
    const steps = ind.slice(1).map((v, i) => v - ind[i])
    check('深层缩进步进小于浅层（缩进放缓生效）',
      steps.length >= 2 && steps[steps.length - 1] < steps[0],
      `浅层 +${steps[0]}px → 深层 +${steps[steps.length - 1]}px`)
    check('最深缩进不超过侧栏宽度',
      ind.length > 0 && ind[ind.length - 1] < 220, `${ind[ind.length - 1]}px`)

    const clipped = chain.filter((r) => r.clipped)
    check('被截断的名字都带 title（悬停可看全）',
      clipped.every((r) => !!r.nameTitle),
      clipped.length ? `${clipped.length} 个被截断` : '没有被截断的')
    check('每行都带完整路径 title', chain.every((r) => !!r.rowTitle))

    /*
     * 收尾：切回主素材库。
     * 后面的小节（排序、视图与详情）都假设当前在主 lib ——
     * 留在这个只有深层链、没有「排A/排B/排C」的库上，
     * 那些断言会全部读到空列表而失败。
     */
    const mainBase = path.basename(lib)
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const el = [...document.querySelectorAll('.root-item')]
        .find(x => (x.textContent || '').includes(${JSON.stringify(mainBase)}))
      if (el) { el.click(); await sleep(1600) }
    })()`)
    await U.sleep(400)
  }

  /*
   * ── 跳转定位时只展开当前那一条链 ────────────────────────────
   *
   * 用户实测：点主界面的素材/文件夹，左侧树会把**所有逛过的分支**都保持展开，
   * 越点越乱，当前位置反而淹没在里面。
   *
   * 期望：跳转仍是"自动定位 + 高亮"，但展开状态**只留当前路径这一条链**，
   * 其它分支收起 —— 展开状态跟着"我现在在哪"走，而不是累积历史。
   */
  console.log('')
  console.log('▸ 跳转定位只展开当前分支')
  {
    const BRANCHES = EXP_BRANCHES
    // 确保在主库上（前面小节可能把视图留在别处）
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const el = [...document.querySelectorAll('.root-item')]
        .find(x => (x.textContent || '').includes(${JSON.stringify(path.basename(lib))}))
      if (el) { el.click(); await sleep(1600) }
    })()`)

    /** 当前展开着的目录名（取路径末段） */
    const expandedNames = () => win.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('.dir-tree')
      const out = []
      for (const row of box.querySelectorAll('.dir-row')) {
        const a = row.querySelector('.dir-arrow')
        if (a && a.classList.contains('open')) {
          const p = row.dataset.path || ''
          out.push(p.split(/[\\\\/]/).pop() || p)
        }
      }
      return out
    })()`)

    /**
     * 按绝对路径逐级点进某目录（等价于点侧栏那一行）。
     *
     * 注意**不要**先点箭头：navigateTo 会把展开状态重置成"只有目标这条链"，
     * 预先把箭头点开反而会被随后的导航收掉，白点一场。
     * 每轮都重新查询行 —— 导航会重建 DOM，上一轮的节点引用会失效。
     */
    const enterByPath = (abs) => win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const root = ${JSON.stringify(lib)}
      const rel = ${JSON.stringify(abs)}.slice(root.length + 1).split(/[\\\\/]/)
      let cur = root
      for (const seg of rel) {
        const target = cur + '\\\\' + seg
        const box = document.querySelector('.dir-tree')
        const row = box.querySelector('.dir-row[data-path="' + CSS.escape(target) + '"]')
        if (!row) return '找不到 ' + target
        row.click()
        await sleep(1100)
        cur = target
      }
      return 'ok'
    })()`)

    // 逐分支进入：每次都应只剩该分支展开
    for (const b of BRANCHES) {
      const r = await enterByPath(path.join(lib, b, '子项目', '批次'))
      const exp = await expandedNames()
      const others = BRANCHES.filter((x) => x !== b && exp.includes(x))
      check(`进入「${b}」后其它分支已收起`, others.length === 0,
        others.length ? `残留 ${others.join(', ')}（展开=${exp.join(', ')}）` : `展开=${exp.join(', ')}  [${r}]`)
      // 断言当前分支真的展开了 —— 否则上面那条会因为"什么都没展开"而假通过
      check(`  进入「${b}」后该分支确实展开了`, exp.includes(b),
        `展开=${exp.join(', ')}`)
    }

    // 当前那条链要完整展开（含目标自身，露出它的子级）
    const last = await expandedNames()
    check('当前分支完整展开到最深层（含目标自身）',
      ['丙部门', '子项目', '批次'].every((n) => last.includes(n)), last.join(', '))

    // 回到库根 → 所有分支收起
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const items = [...document.querySelectorAll('.breadcrumb-item')]
      if (items[0]) { items[0].click(); await sleep(1400) }
    })()`)
    const atRoot = await expandedNames()
    check('回到库根后不再展开任何分支',
      BRANCHES.every((b) => !atRoot.includes(b)), atRoot.join(', ') || '(只剩根)')

    // 手动展开的目录：刷新后必须保留（独占不能误伤手动操作）
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const box = document.querySelector('.dir-tree')
      const row = [...box.querySelectorAll('.dir-row')]
        .find(r => (r.dataset.path || '').endsWith('甲部门'))
      const a = row && row.querySelector('.dir-arrow')
      if (a && !a.classList.contains('open')) { a.click(); await sleep(500) }
    })()`)
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      document.querySelector('#view-list-btn')?.click(); await sleep(700)
      document.querySelector('#view-grid-btn')?.click(); await sleep(900)
    })()`)
    const afterRefresh = await expandedNames()
    check('手动展开的目录在刷新后仍保留（独占没误伤手动操作）',
      afterRefresh.includes('甲部门'), afterRefresh.join(', '))

    // 收尾：回到库根，后面小节都假设从根目录开始
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const items = [...document.querySelectorAll('.breadcrumb-item')]
      if (items[0]) { items[0].click(); await sleep(1400) }
    })()`)
    await U.sleep(400)
  }

  console.log('▸ 视图与详情')
  check('列表视图有行', res.listRows >= ROOT_ASSET_COUNT, `rows=${res.listRows}`)
  check('列表切回网格', res.cardsAfterBack >= ROOT_ASSET_COUNT)
  check('点击卡片 → 详情面板显示', res.detailShown === true)
  check('详情栏含插件字段（parse/detail 生效）', res.detailHasPluginField === true)
  check('长文本字段按原文排版', res.longBlockShown >= 1 && res.longText === '第一行\n第二行\n第三行',
    `${res.longBlockShown} 个长文本块 / ${JSON.stringify(res.longText)}`)
  check('按钮挂在字段内（不在顶部操作栏）',
    res.btnInsideField === 1 && res.btnInTopActions === 0,
    `字段内=${res.btnInsideField} 顶部=${res.btnInTopActions}`)
  check('按钮文案为「查看完整」', res.btnLabel === '查看完整', res.btnLabel)
  check('点字段内按钮 → 弹出完整内容', res.textModalShown === true)
  check('弹窗内容按原文保留换行', res.textModalText === '第一行\n第二行', JSON.stringify(res.textModalText))
  check('弹窗标题取插件返回值', res.textModalTitle === '完整内容', res.textModalTitle)
  check('弹窗可关闭', res.textModalClosed === true)

  console.log('▸ 详情栏常驻')
  check('详情栏有关闭按钮', res.hasCloseBtn === true)
  check('点 ✕ 后面板仍可见（常驻，不隐藏）', res.panelStillVisible === true)
  check('点 ✕ 后回到占位态', res.backToPlaceholder === true)
  check('重新选中素材 → 占位被内容替换', res.reopened === true)
  check('按 Esc 回到占位且面板仍可见', res.closedByEsc === true)

  /*
   * 常驻的核心：左侧宽度不随选中变化。
   * 只断言 class 不够 —— 若有人把占位实现成宽度 0，class 依旧没有 hidden，
   * 但布局照样会跳，所以量一次宽度。
   */
  console.log('▸ 详情栏常驻：左侧宽度不随选中变化')
  {
    const w = () => win.webContents.executeJavaScript(
      `Math.round(document.querySelector('#content').getBoundingClientRect().width)`)
    const wIdle = await w()
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      document.querySelector('.asset-card')?.click(); await sleep(900)
    })()`)
    const wPicked = await w()
    check('选中素材后左侧宽度不变', wPicked === wIdle, `${wIdle}px → ${wPicked}px`)
    // 回到未选中，后面小节假设从根目录、无选中开始
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      document.querySelector('#detail-close')?.click(); await sleep(700)
    })()`)
  }

  console.log('▸ 搜索')
  check('搜索命中', res.searchHit >= 1, `hit=${res.searchHit}`)
  check('搜索未命中 → 0 条', res.searchMiss === 0)
  check('清空搜索 → 恢复', res.searchCleared >= ROOT_ASSET_COUNT)

  console.log('▸ 文件夹视图')
  check('文件夹视图显示', res.folderShown === true)
  check('面包屑存在', res.breadcrumb >= 1)
  check('子文件夹卡片存在', res.folderCards >= 1)
  check('本目录素材卡片存在', res.folderAssetCards >= 1)
  check('进入子文件夹 → 面包屑变长', (res.breadcrumbAfterEnter || 0) > (res.breadcrumb || 0))
  check('返回根层 → 面包屑复原', res.breadcrumbBack === res.breadcrumb)
  check('目录树有节点', res.dirTreeNodes >= 1)

  console.log('▸ 设置页与右键菜单')
  check('设置页可打开', res.settingsOpen === true)
  check('设置页含插件条目', res.settingsPluginItems >= 1)
  check('设置页可关闭', res.settingsClosed === true)
  check('右键菜单含「打开」', res.ctxHasOpen === true)

  // ── 清除缩略图的安全性（真实走一遍 IPC，文件系统层面核对）──
  // 这是最关键的一条：只有 `.preview.` 命名的缩略图可以被删，
  // 用户自己的图片和素材本身必须原封不动。
  console.log('▸ 清除缩略图的安全性')
  const assetA = path.join(lib, `示例素材A${TEST_EXT}`)
  const previewA = assetA + '.preview.png'          // 缩略图 → 应被清除
  const userNamed = path.join(lib, `示例素材B${TEST_EXT}.png`) // 用户命名 → 必须留下
  const userOther = path.join(lib, '我的参考图.png')            // 无关图片 → 必须留下
  fs.writeFileSync(userOther, U.TINY_PNG)

  check('清除前：缩略图存在', fs.existsSync(previewA))
  await win.webContents.executeJavaScript(
    `window.api.clearThumbnails({ rootId: ${JSON.stringify(root.root.id)} })`)
  await U.sleep(1200)

  check('缩略图（.preview.）已被清除', !fs.existsSync(previewA))
  check('素材本身完好', fs.existsSync(assetA))
  check('用户命名的同名图片未被删', fs.existsSync(userNamed))
  check('用户的其它图片未被删', fs.existsSync(userOther))

  console.log('')
  console.log('▸ 顶栏排序')
  /*
   * 回归：顶栏排序此前对「本目录素材」完全无效。
   *
   * 成因有两处，都要覆盖：
   *   ① 渲染层 sortFolderList 里比的是 `state.sort === 'mtime'`，
   *      而 <option> 的值是 `'time'` → 三个分支全不命中，静默退化成按名称排；
   *   ② 文件夹视图走的是 bridge.folderView（不接受排序参数），
   *      它只排了文件夹、**没排素材**，本目录素材永远保持主进程给的默认名称序。
   * 所以这里逐键核对，并要求三个键给出**互不相同**的顺序。
   */
  const sortNames = () => win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.asset-card .card-name')].map(e => e.textContent)`)
  const setSortMode = (mode) => win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const sel = document.querySelector('#sort-select')
    sel.value = ${JSON.stringify(mode)}
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(1000)
  })()`)
  const setSortOrder = (wantDesc) => win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const btn = document.querySelector('#sort-order-btn')
    for (let i = 0; i < 4; i++) {
      if ((btn.textContent.trim() === '↓') === ${wantDesc}) break
      btn.click()
      await sleep(800)
    }
  })()`)

  // 回到根目录（排序只作用于当前目录的素材）
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('#view-grid-btn')?.click()
    await sleep(500)
    const root = document.querySelector('#breadcrumb .breadcrumb-item')
    if (root) { root.click(); await sleep(1200) }
  })()`)

  const EXPECT = {
    name: [`排A${TEST_EXT}`, `排B${TEST_EXT}`, `排C${TEST_EXT}`],
    time: [`排B${TEST_EXT}`, `排A${TEST_EXT}`, `排C${TEST_EXT}`],
    size: [`排C${TEST_EXT}`, `排B${TEST_EXT}`, `排A${TEST_EXT}`],
  }

  await setSortOrder(false) // 统一到升序
  const got = {}
  for (const mode of ['name', 'time', 'size']) {
    await setSortMode(mode)
    got[mode] = (await sortNames()).filter((n) => n.startsWith('排'))
  }
  check('按名称升序', JSON.stringify(got.name) === JSON.stringify(EXPECT.name), JSON.stringify(got.name))
  check('按修改时间升序', JSON.stringify(got.time) === JSON.stringify(EXPECT.time), JSON.stringify(got.time))
  check('按体积升序', JSON.stringify(got.size) === JSON.stringify(EXPECT.size), JSON.stringify(got.size))
  check('三个排序键给出的顺序互不相同',
    new Set([got.name, got.time, got.size].map((a) => JSON.stringify(a))).size === 3)

  // 降序 = 各自升序的逆序
  await setSortMode('time')
  await setSortOrder(true)
  const timeDesc = (await sortNames()).filter((n) => n.startsWith('排'))
  check('按修改时间降序（升序的逆序）',
    JSON.stringify(timeDesc) === JSON.stringify([...EXPECT.time].reverse()), JSON.stringify(timeDesc))

  await setSortMode('size')
  const sizeDesc = (await sortNames()).filter((n) => n.startsWith('排'))
  check('按体积降序（升序的逆序）',
    JSON.stringify(sizeDesc) === JSON.stringify([...EXPECT.size].reverse()), JSON.stringify(sizeDesc))

  // 还原为初始状态，避免影响后续断言
  await setSortOrder(false)
  await setSortMode('name')

  console.log('')
  console.log('▸ 每个文件夹各记各的排序')
  /*
   * 需求：记住每个文件夹的排序方案，并在文件夹变化时清理记录。
   *
   * 这里走完整链路（界面点击 → IPC → settings.json），
   * 而不是只测存储层 —— 因为最容易错的是**读写两侧的路径口径**：
   * 曾经渲染层存的是绝对路径、folderView 查的是相对路径，两边对不上，
   * 表现为「怎么都记不住」，而存储层单测完全发现不了。
   */
  const settingsFile2 = path.join(store.dataDir, 'settings.json')
  const readFolderSort = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile2, 'utf-8')).folderSort || {} } catch { return {} }
  }
  /** 点面包屑回到根目录 */
  const goRoot = () => win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    for (let i = 0; i < 5; i++) {
      const items = [...document.querySelectorAll('.breadcrumb-item')]
      if (items.length <= 1) break
      items[0].click(); await sleep(900)
    }
  })()`)
  /**
   * 进入某个子文件夹。
   *
   * 只比对 `.folder-name` 的文本，**不能**用整个卡片的 textContent：
   * 卡片上还有「N 子目录」这个徽标，含子目录的文件夹会因此被误匹配
   * （例如「丙部门」带一个子目录时会抢在真正的「子目录」前面命中）。
   */
  const goFolder = (name) => win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const card = [...document.querySelectorAll('.folder-card, .folder-row')]
      .find(c => ((c.querySelector('.folder-name') || c).textContent || '').trim() === ${JSON.stringify(name)})
    if (!card) return false
    card.click(); await sleep(1400)
    return true
  })()`)
  const sortUi = () => win.webContents.executeJavaScript(`(() => ({
    select: (document.querySelector('#sort-select') || {}).value,
    arrow: ((document.querySelector('#sort-order-btn') || {}).textContent || '').trim(),
  }))()`)

  await goRoot()
  await setSortMode('name')
  await setSortOrder(false)

  // 1) 在「子目录」里选「按体积 + 降序」
  const inSub = await goFolder('子目录')
  check('能进入子文件夹', inSub === true)
  await setSortMode('size')
  await setSortOrder(true)
  let ui = await sortUi()
  check('子目录已切到按体积降序', ui.select === 'size' && ui.arrow === '↓', `${ui.select}/${ui.arrow}`)

  // 2) 回根目录 → 应是默认（每个目录各记各的，不串味）
  await goRoot()
  ui = await sortUi()
  check('根目录仍是默认排序（未被子的选择污染）', ui.select === 'name' && ui.arrow === '↑',
    `${ui.select}/${ui.arrow}`)
  // 注意：不能断言「总共只有 1 条记录」—— 上面的「顶栏排序」小节
  // 在根目录切过排序，根目录自己那条记录本来就该在。这里只断言
  // 「子目录那条与根目录那条是分开存的两个键」。
  const keysAfterSub = Object.keys(readFolderSort())
  check('子目录与根目录的排序分开存储',
    keysAfterSub.filter((k) => k.endsWith('子目录')).length === 1 &&
      new Set(keysAfterSub).size === keysAfterSub.length,
    keysAfterSub.join(' | '))

  // 3) 再进子目录 → 恢复之前的选择
  await goFolder('子目录')
  ui = await sortUi()
  check('重进子目录恢复了它的排序', ui.select === 'size' && ui.arrow === '↓', `${ui.select}/${ui.arrow}`)

  // 4) 根目录里选「按修改时间升序」→ 两个目录各自独立
  await goRoot()
  await setSortMode('time')
  await setSortOrder(false)
  const keys2 = Object.keys(readFolderSort())
  check('根目录与子目录各有一条记录', keys2.length === 2, keys2.join(' | '))
  check('记录里没有绝对路径（键必须是相对路径）',
    keys2.every((k) => !/[A-Za-z]:[\\/]/.test(k)), keys2.join(' | '))

  // 5) 删除「子目录」→ 扫描 → 它的记录被清、根目录的保留
  fs.rmSync(path.join(lib, '子目录'), { recursive: true, force: true })
  await win.webContents.executeJavaScript(`window.api.scan(${JSON.stringify(root.root.id)})`)
  let cleaned = null
  for (let i = 0; i < 40; i++) {
    await U.sleep(500)
    cleaned = readFolderSort()
    if (!Object.keys(cleaned).some((k) => k.includes('子目录'))) break
  }
  const keysAfter = Object.keys(cleaned || {})
  check('被删目录的排序记录已清理',
    !keysAfter.some((k) => k.includes('子目录')), keysAfter.join(' | ') || '(空)')
  // 只断言"根目录那条还在"，不写死总条数 ——
  // 前面小节导航过的每个目录都会各自留下一条记录（这是设计如此），
  // 用 length === 1 会把"记录条数"和"该清的清掉了"混为一谈，
  // 之后新增任何测试目录都会让它变成误报。
  check('根目录的记录仍然保留（只清失效的）',
    keysAfter.some((k) => k.endsWith('\u0000')), keysAfter.join(' | ') || '(空)')

  console.log('')
  console.log('  ' + JSON.stringify(res))

  // 截图（可选）
  if (process.env.UI_SMOKE_SHOT) {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(process.env.UI_SMOKE_SHOT, img.toPNG())
    log('截图已保存: ' + process.env.UI_SMOKE_SHOT)
  }

  const { app } = require('electron')
  await U.sleep(600)
  try { fs.rmSync(lib, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(probeLib, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(deepLib, { recursive: true, force: true }) } catch {}

  console.log('')
  console.log(failures ? `  ✗ UI 测试失败 ${failures} 项` : '  ✓ UI 测试全部通过')
  app.exit(failures ? 1 : 0)
}
