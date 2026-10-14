/**
 * 增量扫描框架
 *
 * 核心思想（需求报告 3.1 / 4.3）：
 *   • 主程序零类型知识：**文件是否算素材，完全由插件注册表判定**。
 *     扩展名 → 插件 的映射来自插件注册表；没有插件声明该扩展名 → 该文件
 *     不是素材（不显示、不索引）。当前无插件 → 扫描不产生任何素材条目。
 *   • 以「目录指纹」为单位判断目录是否变化：指纹 = hash(直接子项名 + type + size + mtimeMs)
 *   • 指纹未变化 → 目录内文件条目直接复用；指纹变化 → 只对该目录做 diff
 *   • 插件注册表版本变化（安装/卸载插件）→ 指纹全部失效 → 全量重扫
 *   • 索引中存在但本次未确认存在的文件 → 直接从索引删除（不留丢失标记）
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Store } = require('./store')
const { registry } = require('../shared/contracts')
const { THUMB_IMG_EXTS, PREVIEW_MARK } = require('./thumbs')
const { safeParse } = require('./pluginGuard')

/**
 * 目录指纹：对直接子项列表排序后取 sha1
 *
 * 参与指纹的「文件」有两类：
 *   1. 素材（插件声明了该扩展名）
 *   2. 缩略图候选图片（`<素材文件名>.<图片扩展名>` 机制的唯一来源）
 * 第 2 类必须计入指纹，否则「手动往目录里放一张缩略图」不会让目录变脏，
 * 增量扫描会直接复用旧条目 → 缩略图要重启才刷新。
 */
function dirFingerprint(children) {
  const lines = children
    .map((c) => `${c.name}|${c.isDir ? 'd' : 'f'}|${c.isDir ? 0 : c.size}|${c.isDir ? 0 : c.mtimeMs}`)
    .sort()
    .join('\n')
  return crypto.createHash('sha1').update(lines).digest('hex')
}

/** 文件是否算素材：查询插件注册表。返回负责的插件声明或 undefined */
function pluginForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return registry.getByExt(ext)
}

/** 判断 target 是否在 base 目录内（或等于 base） */
function isWithin(target, base) {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 插件 parse 元数据（失败/超时降级为 null，不阻断扫描）
 *
 * 走 safeParse：插件抛异常或卡住都只影响这一个素材，
 * 扫描继续，其余素材照常入库。
 */
async function tryParse(plugin, absPath) {
  return safeParse(plugin, absPath)
}

/**
 * 扫描素材根目录；progress 回调 (rootId, { current, total, message })
 * @param {Object} opts
 *   { concurrency, exclude, scope, shouldAbort } —— scope: { rootId, path } 限定只扫描该目录子树
 *   （增量复用指纹，未变化的目录自动跳过；范围外条目保持原状）
 *   shouldAbort: () => boolean，协作式取消。返回 true 时在下一个可中断点退出，
 *   并**跳过所有「删除」类收尾**（未扫描到的目录/条目不代表已消失），已完成的成果照常保存。
 */
async function scanRoot(store, root, { concurrency = 8, onProgress = () => {}, exclude = [], scope = null, shouldAbort = null, force = false } = {}) {
  const rootId = root.id
  const idx = store.getIndex(rootId)
  const t0 = Date.now()
  const excludeSet = new Set(exclude.map((p) => path.resolve(p)))
  const aborted = () => !!(shouldAbort && shouldAbort())

  // 局部扫描：只从 scope.path 开始遍历；未提供则整根
  const scanStart = scope && scope.rootId === rootId && scope.path ? path.resolve(scope.path) : null
  const pfs = fs.promises

  // 插件版本签名：变化 → 全量重扫
  const pluginSig = registry.version()

  // ── 缓存命中：跳过整库遍历 ──
  // 启动时的自动扫描（force=false）若满足：插件签名未变 + 上次扫描记录的根目录 mtime
  // 与当前一致 → 库在根级没有增删，直接复用缓存，不再每次启动遍历整个目录树。
  // 根级增删会让根 mtime 变化 → 自动进入增量扫描；深层改动由「手动扫描」（force=true）
  // 兜底 —— 手动扫描永远真实遍历并比对指纹，不会漏。
  let rootMtimeMs = null
  try {
    rootMtimeMs = (await pfs.stat(root.path)).mtimeMs
  } catch { /* 根不存在则照常走扫描（会自然全空） */ }
  if (!scope && !force && idx.sig === pluginSig && idx.rootMtime != null && idx.rootMtime === rootMtimeMs) {
    return {
      rootId, durationMs: 0, dirs: 0, added: 0, updated: 0, removed: 0, missing: 0,
      cancelled: false, cached: true, message: '素材库无变化，跳过扫描',
    }
  }

  // ── 1. 收集目录树（一次遍历，得全部目录及直接子项） ──
  // 必须用「异步 + 周期让出事件循环」：大素材库下同步 readdirSync/statSync
  // 会把主进程事件循环堵死 → 窗口未响应、「停止」IPC 与进度广播全部卡住。
  // 插件类型判定逻辑与原来完全一致（pluginForFile 只读注册表），仅 I/O 变异步。
  const dirs = [] // { dir, children: [{name,isDir,size,mtimeMs}] }
  const walkStack = [scanStart || root.path]
  const seen = new Set()
  let walkedDirs = 0
  while (walkStack.length) {
    if (aborted()) break
    const dir = walkStack.pop()
    if (seen.has(dir)) continue
    seen.add(dir)
    if (excludeSet.has(path.resolve(dir))) continue
    let dirents
    try {
      dirents = await pfs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 无权限/被删除目录：跳过
    }
    const children = []
    const fileJobs = []
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (d.name === '.git' || d.name === 'node_modules' || d.name === '$RECYCLE.BIN') continue
        const sub = path.join(dir, d.name)
        if (!seen.has(sub)) walkStack.push(sub)
        children.push({ name: d.name, isDir: true, size: 0, mtimeMs: 0 })
      } else if (d.isFile()) {
        // 类型判定交给插件注册表：无插件声明该扩展名 → 不是素材
        // 但缩略图候选图片（通用图片扩展名）仍要计入指纹，见 dirFingerprint 注释
        const plugin = pluginForFile(d.name)
        const ext = path.extname(d.name).toLowerCase()
        const isThumbCandidate = THUMB_IMG_EXTS.includes(ext)
        // 无关文件不 stat（原逻辑：!plugin && !isThumbCandidate 直接跳过）
        if (plugin || isThumbCandidate) fileJobs.push({ d, plugin })
      }
    }
    // 每个目录内的文件 stat 并行提交给线程池，主线程不被阻塞
    const stats = await Promise.all(
      fileJobs.map((j) =>
        pfs.stat(path.join(dir, j.d.name)).then(
          (st) => ({ j, st }),
          () => null
        )
      )
    )
    for (const r of stats) {
      if (!r) continue
      children.push({
        name: r.j.d.name, isDir: false, size: r.st.size, mtimeMs: r.st.mtimeMs,
        kind: r.j.plugin && r.j.plugin.kind ? r.j.plugin.kind.key : null,
        pluginId: r.j.plugin ? r.j.plugin.id : null,
        isAsset: !!r.j.plugin, // false = 仅作为缩略图候选参与指纹，不建素材条目
      })
    }
    dirs.push({ dir, children })
    // 周期让出事件循环，并报告遍历进度（大库下「停止」与进度条才能持续响应）
    walkedDirs++
    if (walkedDirs % 8 === 0) {
      onProgress(rootId, { current: walkedDirs, total: 0, message: `正在遍历目录（${walkedDirs}）…` })
      await new Promise((r) => setImmediate(r))
    }
  }
  const totalDirs = dirs.length

  // ── 2. 并发处理目录（指纹比对 + diff） ──
  const confirmed = new Set() // 本次确认存在的文件路径
  const changedDirs = []
  const added = { n: 0, bytes: 0 }
  const updated = { n: 0 }
  const removed = { n: 0 }

  let done = 0
  const prevSig = idx.sig // 上次扫描时的插件版本
  const sigChanged = prevSig !== pluginSig

  const pool = async () => {
    while (true) {
      if (aborted()) return
      const job = queue.shift()
      if (!job) return
      const { dir, children } = job
      const fp = dirFingerprint(children)
      const cachedFp = sigChanged ? undefined : idx.fingerprints.get(dir)

      // 本目录的缩略图索引：素材完整文件名(小写) → 对应图片路径，
      // 多扩展名候选时按 THUMB_IMG_EXTS 优先级取值（与 thumbs.findSiblingImage 一致）
      const thumbFor = makeThumbResolver(dir, children)

      if (cachedFp === fp) {
        // 目录未变化：子项名+文件属性均一致。正常情况下条目应已存在；
        // 若因「移入回收站」等直接删索引的路径导致条目缺失（指纹未同步），补建自愈。
        for (const c of children) {
          if (c.isDir || !c.isAsset) continue
          const p = path.join(dir, c.name)
          confirmed.add(p)
          if (!idx.entries.has(p)) {
            const entry = makeEntry(rootId, p, c, {}, thumbFor(p))
            idx.entries.set(p, entry)
            added.n++
            added.bytes += c.size
            const plugin = pluginForFile(p)
            if (plugin && typeof plugin.parse === 'function') scheduleParse(entry, plugin, store, rootId)
          }
        }
        done++
        if (done % 20 === 0) onProgress(rootId, { current: done, total: totalDirs, message: '复用未变化目录' })
        continue
      }

      // 目录有变化（或插件变更全量重扫）：diff 该目录下的文件条目
      changedDirs.push(dir)
      const prevFiles = new Set(
        [...idx.entries.keys()].filter((p) => path.dirname(p) === dir)
      )
      const nowFiles = new Set()
      for (const c of children) {
        if (c.isDir || !c.isAsset) continue // 缩略图候选图片不是素材，不建条目
        const p = path.join(dir, c.name)
        nowFiles.add(p)
        confirmed.add(p)
        const existing = idx.entries.get(p)
        const thumbPath = thumbFor(p)
        if (!existing) {
          const entry = makeEntry(rootId, p, c, {}, thumbPath)
          idx.entries.set(p, entry)
          added.n++
          added.bytes += c.size
          // 新增条目 → 异步触发插件 parse（不阻塞扫描）
          const plugin = pluginForFile(p)
          if (plugin && typeof plugin.parse === 'function') {
            scheduleParse(entry, plugin, store, rootId)
          }
        } else if (existing.size !== c.size || existing.mtime !== Math.floor(c.mtimeMs) || existing.pluginId !== c.pluginId) {
          const entry = makeEntry(rootId, p, c, existing, thumbPath)
          idx.entries.set(p, entry)
          updated.n++
          // 文件内容/归属插件变化 → 重新 parse
          const plugin = pluginForFile(p)
          if (plugin && typeof plugin.parse === 'function') scheduleParse(entry, plugin, store, rootId)
        } else if ((existing.thumbPath || null) !== (thumbPath || null)) {
          // 素材本身没变，只是缩略图增删/改名 → 只更新缩略图指向（即时生效，无需重启）
          existing.thumbPath = thumbPath
          updated.n++
        }
      }
      // 条目在索引中、但本次（该目录）未被确认存在 → 文件已消失，直接从索引删除
      for (const p of prevFiles) {
        if (!nowFiles.has(p)) {
          idx.entries.delete(p)
          removed.n++
        }
      }
      done++
      onProgress(rootId, { current: done, total: totalDirs, message: '扫描目录 ' + path.basename(dir) })
    }
  }

  const queue = [...dirs]
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 16)) }, () => pool())
  await Promise.all(workers)

  // 取消请求可能在任意时刻到达；这里统一判定一次，之后的「删除」类收尾全部跳过。
  const wasAborted = aborted()

  // ── 3. 更新指纹缓存（仅变化的目录） ──
  // 这部分可以无条件做：changedDirs 里的目录都是「已完整 diff 过」的，写入指纹是准确的。
  for (const dir of changedDirs) {
    const item = dirs.find((d) => d.dir === dir)
    if (item) idx.fingerprints.set(dir, dirFingerprint(item.children))
  }
  // 目录已不存在的指纹清理（局部扫描时只清理扫描范围内的指纹）
  // 中断时 seen 不完整 —— 「没遍历到」不等于「已消失」，做了会误删有效指纹
  if (!wasAborted) {
    for (const cachedDir of [...idx.fingerprints.keys()]) {
      if (scanStart && !isWithin(cachedDir, scanStart)) continue
      if (!seen.has(cachedDir)) idx.fingerprints.delete(cachedDir)
    }
  }

  // ── 4. 清理索引中已不存在的条目（丢失即删，不留标记） ──
  // 判据是「本次未确认存在」，中断时 confirmed 不完整 → 会把还没扫到的有效条目全删掉，必须跳过。
  if (!wasAborted && !sigChanged) {
    for (const [p, e] of [...idx.entries.entries()]) {
      // 局部扫描：范围外的条目不参与
      if (scanStart && !isWithin(p, scanStart)) continue
      if (!confirmed.has(p)) {
        idx.entries.delete(p)
        removed.n++
      }
    }
  }

  // 插件签名提交：中断时保留旧值，下一次扫描仍会走全量重扫。
  // 否则「部分重扫」会把 sig 记成已同步，范围外条目的旧 pluginId 将永久残留。
  if (!wasAborted) idx.sig = pluginSig
  // 记录扫描完成时的根目录 mtime（供下次启动的「缓存跳过」比对）
  if (!wasAborted && rootMtimeMs != null) idx.rootMtime = rootMtimeMs

  // 结尾这次等落盘完成再报「完成/返回」（saveIndex 已异步+排队，await 保证磁盘可见）
  await store.saveIndex(rootId)
  const durationMs = Date.now() - t0
  // 中断时不再发「完成」进度（它会把进度条推到 100%，造成已完成的假象）；
  // 结果文案由 SCAN_DONE 事件给出。
  if (!wasAborted) onProgress(rootId, { current: totalDirs, total: totalDirs, message: '完成' })
  return {
    rootId,
    durationMs,
    dirs: totalDirs,
    added: added.n,
    updated: updated.n,
    removed: removed.n,
    missing: 0,
    cancelled: wasAborted,
  }
}

/** 异步 parse 队列：新增/变更条目的元数据解析（不阻塞扫描主流程） */
const parseQueue = new Map() // path -> { entry, plugin, store, rootId }
let parseDraining = false

function scheduleParse(entry, plugin, store, rootId) {
  parseQueue.set(entry.path, { entry, plugin, store, rootId })
  drainParse()
}

/**
 * 对某个插件名下的**全部已索引条目**重跑 parse（不清索引、不重新遍历目录）。
 *
 * ── 为什么需要它 ──────────────────────────────────────
 * parse 的结果（entry.meta）会被缓存在索引里，而扫描器只在**文件自身**
 * （size / mtime / 所属插件）变化时才重跑 parse —— 见 scanRoot 的 diff 分支。
 *
 * 但有些插件的 parse 输出不只取决于文件本身，还取决于**插件设置**。
 * 典型例子：MMD 动作插件在 parse 时把「用户选的模型」镜像到插件目录内，
 * 供预览窗口读取（渲染层读不到 data/ 下的设置）。
 * 用户选完模型后，.vmd 文件一个字节都没变，扫描器于是跳过重解析，
 * 镜像文件永远不更新 —— 预览就一直显示「未指定模型」。
 *
 * 所以设置保存后要主动把该插件的条目重跑一遍。只碰这一个插件的条目，
 * 其余插件的缓存照常复用。
 *
 * @param {Object} store  索引存储（与 scanRoot 同一个实例）
 * @param {string} pluginId 插件 id（= 插件文件夹名）
 * @returns {number} 入队的条目数
 */
function reparsePlugin(store, pluginId) {
  const plugin = registry.getById(pluginId)
  if (!plugin || typeof plugin.parse !== 'function') return 0
  let n = 0
  for (const root of store.listRoots()) {
    const idx = store.getIndex(root.id)
    if (!idx) continue
    for (const entry of idx.entries.values()) {
      if (entry.pluginId !== pluginId) continue
      scheduleParse(entry, plugin, store, root.id)
      n++
    }
  }
  return n
}

async function drainParse() {
  if (parseDraining) return
  parseDraining = true
  // 并发 2，避免大文件解析压垮磁盘
  const touched = new Map() // rootId -> store：本周期解析成功过条目的素材库
  const workers = Array.from({ length: 2 }, async () => {
    while (parseQueue.size) {
      const p = parseQueue.keys().next().value
      const job = parseQueue.get(p)
      parseQueue.delete(p)
      const meta = await safeParse(job.plugin, job.entry.path)
      if (meta) {
        const cur = job.store.getEntry(job.rootId, p)
        if (cur) {
          cur.meta = meta
          touched.set(job.rootId, job.store)
        }
      }
    }
  })
  await Promise.all(workers)
  // 解析结果都在内存索引上：**每个周期只落盘一次**，而不是每解析一个模型就
  // 全量序列化+写一次磁盘（大库上千个模型时那是上百次全量写盘，主进程会卡死）。
  // saveIndex 本身已是异步+按根排队，此处 fire-and-forget 即可。
  for (const [rootId, st] of touched) st.saveIndex(rootId)
  parseDraining = false
}

/**
 * 构造「素材 → 缩略图」解析器（针对单个目录的 children 列表，零额外磁盘探测）
 *
 * 只认 `<素材文件名>.preview.<图片扩展名>` 这种命名（`a.blend` → `a.blend.preview.png`）。
 * 键必须带素材的完整文件名（`a.blend` 与 `a.pmx` 是两个不同的键），
 * 否则同主名的不同素材会抢同一张图。命名规则见 thumbs.js 顶部说明。
 * 多个候选扩展名同时存在时，按 THUMB_IMG_EXTS 的顺序取（与 thumbs.findSiblingImage 一致）。
 *
 * @param {string} dir 目录绝对路径
 * @param {Array} children 该目录的直接子项
 * @returns {(absPath:string) => (string|null)} 对应图片绝对路径，无则 null
 */
function makeThumbResolver(dir, children) {
  const byStem = new Map() // 素材完整文件名(小写) → Map<图片扩展名, absPath>
  for (const c of children) {
    if (c.isDir) continue
    const ext = path.extname(c.name).toLowerCase()
    if (!THUMB_IMG_EXTS.includes(ext)) continue
    // 只收预览图：`a.blend.preview.png` → 键 'a.blend'
    if (!c.name.toLowerCase().includes(PREVIEW_MARK)) continue
    const stem = c.name.slice(0, c.name.length - ext.length).toLowerCase()
    if (!stem.endsWith('.preview')) continue
    const key = stem.slice(0, -'.preview'.length)
    if (!byStem.has(key)) byStem.set(key, new Map())
    byStem.get(key).set(ext, path.join(dir, c.name))
  }
  return (absPath) => {
    const m = byStem.get(path.basename(absPath).toLowerCase())
    if (!m) return null
    for (const ext of THUMB_IMG_EXTS) if (m.has(ext)) return m.get(ext)
    return null
  }
}

function makeEntry(rootId, absPath, child, existing = {}, thumbPath = null) {
  const now = Date.now()
  return {
    id: Store.entryId(absPath),
    path: absPath,
    name: child.name,
    size: child.size,
    mtime: Math.floor(child.mtimeMs),
    dir: path.dirname(absPath),
    rootId,
    tags: existing.tags || [],
    favorite: !!existing.favorite,
    note: existing.note || '',
    kind: child.kind || existing.kind || null, // 来自插件声明
    pluginId: child.pluginId || existing.pluginId || null, // 来自插件声明
    status: 'normal',
    // 缩略图指向：由本次扫描的目录列表推导（只认 `.preview.` 命名），无则 null。
    // 「是不是本程序生成的」不必另存标志 —— 文件名里的 `.preview.` 已经说明了，
    // 判断与清理都以命名约定为准（见 thumbs.isPreviewFile）。
    thumbPath: thumbPath || null,
    meta: existing.meta || null, // 插件 parse 元数据（详情栏数据源）
    firstSeen: existing.firstSeen || now,
  }
}

module.exports = { scanRoot, dirFingerprint, reparsePlugin }
