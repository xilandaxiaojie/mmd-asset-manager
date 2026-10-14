/**
 * MMD 模型插件（mmd模型）
 *
 * 职责：识别并解析 MikuMikuDance 模型（.pmx / .pmd），生成缩略图，并提供独立窗口的 3D 实时预览。
 *
 *   exts: ['.pmx', '.pmd']
 *   icon: 'icon.svg'      —— 类别图标（素材卡片 / 列表 / 详情页中间那个，主程序用 asset:// 加载）
 *   kind.color: '#a80043' —— 类型颜色：填左下角文件类型角标，同时是 icon.svg 的描边色
 *   详情栏强调色：'#e0477f' —— kind.color 的亮色调（#a80043 在深色背景上做文字对比度仅 2.2，太暗）
 *   canThumbnail: true    —— 可生成缩略图（顶栏「缩略图」按钮触发离屏渲染 → 素材同目录 <素材名>.preview.png）
 *   canPreview:   true    —— 独立预览窗口 + 3D 实时渲染（样式由本目录 preview.html 定义）
 *   viewer: 'viewer.mjs'  —— 自包含单文件（内含 three.js + MMDLoader）
 *   parse:                —— 主进程解析模型元数据（模型名/注释/顶点/面/材质/骨骼/表情/纹理）
 *
 * 本插件完全自包含：依赖已打包进 viewer.mjs / parser.cjs，插件目录内无 node_modules，
 * 不读取、不修改主程序的任何文件。
 */
const fs = require('fs')
const path = require('path')
const { parseModel } = require('./parser.cjs')

/**
 * 注释文本 → 详情栏预览（只显示开头一段）
 *
 * 详情栏是窄栏，几百字的多行条款整段塞进去会把面板撑得很长，
 * 所以这里只截**开头若干行**做预览，完整原文由同字段下方的
 * 「查看完整」按钮弹窗展示（见 commentText / detail.fields 的 comment 项）。
 */
function commentPreview(raw, maxLines = 6) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim()
  if (!text) return ''
  const lines = text.split('\n').map((l) => l.trimEnd())
  // 去掉纯空行后再截取，避免预览里开头就是空行
  const kept = lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()))
  const head = kept.slice(0, maxLines).join('\n').trimEnd()
  return kept.length > maxLines ? head + '\n…' : head
}

/** 超过该体积只做基础识别，跳过完整解析（避免解析超大模型时的内存峰值） */
const MAX_FULL_PARSE_BYTES = 64 * 1024 * 1024

/** 千分位分组 */
function group(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Buffer → 独立 ArrayBuffer（避免共享底层内存池） */
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** 统计纹理数量：PMX 有顶层 textures 数组；PMD 的纹理名记录在材质里 */
function countTextures(data) {
  if (Array.isArray(data.textures)) return data.textures.length
  if (Array.isArray(data.materials)) {
    const set = new Set()
    for (const m of data.materials) {
      const name = m && (m.fileName || m.textureFileName)
      if (name) set.add(String(name))
    }
    return set.size
  }
  return 0
}

/** 解析失败/无法识别时统一返回一个「状态」字段，供详情栏展示 */
function failure(message) {
  return { 状态: message }
}

module.exports = {
  id: 'mmd模型',
  name: 'MMD 模型插件',
  version: '1.1.0',
  description: '识别并解析 MikuMikuDance 模型（.pmx / .pmd），可生成缩略图，支持独立窗口 3D 实时预览',
  icon: 'icon.svg',
  exts: ['.pmx', '.pmd'],
  kind: { key: 'mmd-model', label: 'MMD 模型', color: '#a80043' },

  // 缩略图：顶栏「缩略图」按钮触发离屏渲染 → 素材同目录的 `<原名>.png`；预览走独立窗口的 3D 实时渲染
  canThumbnail: true,
  canPreview: true,
  viewer: 'viewer.mjs',
  previewHtml: 'preview.html',

  // 双击卡片 → 打开 3D 预览窗口（用户可在设置页覆盖为「用系统程序打开」或「不操作」）
  dblclick: 'preview',

  /** 元数据解析（主进程执行，只读文件，不改动任何内容） */
  parse: async (filePath) => {
    const ext = path.extname(filePath).toLowerCase()
    const isPmd = ext === '.pmd'
    const label = isPmd ? 'PMD' : 'PMX'

    let stat
    try {
      stat = fs.statSync(filePath)
    } catch (err) {
      return failure('读取文件失败：' + (err && err.message || err))
    }

    // 超大文件：只做基础识别，避免一次性解析占用大量内存
    if (stat.size > MAX_FULL_PARSE_BYTES) {
      return {
        format: label,
        状态: `文件较大（${(stat.size / 1048576).toFixed(1)} MB），已跳过完整解析以节省内存`,
      }
    }

    let data
    try {
      const buf = fs.readFileSync(filePath)
      data = parseModel(toArrayBuffer(buf), ext)
    } catch (err) {
      // mmd-parser 抛出的是字符串，不是 Error
      const msg = typeof err === 'string' ? err : (err && err.message) || String(err)
      return failure(`无法解析（${label}）：${msg}`)
    }

    const meta = (data && data.metadata) || {}
    const out = {
      format: `${label}${meta.version != null ? ' ' + Number(meta.version).toFixed(1) : ''}`,
      modelName: meta.modelName || '（未命名）',
      vertices: group(meta.vertexCount),
      faces: group(meta.faceCount),
      materials: group(meta.materialCount),
      bones: group(meta.boneCount),
      morphs: group(meta.morphCount),
      textures: group(countTextures(data)),
      encoding: isPmd ? 'Shift-JIS' : (meta.encoding === 0 ? 'UTF-16LE' : 'UTF-8'),
    }

    if (meta.englishModelName) out.englishName = meta.englishModelName

    // 注释：详情栏只放开头几行做预览，完整原文由同字段下方的「查看完整」按钮弹窗展示
    // （模型注释常是数百字的中日英三语条款，整段放进窄栏会把面板撑爆）。
    const comment = String(meta.comment || '').trim()
    if (comment) out.comment = commentPreview(comment)

    return out
  },

  /** 详情栏字段（key 对应 parse 返回的元数据） */
  detail: {
    fields: [
      { key: 'format', label: '格式', type: 'badge', style: { color: '#e0477f' } },
      { key: 'modelName', label: '模型名', type: 'text', style: { bold: true } },
      { key: 'englishName', label: '英文名', type: 'text' },
      // 注释：只显示开头几行，下面挂「查看完整」按钮弹出全文
      { key: 'comment', label: '注释', type: 'long', style: { button: 'show-comment' } },
      { key: 'vertices', label: '顶点数', type: 'text' },
      { key: 'faces', label: '面数', type: 'text' },
      { key: 'materials', label: '材质数', type: 'text' },
      { key: 'bones', label: '骨骼数', type: 'text' },
      { key: 'morphs', label: '表情数', type: 'text' },
      { key: 'textures', label: '纹理数', type: 'text' },
      { key: 'encoding', label: '文本编码', type: 'text' },
    ],
    // 详情栏按钮：被 fields 里 comment 的 style.button 引用（挂在字段下方，不在顶部）
    buttons: [
      {
        id: 'show-comment',
        label: '查看完整',
        run: async (filePath) => {
          const data = parseModel(toArrayBuffer(fs.readFileSync(filePath)),
            path.extname(filePath).toLowerCase())
          const comment = String((data && data.metadata && data.metadata.comment) || '').trim()
          if (!comment) return '这个模型没有写注释。'
          const modelName = (data.metadata && data.metadata.modelName) || path.basename(filePath)
          return { title: `${modelName} — 注释`, text: comment }
        },
      },
    ],
    style: { accent: '#e0477f' },
    showMeta: true,
  },
}
