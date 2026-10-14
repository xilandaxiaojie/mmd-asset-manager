/**
 * Blender 工程插件（blender工程）
 *
 * 职责：让主程序识别 Blender 工程文件（.blend），并在详情栏展示工程版本信息。
 *
 *   exts: ['.blend']
 *   icon: 'icon.svg'      —— 类别图标（素材卡片 / 列表 / 详情页中间那个，主程序用 asset:// 加载）
 *   canThumbnail: false   —— 不生成缩略图（主程序缩略图只取素材同目录 <素材名>.preview.* 的图片）
 *   canPreview:   false   —— 不提供实时预览
 *   parse:                —— 只读文件头（最多 17 字节），解析版本 / 指针位数 / 字节序 / 压缩
 *
 * 本插件完全自包含：只依赖 Node 内置模块，不读取、不修改主程序的任何文件。
 *
 * 关于 id：插件 id 以**文件夹名**为准（主程序加载时用目录名覆盖 manifest.id，
 * 见 pluginHost.js 的 loadPlugins / 启用 / 安装三条路径）。此处写成同值，
 * 是为了「把本目录打包成 zip 重新安装」时落地目录名与现在一致 ——
 * 否则会装出 plugins/blender/，与已存在的目录名对不上。
 *
 * ── .blend 文件头格式（依据 Blender 源码 BLO_core_blend_header.hh）──
 *   格式 0（12 字节头）：
 *     0-6   'BLENDER'
 *     7     指针大小：'-' = 8 字节（64 位） / '_' = 4 字节（32 位）
 *     8     字节序：'v' = 小端 / 'V' = 大端
 *     9-11  3 位 ASCII 版本号，值 = 主版本 * 100 + 次版本（'305' → 3.5，'293' → 2.93）
 *   格式 1（17 字节头，新格式）：
 *     0-6   'BLENDER'
 *     7-8   头长度，ASCII 数字（当前恒为 '17'）
 *     9     '-'
 *     10-11 文件格式版本号（当前恒为 '01'）
 *     12    'v'
 *     13-16 4 位 ASCII 版本号（'0405' → 4.5）
 *   压缩：保存时勾选「Compress」会得到 gzip 流（以 0x1F 0x8B 开头），
 *         此时需先解压头部才能读到版本（本插件只解压开头，不读取整个文件）。
 */
const fs = require('fs')
const zlib = require('zlib')

/** 需要读取的最大头长度（格式 1 为 17 字节） */
const HEADER_MAX = 17
/** gzip 变体：最多读取 512KB 压缩数据即可解出文件头 */
const GZIP_PREFIX_BYTES = 512 * 1024

/** 版本值 → '4.2' 形式（值 = 主版本 * 100 + 次版本） */
function formatVersion(code) {
  if (!Number.isFinite(code) || code <= 0) return ''
  return `${Math.floor(code / 100)}.${code % 100}`
}

/** 解码 12 / 17 字节头；无法识别返回 null */
function decodeHeader(buf) {
  if (!buf || buf.length < 12) return null
  if (buf.toString('latin1', 0, 7) !== 'BLENDER') return null

  const b7 = buf[7]
  const b8 = buf[8]

  // ── 格式 1：第 7-8 字节为 ASCII 数字（头长度）──
  if (b7 >= 0x30 && b7 <= 0x39 && b8 >= 0x30 && b8 <= 0x39) {
    if (buf.length < 17) return null
    const endian = buf[12] === 0x76 ? 'little' : buf[12] === 0x56 ? 'big' : null // 'v' / 'V'
    const code = Number(buf.toString('latin1', 13, 17)) // '0405'
    if (!endian || !Number.isFinite(code)) return null
    return { format: 1, headerBytes: Number(buf.toString('latin1', 7, 9)) || 17, endian, code, pointerBytes: 8 }
  }

  // ── 格式 0 ──
  const pointerBytes = b7 === 0x2d ? 8 : b7 === 0x5f ? 4 : null // '-' / '_'
  const endian = b8 === 0x76 ? 'little' : b8 === 0x56 ? 'big' : null
  const code = Number(buf.toString('latin1', 9, 12)) // '305'
  if (!pointerBytes || !endian || !Number.isFinite(code)) return null
  return { format: 0, headerBytes: 12, endian, code, pointerBytes }
}

/** 读取 gzip 压缩 .blend 的文件头（只解压开头若干字节，避免读取整个大文件） */
function readGzipHeader(absPath) {
  return new Promise((resolve) => {
    const rs = fs.createReadStream(absPath, { start: 0, end: GZIP_PREFIX_BYTES - 1 })
    const gunzip = zlib.createGunzip()
    let settled = false
    let acc = Buffer.alloc(0)
    const finish = (value) => {
      if (settled) return
      settled = true
      rs.destroy()
      gunzip.destroy()
      resolve(value)
    }
    gunzip.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk])
      if (acc.length >= HEADER_MAX) finish(decodeHeader(acc))
    })
    gunzip.on('end', () => finish(decodeHeader(acc)))
    gunzip.on('error', () => finish(null))
    rs.on('error', () => finish(null))
    rs.pipe(gunzip)
  })
}

/** 读取 .blend 文件头（自动识别 gzip 压缩变体） */
async function readBlendHeader(absPath) {
  const fd = fs.openSync(absPath, 'r')
  let head
  try {
    const buf = Buffer.alloc(HEADER_MAX)
    const n = fs.readSync(fd, buf, 0, HEADER_MAX, 0)
    head = buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }

  // gzip 魔数 0x1F 0x8B
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return { compressed: 'gzip', header: await readGzipHeader(absPath) }
  }
  return { compressed: '无', header: decodeHeader(head) }
}

module.exports = {
  id: 'blender工程',
  name: 'Blender 工程插件',
  version: '1.0.0',
  description: '识别 Blender 工程文件（.blend），解析工程版本 / 指针位数 / 字节序 / 压缩方式',
  icon: 'icon.svg',
  exts: ['.blend'],
  kind: { key: 'blender', label: 'Blender 工程', color: '#ea7600' },

  // 不生成缩略图、不提供实时预览
  canThumbnail: false,
  canPreview: false,
  viewer: null,
  previewHtml: null,

  // 元数据解析：只读文件头，不做任何内容级解析
  parse: async (filePath) => {
    const { compressed, header } = await readBlendHeader(filePath)

    // 头无法识别（非 .blend、损坏，或非常规变体）
    if (!header) {
      return { 状态: '无法识别该文件头（可能已损坏或非标准变体）' }
    }

    return {
      blenderVersion: formatVersion(header.code),
      pointerSize: header.pointerBytes === 8 ? '64 位' : '32 位',
      endianness: header.endian === 'little' ? '小端（little-endian）' : '大端（big-endian）',
      compressed: compressed === 'gzip' ? 'gzip（保存时勾选了压缩）' : '无',
      headerFormat: `格式 ${header.format}（${header.headerBytes} 字节头）`,
    }
  },

  // 详情栏字段（key 对应 parse 返回的元数据）
  detail: {
    fields: [
      { key: 'blenderVersion', label: 'Blender 版本', type: 'badge', style: { color: '#ea7600' } },
      { key: 'pointerSize', label: '指针位数', type: 'text' },
      { key: 'endianness', label: '字节序', type: 'text' },
      { key: 'compressed', label: '压缩', type: 'text' },
      { key: 'headerFormat', label: '头格式', type: 'text' },
    ],
    style: { accent: '#ea7600' },
    showMeta: true,
  },
}
