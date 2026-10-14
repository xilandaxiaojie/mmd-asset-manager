/**
 * 手动封面记录的两种值：
 *   `清宵.pmx`     —— 用本目录直属的这个素材
 *   `sub:00base`   —— 用名为 00base 的**子文件夹**当前显示的封面
 *
 * 前缀用 `sub:` 是因为素材名里不可能出现冒号（Windows 文件名禁用字符），
 * 所以不会与真实素材名撞车。
 */
const SUB_PREFIX = 'sub:'

/**
 * 把目录相对路径规范化成**存记录用的键**。
 *
 * ⚠️ 这里是整个功能最容易出错的地方，务必留意：
 *
 * 树里的 path 沿用**与素材根一致的风格**（Windows 上是反斜杠，见 pathDirOf），
 * 而 store 那边（主进程 toRelPath）一律把分隔符换成**正斜杠**再存。
 * 两边不统一的话 `thumbs[key]` 永远匹配不上 —— 表现为「设了封面完全没反应」，
 * 而且不会报任何错、日志也干净，极难查。（这个坑实际踩过一次。）
 *
 * 所以：**查记录一律先规范化**，不要直接用 node.path 去查。
 */
function normalizeRelKey(relPath) {
  return String(relPath || '').split(/[\\/]/).join('/')
}

/**
 * 文件夹树 —— 把「一个文件一条记录」的素材索引，整理成可按目录浏览的层级结构。
 *
 * 设计要点（零类型知识，通用）：
 *  1. 树从素材路径推导，不额外存盘；只包含「通向素材」的目录（空目录不出现）。
 *  2. 文件夹缩略图：先看**用户手动指定的**，没有再走自动规则 ——
 *     自动规则是「先看子文件夹，取子树里第一个有缩略图的素材的缩略图；
 *     子文件夹都没有，才看本目录自己的素材；整个子树都没有 → 用文件夹图标」。
 *     （「有缩略图」= 条目带 thumbPath，即同目录存在对应图片）
 *  3. 排序：文件夹无自身 mtime/size，取整棵子树聚合（体积=子树素材之和、时间=最新）。
 */

/** 文件夹节点（返回给渲染进程的是纯数据，无函数字段） */
class FolderNodeData {
  constructor(rootId, rootPath, path, name, absPath) {
    this.key = `${rootId}\u0000${path}`
    this.rootId = rootId
    this.rootPath = rootPath
    this.path = path // 相对素材根的路径，根为 ''
    this.name = name
    this.absPath = absPath
    this.children = []
    this.assets = [] // 直接位于该文件夹下的素材
    this.subtree = [] // 该文件夹子树内全部素材（含自身直接子级）
    this.representative = null // 代表缩略图素材（可 null）
    /*
     * 用户手动指定的封面素材名（可 null）。
     *
     * 只作用于「这个文件夹自己显示什么」，不改变其它文件夹。
     * 父文件夹会跟着变，是因为它本来就走「子文件夹优先」去取子级的
     * representative —— 不是这里跨级写了什么。
     */
    this.manualThumb = null
    /*
     * 手动封面**确实生效**（选中的就是那张手动指定的图）。
     *
     * 与 manualThumb 的区别：manualThumb 是「记录」，可能已失效
     * （素材被删/缩略图被删）而回落到自动结果；这个标记只在真的用上了
     * 手动那张图时才为 true。
     *
     * 父目录挑子文件夹时用它来做优先级判断：手动设过的子文件夹要压过
     * 仅靠名称序胜出的。见 pickRepresentative 的 ② 说明。
     */
    this.effectiveManual = false
  }
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/** 查找条目是否已有缩略图（供代表图选择） */
function hasSiblingImage(entry) {
  return !!entry.thumbPath
}

/**
 * 选代表缩略图素材。
 *
 * 顺序：
 *   ① 用户手动指定的（且**素材还在本目录直属子级里**、缩略图也还在）
 *   ② 用户手动指定的**子文件夹**（记录值是子文件夹名，见下）
 *   ③ 子文件夹 —— 但**手动指定过封面的子文件夹优先于自动挑的**
 *   ④ 本目录直属的素材
 *   ⑤ 都没有 → null（渲染层显示文件夹图标）
 *
 * 关于 ① 的两个约束：
 *   • **只认直属子级**（node.assets）。手动封面只能由「素材右键 → 用作文件夹封面」
 *     产生，而网格里只显示当前目录直属的素材，所以记录天然只会指向直属素材。
 *   • **失效即回落**：素材被删、缩略图被删、目录被改名，都会让 ① 判定不通过，
 *     自动落到后面几轮。用户不会遇到「设过封面、后来图没了，文件夹永久空白」。
 *
 * 关于 ②：记录里带 `sub:` 前缀表示「用某个**子文件夹**的封面」，值如 `sub:00base`。
 *   这是「右键子文件夹 → 用作父文件夹封面」写下的，**直接决定父文件夹显示什么**，
 *   不再依赖子文件夹自己有没有手动记录。
 *
 *   为什么需要它（而不是只靠 ③ 的优先级）：③ 那轮在同级有**多个**手动设过封面的
 *   子文件夹时，只能退回按名称序取第一个 —— 于是「先给 A 设、再给 B 设」，
 *   父目录可能仍显示 A，用户看到的是「第二次设没反应」。
 *   ② 用一个明确的指针把「父目录要用谁」这件事记死在父目录自己身上，没有歧义。
 *
 * 关于 ③：这是「给子文件夹设封面，父文件夹跟着变」能成立的关键。
 *   如果只按名称序遍历子文件夹取第一个非空（早期实现就是这样），那么
 *   s1、s2 两个子文件夹里只要 s1 有图，给 s2 设封面**对父目录毫无影响** ——
 *   父目录永远显示 s1 的图，用户看到的是「设了没反应」。
 *   所以先扫一遍「自己手动设过封面、且该封面确实生效」的子文件夹，
 *   让明确的人为意图压过默认的名称序。
 *
 *   （判定「确实生效」用 `manualThumb && representative` 还不够 ——
 *   记录可能已失效而回落成自动结果。所以 pickRepresentative 除了选中的条目，
 *   还回报「这次选中的是不是手动那张」，由 finalize 记到 effectiveManual 上。）
 *
 * @returns {{entry: object|null, manual: boolean}} 选中的素材条目，以及它是否来自手动指定
 */
function pickRepresentative(node) {
  if (node.manualThumb) {
    // ② 手动指定的子文件夹（值形如 `sub:00base`）
    if (node.manualThumb.startsWith(SUB_PREFIX)) {
      const subName = node.manualThumb.slice(SUB_PREFIX.length)
      const child = node.children.find((c) => c.name === subName)
      if (child && child.representative) return { entry: child.representative, manual: false }
    } else {
      // ① 手动指定的素材（直属子级）
      const manual = node.assets.find((a) => a.name === node.manualThumb)
      if (manual && hasSiblingImage(manual)) return { entry: manual, manual: true }
    }
  }
  // ③-1：优先看「手动设过封面且生效」的子文件夹
  for (const child of node.children) {
    if (child.effectiveManual && child.representative) return { entry: child.representative, manual: false }
  }
  // ③-2：再按原有的名称序规则
  for (const child of node.children) {
    if (child.representative) return { entry: child.representative, manual: false }
  }
  return { entry: node.assets.find(hasSiblingImage) || null, manual: false }
}

/**
 * 构建文件夹树
 * @param {Array} roots  素材根 [{id, path, name, enabled}]
 * @param {Array} entries 素材条目（含 rootId/path/name/thumbPath 等）
 * @param {object} [folderThumb] 手动封面记录 { "<rootId>\0<相对路径>": "<素材文件名>" }
 *        （settings.folderThumb，由调用方从 store 取好传进来 —— 本模块不碰存储）
 * @returns {FolderNodeData[]} 各根的顶层节点
 */
function buildFolderTree(roots, entries, folderThumb) {
  const thumbs = folderThumb && typeof folderThumb === 'object' ? folderThumb : {}
  const nodes = new Map()
  const rootNodes = []

  const ensure = (root, path) => {
    const key = `${root.id}\u0000${path}`
    const existing = nodes.get(key)
    if (existing) return existing
    const node = new FolderNodeData(
      root.id,
      root.path,
      path,
      path ? path.split(/[\\/]/).pop() : root.name || root.path,
      path ? joinPath(root.path, path) : root.path
    )
    /*
     * 手动封面：键格式与 store 的 folderSortKey 一致（rootId + \0 + 相对路径）。
     * 注意 path 是**反斜杠**风格（跟着素材根走），而 store 存的是正斜杠，
     * 所以这里必须先规范化再查，否则在 Windows 上永远查不到（见 normalizeRelKey）。
     */
    const rec = thumbs[`${root.id}\u0000${normalizeRelKey(path)}`]
    node.manualThumb = typeof rec === 'string' && rec ? rec : null
    nodes.set(key, node)
    if (!path) {
      rootNodes.push(node)
    } else {
      const parentPath = path.split(/[\\/]/).slice(0, -1).join(path.includes('\\') ? '\\' : '/')
      ensure(root, parentPath).children.push(node)
    }
    return node
  }

  const rootById = new Map(roots.map((r) => [r.id, r]))
  for (const root of roots) ensure(root, '')

  for (const entry of entries) {
    if (entry.status === 'missing') continue
    const root = rootById.get(entry.rootId)
    if (!root) continue
    const dirPath = pathDirOf(entry.path, root.path)
    ensure(root, dirPath).assets.push(entry)
  }

  const finalize = (node) => {
    node.children.sort((a, b) => collator.compare(a.name, b.name))
    node.assets.sort((a, b) => collator.compare(a.name, b.name))
    // 必须先递归子级：下面挑代表图要用到子级的 representative / effectiveManual
    for (const child of node.children) finalize(child)
    node.subtree = node.assets.slice()
    for (const child of node.children) node.subtree.push(...child.subtree)
    const picked = pickRepresentative(node)
    node.representative = picked.entry
    node.effectiveManual = picked.manual
  }
  for (const node of rootNodes) finalize(node)
  return rootNodes
}

/** 相对素材根的路径（目录部分），用与根一致的风格 */
function pathDirOf(absPath, rootPath) {
  const sep = rootPath.includes('\\') ? '\\' : '/'
  const rel = absPath.startsWith(rootPath)
    ? absPath.slice(rootPath.length).replace(/^[\\/]+/, '')
    : absPath
  const idx = rel.lastIndexOf(sep)
  return idx > 0 ? rel.slice(0, idx) : ''
}

function joinPath(base, rel) {
  const sep = base.includes('\\') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + rel
}

/** 定位节点 */
function findFolder(nodes, rootId, path) {
  const root = nodes.find((n) => n.rootId === rootId)
  if (!root) return null
  if (!path) return root
  const segs = path.split(/[\\/]/)
  let cur = root
  for (const s of segs) {
    cur = cur.children.find((c) => c.name === s)
    if (!cur) return null
  }
  return cur
}

/** 面包屑链（含根） */
function breadcrumbOf(nodes, rootId, path) {
  const root = nodes.find((n) => n.rootId === rootId)
  if (!root) return []
  const chain = [root]
  if (!path) return chain
  let cur = root
  for (const s of path.split(/[\\/]/)) {
    const next = cur.children.find((c) => c.name === s)
    if (!next) break
    chain.push(next)
    cur = next
  }
  return chain
}

/** 节点 → 渲染进程可用的纯数据（避免带大数组套娃；只取展示所需） */
function nodeToView(node) {
  const stats = subtreeStats(node)
  return {
    key: node.key,
    rootId: node.rootId,
    path: node.path,
    name: node.name,
    absPath: node.absPath,
    count: node.subtree.length,
    size: stats.size,
    mtime: stats.mtime,
    childrenCount: node.children.length,
    assetCount: node.assets.length,
    representative: node.representative ? slimEntry(node.representative) : null,
    /*
     * 是否设过手动封面 —— 渲染层据此决定文件夹右键菜单里
     * 「取消文件夹封面」这一项要不要出现。
     *
     * 传的是**记录本身**（不是「是否生效」）：记录可能因素材/缩略图被删而失效
     * （此时 representative 已回落到自动结果），但记录还在，用户仍应该能取消它 ——
     * 否则就留了个删不掉的脏记录。
     *
     * 值可能是 `清宵.pmx`（素材）或 `sub:00base`（子文件夹），
     * 渲染层要显示给用户看，所以额外给一个**去掉前缀的** manualThumbLabel。
     */
    manualThumb: node.manualThumb || null,
    manualThumbLabel: node.manualThumb
      ? (node.manualThumb.startsWith(SUB_PREFIX)
        ? '子文件夹 ' + node.manualThumb.slice(SUB_PREFIX.length)
        : node.manualThumb)
      : null,
    // 是否来自「用作父文件夹封面」（供界面区分文案，比如菜单里显示「取消」还是别的）
    manualThumbIsSub: !!(node.manualThumb && node.manualThumb.startsWith(SUB_PREFIX)),
  }
}

function subtreeStats(node) {
  let size = 0
  let mtime = 0
  for (const a of node.subtree) {
    size += a.size || 0
    if (a.mtime > mtime) mtime = a.mtime
  }
  return { size, mtime }
}

/** 条目精简（给渲染进程） */
function slimEntry(entry) {
  return {
    id: entry.id,
    path: entry.path,
    name: entry.name,
    size: entry.size,
    mtime: entry.mtime,
    dir: entry.dir,
    rootId: entry.rootId,
    tags: entry.tags || [],
    favorite: !!entry.favorite,
    note: entry.note || '',
    kind: entry.kind || null,
    pluginId: entry.pluginId || null,
    status: entry.status,
    thumbPath: entry.thumbPath || null,
    meta: entry.meta || null,
  }
}

module.exports = {
  buildFolderTree,
  findFolder,
  breadcrumbOf,
  nodeToView,
  slimEntry,
  // 「用子文件夹的封面」这种记录值的前缀与拼装/解析，给主进程用
  SUB_PREFIX,
  subRef: (name) => SUB_PREFIX + String(name || ''),
}
