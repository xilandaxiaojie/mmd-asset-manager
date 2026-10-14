/**
 * 插件宿主（Plugin Host）
 *
 * 职责：
 *  • 从 plugins/ 目录扫描并加载插件（每个插件 = 一个文件夹，入口 index.cjs）
 *  • manifest 校验（id/name/exts 必填；能力/界面定制可选）
 *  • 加载失败只记日志，不影响主程序启动
 *  • 按 settings.disabledPlugins 跳过已禁用的插件
 *  • 插件自定义设置（manifest.settings）持久化：userData/plugin-settings.json
 *
 * 注意：本模块不包含任何文件类型知识；插件的 exts / kind / 能力 完全来自
 * 插件自身的声明。卸载/禁用插件 = 该类型所有功能一起消失（由注册表驱动）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { registry } = require('../shared/contracts')
const { extractZip } = require('./zip')

/** 插件设置存储文件（相对 userData） */
const PLUGIN_SETTINGS_FILE = 'plugin-settings.json'
/** 插件界面覆盖存储文件（相对数据目录） */
const PLUGIN_OVERRIDES_FILE = 'plugin-overrides.json'

/** 主程序自动拷贝进来的图标文件前缀（清理旧图标时只删自己生成的文件） */
const ICON_FILE_PREFIX = 'amm-icon-'

/**
 * 是否「简易插件」：由主程序「新建插件」生成，只声明文件类型、没有任何实现代码。
 * 显式声明 simple:true 优先；否则按「只有声明」自动判定 —— 这样早期版本生成的
 * 简易插件（当时还没这个字段）也能被识别，而带 parse/viewer 的手写插件不会误判。
 */
function isSimpleManifest(raw) {
  if (!raw || typeof raw !== 'object') return false
  if (raw.simple === true) return true
  return !raw.parse && !raw.viewer && !raw.canThumbnail && !raw.canPreview
    && !(Array.isArray(raw.actions) && raw.actions.length)
}

/** 校验插件 manifest，返回规范化后的 manifest 或 null */
function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { id, name, exts } = raw
  if (typeof id !== 'string' || !id.trim()) return null
  if (typeof name !== 'string' || !name.trim()) return null
  if (!Array.isArray(exts) || !exts.length) return null

  const manifest = {
    id: id.trim(),
    name: name.trim(),
    version: typeof raw.version === 'string' ? raw.version : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    icon: typeof raw.icon === 'string' ? raw.icon : '',
    /*
     * extIcons：按扩展名覆盖图标 { '.mp3': 'audio.svg' }。
     * 一个插件可能管差别很大的几种素材（MMD 动作插件同时管动作与音频），
     * 共用一个图标会让人分不清；这里允许逐个扩展名指定。
     * 只收「.xxx → 字符串文件名」形状的项，避免任意键值污染清单。
     */
    extIcons: (raw.extIcons && typeof raw.extIcons === 'object' && !Array.isArray(raw.extIcons))
      ? Object.fromEntries(
          Object.entries(raw.extIcons)
            .filter(([k, v]) => /^\.[a-z0-9]+$/i.test(k) && typeof v === 'string' && v.trim())
            .map(([k, v]) => [k.toLowerCase(), v.trim()]))
      : null,
    simple: isSimpleManifest(raw),
    exts: exts
      .map((e) => (typeof e === 'string' ? e.toLowerCase() : ''))
      .filter((e) => e.startsWith('.')),
    kind: raw.kind && raw.kind.key ? { ...raw.kind } : null,
    // 能力
    canPreview: !!raw.canPreview,
    canThumbnail: !!raw.canThumbnail,
    viewer: typeof raw.viewer === 'string' ? raw.viewer : null,
    previewHtml: typeof raw.previewHtml === 'string' ? raw.previewHtml : null,
    parse: typeof raw.parse === 'function' ? raw.parse : null,
    /*
     * 预览前的可选准备钩子。签名 preparePreview(filePath) → Promise|void。
     *
     * 预览窗口的 viewer 没有 fs/IPC，只能读「已知路径」；插件若要在预览里
     * 用到素材旁边的信息，必须在此先查好写进插件目录。
     * 不能只依赖 parse()：扫描有缓存，素材没变就不会重新 parse。
     */
    preparePreview: typeof raw.preparePreview === 'function' ? raw.preparePreview : null,
    // 双击行为：非法值一律丢弃（当未声明），由界面回落到全局默认
    dblclick: normalizeDblclick(raw.dblclick),
    // 界面定制
    actions: Array.isArray(raw.actions)
      ? raw.actions
          .filter((a) => a && typeof a.id === 'string' && typeof a.label === 'string' && typeof a.run === 'function')
          .map((a) => ({ id: a.id, label: a.label, scope: a.scope === 'multi' ? 'multi' : 'single', run: a.run }))
      : [],
    detail: normalizeDetail(raw.detail),
    settings: Array.isArray(raw.settings)
      ? raw.settings
          .filter((s) => s && typeof s.key === 'string' && typeof s.label === 'string')
          .map((s) => ({
            key: s.key,
            label: s.label,
            /*
             * type 白名单。
             *   'dir'  值是**相对插件目录的路径**，界面给「浏览…」按钮，
             *          选中的文件夹会被复制进插件目录（理由见 index.cjs 的 handlePluginPickDir）。
             *   'file' 从另一个 dir 设置项（s.from 指定）里挑一个文件，
             *          界面渲染成下拉框，候选由主进程扫描后填充。
             *          解决「一个模型文件夹里有多个 .pmx」的选择问题。
             */
            type: ['text', 'number', 'boolean', 'select', 'dir', 'file'].includes(s.type) ? s.type : 'text',
            options: Array.isArray(s.options) ? s.options : [],
            // type:'file' 用：候选来源的 dir 设置项 key、扩展名白名单、是否递归
            from: typeof s.from === 'string' ? s.from : '',
            match: Array.isArray(s.match)
              ? s.match.map((e) => String(e).toLowerCase()).filter((e) => /^\.[a-z0-9]+$/.test(e))
              : [],
            recursive: s.recursive !== false,
            default: s.default,
          }))
      : [],
  }
  if (!manifest.exts.length) return null
  return manifest
}

/** 规范化 detail 声明 */
function normalizeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null
  const fields = Array.isArray(detail.fields)
    ? detail.fields
        .filter((f) => f && typeof f.key === 'string')
        .map((f) => ({
          key: f.key,
          label: f.label || f.key,
          type: ['text', 'color', 'link', 'badge', 'long'].includes(f.type) ? f.type : 'text',
          style: f.style && typeof f.style === 'object' ? { ...f.style } : null,
        }))
    : []
  // 详情栏按钮：run 保留在主进程（与 actions 同理，不下发到渲染进程）
  const buttons = Array.isArray(detail.buttons)
    ? detail.buttons
        .filter((b) => b && typeof b.id === 'string' && typeof b.label === 'string' && typeof b.run === 'function')
        .map((b) => ({
          id: b.id,
          label: b.label,
          icon: typeof b.icon === 'string' ? b.icon : '',
          run: b.run,
        }))
    : []
  return {
    fields,
    buttons,
    style: detail.style && typeof detail.style === 'object' ? { ...detail.style } : null,
    showMeta: detail.showMeta !== false,
  }
}

/**
 * 双击素材的合法行为。
 *
 * 'preview' 打开预览窗口 / 'open' 用系统默认程序打开 / 'none' 不做任何事。
 * 插件可声明 `dblclick`，用户在设置页也能按插件覆盖；两者都走这里的校验，
 * 非法值一律当「未声明」处理（回落到全局默认），不让脏数据传到界面。
 */
const DBLCLICK_ACTIONS = ['preview', 'open', 'none']

/**
 * 未声明时的全局默认：**不做任何操作**。
 *
 * 为什么默认是「无操作」而不是「打开预览」：
 *   双击是有副作用的动作（会开窗口 / 拉起外部程序），而「未声明」只代表
 *   插件作者没表达意图，不代表同意做某个动作。拿不准就不动，比替用户
 *   做决定更稳妥 —— 想开放预览的插件显式写一行 `dblclick: 'preview'` 即可，
 *   事实上各插件本来就都写了。
 * 单击选中 + 详情栏已经能满足「随便点点看看」的需求，
 * 双击留给用户明确想要的操作。
 */
const DBLCLICK_DEFAULT = 'none'

/** 合法就返回原值，否则返回 null（表示「未声明」） */
function normalizeDblclick(v) {
  return typeof v === 'string' && DBLCLICK_ACTIONS.includes(v) ? v : null
}

/**
 * 把界面上的覆盖（plugin-overrides.json）叠加到 manifest 上。
 * 只覆盖用户可编辑的几项：显示名 / 扩展名 / 图标 / 类别色 / 双击行为。
 * 绝不写回插件文件 —— 手写插件保持原样，覆盖只是加载期的一层皮。
 */
function applyOverrides(manifest, ov) {
  if (!manifest || !ov || typeof ov !== 'object') return manifest
  if (typeof ov.name === 'string' && ov.name.trim()) manifest.name = ov.name.trim()
  if (Array.isArray(ov.exts) && ov.exts.length) {
    const exts = ov.exts
      .map((e) => (typeof e === 'string' ? e.toLowerCase() : ''))
      .filter((e) => /^\.[a-z0-9]+$/.test(e))
    if (exts.length) manifest.exts = [...new Set(exts)]
  }
  if (typeof ov.icon === 'string') manifest.icon = ov.icon
  /*
   * extIcons 覆盖：{ '.mp3': '自己选的图.png', ... }。
   *
   * 值 '' 表示「这一项恢复插件声明的图标」—— 与 ov.icon 的约定一致
   * （空字符串 = 恢复默认）。这里把它落成「删掉该项」，
   * 于是渲染层取不到覆盖值，自然回退到 manifest.extIcons / manifest.icon。
   */
  if (ov.extIcons && typeof ov.extIcons === 'object' && !Array.isArray(ov.extIcons)) {
    const base = { ...(manifest.extIcons || {}) }
    for (const [k, v] of Object.entries(ov.extIcons)) {
      const key = String(k).toLowerCase()
      if (!/^\.[a-z0-9]+$/.test(key)) continue
      if (typeof v !== 'string') continue
      if (v === '') delete base[key]
      else base[key] = v
    }
    manifest.extIcons = Object.keys(base).length ? base : null
  }
  if (typeof ov.kindColor === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(ov.kindColor.trim())) {
    const color = ov.kindColor.trim()
    manifest.kind = manifest.kind
      ? { ...manifest.kind, color }
      : { key: manifest.id, label: manifest.name, color }
  }
  /*
   * 双击行为：用户覆盖优先于插件声明。
   *
   * 'default' 是设置页里「跟随插件声明」的哨兵值 —— 表示**没有用户覆盖**。
   * 这种情况下必须原样保留 manifest 上已有的值（那是插件自己声明的），
   * 不能 delete：本函数收到的是「插件声明 + 可能已有的覆盖」，删掉会连声明一起丢掉。
   * 持久化层（PluginOverridesStore.set）负责把 'default' 落成「键被删除」。
   */
  const db = normalizeDblclick(ov.dblclick)
  if (db) manifest.dblclick = db
  return manifest
}

/**
 * 在插件入口源码里定位「清单对象里声明的 id 字符串字面量」。
 *
 * 这同时是**插件清单规范**的判据：id 必须写成平铺对象字面量
 * `module.exports = { id: 'xxx', … }` 里的一个字符串字面量。
 *
 * 为什么要成规范：插件 id 运行时以**目录名**为准（见 loadPlugins），声明值只在
 * 「把目录打包成 zip 重新安装」时决定落地目录名。要保证两者一致，改文件夹名时就得
 * 能改到那一处声明值 —— 写成拼装形式（`...BASE` / `exports.id = …` / 运行时算出来）
 * 就没法安全地改，只能让作者改成平铺写法。
 *
 * 实现：单遍扫描，跳过注释与字符串（插件作者常把清单形状写进注释演示，
 * 不跳过就会定位到注释里的假 id），只在**代码区**里认 `module.exports = {`，
 * 再在它的深度 1 处认 `id` 键。
 *
 * @param {string} src 入口文件源码
 * @returns {{ok:true,start:number,end:number,value:string} | {ok:false,reason:string}}
 *          start/end = 值的**引号内**区间（start 指向首字符，end 指向闭合引号）
 */
function locateDeclaredId(src) {
  let i = 0
  let open = -1
  let depth = 0
  let quote = ''
  let valStart = -1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n + 1; continue }
    if (ch === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1
      i = j + 1
      continue
    }
    if (open < 0) {
      // 还没找到清单对象：只在代码区里认 `module.exports = {`
      if (ch === 'm' && src.startsWith('module', i)) {
        const head = /^module\.exports\s*=\s*\{/.exec(src.slice(i, i + 40))
        if (head) { open = i + head[0].length - 1; depth = 1; i = open + 1; continue }
      }
      i++
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      i++
      if (depth <= 0) break // 清单对象字面量结束了
      continue
    }
    if (depth === 1) {
      // `id:` / `'id':` / `"id":` —— 后面紧跟一个字符串字面量
      const key = /^(?:id|(['"])id\1)\s*:\s*(['"])/.exec(src.slice(i, i + 32))
      if (key) { quote = key[2]; valStart = i + key[0].length - 1; break }
    }
    i++
  }

  if (open < 0) return { ok: false, reason: '入口里没有 `module.exports = {…}` 对象字面量' }
  if (valStart < 0) return { ok: false, reason: '`module.exports = {…}` 里没有平铺写出的 `id: \'…\'`' }
  let valEnd = valStart + 1
  while (valEnd < src.length && src[valEnd] !== quote) valEnd += src[valEnd] === '\\' ? 2 : 1
  if (valEnd >= src.length) return { ok: false, reason: '声明 id 的字符串没有闭合' }
  return { ok: true, start: valStart + 1, end: valEnd, value: src.slice(valStart + 1, valEnd) }
}

/**
 * 从指定目录加载所有插件
 * @param {string} pluginsDir  plugins/ 目录绝对路径
 * @param {string[]} disabledIds 已禁用的插件 id 列表
 * @param {Object} [overrides]  界面覆盖表（键 = 插件文件夹名）
 * @returns {Promise<{loaded: string[], failed: {dir:string,error:string}[]}>}
 */
async function loadPlugins(pluginsDir, disabledIds = [], overrides = null) {
  const result = { loaded: [], failed: [] }
  const disabledSet = new Set(disabledIds || [])
  let entries = []
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
  } catch {
    return result // 目录不存在 → 空
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = path.join(pluginsDir, ent.name)
    const indexFile = path.join(dir, 'index.cjs')
    if (!fs.existsSync(indexFile)) {
      result.failed.push({ dir: ent.name, error: '缺少 index.cjs' })
      continue
    }
    try {
      // 清单规范校验：id 必须是平铺对象字面量里的字符串字面量。
      // 放在 require **之前** —— 不合规范的插件连它的代码都不执行。
      const spec = locateDeclaredId(fs.readFileSync(indexFile, 'utf8'))
      if (!spec.ok) {
        result.failed.push({ dir: ent.name, error: `清单格式不规范：${spec.reason}` })
        continue
      }
      // 清 require 缓存，保证卸载/重装后重新加载最新代码
      delete require.cache[require.resolve(indexFile)]
      const raw = require(indexFile)
      const manifest = validateManifest(raw)
      if (!manifest) {
        result.failed.push({ dir: ent.name, error: 'manifest 无效（需 id/name/exts）' })
        continue
      }
      // 插件 id 以**文件夹名**为准（改文件夹名即改名，不必改插件代码）
      manifest.id = ent.name
      applyOverrides(manifest, overrides && overrides[ent.name])
      if (disabledSet.has(manifest.id)) continue // 已禁用，跳过加载

      registry.register(manifest)
      result.loaded.push(manifest.id)
      console.log(`[plugin] 已加载: ${manifest.name} (${manifest.exts.join(', ')})`)
    } catch (err) {
      result.failed.push({ dir: ent.name, error: String(err && err.message || err) })
      console.error(`[plugin] 加载失败 ${ent.name}:`, err)
    }
  }
  return result
}

/**
 * 清理 require 缓存（安装/卸载后调用，保证下次加载最新代码）
 * 删除插件目录下所有已缓存的模块（含 index.cjs 与其相对依赖）
 */
function clearRequireCache(pluginDir) {
  const prefix = path.resolve(pluginDir)
  for (const key of Object.keys(require.cache)) {
    if (key === prefix || key.startsWith(prefix + path.sep)) delete require.cache[key]
  }
}

/** 在解压结果中定位插件根目录（含 index.cjs，容忍 zip 常见的单层包裹） */
function locatePluginRoot(dir) {
  if (fs.existsSync(path.join(dir, 'index.cjs'))) return dir
  let subs = []
  try {
    subs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '__MACOSX' && !e.name.startsWith('.'))
  } catch {
    return null
  }
  // 一层包裹：<folder>/index.cjs
  for (const s of subs) {
    const sub = path.join(dir, s.name)
    if (fs.existsSync(path.join(sub, 'index.cjs'))) return sub
  }
  // 两层包裹：<a>/<b>/index.cjs
  for (const s of subs) {
    const sub = path.join(dir, s.name)
    let inner = []
    try { inner = fs.readdirSync(sub, { withFileTypes: true }) } catch { continue }
    for (const t of inner) {
      if (t.isDirectory() && fs.existsSync(path.join(sub, t.name, 'index.cjs'))) return path.join(sub, t.name)
    }
  }
  return null
}

/**
 * 安装插件（仅接受 .zip 压缩包）
 * 流程：解压到临时目录 → 定位插件根（含 index.cjs）→ 校验 manifest → 复制到 plugins/<id>
 * @param {string} pluginsDir plugins/ 目录
 * @param {string} srcPath 插件 zip 压缩包路径
 */
async function installPlugin(pluginsDir, srcPath) {
  const src = path.resolve(srcPath)
  if (!fs.existsSync(src)) return { ok: false, error: '所选文件不存在' }
  if (!fs.statSync(src).isFile()) return { ok: false, error: '请选择 .zip 插件压缩包' }
  if (path.extname(src).toLowerCase() !== '.zip') return { ok: false, error: '请选择 .zip 插件压缩包' }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-plugin-'))
  try {
    try {
      extractZip(src, tmpDir)
    } catch (err) {
      return { ok: false, error: `解压失败: ${err.message}` }
    }

    const workDir = locatePluginRoot(tmpDir)
    if (!workDir) return { ok: false, error: '压缩包内未找到 index.cjs，不是有效的插件' }

    const manifestFile = path.join(workDir, 'index.cjs')
    // 清单规范校验：不合规范的包直接拒装 —— 否则会落到 plugins/ 里却永远加载不了
    try {
      const spec = locateDeclaredId(fs.readFileSync(manifestFile, 'utf8'))
      if (!spec.ok) return { ok: false, error: `插件清单格式不规范：${spec.reason}` }
    } catch (err) {
      return { ok: false, error: `读取 index.cjs 失败: ${err.message}` }
    }
    let manifest
    try {
      clearRequireCache(workDir)
      const raw = require(manifestFile)
      manifest = validateManifest(raw)
    } catch (err) {
      return { ok: false, error: `index.cjs 加载失败: ${err.message}` }
    }
    if (!manifest) return { ok: false, error: 'manifest 无效（需 id/name/exts）' }

    const dest = path.join(pluginsDir, manifest.id)
    if (fs.existsSync(dest)) {
      return { ok: false, error: `已存在同名插件「${manifest.id}」，请先卸载` }
    }

    fs.mkdirSync(pluginsDir, { recursive: true })
    fs.cpSync(workDir, dest, { recursive: true })
    return { ok: true, id: manifest.id, name: manifest.name, manifest }
  } catch (err) {
    return { ok: false, error: `安装失败: ${err.message}` }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 卸载插件：直接删除 plugins/<id> 整个目录（不走回收站，不可还原）
 * 同时注销注册表并清理 require 缓存 → 立即生效
 */
async function uninstallPlugin(pluginsDir, pluginId) {
  const dir = path.join(pluginsDir, pluginId)
  if (!fs.existsSync(dir)) return { ok: false, error: '插件目录不存在' }
  try {
    clearRequireCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    registry.unregister(pluginId)
    return { ok: true, id: pluginId }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/* ── 插件设置存储 ─────────────────────────────────────── */

class PluginSettingsStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, PLUGIN_SETTINGS_FILE)
    this.data = {}
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
    } catch {}
  }

  /** 读取某插件的设置（合并默认值） */
  get(pluginId, settingsDef = []) {
    const saved = this.data[pluginId] || {}
    const out = {}
    for (const s of settingsDef) out[s.key] = saved[s.key] !== undefined ? saved[s.key] : s.default
    return out
  }

  /** 保存某插件的设置 */
  set(pluginId, values) {
    this.data[pluginId] = { ...(this.data[pluginId] || {}), ...values }
    this.save()
    return this.data[pluginId]
  }

  /** 改名：把某插件的设置挪到新 id 下 */
  rename(oldId, newId) {
    if (oldId === newId) return
    if (this.data[oldId] !== undefined) {
      this.data[newId] = this.data[oldId]
      delete this.data[oldId]
      this.save()
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8')
  }
}

/* ── 插件界面覆盖存储（显示名/扩展名/图标/类别色） ────────── */

class PluginOverridesStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, PLUGIN_OVERRIDES_FILE)
    this.data = {}
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
    } catch {}
  }

  /** 全部覆盖（供 loadPlugins 一次性注入） */
  all() {
    return this.data
  }

  get(pluginId) {
    return this.data[pluginId] || null
  }

  /** 合并写入；值为 undefined 的键不动，值为 null/'' 的键表示「清除该覆盖」 */
  set(pluginId, values = {}) {
    const cur = { ...(this.data[pluginId] || {}) }
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue
      if (v === null || v === '') delete cur[k]
      else cur[k] = v
    }
    if (Object.keys(cur).length) this.data[pluginId] = cur
    else delete this.data[pluginId]
    this.save()
    return this.data[pluginId] || null
  }

  /** 改名：覆盖随插件一起搬到新文件夹名下 */
  rename(oldId, newId) {
    if (oldId === newId) return
    if (this.data[oldId] !== undefined) {
      this.data[newId] = this.data[oldId]
      delete this.data[oldId]
      this.save()
    }
  }

  remove(pluginId) {
    if (this.data[pluginId] === undefined) return
    delete this.data[pluginId]
    this.save()
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8')
  }
}

module.exports = {
  loadPlugins,
  installPlugin,
  uninstallPlugin,
  validateManifest,
  normalizeDetail,
  normalizeDblclick,
  DBLCLICK_ACTIONS,
  DBLCLICK_DEFAULT,
  isSimpleManifest,
  locateDeclaredId,
  applyOverrides,
  PluginSettingsStore,
  PluginOverridesStore,
  clearRequireCache,
  ICON_FILE_PREFIX,
}
