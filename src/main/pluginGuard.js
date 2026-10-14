/**
 * 插件调用兜底（超时 + 异常隔离）
 *
 * ── 为什么需要这个 ────────────────────────────────────────
 * 插件在主进程里通过 `require` 直接加载（pluginHost.js），享有完整 Node 权限。
 * 这带来两类风险：
 *
 *   1. **崩溃**：插件代码抛异常 —— 各处已有 try/catch，能挡住
 *   2. **卡死**：插件陷入死循环 / 等待永不 resolve 的 Promise
 *      —— try/catch 挡不住，主进程会永久卡住，整个界面失去响应
 *
 * 本模块解决第 2 类：给每次插件调用套上超时。
 *
 * ── 超时是怎么做到的 ──────────────────────────────────────
 * 同进程里**无法真正杀死**一段同步死循环的代码 —— 事件循环被占满，
 * 连 setTimeout 都排不上。所以这里的超时是「**调用方放弃等待**」：
 * 超时后立刻给上层返回失败，让界面恢复可用，而不是干等。
 *
 * 这对异步挂起（await 一个不 resolve 的 Promise、网络/IO 卡住）**完全有效**，
 * 对纯同步死循环则只能保证"界面不再被这个调用阻塞"。
 *
 * 真正彻底的隔离需要 utilityProcess（独立进程 + 可强杀），
 * 那是更大的改造，此处不做。
 */

/** 各调用的默认超时（毫秒）。可用环境变量覆盖，便于测试。 */
const DEFAULTS = {
  parse: 30_000,     // 解析单个素材：大模型可能较慢，给足时间
  action: 60_000,    // 用户触发的操作：可能涉及文件拷贝等耗时工作
  load: 10_000,      // 插件加载：纯 require + 清单校验
}

/** 超时判定用 Symbol，避免与插件返回值混淆 */
const TIMED_OUT = Symbol('plugin-timeout')

/**
 * 给一个 Promise 套超时。超时后返回 TIMED_OUT，不抛出。
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise<any|typeof TIMED_OUT>}
 */
function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    // 超时计时器不应阻止进程退出
    if (timer.unref) timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 超时时间：环境变量优先（测试用），否则用默认值 */
function timeoutFor(kind, override) {
  if (Number.isFinite(override)) return override
  const env = Number(process.env[`AMM_PLUGIN_TIMEOUT_${kind.toUpperCase()}`])
  if (Number.isFinite(env) && env >= 0) return env
  return DEFAULTS[kind] ?? 30_000
}

/**
 * 调用插件的 `parse`。
 *
 * @param {Object} plugin 插件 manifest
 * @param {string} absPath 素材绝对路径
 * @param {Object} [opts] {timeout, label}
 * @returns {Promise<Object|null>} 失败/超时/返回非法一律 null（扫描不因单个素材中断）
 */
async function safeParse(plugin, absPath, opts = {}) {
  if (!plugin || typeof plugin.parse !== 'function') return null
  const ms = timeoutFor('parse', opts.timeout)
  const label = opts.label || absPath

  let meta
  try {
    meta = await withTimeout(Promise.resolve().then(() => plugin.parse(absPath)), ms)
  } catch (err) {
    console.warn(`[plugin:parse] ${plugin.id} 解析失败 ${label}:`, (err && err.message) || err)
    return null
  }

  if (meta === TIMED_OUT) {
    console.warn(`[plugin:parse] ${plugin.id} 解析超时（${ms}ms）${label}：已放弃等待，界面不受影响`)
    return null
  }
  // 插件返回非对象（null/字符串/数字）→ 视作没有元数据，而不是让上层拿到脏数据
  return meta && typeof meta === 'object' ? meta : null
}

/**
 * 调用插件的详情栏按钮 `button.run`。
 *
 * 与 safeAction 的关键区别：**保留返回值**。
 * 详情栏按钮的用途就是把结果拿给用户看（例如「查看完整注释」要弹出一整段文本），
 * 所以这里返回 { ok, result }，由界面决定怎么呈现。
 *
 * 约定 `run` 的返回值：
 *   • string            → 界面按「长文本」弹出（保留换行）
 *   • { title, text }   → 弹窗标题 + 正文
 *   • 其它/undefined    → 只提示「完成」
 *
 * @returns {Promise<{ok:boolean, result?:any, error?:string}>}
 */
async function safeButton(plugin, button, filePath, opts = {}) {
  if (!button || typeof button.run !== 'function') {
    return { ok: false, error: '该按钮没有可执行函数' }
  }
  const ms = timeoutFor('action', opts.timeout)
  const p = typeof filePath === 'string' ? filePath : String(filePath || '')

  let result
  try {
    result = await withTimeout(Promise.resolve().then(() => button.run(p)), ms)
  } catch (err) {
    const msg = String((err && err.message) || err)
    console.warn(`[plugin:button] ${plugin && plugin.id} 执行失败:`, msg)
    return { ok: false, error: msg }
  }

  if (result === TIMED_OUT) {
    const msg = `操作超时（超过 ${Math.round(ms / 1000)} 秒），已停止等待`
    console.warn(`[plugin:button] ${plugin && plugin.id} ${msg}`)
    return { ok: false, error: msg }
  }
  return { ok: true, result }
}

/**
 * 调用插件的自定义操作 `action.run`。
 *
 * 与 parse 不同，操作是用户主动触发的，失败必须让用户看到原因，
 * 所以这里返回结构化结果而不是 null。
 *
 * @returns {Promise<{ok:boolean, message?:string, error?:string}>}
 */
async function safeAction(plugin, action, filePaths, opts = {}) {
  if (!action || typeof action.run !== 'function') {
    return { ok: false, error: '该操作没有可执行函数' }
  }
  const ms = timeoutFor('action', opts.timeout)
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths]

  let result
  try {
    result = await withTimeout(Promise.resolve().then(() => action.run(paths)), ms)
  } catch (err) {
    const msg = String((err && err.message) || err)
    console.warn(`[plugin:action] ${plugin && plugin.id} 操作失败:`, msg)
    return { ok: false, error: msg }
  }

  if (result === TIMED_OUT) {
    const msg = `操作超时（超过 ${Math.round(ms / 1000)} 秒），已停止等待`
    console.warn(`[plugin:action] ${plugin && plugin.id} ${msg}`)
    return { ok: false, error: msg }
  }
  return { ok: true, message: typeof result === 'string' ? result : '完成' }
}

/**
 * 执行插件加载（require index.cjs）。
 *
 * 注意：`require` 是同步的，同步死循环无法被超时救回，
 * 所以这里只做异常隔离；超时对异步加载场景有效。
 *
 * @param {Function} loader 返回 manifest 的函数（内部做 require + 校验）
 * @returns {Promise<{ok:true, manifest:any} | {ok:false, error:string}>}
 */
async function safeLoad(loader, opts = {}) {
  const ms = timeoutFor('load', opts.timeout)
  let manifest
  try {
    manifest = await withTimeout(Promise.resolve().then(loader), ms)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  if (manifest === TIMED_OUT) {
    return { ok: false, error: `加载超时（超过 ${Math.round(ms / 1000)} 秒）` }
  }
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: '插件未导出清单对象' }
  }
  return { ok: true, manifest }
}

module.exports = { safeParse, safeAction, safeButton, safeLoad, withTimeout, timeoutFor, DEFAULTS, TIMED_OUT }
