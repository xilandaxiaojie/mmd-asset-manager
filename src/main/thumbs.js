/**
 * 缩略图服务（通用策略，零类型知识）
 *
 * ── 命名规则 ──────────────────────────────────────────────
 * 素材 `a.blend` 的缩略图 = 同目录的 `a.blend.preview.png`
 *
 * 两层含义都在文件名里：
 *   • `a.blend`   —— 保留素材完整扩展名，避免同主名的不同素材撞车
 *                    （`a.blend` 与 `a.pmx` 若都找 `a.png` 会共用一张图）
 *   • `.preview.` —— 标明「这是预览图」，与用户自己的图片区分开
 *
 * 图片扩展名仍按 PNG/JPG/JPEG/BMP/WEBP/GIF 顺序取第一个存在的，
 * 所以手放 `a.blend.preview.jpg` 同样能识别。
 *
 * ── 从文件名就能判断来源 ──────────────────────────────────
 * 带 `.preview.` 的是缩略图，不带的是用户自己的图片 ——
 * 「清除缩略图」只删前者，绝不碰后者（见 isPreviewFile）。
 *
 * ── 与插件渲染能力的关系 ──────────────────────────────────
 * 网格/列表里的缩略图**只**来自磁盘上这个命名的图片。插件的渲染能力
 * （viewer.snapshot）不参与显示，只用于「按需生成」——即顶栏「缩略图」按钮：
 * 对插件声明 canThumbnail 且当前没有缩略图的素材，调用插件渲染生成一张
 * 上述命名的 PNG 落到素材同目录，之后便与手动放置的走完全相同的显示路径。
 */
const fs = require('fs')
const path = require('path')

/** 通用图片扩展名（仅作为旁挂缩略图的候选，不参与任何素材类型判断） */
const THUMB_IMG_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif']

/** 预览图标记：文件名里的这一段表明「这是缩略图」 */
const PREVIEW_MARK = '.preview.'

/** 缩略图尺寸档位（设置项；生成缩略图时交给插件渲染的分辨率） */
const THUMB_SIZES = [128, 256, 512, 1024, 2048]
const DEFAULT_THUMB_SIZE = 256

/** 把任意输入吸附到最近的合法档位 */
function normalizeThumbSize(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_THUMB_SIZE
  let best = THUMB_SIZES[0]
  for (const s of THUMB_SIZES) if (Math.abs(s - n) < Math.abs(best - n)) best = s
  return best
}

/**
 * 生成缩略图的输出路径：`<素材文件名>.preview.png`
 * 例如 `a.blend` → `a.blend.preview.png`
 */
function thumbOutPathFor(absPath) {
  const dir = path.dirname(absPath)
  return path.join(dir, path.basename(absPath) + PREVIEW_MARK + 'png')
}

/** 占位图标颜色：按扩展名哈希取色，稳定且无类型语义 */
function extColor(ext) {
  const palette = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b']
  let h = 0
  for (const ch of String(ext || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

/**
 * 在素材文件同目录查找缩略图；找不到返回 null。
 *
 * 命名：`<素材文件名>.preview.<图片扩展名>`，例如 `a.blend` 找 `a.blend.preview.png`。
 *
 * **只认带 `.preview.` 的名字**：这样「哪些文件是缩略图」一目了然，
 * 也不会误把用户随手放的 `a.blend.png` 当成缩略图。
 */
function findSiblingImage(absPath) {
  const dir = path.dirname(absPath)
  const stem = path.basename(absPath) + PREVIEW_MARK.slice(0, -1) // 'a.blend.preview'
  for (const ext of THUMB_IMG_EXTS) {
    const candidate = path.join(dir, stem + ext)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

/**
 * 判断一个路径是不是本程序的缩略图（文件名里带 `.preview.`）。
 *
 * 这是「清除缩略图」唯一的安全依据：只有符合命名约定的才允许删除，
 * 用户自己命名的图片一律不动。
 */
function isPreviewFile(p) {
  return !!p && path.basename(p).includes(PREVIEW_MARK)
}

/**
 * 取条目缩略图信息（供渲染进程展示）
 *
 * 只查磁盘上带 `.preview.` 命名的图片；没有就回退占位图标。
 * 索引里的 `thumbPath` 只是缓存（省一次磁盘查找），这里仍以实际存在的文件为准。
 */
function resolveThumbnail(entry) {
  const cached = entry.thumbPath && fs.existsSync(entry.thumbPath) ? entry.thumbPath : null
  const img = cached || findSiblingImage(entry.path)
  if (img && fs.existsSync(img)) {
    return { type: 'image', path: img }
  }

  // 没有缩略图 → 只显示文件类型（按扩展名取色的占位图标）
  return { type: 'placeholder', ext: extOf(entry.path) }
}

function extOf(p) {
  return (path.extname(p) || '').toLowerCase()
}

/** 生成占位 SVG（data: URI） */
function placeholderSvg(ext, size = 160, bg = '#2a2d33') {
  const color = extColor(ext)
  const label = (ext || '?').replace('.', '') || '?'
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${bg}"/>` +
    `<rect x="${size * 0.22}" y="${size * 0.26}" width="${size * 0.56}" height="${size * 0.44}" rx="${size * 0.05}" fill="${color}" opacity="0.85"/>` +
    `<path d="M${size * 0.30} ${size * 0.38} l${size * 0.14} ${size * 0.14} l${size * 0.12} -${size * 0.10} l${size * 0.16} ${size * 0.18}" stroke="#fff" stroke-width="${Math.max(2, size * 0.02)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<text x="${size / 2}" y="${size * 0.84}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="${size * 0.16}" fill="#e2e4e8" font-weight="600">${label.toUpperCase()}</text>` +
    `</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

/**
 * 缩略图缓存：键 = 路径，签名 = 素材 mtime + 缩略图路径 + **缩略图自身的 mtime**。
 *
 * 三项都要进签名，少一个就会有「改了图但界面不变」：
 *   • 素材 mtime      —— 素材本身被替换
 *   • 缩略图路径      —— 手动放入/删除旁挂图片（素材 mtime 不变，只有这个变）
 *   • 缩略图 mtime    —— **用同名新图覆盖旧图**（两者路径完全相同！
 *                        预览窗口的「生成预览图」正是这种情况）
 *
 * ── 为什么不每次都去 stat 一遍 ──────────────────────────────
 * 第三项的最直白实现是「每次调用都 stat 缩略图拿 mtime」，但那样每个条目
 * 每帧都要多做一次 stat + 一次 findSiblingImage（最多 7 次 stat），
 * 大素材库里滚动会明显发卡 —— 缓存的收益基本被抵消光。
 *
 * 改用**失效驱动**：
 *   • 覆盖/删除/生成缩略图的那几处（预览窗口存图、清除缩略图、批量生成、扫描完成）
 *     都会显式调 clearThumbCache() → 下次自然重算
 *   • 缩略图是被本程序写入的，写入点有限且都在我们控制内，能保证不漏
 * 这样既正确又不牺牲热路径性能。
 */
const thumbCache = new Map()

/** 取文件 mtimeMs；读不到返回 0（文件不存在/无权限） */
function mtimeOf(p) {
  if (!p) return 0
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 缩略图版本号（拼进 URL 当 `?v=` 用）。
 * 取整到毫秒字符串即可 —— 只要文件一变，值就变，够 Chromium 认成新资源。
 * 读不到就返回空串，URL 退回不带版本号的老样子（不影响功能）。
 *
 * 注意这是**给浏览器做缓存失效**用的，与上面的服务端缓存是两回事，
 * 所以它必须每次真读一次 stat（只对「正在取缩略图 URL」的条目调用，
 * 频次远低于 cachedResolve）。
 */
function thumbVersionOf(imgPath) {
  const ms = mtimeOf(imgPath)
  return ms ? String(Math.round(ms)) : ''
}

function cachedResolve(entry) {
  const key = entry.path
  const sig = `${entry.mtime}\u0000${entry.thumbPath || ''}`
  const hit = thumbCache.get(key)
  if (hit && hit.sig === sig) return hit.value
  const value = resolveThumbnail(entry)
  thumbCache.set(key, { sig, value })
  return value
}

/** 清空缩略图缓存（扫描完成 / 批量生成缩略图后调用，保证即时刷新） */
function clearThumbCache() {
  thumbCache.clear()
}

module.exports = {
  resolveThumbnail,
  cachedResolve,
  clearThumbCache,
  findSiblingImage,
  thumbOutPathFor,
  thumbVersionOf,
  isPreviewFile,
  normalizeThumbSize,
  placeholderSvg,
  extOf,
  THUMB_IMG_EXTS,
  THUMB_SIZES,
  DEFAULT_THUMB_SIZE,
  PREVIEW_MARK,
}
