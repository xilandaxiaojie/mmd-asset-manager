/**
 * 插件调用兜底（pluginGuard）测试
 *
 * 插件在主进程里以完整权限运行，所以「插件出错不能拖垮软件」是硬要求：
 *   • 抛异常 → 只影响这一个素材/这一次操作
 *   • 卡住（Promise 永不 resolve）→ 放弃等待，界面恢复可用
 *
 * 这是本套件里少见的**不依赖 Electron 生命周期**的测试：
 * pluginGuard 是纯逻辑模块，可直接 require。
 */
const path = require('path')
const { test, run } = require('./_harness')

const G = require(path.join(__dirname, '..', 'src', 'main', 'pluginGuard.js'))

/** 永不 resolve 的 Promise —— 模拟插件卡死 */
const hang = () => new Promise(() => {})

test('parse：正常返回原样透传', async (t) => {
  const r = await G.safeParse({ id: 'p', parse: async () => ({ ver: 1 }) }, '/x')
  t.eq(r && r.ver, 1, '正常结果被返回')
})

test('parse：插件抛异常 → 降级为 null，不抛出', async (t) => {
  const r = await G.safeParse({ id: 'p', parse: async () => { throw new Error('boom') } }, '/x')
  t.eq(r, null, '异常被吞成 null（扫描不中断）')
})

test('parse：返回非对象 → null（不让脏数据进索引）', async (t) => {
  t.eq(await G.safeParse({ id: 'p', parse: async () => '字符串' }, '/x'), null, '字符串被拒')
  t.eq(await G.safeParse({ id: 'p', parse: async () => 42 }, '/x'), null, '数字被拒')
  t.eq(await G.safeParse({ id: 'p', parse: async () => null }, '/x'), null, 'null 被拒')
})

test('parse：插件没实现 parse → null', async (t) => {
  t.eq(await G.safeParse({ id: 'p' }, '/x'), null, '缺方法安全返回')
  t.eq(await G.safeParse(null, '/x'), null, '空插件安全返回')
})

test('parse：卡死不 resolve → 超时放弃等待（关键场景）', async (t) => {
  const t0 = Date.now()
  const r = await G.safeParse({ id: 'p', parse: hang }, '/x', { timeout: 500 })
  const ms = Date.now() - t0
  t.eq(r, null, '超时返回 null')
  t.ok(ms >= 450 && ms < 3000, '在超时时间内返回而非永久挂起', `${ms} ms`)
})

test('parse：超时可由环境变量覆盖', async (t) => {
  process.env.AMM_PLUGIN_TIMEOUT_PARSE = '250'
  try {
    const t0 = Date.now()
    await G.safeParse({ id: 'p', parse: hang }, '/x')
    const ms = Date.now() - t0
    t.ok(ms >= 200 && ms < 2000, '按环境变量超时', `${ms} ms`)
  } finally {
    delete process.env.AMM_PLUGIN_TIMEOUT_PARSE
  }
})

test('action：正常返回 ok + message', async (t) => {
  const r = await G.safeAction({ id: 'p' }, { run: async () => '处理了 3 个文件' }, ['/x'])
  t.eq(r.ok, true, '成功标记')
  t.eq(r.message, '处理了 3 个文件', '透传插件的文字结果')
})

test('action：返回非字符串 → 通用完成文案', async (t) => {
  const r = await G.safeAction({ id: 'p' }, { run: async () => undefined }, ['/x'])
  t.eq(r.ok, true, '仍算成功')
  t.eq(r.message, '完成', '用兜底文案')
})

test('action：抛异常 → ok:false + 具体原因（用户要看到）', async (t) => {
  const r = await G.safeAction({ id: 'p' }, { run: async () => { throw new Error('权限不足') } }, ['/x'])
  t.eq(r.ok, false, '失败标记')
  t.eq(r.error, '权限不足', '带上原始原因')
})

test('action：超时 → ok:false + 超时说明', async (t) => {
  const t0 = Date.now()
  const r = await G.safeAction({ id: 'p' }, { run: hang }, ['/x'], { timeout: 500 })
  const ms = Date.now() - t0
  t.eq(r.ok, false, '失败标记')
  t.ok(/超时/.test(r.error || ''), '错误说明含「超时」', r.error || '')
  t.ok(ms >= 450 && ms < 3000, '按时返回', `${ms} ms`)
})

test('action：没有 run 函数 → ok:false', async (t) => {
  const r = await G.safeAction({ id: 'p' }, {}, ['/x'])
  t.eq(r.ok, false, '安全失败')
})

test('action：单个路径也能处理（自动包成数组）', async (t) => {
  let got = null
  await G.safeAction({ id: 'p' }, { run: async (paths) => { got = paths } }, '/single')
  t.ok(Array.isArray(got) && got[0] === '/single', '非数组入参被包装', JSON.stringify(got))
})

test('safeLoad：异常隔离 + 空清单识别', async (t) => {
  const bad = await G.safeLoad(() => { throw new Error('加载炸了') })
  t.eq(bad.ok, false, '异常被捕获')
  t.eq(bad.error, '加载炸了', '保留原因')

  const empty = await G.safeLoad(() => null)
  t.eq(empty.ok, false, 'null 清单被拒')

  const good = await G.safeLoad(() => ({ id: 'ok' }))
  t.eq(good.ok, true, '正常清单通过')
  t.eq(good.manifest.id, 'ok', '清单内容正确')
})

test('withTimeout：不误伤快速完成的调用', async (t) => {
  const fast = await G.withTimeout(Promise.resolve('done'), 5000)
  t.eq(fast, 'done', '快调用原样返回')
  t.ok(fast !== G.TIMED_OUT, '未误判为超时')
})

test('button：字符串返回值被保留（详情栏要拿它弹窗）', async (t) => {
  const r = await G.safeButton({ id: 'p' }, { run: async () => '第一行\n第二行' }, '/x')
  t.eq(r.ok, true, '执行成功')
  t.eq(r.result, '第一行\n第二行', '返回值原样保留，换行未丢')
})

test('button：结构化返回值被保留（title + text）', async (t) => {
  const r = await G.safeButton({ id: 'p' }, { run: async () => ({ title: 'T', text: 'B' }) }, '/x')
  t.eq(r.ok, true, '执行成功')
  t.eq(r.result.title, 'T', 'title 保留')
  t.eq(r.result.text, 'B', 'text 保留')
})

test('button：收到单个路径（不是数组）', async (t) => {
  let got = null
  await G.safeButton({ id: 'p' }, { run: async (p) => { got = p; return 'ok' } }, '/single')
  t.eq(got, '/single', '按钮只针对一个素材，传单路径')
})

test('button：抛异常 → ok:false 且带原因，不抛出', async (t) => {
  const r = await G.safeButton({ id: 'p' }, { run: async () => { throw new Error('炸了') } }, '/x')
  t.eq(r.ok, false, '失败被捕获')
  t.eq(r.error, '炸了', '保留原因给界面提示')
})

test('button：卡死 → 超时返回，不永久挂起', async (t) => {
  const r = await G.safeButton({ id: 'p' }, { run: hang }, '/x', { timeout: 50 })
  t.eq(r.ok, false, '超时算失败')
  t.ok(/超时/.test(r.error || ''), '提示里说明是超时', r.error)
})

test('button：没有 run 函数 → 明确拒绝', async (t) => {
  const r = await G.safeButton({ id: 'p' }, { id: 'b', label: 'x' }, '/x')
  t.eq(r.ok, false, '缺 run 被拒')
})

test('缺省超时是有限值（不能为 0 / 无上限）', async (t) => {
  for (const [kind, ms] of Object.entries(G.DEFAULTS)) {
    t.ok(Number.isFinite(ms) && ms > 0, `${kind} 有有限超时`, `${ms} ms`)
  }
})

/** 调度入口（CJS 无顶层 await，必须包一层 async） */
async function main() {
  const ok = await run()
  process.exit(ok ? 0 : 1)
}

main()
