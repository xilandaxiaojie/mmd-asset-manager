/**
 * 每个文件夹各自的排序方案：存储层测试
 *
 * 需求：「记住每个文件夹内的排序方案；有文件夹变化时修改或删除记录」。
 *
 * 存储结构：settings.folderSort = { "<rootId>\0<相对路径>": { sort, order } }
 * 三个设计决定都在这里锁住：
 *   • 键用「根id + 相对路径」而不是绝对路径 —— 换盘符/换机器不该失效
 *   • 分隔符用 NUL（路径里不可能出现）—— 否则 rootId 与路径会串味
 *   • 清理走「按当前真实存在的目录反向校验」—— 幂等、自愈，
 *     不依赖扫描结果的 removed 计数（那个只给个数、拿不到路径）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test, run } = require('./_harness')

const { Store } = require(path.join(__dirname, '..', 'src', 'main', 'store.js'))

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-sortstore-'))
  return { store: new Store(dir), dir }
}

test('读写：按根 + 相对路径各自独立', async (t) => {
  const { store, dir } = freshStore()
  t.eq(store.getFolderSort('r1', ''), null, '没有记录时返回 null（调用方回落默认）')

  store.setFolderSort('r1', '', 'name', 'asc')
  store.setFolderSort('r1', '模型/角色', 'size', 'desc')
  store.setFolderSort('r2', '', 'time', 'desc')

  t.eq(store.getFolderSort('r1', '').sort, 'name', 'r1 根目录记的是 name')
  t.eq(store.getFolderSort('r1', '模型/角色').order, 'desc', 'r1 子目录记的是 desc')
  t.eq(store.getFolderSort('r2', '').sort, 'time', '另一个根互不影响')
  t.eq(store.getFolderSort('r1', '没有这个'), null, '未记录的目录仍返回 null')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('落盘：重开 Store 后记录仍在', async (t) => {
  const { store, dir } = freshStore()
  store.setFolderSort('r1', 'a/b', 'size', 'desc')

  const reopened = new Store(dir) // 模拟重启
  const got = reopened.getFolderSort('r1', 'a/b')
  t.ok(got !== null, '重开后能读到')
  t.eq(got.sort, 'size', '排序键保住')
  t.eq(got.order, 'desc', '升降序保住')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('键名歧义：rootId 与路径不会串味（分隔符是 NUL）', async (t) => {
  const { store, dir } = freshStore()
  t.eq(Store.SORT_SEP, '\u0000', '分隔符是不可能在路径里出现的 NUL')
  t.eq(Store.folderSortKey('R', 'a/b'), 'R\u0000a/b', '键 = rootId + NUL + 相对路径')

  store.setFolderSort('a', 'b/c', 'size', 'desc')
  t.ok(store.getFolderSort('a', 'b/c') !== null, 'root=a rel=b/c 能取到')
  t.eq(store.getFolderSort('a/b', 'c'), null, 'root=a/b rel=c 不该误命中')
  t.eq(store.getFolderSort('a', 'b'), null, 'root=a rel=b 不该误命中')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('清理：目录消失后记录被清掉，且不影响别的根', async (t) => {
  const { store, dir } = freshStore()
  store.setFolderSort('r1', '', 'name', 'asc')
  store.setFolderSort('r1', '模型/角色', 'size', 'desc')
  store.setFolderSort('r2', '', 'time', 'desc')

  // 目录都还在 → 一条都不该清
  t.eq(store.pruneFolderSort('r1', ['', '模型', '模型/角色']).removed, 0, '目录都在时不清理')
  t.ok(store.getFolderSort('r1', '模型/角色') !== null, '记录保留')

  // 只剩根目录还存在 → 子目录记录该被清
  t.eq(store.pruneFolderSort('r1', ['']).removed, 1, '消失的目录被清掉 1 条')
  t.eq(store.getFolderSort('r1', '模型/角色'), null, '该记录已清')
  t.ok(store.getFolderSort('r1', '') !== null, '根目录自己的记录不受影响')
  t.ok(store.getFolderSort('r2', '') !== null, '另一个根的记录不受影响')

  t.eq(store.pruneFolderSort('r1', ['']).removed, 0, '重复清理是幂等的')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('清理：live 集合接受数组或 Set', async (t) => {
  const { store, dir } = freshStore()
  store.setFolderSort('r1', 'keep', 'size', 'desc')
  store.setFolderSort('r1', 'drop', 'size', 'desc')

  t.eq(store.pruneFolderSort('r1', new Set(['', 'keep'])).removed, 1, '传 Set 也能工作')
  t.ok(store.getFolderSort('r1', 'keep') !== null, 'keep 保留')
  t.eq(store.getFolderSort('r1', 'drop'), null, 'drop 被清')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('改名：记录跟着搬到新路径（含全部子孙）', async (t) => {
  const { store, dir } = freshStore()
  store.setFolderSort('r1', '旧名', 'size', 'desc')
  store.setFolderSort('r1', '旧名/子', 'time', 'asc')
  store.setFolderSort('r1', '无关目录', 'name', 'asc')

  t.eq(store.moveFolderSort('r1', '旧名', '新名').moved, 2, '自身 + 子孙共搬 2 条')
  t.eq(store.getFolderSort('r1', '新名').sort, 'size', '自身已搬到新名')
  t.eq(store.getFolderSort('r1', '新名/子').order, 'asc', '子孙也搬到新名/子')
  t.eq(store.getFolderSort('r1', '旧名'), null, '旧键已清')
  t.eq(store.getFolderSort('r1', '旧名/子'), null, '旧子孙键已清')
  t.ok(store.getFolderSort('r1', '无关目录') !== null, '无关目录不受影响')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('改名：前缀相同但不是子孙的目录不能被误搬', async (t) => {
  const { store, dir } = freshStore()
  store.setFolderSort('r1', 'ab', 'size', 'desc')
  store.setFolderSort('r1', 'abc', 'time', 'asc') // 名字以 ab 开头，但不是 ab 的子目录

  store.moveFolderSort('r1', 'ab', 'xy')
  t.eq(store.getFolderSort('r1', 'xy').sort, 'size', 'ab 搬到了 xy')
  t.eq(store.getFolderSort('r1', 'abc').sort, 'time', 'abc 未被误搬（前缀匹配要看分隔符）')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('删除素材库：该根的记录全清，别的根不受影响', async (t) => {
  const { store, dir } = freshStore()
  store.addRoot(path.join(dir, 'libA'))
  const rootId = store.listRoots()[0].id
  store.setFolderSort(rootId, '', 'size', 'desc')
  store.setFolderSort(rootId, 'x/y', 'time', 'asc')
  store.setFolderSort('other', '', 'name', 'asc')

  t.eq(store.clearFolderSortForRoot(rootId).removed, 2, '清掉该根的 2 条')
  t.eq(store.getFolderSort(rootId, ''), null, '根记录已清')
  t.eq(store.getFolderSort(rootId, 'x/y'), null, '子记录已清')
  t.ok(store.getFolderSort('other', '') !== null, '别的根不受影响')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('实例隔离：两个 Store 不能共享 folderSort（浅拷贝默认值的坑）', async (t) => {
  /*
   * 回归：`_loadSettings` 曾用 `{ ...DEFAULT_SETTINGS }` 做浅拷贝，
   * 嵌套的 folderSort 于是被所有实例共享同一个引用 ——
   * 往 A 写记录会污染模块级默认值，B 实例凭空多出 A 的记录。
   * 这条断言就是钉住「新实例必须干净」。
   */
  const a = freshStore()
  const b = freshStore()
  a.store.setFolderSort('rA', 'x', 'size', 'desc')

  t.eq(Object.keys(b.store.settings.folderSort).length, 0, 'B 实例不受 A 的写入影响')
  t.eq(b.store.getFolderSort('rA', 'x'), null, 'B 里读不到 A 的记录')

  // 再开一个全新实例，确认模块默认值本身也没被改写
  const c = freshStore()
  t.eq(Object.keys(c.store.settings.folderSort).length, 0, '模块级默认值未被污染')

  for (const s of [a, b, c]) fs.rmSync(s.dir, { recursive: true, force: true })
})

test('脏数据容错：folderSort 缺失或类型异常时不崩', async (t) => {
  const { store, dir } = freshStore()
  store.settings.folderSort = null
  t.eq(store.getFolderSort('r1', ''), null, 'folderSort 为 null 时返回 null')
  t.eq(store.pruneFolderSort('r1', ['']).removed, 0, 'prune 不崩')
  t.eq(store.clearFolderSortForRoot('r1').removed, 0, 'clear 不崩')
  // 写入会自动重建字段
  store.setFolderSort('r1', '', 'time', 'desc')
  t.eq(store.getFolderSort('r1', '').sort, 'time', '写入后恢复正常')

  fs.rmSync(dir, { recursive: true, force: true })
})

/** 调度入口（CJS 无顶层 await，必须包一层 async） */
async function main() {
  const ok = await run()
  // 必须显式 exit：Store 里留着待写队列等句柄，不退出的话进程会挂住，
  // 测试运行器（tests/run.js）会一直等这个子进程。与其它测试文件保持一致。
  process.exit(ok ? 0 : 1)
}

main()
