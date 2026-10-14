/**
 * 手动指定文件夹封面
 *
 * 需求：可以指定「哪个缩略图作为父文件夹的缩略图」，
 *       且**只能设直属父级** —— 一个文件夹里有多个子文件夹时，
 *       给子文件夹设一次，父文件夹靠「子文件夹优先」自动跟着变。
 *
 * 存储结构：settings.folderThumb = { "<rootId>\0<相对路径>": "<素材文件名>" }
 * 与 folderSort 完全同构（键格式、清理、改名搬移），这里锁住三点：
 *   • 存的是**素材文件名**，不是缩略图路径也不是绝对路径
 *   • 手动封面只影响该文件夹自己；父级跟着变是「子文件夹优先」的既有行为
 *   • 记录失效（素材/缩略图没了）要**静默回落**到自动规则，不留空白
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test, run } = require('./_harness')

const { Store } = require(path.join(__dirname, '..', 'src', 'main', 'store.js'))
const { buildFolderTree, nodeToView } = require(path.join(__dirname, '..', 'src', 'shared', 'folderTree.js'))

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-coverstore-'))
  return { store: new Store(dir), dir }
}

/** 造一个假条目（t 里只需要这几个字段） */
function entry(rootId, absPath, name, opts = {}) {
  return {
    id: name,
    rootId,
    path: absPath,
    name,
    size: 100,
    mtime: 1000,
    dir: path.dirname(absPath),
    status: 'ok',
    thumbPath: opts.thumb === false ? null : absPath + '.preview.png',
  }
}

const ROOT = 'X:\\lib'

// ── 存储层 ──────────────────────────────────────────

test('封面记录：按根 + 相对路径各自独立', async (t) => {
  const { store, dir } = freshStore()
  t.eq(store.getFolderThumb('r1', ''), null, '没有记录时返回 null')

  store.setFolderThumb('r1', '', '根封面.png')
  store.setFolderThumb('r1', '模型/角色', '角色.blend')
  store.setFolderThumb('r2', '', '别的.png')

  t.eq(store.getFolderThumb('r1', ''), '根封面.png', 'r1 根目录')
  t.eq(store.getFolderThumb('r1', '模型/角色'), '角色.blend', 'r1 子目录')
  t.eq(store.getFolderThumb('r2', ''), '别的.png', '另一个根互不影响')
  t.eq(store.getFolderThumb('r1', '没有这个'), null, '未记录的目录返回 null')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('封面记录：落盘后重开仍在', async (t) => {
  const { store, dir } = freshStore()
  store.setFolderThumb('r1', 'a/b', '封面★.png')

  const reopened = new Store(dir)
  t.eq(reopened.getFolderThumb('r1', 'a/b'), '封面★.png', '重开 Store 后记录还在')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('封面记录：与 folderSort 共用同一套键，不会互相串味', async (t) => {
  const { store, dir } = freshStore()
  // 同一目录同时有排序记录和封面记录，两者必须互不干扰
  store.setFolderSort('r1', 'a', 'size', 'desc')
  store.setFolderThumb('r1', 'a', 'x.png')

  t.eq(store.getFolderSort('r1', 'a').sort, 'size', '排序记录没被封面覆盖')
  t.eq(store.getFolderThumb('r1', 'a'), 'x.png', '封面记录也没被排序覆盖')
  t.eq(Store.folderSortKey('R', 'a/b'), 'R\u0000a/b', '复用同一个键格式（rootId + NUL + 相对路径）')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('封面记录：取消与清理', async (t) => {
  const { store, dir } = freshStore()
  store.setFolderThumb('r1', '', 'a.png')
  store.setFolderThumb('r1', 'keep', 'b.png')
  store.setFolderThumb('r1', 'drop', 'c.png')
  store.setFolderThumb('r2', '', 'd.png')

  t.eq(store.clearFolderThumb('r1', 'drop').removed, 1, '取消一条')
  t.eq(store.getFolderThumb('r1', 'drop'), null, '该记录已清')
  t.eq(store.clearFolderThumb('r1', 'drop').removed, 0, '重复取消是幂等的')

  /*
   * prune：按「当前真实存在的目录」反向校验、清理。
   * 注意 'drop' 刚才已被 clearFolderThumb 取消掉了，所以要再放一条
   * 只存在于记录里、目录已消失的 gone，才能真正验证 prune 的清理行为。
   */
  store.setFolderThumb('r1', 'gone', 'e.png')
  t.eq(store.pruneFolderThumb('r1', ['', 'keep']).removed, 1, '目录已消失的 gone 被清掉')
  t.eq(store.getFolderThumb('r1', 'gone'), null, 'gone 记录已清')
  t.eq(store.getFolderThumb('r1', 'keep'), 'b.png', '还在的目录保留')
  t.eq(store.getFolderThumb('r1', ''), 'a.png', '根目录自己不受影响')
  t.eq(store.getFolderThumb('r2', ''), 'd.png', '另一个根不受影响')
  t.eq(store.pruneFolderThumb('r1', new Set(['', 'keep'])).removed, 0, 'prune 幂等，且接受 Set')

  // 改名搬移（含子孙）
  store.setFolderThumb('r1', '旧名', 'e.png')
  store.setFolderThumb('r1', '旧名/子', 'f.png')
  store.setFolderThumb('r1', '无关', 'g.png')
  t.eq(store.moveFolderThumb('r1', '旧名', '新名').moved, 2, '自身 + 子孙共搬 2 条')
  t.eq(store.getFolderThumb('r1', '新名'), 'e.png', '自身已搬')
  t.eq(store.getFolderThumb('r1', '新名/子'), 'f.png', '子孙已搬')
  t.eq(store.getFolderThumb('r1', '旧名'), null, '旧键已清')
  t.eq(store.getFolderThumb('r1', '无关'), 'g.png', '无关目录不受影响')

  // 删库：此时 r1 下有 ''、'keep'、'新名'、'新名/子'、'无关' 共 5 条
  t.eq(store.clearFolderThumbForRoot('r1').removed, 5, '清掉该根全部 5 条')
  t.eq(store.getFolderThumb('r1', ''), null, '根记录已清')
  t.eq(store.getFolderThumb('r1', '新名/子'), null, '子记录已清')
  t.eq(store.getFolderThumb('r2', ''), 'd.png', '别的根不受影响')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('封面记录：脏数据容错 + 实例隔离', async (t) => {
  const { store, dir } = freshStore()
  store.settings.folderThumb = null
  t.eq(store.getFolderThumb('r1', ''), null, '为 null 时返回 null 不崩')
  t.eq(store.pruneFolderThumb('r1', ['']).removed, 0, 'prune 不崩')
  t.eq(store.clearFolderThumbForRoot('r1').removed, 0, 'clear 不崩')
  store.setFolderThumb('r1', '', 'x.png')
  t.eq(store.getFolderThumb('r1', ''), 'x.png', '写入后自动重建字段')

  /*
   * 回归：_loadSettings 的浅拷贝坑。
   * folderThumb 是嵌套对象，必须独立深拷贝，否则模块级默认值会被污染。
   */
  const a = freshStore()
  const b = freshStore()
  a.store.setFolderThumb('rA', 'x', 'p.png')
  t.eq(Object.keys(b.store.settings.folderThumb).length, 0, 'B 实例不受 A 写入影响')
  const c = freshStore()
  t.eq(Object.keys(c.store.settings.folderThumb).length, 0, '模块级默认值未被污染')

  for (const s of [a, b, c]) fs.rmSync(s.dir, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── 选图逻辑（folderTree） ───────────────────────────

test('选图：分隔符风格 —— 树里是反斜杠、记录里是正斜杠，必须能对上', async (t) => {
  /*
   * 回归：这是本功能实际踩过的坑，而且**完全静默**（不报错、日志也干净），
   * 表现为「设了封面完全没反应」。
   *
   * 成因：
   *   • 树里节点的 path 跟着**素材根**的风格走 —— Windows 上是反斜杠
   *     （pathDirOf 用 rootPath 里的分隔符），所以是 '01模型\鸣潮-清宵'
   *   • 而主进程 toRelPath 存记录时一律换成**正斜杠**：'01模型/鸣潮-清宵'
   * 两边不统一 → thumbs[key] 永远 undefined → 静默回落自动规则。
   *
   * 所以这里显式用反斜杠的 rootPath 造树，用正斜杠的键写记录。
   */
  const winRoot = 'X:\\lib'
  const entries = [
    entry('r1', winRoot + '\\sub\\inner\\pic.png', 'pic.png'),
  ]
  const roots = [{ id: 'r1', path: winRoot, name: 'lib', enabled: true }]

  // 记录键用正斜杠（与 store 一致），指向 inner 里的素材
  const tree = buildFolderTree(roots, entries, { 'r1\u0000sub/inner': 'pic.png' })
  const sub = tree[0].children.find((c) => c.name === 'sub')
  const inner = sub && sub.children.find((c) => c.name === 'inner')

  t.ok(inner, '树里能找到 sub\\inner 节点（树内路径是反斜杠风格）')
  t.eq(inner.manualThumb, 'pic.png', '正斜杠的记录键能对上反斜杠的节点路径')
  t.eq(inner.effectiveManual, true, '手动封面确实生效')
  t.eq(inner.representative.name, 'pic.png', '代表图就是指定的那张')
})

test('选图：手动封面优先于自动规则', async (t) => {
  /*
   * 目录结构：
   *   lib/
   *     a.png            ← 本目录素材（自动规则下排在子文件夹之后）
   *     b.png
   *     sub/c.png        ← 子文件夹里的素材（自动规则会先选它）
   */
  const entries = [
    entry('r1', ROOT + '\\a.png', 'a.png'),
    entry('r1', ROOT + '\\b.png', 'b.png'),
    entry('r1', ROOT + '\\sub\\c.png', 'c.png'),
  ]
  const roots = [{ id: 'r1', path: ROOT, name: 'lib', enabled: true }]

  // 没有手动记录 → 自动规则：子文件夹优先
  let tree = buildFolderTree(roots, entries, {})
  t.eq(tree[0].representative.name, 'c.png', '自动规则选子文件夹里的 c.png')

  // 手动指定本目录的 a.png → 压过子文件夹
  tree = buildFolderTree(roots, entries, { 'r1\u0000': 'a.png' })
  t.eq(tree[0].representative.name, 'a.png', '手动指定的封面优先于子文件夹')
})

test('选图：给子文件夹设封面，父文件夹跟着变（不需要跨级设置）', async (t) => {
  /*
   * 这正是用户要的用法：
   *   lib/
   *     s1/x.png     ← 给 s1 设封面为 x.png
   *     s2/y.png
   *   父目录 lib 自己**没有任何手动记录**，但它应该显示 s1 的封面。
   */
  const entries = [
    entry('r1', ROOT + '\\s1\\x.png', 'x.png'),
    entry('r1', ROOT + '\\s2\\y.png', 'y.png'),
  ]
  const roots = [{ id: 'r1', path: ROOT, name: 'lib', enabled: true }]
  // 自动规则下 s1 排在前面（名称序），本来就会选 x.png
  let tree = buildFolderTree(roots, entries, {})
  t.eq(tree[0].representative.name, 'x.png', '默认按子文件夹名称序选 s1 的图')

  // 现在把 s2 设成封面 → 父目录应该改成显示 y.png，尽管父目录自己没有记录
  tree = buildFolderTree(roots, entries, { 'r1\u0000s2': 'y.png' })
  t.eq(tree[0].representative.name, 'y.png', '给子文件夹 s2 设封面后，父文件夹跟着显示它')
  t.eq(tree[0].manualThumb, null, '父目录自己并没有手动记录（靠的就是子文件夹优先）')

  // 而 s2 节点自己也用这张
  const s2 = tree[0].children.find((c) => c.name === 's2')
  t.eq(s2.representative.name, 'y.png', 's2 自己当然也用这张')
})

test('选图：sub: 记录 —— 「用作父文件夹封面」直接指定父级显示谁', async (t) => {
  /*
   * 右键子文件夹 →「用作父文件夹封面」会在**父目录**写下 `sub:<子文件夹名>`。
   *
   * 为什么需要这个专门的前缀（而不是只靠「手动设过的子文件夹优先」）：
   *   同级有**多个**手动设过封面的子文件夹时，那套优先级只能退回按名称序取第一个，
   *   于是「先给 A 设、再给 B 设」可能仍然显示 A —— 第二次设看起来没反应。
   *   sub: 把「父目录要用谁」记死在父目录自己身上，没有歧义。
   */
  const entries = [
    entry('r1', ROOT + '\\s1\\x.png', 'x.png'),
    entry('r1', ROOT + '\\s2\\y.png', 'y.png'),
  ]
  const roots = [{ id: 'r1', path: ROOT, name: 'lib', enabled: true }]

  // 两个子文件夹都有手动封面 → 旧的优先级规则会选名称序在前的 s1
  let tree = buildFolderTree(roots, entries, { 'r1\u0000s1': 'x.png', 'r1\u0000s2': 'y.png' })
  t.eq(tree[0].representative.name, 'x.png', '两个都有手动封面时，旧的优先级退回名称序（这就是歧义）')

  // 用 sub: 明确指定要 s2 → 必须听它的
  tree = buildFolderTree(roots, entries, { 'r1\u0000': 'sub:s2', 'r1\u0000s1': 'x.png', 'r1\u0000s2': 'y.png' })
  t.eq(tree[0].representative.name, 'y.png', 'sub:s2 压过名称序，父目录显示 s2 的图')
  t.eq(tree[0].manualThumb, 'sub:s2', '记录原样保留')
  // manualThumbLabel / IsSub 是给渲染层的（在 nodeToView 上）
  const view0 = nodeToView(tree[0])
  t.eq(view0.manualThumbIsSub, true, '标记为「来自子文件夹」')
  t.eq(view0.manualThumbLabel, '子文件夹 s2', '给界面显示用的可读标签')

  // sub: 指向的子文件夹不存在 → 静默回落，不留空白
  tree = buildFolderTree(roots, entries, { 'r1\u0000': 'sub:没了' })
  t.eq(tree[0].representative.name, 'x.png', '指向不存在的子文件夹 → 回落自动规则')
  t.eq(tree[0].manualThumb, 'sub:没了', '记录仍保留，用户能取消')

  // sub: 指向的子文件夹没有可用封面 → 同样回落
  const entries2 = [entry('r1', ROOT + '\\s1\\x.png', 'x.png'), entry('r1', ROOT + '\\s9\\n.png', 'n.png', { thumb: false })]
  tree = buildFolderTree(roots, entries2, { 'r1\u0000': 'sub:s9' })
  t.eq(tree[0].representative.name, 'x.png', '目标子文件夹没封面 → 回落')

  // 素材名记录仍按素材语义解析（没被 sub: 逻辑带偏）
  const tree3 = buildFolderTree([{ id: 'r1', path: ROOT, name: 'lib', enabled: true }],
    [entry('r1', ROOT + '\\a.png', 'a.png')], { 'r1\u0000': 'a.png' })
  const view3 = nodeToView(tree3[0])
  t.eq(view3.manualThumbIsSub, false, '素材名记录不算子文件夹记录')
  t.eq(view3.manualThumbLabel, 'a.png', '素材名标签就是文件名本身')
})

test('选图：手动封面失效时静默回落，不留空白', async (t) => {
  const roots = [{ id: 'r1', path: ROOT, name: 'lib', enabled: true }]

  // 记录指向一个已不存在的素材 → 回落到自动规则
  let entries = [entry('r1', ROOT + '\\a.png', 'a.png')]
  let tree = buildFolderTree(roots, entries, { 'r1\u0000': '已删除.png' })
  t.eq(tree[0].representative.name, 'a.png', '素材没了 → 回落到自动规则，不是空白')

  // 记录指向的素材还在，但它**没有缩略图** → 同样回落
  entries = [entry('r1', ROOT + '\\a.png', 'a.png'), entry('r1', ROOT + '\\no.png', 'no.png', { thumb: false })]
  tree = buildFolderTree(roots, entries, { 'r1\u0000': 'no.png' })
  t.eq(tree[0].representative.name, 'a.png', '指定的素材没缩略图 → 回落')

  // 记录还在，manualThumb 要能读到 —— 否则用户无法把它取消掉
  t.eq(tree[0].manualThumb, 'no.png', '记录本身仍保留（界面上还能「取消封面」）')
})

test('选图：只认直属子级（不能跨级直接指到后代）', async (t) => {
  /*
   * 手动封面只在 node.assets（直属素材）里找。
   * 这是刻意的约束：入口只有「素材右键」，而网格里只显示当前目录直属的素材，
   * 所以记录天然只指向直属素材；用 assets 而非 subtree 让语义与入口保持一致。
   */
  const entries = [entry('r1', ROOT + '\\sub\\deep.png', 'deep.png')]
  const roots = [{ id: 'r1', path: ROOT, name: 'lib', enabled: true }]

  // 根目录自己没有直属素材 —— 根上写 deep.png 这条记录不生效
  const tree = buildFolderTree(roots, entries, { 'r1\u0000': 'deep.png' })
  t.eq(tree[0].manualThumb, 'deep.png', '记录本身存下来了')
  // 但根目录的代表图来自子文件夹 sub 的自动结果（不是因为它「跨级指定」生效）
  t.eq(tree[0].representative.name, 'deep.png', '父目录靠子文件夹优先拿到这张')
  t.eq(tree[0].effectiveManual, false, '父目录这张不是手动指定的结果')

  // 正确做法：给 sub 设，父级靠「子文件夹优先」自动拿到
  const tree2 = buildFolderTree(roots, entries, { 'r1\u0000sub': 'deep.png' })
  t.eq(tree2[0].representative.name, 'deep.png', '给 sub 设 → 父目录自动拿到')
  t.eq(tree2[0].effectiveManual, false, '父目录依旧靠子级冒上来的结果')
  t.eq(tree2[0].children.find((c) => c.name === 'sub').effectiveManual, true, 'sub 自己才是手动生效的那个')
})

test('选图：nodeToView 暴露 manualThumb 供界面判断是否显示「取消封面」', async (t) => {
  const entries = [entry('r1', ROOT + '\\a.png', 'a.png')]
  const roots = [{ id: 'r1', path: ROOT, name: 'lib', enabled: true }]

  let tree = buildFolderTree(roots, entries, {})
  t.eq(nodeToView(tree[0]).manualThumb, null, '没设过 → null')

  tree = buildFolderTree(roots, entries, { 'r1\u0000': 'a.png' })
  t.eq(nodeToView(tree[0]).manualThumb, 'a.png', '设过 → 返回素材名')

  // 记录失效时仍要能读到（否则留着删不掉的脏记录）
  const tree2 = buildFolderTree(roots, entries, { 'r1\u0000': '没了.png' })
  t.eq(nodeToView(tree2[0]).manualThumb, '没了.png', '记录失效也要能读到，用户才能取消')
})

test('选图：不传 folderThumb 参数时不崩（向后兼容）', async (t) => {
  const entries = [entry('r1', ROOT + '\\a.png', 'a.png')]
  const roots = [{ id: 'r1', path: ROOT, name: 'lib', enabled: true }]
  const tree = buildFolderTree(roots, entries) // 少传第三个参数
  t.eq(tree[0].representative.name, 'a.png', '照常走自动规则')
  t.eq(tree[0].manualThumb, null, 'manualThumb 为 null')
})

/** 调度入口（CJS 无顶层 await，必须包一层 async） */
async function main() {
  const ok = await run()
  process.exit(ok ? 0 : 1)
}

main()
