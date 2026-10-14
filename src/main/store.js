/**
 * 存储层：JSON 分片持久化
 *  - settings.json           全局设置（根目录列表、扫描并发、缩略图尺寸、背景色等）
 *  - index-<rootId>.json     每个素材根目录一个索引分片（条目 + 目录指纹）
 *
 * 素材条目字段（与类型无关，通用）：
 *   { id, path, name, size, mtime, dir, tags[], favorite, note,
 *     kind, pluginId, status, thumbPath }
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DEFAULT_SETTINGS = {
  roots: [], // { id, name, path, enabled, addedAt }
  scanConcurrency: 8,
  thumbSize: 256, // 生成缩略图的分辨率（128 / 256 / 512 / 1024 / 2048）
  gridSize: 150, // 网格最小宽度 px（顶栏滑块，持久化以免每次启动回到默认）
  /*
   * 每个文件夹各自记住排序方案：{ "<rootId>\0<相对路径>": { sort, order } }
   * 见下方 setFolderSort / pruneFolderSort 的说明。
   */
  folderSort: {},
  /*
   * 手动指定的文件夹封面：{ "<rootId>\0<相对路径>": "<素材文件名>" }
   *
   * 只作用于「这个文件夹自己显示什么」，不改变其它文件夹。
   * 父文件夹之所以会跟着变，是因为它本来就走「子文件夹优先」规则去取
   * 子级的 representative —— 所以想换父级封面，给对应子文件夹设一次即可。
   * 详见 folderTree.js 的 pickRepresentative。
   */
  folderThumb: {},
}

class Store {
  /**
   * @param {string} dataDir 数据目录（userData 下）
   */
  constructor(dataDir) {
    this.dataDir = dataDir
    this.indexDir = path.join(dataDir, 'index')
    fs.mkdirSync(this.indexDir, { recursive: true })
    this.settingsFile = path.join(dataDir, 'settings.json')
    this.settings = this._loadSettings()
    /** rootId -> { entries: Map<path, entry>, fingerprints: Map<dir, string> } */
    this.cache = new Map()
    /** rootId -> Promise：索引写入队列（串行落盘，避免并发写乱序/覆盖） */
    this._saveQueues = new Map()
  }

  _loadSettings() {
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(this.settingsFile, 'utf-8'))
    } catch {
      parsed = null // 首次启动 / 文件损坏 → 用默认值
    }
    /*
     * 必须**深拷贝**默认值，不能只 `{ ...DEFAULT_SETTINGS }`。
     *
     * 浅拷贝下嵌套对象（folderSort / folderThumb）是所有 Store 实例
     * **共享同一个引用**：往 A 实例里写记录，会把模块级的 DEFAULT_SETTINGS
     * 一起改了，于是 B 实例（哪怕是另一个数据目录）凭空多出 A 的记录。
     * 这个坑是「每个文件夹的排序」引进来之后才暴露的 —— 之前 DEFAULT_SETTINGS
     * 里只有数字和数组，数组又总是整体赋值，所以一直没被发现。
     * 之后每加一个嵌套对象字段，都要在这里补一行。
     */
    const defaults = {
      ...DEFAULT_SETTINGS,
      roots: [],
      folderSort: {},
      folderThumb: {},
    }
    const merged = { ...defaults, ...(parsed || {}) }
    // 逐字段校验：文件被手工改坏时也要能起来
    if (!Array.isArray(merged.roots)) merged.roots = []
    if (!merged.folderSort || typeof merged.folderSort !== 'object' || Array.isArray(merged.folderSort)) {
      merged.folderSort = {}
    }
    if (!merged.folderThumb || typeof merged.folderThumb !== 'object' || Array.isArray(merged.folderThumb)) {
      merged.folderThumb = {}
    }
    return merged
  }

  saveSettings() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf-8')
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch }
    this.saveSettings()
    return this.settings
  }

  // ── 根目录 ──────────────────────────────────────────

  listRoots() {
    return this.settings.roots.map((r) => ({ ...r }))
  }

  addRoot(dirPath) {
    const resolved = path.resolve(dirPath)
    const existing = this.settings.roots.find((r) => r.path === resolved)
    if (existing) return { ok: false, error: '该目录已在素材库中', root: existing }
    const root = {
      id: crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12),
      name: path.basename(resolved) || resolved,
      path: resolved,
      enabled: true,
      addedAt: Date.now(),
    }
    this.settings.roots.push(root)
    this.saveSettings()
    return { ok: true, root }
  }

  removeRoot(rootId) {
    this.settings.roots = this.settings.roots.filter((r) => r.id !== rootId)
    this.clearFolderSortForRoot(rootId) // 素材库都没了，它的目录排序记录一并清掉
    this.saveSettings()
    this.cache.delete(rootId)
    // 删除索引分片
    try {
      fs.rmSync(this._indexFile(rootId), { force: true })
    } catch {}
    return { ok: true }
  }

  setRootEnabled(rootId, enabled) {
    const root = this.settings.roots.find((r) => r.id === rootId)
    if (!root) return { ok: false, error: '根目录不存在' }
    root.enabled = !!enabled
    this.saveSettings()
    return { ok: true, root: { ...root } }
  }

  getRoot(rootId) {
    return this.settings.roots.find((r) => r.id === rootId) || null
  }

  // ── 每个文件夹的排序方案 ─────────────────────────────
  /*
   * 结构：settings.folderSort = { "<rootId>\u0000<相对路径>": { sort, order } }
   *
   * 为什么键是「根 id + 相对路径」而不是绝对路径：
   *   • 绝对路径把素材库位置焊死在设置里，换盘符/换机器就全失效
   *   • 相对路径可读性好，出问题时能直接看懂是哪一层目录
   *
   * 为什么用「扁平 map」而不是跟着目录树存嵌套对象：
   *   • 重命名/移动目录时嵌套结构要递归搬移，容易写错且丢数据
   *   • 扁平结构下，目录重命名 = 删旧键 + 写新键，逻辑只有一处
   *   • 清理失效项也简单：遍历一遍键即可（见 pruneFolderSort）
   */

  /** 排序键分隔符：不可能出现在路径里的字符，避免「根id + 路径」拼接歧义 */
  static get SORT_SEP() {
    return '\u0000'
  }

  /** 拼 folderSort 的键 */
  static folderSortKey(rootId, relPath) {
    return `${rootId}${Store.SORT_SEP}${relPath || ''}`
  }

  /** 取某目录的排序方案；没有记录时返回 null（调用方回落到全局默认） */
  getFolderSort(rootId, relPath) {
    const all = this.settings.folderSort
    if (!all || typeof all !== 'object') return null
    const v = all[Store.folderSortKey(rootId, relPath)]
    return v && typeof v === 'object' ? { ...v } : null
  }

  /** 记下某目录的排序方案 */
  setFolderSort(rootId, relPath, sort, order) {
    if (!this.settings.folderSort || typeof this.settings.folderSort !== 'object') {
      this.settings.folderSort = {}
    }
    this.settings.folderSort[Store.folderSortKey(rootId, relPath)] = { sort, order }
    this.saveSettings()
    return { ok: true }
  }

  /**
   * 清掉不再存在的目录的排序记录。
   *
   * @param {string} rootId 素材根 id
   * @param {Set<string>|Array<string>} liveRelPaths 该根下**当前真实存在**的目录相对路径
   *        （含空串代表根目录自身）
   * @returns {{removed:number}} 清掉了几条
   *
   * 为什么不用「扫描结果的 removed 计数」来清理：
   *   扫描只返回删除了**几个条目**，拿不到具体路径；而且条目删除 ≠ 目录消失
   *   （目录里还有别的素材时目录仍在）。所以改为**按当前索引里真实存在的目录**
   *   反向校验 —— 这天然是幂等且自愈的：无论目录是怎么没的（删除、改名、
   *   换盘符、手工清理），只要它不在现有目录集合里，记录就会被清掉。
   */
  pruneFolderSort(rootId, liveRelPaths) {
    const all = this.settings.folderSort
    if (!all || typeof all !== 'object') return { removed: 0 }
    const live = liveRelPaths instanceof Set ? liveRelPaths : new Set(liveRelPaths || [])
    const prefix = `${rootId}${Store.SORT_SEP}`
    let removed = 0
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue
      if (live.has(key.slice(prefix.length))) continue
      delete all[key]
      removed++
    }
    if (removed) this.saveSettings()
    return { removed }
  }

  /** 清掉某个素材根的全部排序记录（删除素材库时调用） */
  clearFolderSortForRoot(rootId) {
    const all = this.settings.folderSort
    if (!all || typeof all !== 'object') return { removed: 0 }
    const prefix = `${rootId}${Store.SORT_SEP}`
    let removed = 0
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue
      delete all[key]
      removed++
    }
    if (removed) this.saveSettings()
    return { removed }
  }

  /**
   * 目录被重命名/移动时，把排序记录跟着搬过去。
   * 不搬的话用户会看到「排好序的文件夹一改名就恢复默认」。
   */
  moveFolderSort(rootId, oldRelPath, newRelPath) {
    const all = this.settings.folderSort
    if (!all || typeof all !== 'object') return { moved: 0 }
    const oldPrefix = `${rootId}${Store.SORT_SEP}${oldRelPath}`
    const newPrefix = `${rootId}${Store.SORT_SEP}${newRelPath}`
    const moves = []
    for (const key of Object.keys(all)) {
      // 同时覆盖自身与其全部子孙目录
      if (key !== oldPrefix && !key.startsWith(oldPrefix + '\\') && !key.startsWith(oldPrefix + '/')) continue
      moves.push([key, newPrefix + key.slice(oldPrefix.length)])
    }
    for (const [from, to] of moves) {
      all[to] = all[from]
      delete all[from]
    }
    if (moves.length) this.saveSettings()
    return { moved: moves.length }
  }

  // ── 手动指定的文件夹封面 ─────────────────────────────
  /*
   * 结构：settings.folderThumb = { "<rootId>\u0000<相对路径>": "<素材文件名>" }
   *
   * 与 folderSort 用**完全相同的键格式与生命周期管理**（prune / clear / move），
   * 理由见上面那段注释：绝对路径会焊死素材库位置，扁平 map 让改名只有一处逻辑。
   *
   * 为什么存「素材文件名」而不是缩略图路径、也不是素材绝对路径：
   *   • 素材绝对路径含盘符，换机器/换盘就失效 —— 与键的取舍同理
   *   • 缩略图文件名是**推导**出来的（<素材文件名>.preview.<扩展名>，见 thumbs.js），
   *     存素材名就等于同时锁定了缩略图；而且用户日后「重建缩略图」换了图，
   *     记录依然有效（缩略图名字没变，只是内容变了）
   *   • 素材名可读，出问题能直接看懂指的是哪个文件
   *
   * 记录失效（素材被删/缩略图被删）时**不报错、不留空**：folderTree 那边
   * 判定不通过就自动回落到原有的自动规则，用户不会遇到「永久空白封面」。
   */

  /** 取某目录手动指定的封面素材名；没有记录时返回 null */
  getFolderThumb(rootId, relPath) {
    const all = this.settings.folderThumb
    if (!all || typeof all !== 'object') return null
    const v = all[Store.folderSortKey(rootId, relPath)]
    return typeof v === 'string' && v ? v : null
  }

  /** 记下某目录的手动封面（素材名） */
  setFolderThumb(rootId, relPath, assetName) {
    if (!this.settings.folderThumb || typeof this.settings.folderThumb !== 'object') {
      this.settings.folderThumb = {}
    }
    this.settings.folderThumb[Store.folderSortKey(rootId, relPath)] = String(assetName)
    this.saveSettings()
    return { ok: true }
  }

  /** 取消某目录的手动封面（回落到自动规则） */
  clearFolderThumb(rootId, relPath) {
    const all = this.settings.folderThumb
    if (!all || typeof all !== 'object') return { ok: true, removed: 0 }
    const key = Store.folderSortKey(rootId, relPath)
    if (!(key in all)) return { ok: true, removed: 0 }
    delete all[key]
    this.saveSettings()
    return { ok: true, removed: 1 }
  }

  /**
   * 清掉不再存在的目录的封面记录（与 pruneFolderSort 同构）。
   * 幂等、自愈：不管目录是怎么没的（删除/改名/换盘/手工清理），
   * 只要不在现有目录集合里就会被清掉。
   */
  pruneFolderThumb(rootId, liveRelPaths) {
    const all = this.settings.folderThumb
    if (!all || typeof all !== 'object') return { removed: 0 }
    const live = liveRelPaths instanceof Set ? liveRelPaths : new Set(liveRelPaths || [])
    const prefix = `${rootId}${Store.SORT_SEP}`
    let removed = 0
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue
      if (live.has(key.slice(prefix.length))) continue
      delete all[key]
      removed++
    }
    if (removed) this.saveSettings()
    return { removed }
  }

  /** 清掉某个素材根的全部封面记录（删除素材库时调用） */
  clearFolderThumbForRoot(rootId) {
    const all = this.settings.folderThumb
    if (!all || typeof all !== 'object') return { removed: 0 }
    const prefix = `${rootId}${Store.SORT_SEP}`
    let removed = 0
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue
      delete all[key]
      removed++
    }
    if (removed) this.saveSettings()
    return { removed }
  }

  /** 目录改名/移动时把封面记录搬过去（与 moveFolderSort 同构） */
  moveFolderThumb(rootId, oldRelPath, newRelPath) {
    const all = this.settings.folderThumb
    if (!all || typeof all !== 'object') return { moved: 0 }
    const oldPrefix = `${rootId}${Store.SORT_SEP}${oldRelPath}`
    const newPrefix = `${rootId}${Store.SORT_SEP}${newRelPath}`
    const moves = []
    for (const key of Object.keys(all)) {
      if (key !== oldPrefix && !key.startsWith(oldPrefix + '\\') && !key.startsWith(oldPrefix + '/')) continue
      moves.push([key, newPrefix + key.slice(oldPrefix.length)])
    }
    for (const [from, to] of moves) {
      all[to] = all[from]
      delete all[from]
    }
    if (moves.length) this.saveSettings()
    return { moved: moves.length }
  }

  _indexFile(rootId) {
    return path.join(this.indexDir, `index-${rootId}.json`)
  }

  // ── 索引分片 ────────────────────────────────────────

  _loadIndex(rootId) {
    if (this.cache.has(rootId)) return this.cache.get(rootId)
    const empty = { entries: new Map(), fingerprints: new Map(), sig: -1 }
    try {
      const raw = fs.readFileSync(this._indexFile(rootId), 'utf-8')
      const parsed = JSON.parse(raw)
      const entries = new Map()
      for (const e of parsed.entries || []) entries.set(e.path, e)
      const fingerprints = new Map(parsed.fingerprints || [])
      // sig 是插件集合的内容指纹（字符串，如 "blender\0.blend\u0001mmd模型\0.pmx,.pmd"）；
      // 历史版本只有数字 sig，读取时必须保留任意类型，否则字符串 sig 被读成 -1，
      // 启动扫描的「缓存跳过」判断（idx.sig === pluginSig）将永远不成立 → 每次启动都遍历。
      const idx = { entries, fingerprints, sig: parsed.sig != null ? parsed.sig : -1, rootMtime: typeof parsed.rootMtime === 'number' ? parsed.rootMtime : null }
      this.cache.set(rootId, idx)
      return idx
    } catch {
      this.cache.set(rootId, empty)
      return empty
    }
  }

  getIndex(rootId) {
    return this._loadIndex(rootId)
  }

  /**
   * 保存索引（异步、按根目录串行落盘，不阻塞主进程事件循环）。
   *
   * 历史版本是全量 `fs.writeFileSync`：大库索引几 MB，JSON.stringify + 写盘
   * 会把主进程卡成「未响应」。改为 fs.promises.writeFile 并押入每根目录一条
   * 队列 —— 调用方无需 await，最后一次写必然包含那一刻的最新内存状态。
   * @param {string} rootId
   * @returns {Promise<void>} 排队后的写入 promise（调用方可 await，也不强制）
   */
  saveIndex(rootId) {
    const prev = this._saveQueues.get(rootId) || Promise.resolve()
    const next = prev
      .catch(() => {}) // 前一次失败不阻塞后续写入
      .then(() => {
        const idx = this._loadIndex(rootId)
        const payload = {
          version: 1,
          savedAt: Date.now(),
          sig: idx.sig,
          rootMtime: idx.rootMtime, // 上次扫描完成时的根目录 mtime（启动跳过遍历的依据）
          entries: [...idx.entries.values()],
          fingerprints: [...idx.fingerprints.entries()],
        }
        return fs.promises.writeFile(this._indexFile(rootId), JSON.stringify(payload), 'utf-8')
      })
      .catch((err) => {
        console.error('[store] saveIndex 失败:', err && err.message || err)
      })
    this._saveQueues.set(rootId, next)
    return next
  }

  // ── 条目操作（通用） ────────────────────────────────

  /** 生成条目 id（按绝对路径哈希） */
  static entryId(absPath) {
    return crypto.createHash('sha1').update(absPath).digest('hex')
  }

  upsertEntry(rootId, entry) {
    const idx = this._loadIndex(rootId)
    const prev = idx.entries.get(entry.path)
    const merged = prev ? { ...prev, ...entry } : { ...entry }
    idx.entries.set(entry.path, merged)
    return merged
  }

  deleteEntry(rootId, absPath) {
    const idx = this._loadIndex(rootId)
    idx.entries.delete(absPath)
  }

  getEntry(rootId, absPath) {
    const idx = this._loadIndex(rootId)
    return idx.entries.get(absPath) || null
  }

  /** 更新条目标签/收藏/备注等（不覆盖文件属性） */
  patchEntry(rootId, absPath, patch) {
    const idx = this._loadIndex(rootId)
    const e = idx.entries.get(absPath)
    if (!e) return null
    const allowed = ['tags', 'favorite', 'note', 'kind', 'pluginId']
    for (const k of allowed) {
      if (k in patch) e[k] = patch[k]
    }
    return e
  }
}

module.exports = { Store }
