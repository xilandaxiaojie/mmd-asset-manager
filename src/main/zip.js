/**
 * 最小 ZIP 解压器（零依赖）
 *
 * 主程序不引入任何第三方解压库，仅用 Node 内置 zlib 完成：
 *  • 解析中央目录（EOCD）→ 遍历条目
 *  • 支持压缩方式 0（stored）与 8（deflate）
 *  • 目录条目自动创建
 *  • 文件名编码：优先 UTF-8（general purpose flag bit 11），否则回退 GBK
 *  • 防 Zip-Slip：所有写出路径必须落在目标目录内
 *
 * 注意：本模块不含任何文件类型知识，仅做「压缩包 → 目录」的通用解压。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** 从尾部向前定位 EOCD（考虑最多 64KB 注释） */
function findEOCD(buf) {
  const minPos = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/** 按条目声明的编码解码文件名 */
function decodeName(buf, start, len, utf8Flag) {
  const slice = buf.subarray(start, start + len)
  if (utf8Flag) return slice.toString('utf-8')
  try {
    return new TextDecoder('gbk').decode(slice)
  } catch {
    return slice.toString('utf-8')
  }
}

/** 安全拼接：确保结果位于 root 之内（防 Zip-Slip） */
function safeJoin(root, name) {
  const p = path.resolve(root, name)
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error('压缩包包含非法路径: ' + name)
  }
  return p
}

/**
 * 解压 zip 到目标目录
 * @param {string} zipPath   zip 文件绝对路径
 * @param {string} destDir   目标目录（不存在则创建）
 * @returns {string} destDir
 */
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath)
  const eocd = findEOCD(buf)
  if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到中央目录）')

  const total = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  if (off <= 0 || off >= buf.length) throw new Error('zip 中央目录偏移无效')

  const destRoot = path.resolve(destDir)
  fs.mkdirSync(destRoot, { recursive: true })

  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) {
      throw new Error('zip 中央目录损坏')
    }
    const flag = buf.readUInt16LE(off + 8)
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = decodeName(buf, off + 46, nameLen, (flag & 0x0800) !== 0)
    off += 46 + nameLen + extraLen + commentLen

    // 目录条目
    if (name.endsWith('/')) {
      fs.mkdirSync(safeJoin(destRoot, name), { recursive: true })
      continue
    }

    // 本地文件头 → 定位数据区
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) {
      throw new Error('zip 本地文件头损坏: ' + name)
    }
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const comp = buf.subarray(dataStart, dataStart + compSize)

    let data
    if (method === 0) data = comp
    else if (method === 8) data = zlib.inflateRawSync(comp)
    else throw new Error(`不支持的压缩方式 (${method}): ${name}`)

    const outPath = safeJoin(destRoot, name)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, data)
  }
  return destRoot
}

module.exports = { extractZip }
