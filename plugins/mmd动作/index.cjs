/**
 * MMD 动作插件（mmd动作）
 *
 * 职责：识别并解析 MMD 的动作 / 镜头 / 姿势文件，以及配套音频，
 *       并提供「套用指定模型」的 3D 实时预览。
 *
 *   exts: ['.vmd', '.vpd', '.mp3', '.wav']
 *   ┌ .vmd  MikuMikuDance 动作数据（骨骼关键帧）或镜头数据（相机关键帧）
 *   ├ .vpd  MikuMikuDance 姿势数据（单帧，不是动画）
 *   └ .mp3/.wav  配套音频（跳舞用的曲子）
 *
 *   icon: 'icon.svg'       —— 类别图标
 *   kind.color: '#7c3aed'  —— 动作类颜色
 *   canThumbnail: false    —— 不做缩略图（动作/音频都没有「一眼可辨的画面」）
 *   canPreview:   true     —— 独立预览窗口
 *   viewer: 'viewer.mjs'   —— 自包含单文件（内含 three.js + MMDLoader + MMDAnimationHelper）
 *   settings: 'modelDir'   —— type:'dir'，指定套用的模型文件夹（由主程序复制进插件目录）
 *             'modelFile'  —— type:'file'，从上面那个文件夹里挑具体哪个模型
 *
 * ── 预览行为 ────────────────────────────────────────────────
 * • 打开动作时停在第 0 帧，点「开始」才播放（不自动播放）
 * • 播放按**真实时间**推进，与显示器刷新率无关（不会 2 倍速）
 * • 自动加载动作**同目录**的音频：只有一个就用它，多个用下拉框挑（默认第一个）
 * • 动作与音频一起播放/暂停/跳转，不会各走各的
 *
 * ── 为什么动作和音频在一个插件里 ────────────────────────────
 * 用户要的是「模型套动作跳起来」。动作和音频是同一件事的两半：
 * 预览时模型 + 动作 + 音频一起放。拆成两个插件反而要解决
 * 「怎么让音频插件知道动作插件在放什么」，得不偿失。
 * 但**类别（kind）分开**：动作是紫色，音频是青色，
 * 卡片角标一眼能分清 —— 这在同一个插件里用不上两个 kind 字段，
 * 所以 kind 声明为动作，音频的具体类型由 parse 结果在详情栏标出。
 *
 * ── 本插件完全自包含 ───────────────────────────────────────
 * 依赖已打包进 viewer.mjs / parser.cjs，插件目录内无 node_modules，
 * 不读取、不修改主程序的任何代码文件。
 *
 * ⚠️ 唯一会写的两处（都在插件目录内）：
 *    • `_runtime/settings.json` —— 模型路径小抄
 *    • `_runtime/audio/*.json`  —— 动作同目录的音频清单
 *    原因见 mirrorSettings() / writeSiblingAudioList() 的注释
 *    （预览窗口的 viewer 没有 fs，只能读插件目录内、经 asset:// 放行的已知路径）。
 *
 * ── 关于「套用的模型」──────────────────────────────────────
 * 本插件**不内置任何模型**。模型由用户在设置里指定，主程序把所选文件夹
 * 复制到插件目录下，预览时从这里读。
 *
 * ⚠️ 用户自备的模型通常有版权、授权多不允许再分发 ——
 *    不要把它提交进仓库（.gitignore 已按白名单挡住插件目录下的非源码文件）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/* ── VMD 文件格式 ─────────────────────────────────────────
 *
 * 实测出的字节布局（对着真实文件逐个字段核对过）：
 *
 *   偏移 0        签名，固定占 30 字节
 *                 'Vocaloid Motion Data 0002'（25 字符）+ 5 字节填充
 *                 旧格式是 'Vocaloid Motion Data file'
 *   偏移 30       适用模型名，Shift-JIS，固定 20 字节（旧格式没有这段）
 *   偏移 50       骨骼帧数 u32
 *   之后          骨骼帧 × 111 字节
 *                 表情帧数 u32
 *                 表情帧 × 23 字节
 *                 相机帧数 u32        ← 只有镜头数据才有这一段
 *                 相机帧 × 61 字节
 *                 影子/属性帧数 u32   ← 可选
 *
 * ⚠️ 三个计数**不是挨着的**：表情计数在前一段数据**之后**，
 *    所以要先知道骨骼帧数才能定位表情帧数。
 *    早期版本把三个计数当成 50/54/58 的连续字段读，结果
 *    真实文件里读出来的全是垃圾值（表情帧数变成 24 亿）。
 *    教训：文件格式不能靠猜，要拿真实文件对。
 */
const VMD_SIG_FIELD = 30
const VMD_MODEL_NAME_BYTES = 20
const VMD_COUNTS_OFFSET = VMD_SIG_FIELD + VMD_MODEL_NAME_BYTES // 50

/** 两种签名（新版带模型名，旧版没有） */
const VMD_SIG_NEW = 'Vocaloid Motion Data 0002'
const VMD_SIG_OLD = 'Vocaloid Motion Data file'

/** 每种记录的字节数（用于跨段定位与完整性校验） */
const VMD_BONE_RECORD = 111
const VMD_MORPH_RECORD = 23
const VMD_CAMERA_RECORD = 61

/** 相机骨骼在 VMD 里的固定名字（镜头数据就是对这根「骨骼」打关键帧） */
const VMD_CAMERA_BONE = 'カメラ・照明'

/** 音频扩展名 */
const AUDIO_EXTS = ['.mp3', '.wav']

/** 动作类颜色（与 icon.svg 的描边色一致） */
const ACCENT = '#a78bfa'

/** 千分位分组 */
function group(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 字节数 → 人类可读（主程序不提供这类工具，插件自带） */
function humanSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * 秒 → mm:ss（帧数 ÷ 30fps，VMD 固定 30fps）
 *
 * 必须挡住非有限值：帧数缺失时算出来是 NaN，
 * 直接显示成「NaN:NaN」比「未知」难看得多。
 */
function fmtFrames(frames) {
  const n = Number(frames)
  if (!Number.isFinite(n) || n < 0) return '未知'
  const total = Math.floor(n / 30)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 读 VMD 头部，判断是**动作数据**、**镜头数据**，还是两者都有。
 *
 * 只读文件开头一段（够覆盖骨骼段之前的头部即可，见下方 headBytes 的说明），
 * 不解析整个文件 —— 动作文件动辄几 MB，而这里只需要几个计数。
 *
 * @param {Buffer} buf 文件开头的一段（第 0 字节起）
 * @param {number} fileSize 文件真实大小（用于校验计数是否合理）
 * @returns {{ok:boolean, kind?:string, modelName?:string, boneFrames?:number,
 *            morphFrames?:number, cameraFrames?:number, reason?:string}}
 */
function readVmdHeader(buf, fileSize) {
  if (buf.length < VMD_COUNTS_OFFSET + 4) {
    return { ok: false, reason: '文件过小，不是有效的 VMD' }
  }

  // 签名占 30 字节，但字符串本身只有 25 字符，后面是填充（可能是 0，也可能是残留字节）
  const sig = buf.toString('latin1', 0, 25).replace(/\0+$/, '').trim()
  if (sig !== VMD_SIG_NEW && sig !== VMD_SIG_OLD) {
    return { ok: false, reason: `文件头不是 VMD 签名（读到「${sig.slice(0, 24)}」）` }
  }

  // 模型名固定 20 字节，Shift-JIS。旧格式没有这段，但偏移仍按新版算 ——
  // 旧文件的这段区域是骨骼数据，解码出来是乱码，交给下面的合理性校验兜底。
  const rawName = buf.toString('latin1', VMD_SIG_FIELD, VMD_SIG_FIELD + VMD_MODEL_NAME_BYTES)
  const modelName = sig === VMD_SIG_NEW ? decodeShiftJis(rawName) : ''

  const boneFrames = buf.readUInt32LE(VMD_COUNTS_OFFSET)

  /*
   * 骨骼段之后的偏移。这一段可能超出已读入的 buf 范围
   * （骨骼帧多时，表情计数离文件头很远）—— 那就只知道骨骼帧数，
   * 表情/相机帧数留 0，不影响「这是动作还是镜头」的判断。
   */
  const morphAt = VMD_COUNTS_OFFSET + boneFrames * VMD_BONE_RECORD
  let morphFrames = 0
  let cameraFrames = 0

  /*
   * 先做一次总体校验：光头部就声称的数据量不该超过文件实际大小。
   * 计数被读错（或文件损坏）时这个检查能立刻发现 ——
   * 否则预览窗口会卡在「按一个天文数字去解析」上。
   */
  const minBytes = VMD_COUNTS_OFFSET + boneFrames * VMD_BONE_RECORD
  if (minBytes > fileSize) {
    return {
      ok: false,
      reason: `骨骼帧数与文件大小不符（头部声称 ${group(boneFrames)} 帧，需至少 ${humanSize(minBytes)}，实际仅 ${humanSize(fileSize)}），文件可能损坏`,
    }
  }

  if (morphAt + 4 <= buf.length) {
    const candidate = buf.readUInt32LE(morphAt)
    /*
     * 表情计数也要做合理性校验：按它算出来的总长度不能超过文件大小。
     * 实测有些工具（如 PmxEditor）导出的中间文件在这一段是别的东西，
     * 直接采信会读到 363 这种「需要 8 KB 但文件只有 288 字节」的值。
     * 校验不过就当作「读不到」，退回 0 —— 宁可少显示一个数字，
     * 也不要显示一个明显错误的数。
     */
    const need = morphAt + 4 + candidate * VMD_MORPH_RECORD
    if (need <= fileSize) {
      morphFrames = candidate
      const camAt = need
      if (camAt + 4 <= buf.length) {
        const camCandidate = buf.readUInt32LE(camAt)
        if (camAt + 4 + camCandidate * VMD_CAMERA_RECORD <= fileSize) cameraFrames = camCandidate
      }
    } else {
      morphFrames = -1 // 读到了但不可信，按「未知」处理
    }
  } else if (morphAt + 4 <= fileSize) {
    // 头部读得不够长，但文件里确实还有内容 —— 保守地按「未知」处理
    morphFrames = -1
  }

  /*
   * 类型判据（按可靠性排序）：
   *   ① 相机帧数 > 0        → 明确是镜头数据（最强证据）
   *   ② 骨骼帧数 === 0      → 没有骨骼可动，只可能是镜头数据
   *   ③ 否则               → 动作数据
   *
   * 注意不能用「表情帧为 0」当判据：大量动作数据本来就不带表情
   * （尤其是只导出了骨骼的舞蹈动作），那样会把动作误判成镜头。
   */
  const isCamera = cameraFrames > 0 || boneFrames === 0

  return {
    ok: true,
    kind: isCamera ? 'camera' : 'motion',
    modelName,
    boneFrames,
    morphFrames: morphFrames < 0 ? 0 : morphFrames,
    morphFramesUnknown: morphFrames < 0,
    cameraFrames,
    sig,
  }
}

/**
 * Shift-JIS 字节 → 字符串。
 *
 * ⚠️ 必须**截到第一个 \0 为止**再解码。
 * 20 字节的模型名字段并不保证尾部是干净的填充：实测某个日文模型名
 * 后面跟着一堆残留字节（有些写入工具不擦原缓冲区），
 * 直接整段解码会得到「模型名\0������」这种尾巴。
 */
function decodeShiftJis(latin1Str) {
  // 先按 latin1 找到第一个 NUL，只取它之前的部分
  const cut = latin1Str.indexOf('\0')
  const head = cut >= 0 ? latin1Str.slice(0, cut) : latin1Str
  if (!head) return ''
  try {
    const bytes = Buffer.from(head, 'latin1')
    return new TextDecoder('shift_jis').decode(bytes).trim()
  } catch {
    // 环境不支持 shift_jis 时退回原始字节的可读形式，不影响主流程
    return head.trim()
  }
}

/**
 * 读 VPD 头部。VPD 是纯文本（**Shift-JIS** 编码，不是 UTF-8），形如：
 *
 *   Vocaloid Pose Data file
 *
 *   モデル名.osm;            // 文件名
 *   30;                      // 总姿势骨骼数
 *
 *   Bone0{右腕
 *     0.000000,0.000000,0.000000;      // trans x,y,z
 *     -0.071600,0.063158,0.413080,0.90 // rot x,y,z,w
 *
 * ⚠️ 两个坑（都是对着真实文件才发现的）：
 *   ① 编码是 Shift-JIS，用 UTF-8 读会变乱码。骨骼名只是展示用，
 *      但**声明在文件里的「总骨骼数」**那一行是 ASCII 数字，照样读得出来。
 *   ② 骨骼行的分隔符是 `{` 不是 `;`（早期版本按 `Bone0;` 匹配，一个都匹配不到，
 *      于是所有 VPD 都显示「0 根骨骼」）。
 *
 * 优先用文件自己声明的总数（第 2 个非空行，形如 `30;`），
 * 读不到再退回数 Bone 行 —— 前者更权威。
 */
function readVpdHeader(buf) {
  // 用 latin1 读，保住原始字节；只需要其中的 ASCII 结构
  const text = buf.toString('latin1')
  if (!/Vocaloid\s+Pose\s+Data/i.test(text.slice(0, 128))) {
    return { ok: false, reason: '文件头不是「Vocaloid Pose Data」，不是有效的 VPD' }
  }

  const lines = text.split(/\r?\n/)

  // 文件声明的总骨骼数：找第一个形如 "数字;" 的独立行
  let declared = -1
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*;\s*(?:\/\/.*)?$/)
    if (m) { declared = Number(m[1]); break }
  }

  // 实际数到的骨骼块（Bone0{ / Bone1{ ...）
  const boneLines = lines.filter((l) => /^\s*Bone\s*\d*\s*\{/i.test(l)).length

  // 模型名：形如 "xxx.osm;" 的那一行
  let modelName = ''
  const mn = text.match(/^\s*([^\r\n;{}]+\.(?:osm|pmx|pmd|vpd|vmd))\s*;/im)
  if (mn) modelName = decodeShiftJis(Buffer.from(mn[1], 'latin1')).trim()

  return {
    ok: true,
    boneCount: declared >= 0 ? declared : boneLines,
    countedBones: boneLines,
    declared,
    modelName,
  }
}

/* ── 设置镜像 ──────────────────────────────────────────── */

/** 插件目录内、供 viewer 读取的小抄文件（相对本文件所在目录） */
const RUNTIME_REL = path.join('_runtime', 'settings.json')

/** 同目录音频清单的存放目录（相对本文件所在目录） */
const AUDIO_LIST_DIR_REL = path.join('_runtime', 'audio')

/**
 * 路径 → 清单文件名。
 *
 * ⚠️ 算法必须与 viewer.src.js 里的 hashPathKey 完全一致（改一边要改另一边）。
 * 素材路径可能很长且含中文，直接当文件名会超长/非法，哈希后是定长十六进制。
 */
function audioListKey(filePath) {
  const norm = String(filePath).replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 32)
}

/**
 * 扫描动作文件所在目录，把音频文件名写成清单供 viewer 读取。
 *
 * ── 为什么要在主进程做 ──────────────────────────────────
 * viewer 没有 fs，也没有列目录的 IPC；它唯一能读的是 asset:// 放行范围内的
 * **已知路径**。所以「同目录下有哪些音频」必须由主进程先查好写下来。
 *
 * 只记**文件名**（不记绝对路径）：viewer 拿它和动作文件同目录拼起来即可，
 * 换机器/换盘符都不会失效；同时也避免了把用户目录结构写进插件目录。
 *
 * @param {string} vmdPath 动作文件绝对路径
 * @returns {Array<{name:string}>} 写出去的清单（按文件名排序）
 */
function writeSiblingAudioList(vmdPath) {
  const dir = path.dirname(vmdPath)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }

  const files = names
    .filter((n) => AUDIO_EXTS.includes(path.extname(n).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh'))

  const payload = {
    dir,
    files: files.map((n) => ({ name: n })),
    updatedAt: Date.now(),
  }

  const out = path.join(__dirname, AUDIO_LIST_DIR_REL, audioListKey(vmdPath) + '.json')
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf-8')
  } catch {
    // 写不进去只影响配乐，不影响动作预览
  }
  return files
}

/**
 * 把「本插件在 plugin-settings.json 里的那一份」镜像到插件目录内。
 *
 * ── 为什么非要多这一步 ──────────────────────────────────
 * 预览窗口里的 viewer **没有 Node、也没有读文件的 API**，唯一通道是
 * `asset://`。而 `asset://` 的放行范围是「素材库根」+「plugins 目录」——
 * `data/` 不在里面，**读不到 plugin-settings.json**。
 * 主程序调用 viewer 时也只传素材路径（`viewer.load(entry.path, {})`），
 * 不传任何设置。
 *
 * 插件目录本身是放行的，所以这里把 viewer 需要的那点信息
 * （模型文件夹 + 具体模型文件）写进插件目录内的一份 json。
 * viewer 用 `asset://` 读它，就能自己找到模型。
 *
 * 本函数在 parse() 里调用 —— parse 是**主进程**执行的，有完整 Node 权限。
 * 写的是自己插件目录内的文件，不碰主程序、不碰素材库。
 *
 * @param {object} settings 本插件的设置（已合并默认值）
 */
function mirrorSettings(settings) {
  const modelDir = String((settings && settings.modelDir) || '').trim()
  // 用户在设置里显式挑的那个模型文件（相对插件目录，形如 '模型/xxx.pmx'）
  let modelFile = String((settings && settings.modelFile) || '').trim()

  /*
   * 校验用户选的文件确实还在：设置里存的可能是旧值
   * （换过文件夹、或用户手动删过），指向不存在的路径会让
   * viewer 报一个看不懂的加载错误。不存在就退回自动挑选。
   */
  if (modelFile) {
    try {
      if (!fs.statSync(path.join(__dirname, modelFile)).isFile()) modelFile = ''
    } catch {
      modelFile = ''
    }
  }

  // 没指定（或指定的已失效）→ 在文件夹里自动挑一个，.pmx 优先于 .pmd
  if (!modelFile && modelDir) {
    const abs = path.join(__dirname, modelDir)
    try {
      if (fs.statSync(abs).isDirectory()) {
        const found = findModelFile(abs, modelDir, 2)
        if (found) modelFile = found
      }
    } catch {
      // 文件夹不存在/读不了 → modelFile 留空，viewer 会给提示
    }
  }

  const payload = {
    modelDir,
    modelFile: modelFile || null,
    updatedAt: Date.now(),
  }
  try {
    const out = path.join(__dirname, RUNTIME_REL)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf-8')
  } catch {
    // 写不进去不影响 parse 返回（只影响预览能不能找到模型）
  }
  return payload
}

/**
 * 在模型文件夹里找一个可用的模型文件。
 *
 * 优先在**根目录**找（绝大多数模型是 `模型/xxx.pmx`），
 * 找不到再往子目录里找一层（有些作者把 pmx 放在以模型名命名的子目录）。
 * 返回相对插件目录的路径（用 / 分隔，方便直接拼进 asset:// URL）。
 *
 * @param {string} absDir 绝对路径
 * @param {string} relDir 相对插件目录的路径
 * @param {number} depth 还能往下找几层
 */
function findModelFile(absDir, relDir, depth) {
  let entries
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return null
  }

  const files = entries.filter((e) => e.isFile())
  // 先 .pmx 再 .pmd
  for (const want of ['.pmx', '.pmd']) {
    const hit = files.find((e) => e.name.toLowerCase().endsWith(want))
    if (hit) return relDir + '/' + hit.name
  }

  if (depth > 0) {
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue
      const found = findModelFile(
        path.join(absDir, ent.name), relDir + '/' + ent.name, depth - 1)
      if (found) return found
    }
  }
  return null
}

/**
 * 读本插件的设置。
 *
 * 主程序目前**不把设置值传给插件**（见 PLUGIN-INTERFACE 第 7 节），
 * 所以插件自己读。位置与主程序一致：软件主目录下的 data/plugin-settings.json，
 * 可用 AMM_DATA_DIR 覆盖。
 */
function readMySettings() {
  const dataDir = process.env.AMM_DATA_DIR
    || path.join(__dirname, '..', '..', 'data')
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugin-settings.json'), 'utf-8'))
    return (all && all[path.basename(__dirname)]) || {}
  } catch {
    return {}
  }
}

/** 解析失败/无法识别时统一返回「状态」字段，供详情栏展示 */
function failure(message) {
  return { 状态: message }
}

module.exports = {
  id: 'mmd动作',
  name: 'MMD 动作插件',
  version: '1.0.0',
  description: '预览 MMD 动作/镜头（.vmd）与姿势（.vpd），可套用指定模型；同时管理配套音频（.mp3/.wav）',
  icon: 'icon.svg',
  /*
   * 音频用另一个图标。
   *
   * 本插件同时管两种差别很大的素材 —— 动作（.vmd/.vpd）和音频（.mp3/.wav）。
   * 共用一个图标的话，卡片和列表里根本分不清哪个是动作、哪个是曲子。
   * 主程序按条目的扩展名优先取这里的图标，取不到再退回插件级 icon。
   */
  extIcons: {
    '.mp3': 'icon-audio.svg',
    '.wav': 'icon-audio.svg',
  },
  exts: ['.vmd', '.vpd', '.mp3', '.wav'],
  kind: { key: 'mmd-motion', label: 'MMD 动作', color: '#7c3aed' },

  // 动作/音频都没有「一眼可辨的画面」，不做缩略图（预览窗口里可以按画面生成预览图）
  canThumbnail: false,
  canPreview: true,
  viewer: 'viewer.mjs',
  previewHtml: 'preview.html',

  // 双击卡片 → 打开预览窗口
  dblclick: 'preview',

  /**
   * 插件设置。
   *
   * 'dir' 是主程序提供的类型：界面渲染成「浏览…」按钮，
   * 选中的文件夹被**整个复制进插件目录**，这里存的是相对路径。
   * 之所以要复制而不是记原路径 —— 预览窗口的 viewer 只能读
   * asset:// 放行范围内的文件（素材库 + plugins 目录），库外路径读不到。
   *
   * 'file' 从上面那个文件夹里挑一个文件。一个模型文件夹里常常有多个
   * .pmx（不同服装/版本），只选文件夹无法确定用哪个，所以再给一个下拉框。
   * 候选由主程序扫描后填充；只有一个时自动选中。
   */
  settings: [
    {
      key: 'modelDir',
      label: '模型文件夹',
      type: 'dir',
      default: '',
    },
    {
      key: 'modelFile',
      label: '模型文件',
      type: 'file',
      from: 'modelDir',            // 候选来自上面那个设置项选中的文件夹
      match: ['.pmx', '.pmd'],     // 只列模型文件
      recursive: true,             // 含子目录（有些作者按服装分文件夹）
      default: '',
    },
  ],

  /**
   * 打开预览前的准备（主进程执行）。
   *
   * ── 为什么不能只靠 parse() ──────────────────────────────
   * parse() 的结果有缓存：主程序只在**素材文件本身变了**（大小/mtime）
   * 才重新调用它。所以「插件更新后新加的逻辑」对已经扫描过的老素材
   * 不会生效 —— 同目录音频清单就踩了这个坑：库早就扫过了，
   * 所有 .vmd 都命中缓存，writeSiblingAudioList 一次都没跑，
   * 预览窗口自然读不到清单，也就没有配乐。
   *
   * 这个钩子由主程序在**每次打开预览前**调用，与扫描缓存无关，
   * 保证 viewer 去读清单时它一定是最新的。
   *
   * @param {string} filePath 即将预览的素材绝对路径
   */
  preparePreview: async (filePath) => {
    const ext = path.extname(filePath).toLowerCase()
    // 只有动作/镜头需要配乐；姿势和音频自己不需要
    if (ext !== '.vmd') return
    writeSiblingAudioList(filePath)
  },

  /** 元数据解析（主进程执行，只读素材文件；仅在插件目录内写 _runtime 小抄） */
  parse: async (filePath) => {
    const ext = path.extname(filePath).toLowerCase()

    let stat
    try {
      stat = fs.statSync(filePath)
    } catch (err) {
      return failure('读取文件失败：' + ((err && err.message) || err))
    }

    // 每次扫描/刷新都同步一次小抄，保证预览窗口读到的是最新设置
    const mirrored = mirrorSettings(readMySettings())

    /*
     * 动作文件的「同目录音频清单」。
     *
     * 预览窗口需要在打开动作时自动配上同目录的曲子，但 viewer 没有 fs、
     * 也没有列目录的 API。所以在这里（主进程，有完整 Node 权限）扫一遍
     * 动作所在目录，把音频文件名写成清单，viewer 用 asset:// 读。
     *
     * 只对 .vmd 做：姿势（.vpd）和音频自己不需要配乐。
     */
    if (ext === '.vmd') {
      try {
        writeSiblingAudioList(filePath)
      } catch {
        // 写清单失败不影响解析结果，只是预览时不会有配乐
      }
    }

    if (stat.size === 0) return failure('文件为空')

    /* ── 音频 ───────────────────────────────────── */
    if (AUDIO_EXTS.includes(ext)) {
      return {
        format: ext === '.mp3' ? 'MP3 音频' : 'WAV 音频',
        fileSize: humanSize(stat.size),
        提示: '双击打开播放器；音频与动作可在同一预览流程里配合使用',
      }
    }

    /* ── VMD / VPD ──────────────────────────────── */
    /*
     * VMD 的读入长度：骨骼帧数在偏移 50，但**表情/相机帧数在整段骨骼数据之后**，
     * 所以要读到 `50 + 骨骼帧数*111 + 4 + 表情帧数*23 + 4` 才能全部定位。
     * 骨骼帧多时这可能很大（1 万帧 ≈ 1.1 MB），但比起整个文件仍小得多，
     * 且这是判断「动作还是镜头」所必需的 —— 预算上限 8 MB，
     * 超出的部分只影响表情/相机计数（类型判断有骨骼帧数兜底）。
     */
    const VMD_HEAD_BUDGET = 8 * 1024 * 1024
    let buf
    try {
      if (ext === '.vpd') {
        buf = fs.readFileSync(filePath) // VPD 是文本且通常很小，整体读
      } else {
        const want = Math.min(stat.size, VMD_HEAD_BUDGET)
        const fd = fs.openSync(filePath, 'r')
        buf = Buffer.alloc(want)
        const read = fs.readSync(fd, buf, 0, want, 0)
        fs.closeSync(fd)
        if (read < want) buf = buf.subarray(0, read)
      }
    } catch (err) {
      return failure('读取文件失败：' + ((err && err.message) || err))
    }

    if (ext === '.vpd') {
      const v = readVpdHeader(buf)
      if (!v.ok) return failure(`无法解析 VPD：${v.reason}`)
      const out = {
        format: 'VPD 姿势',
        姿势骨骼数: group(v.boneCount),
        fileSize: humanSize(stat.size),
        提示: 'VPD 是单帧姿势（不是动画），预览时会套用到模型上静止显示',
      }
      if (v.modelName) out.适用模型 = v.modelName
      // 声明数与实际数对不上时提示一下（文件被截断过会出现）
      if (v.declared >= 0 && v.countedBones > 0 && v.declared !== v.countedBones) {
        out.状态 = `文件声明 ${v.declared} 根骨骼，实际读到 ${v.countedBones} 根`
      } else if (v.boneCount === 0) {
        out.状态 = '没有读到任何骨骼，文件可能不完整'
      }
      if (mirrored.modelFile) out.预览模型 = path.basename(mirrored.modelFile)
      return out
    }

    // .vmd
    const h = readVmdHeader(buf, stat.size)
    if (!h.ok) return failure(`无法解析 VMD：${h.reason}`)

    const isCamera = h.kind === 'camera'
    const out = {
      format: isCamera ? 'VMD 镜头数据' : 'VMD 动作数据',
      fileSize: humanSize(stat.size),
    }
    if (h.modelName) out.适用模型 = h.modelName

    if (isCamera) {
      // 镜头数据：主体是相机帧，骨骼/表情通常为 0，别把 0 当「没内容」展示
      if (h.cameraFrames > 0) {
        out.相机帧数 = group(h.cameraFrames)
        out.时长约 = fmtFrames(h.cameraFrames)
      }
      if (h.boneFrames > 0) out.骨骼帧数 = group(h.boneFrames)
      out.提示 = '镜头数据记录的是相机运动，不驱动模型骨骼；预览窗口会用它控制视角'
      // 镜头数据不需要模型也能预览（相机运动本身就能看），所以不提示「未指定模型」
    } else {
      out.骨骼帧数 = group(h.boneFrames)
      out.表情帧数 = h.morphFramesUnknown ? '未知' : group(h.morphFrames)
      out.时长约 = fmtFrames(h.boneFrames)
      if (!h.modelName) {
        out.提示 = '文件未记录适用模型名，动作可能与模型骨骼不匹配（表现为姿势错位）'
      }
      // 动作数据必须套模型才有意义 —— 没指定模型时明确说清楚
      if (mirrored.modelFile) {
        out.预览模型 = path.basename(mirrored.modelFile)
      } else {
        out.提示 = (out.提示 ? out.提示 + '；' : '') + '尚未在插件设置里指定套用的模型，预览时将看不到动作效果'
      }
    }
    return out
  },

  /** 详情栏字段（key 对应 parse 返回的元数据） */
  detail: {
    fields: [
      { key: 'format', label: '格式', type: 'badge', style: { color: ACCENT } },
      { key: '适用模型', label: '适用模型', type: 'text', style: { bold: true } },
      { key: '骨骼帧数', label: '骨骼帧数', type: 'text' },
      { key: '表情帧数', label: '表情帧数', type: 'text' },
      { key: '姿势骨骼数', label: '姿势骨骼数', type: 'text' },
      { key: '时长约', label: '时长约', type: 'text' },
      { key: '预览模型', label: '预览模型', type: 'text' },
      { key: 'fileSize', label: '文件大小', type: 'text' },
      { key: '状态', label: '状态', type: 'text' },
      { key: '提示', label: '说明', type: 'long', style: { rows: 3 } },
    ],
    style: { accent: ACCENT },
    showMeta: true,
  },
}
