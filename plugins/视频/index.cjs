/**
 * 视频插件（视频）
 *
 * 职责：识别视频素材（.mp4 / .webm / .mov），提供独立窗口的播放预览与缩略图。
 *
 *   exts: ['.mp4', '.webm', '.mov']
 *   icon: 'icon.svg'      —— 类别图标（素材卡片 / 列表 / 详情页中间那个，主程序用 asset:// 加载）
 *   kind.color: '#0ea5e9' —— 类型颜色：填左下角文件类型角标，同时是 icon.svg 的描边色
 *   canThumbnail: true    —— 可生成缩略图（顶栏「缩略图」按钮 → 素材同目录 <素材名>.preview.png）
 *   canPreview:   true    —— 独立预览窗口 + 播放器（样式由本目录 preview.html 定义）
 *   viewer: 'viewer.mjs'  —— 渲染模块（原生 <video>，无需第三方库）
 *   parse:                —— 主进程只做**轻量**识别（不解析容器内部结构）
 *
 * ── 为什么只支持这三种格式 ──────────────────────────────
 * 预览靠 Chromium 自带解码器。mp4(H.264/AAC) / webm(VP8/VP9/Opus) / mov(H.264)
 * 能原生播放；mkv / avi / flv / wmv 的**容器**Chromium 解不了，
 * 声明它们只会让用户看到「无法播放」的空白窗口。
 * 所以这里刻意不声明——不支持的格式宁可不被认成素材，也好过假装能播。
 *
 * ── 元数据为什么这么少 ──────────────────────────────────
 * 主进程没有 ffprobe 这类工具，也不该为了读个时长就去解析 MP4 box 结构。
 * 时长/分辨率等精确信息由**渲染进程的 <video> 元素**在加载后读出，
 * 通过预览窗口呈现；详情栏这里只给主程序能确定知道的东西（格式、大小）。
 *
 * 本插件完全自包含：无 node_modules，不读取、不修改主程序的任何文件。
 */
const fs = require('fs')
const path = require('path')

/** 各格式的说明（详情栏「格式」字段展示） */
const FORMAT_LABEL = {
  '.mp4': 'MP4',
  '.webm': 'WebM',
  '.mov': 'MOV',
}

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
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

module.exports = {
  id: '视频',
  name: '视频插件',
  version: '1.0.0',
  description: '预览 MP4 / WebM / MOV 视频，可拖动进度、从视频抽帧生成缩略图',
  icon: 'icon.svg',
  exts: ['.mp4', '.webm', '.mov'],
  kind: { key: 'video', label: '视频', color: '#0ea5e9' },

  // 缩略图：顶栏「缩略图」按钮触发离屏渲染 → 素材同目录的 <素材名>.preview.png
  canThumbnail: true,
  canPreview: true,
  viewer: 'viewer.mjs',
  previewHtml: 'preview.html',

  // 双击卡片 → 打开播放窗口（用户可在设置页改成「用系统程序打开」或「不操作」）
  dblclick: 'preview',

  /** 元数据解析（主进程执行，只读文件，不改动任何内容） */
  parse: async (filePath) => {
    const ext = path.extname(filePath).toLowerCase()
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch (err) {
      return { 状态: '读取文件失败：' + ((err && err.message) || err) }
    }

    const out = {
      format: FORMAT_LABEL[ext] || ext.replace('.', '').toUpperCase(),
      fileSize: humanSize(stat.size),
    }
    // 基本合理性检查：空文件 / 头部明显不对时给个提示，避免用户以为是软件坏了
    if (stat.size === 0) {
      out.状态 = '文件为空'
    } else if (stat.size < 1024) {
      out.状态 = '文件过小，可能不是有效的视频'
    }
    // 时长 / 分辨率 / 编码：由预览窗口里的 <video> 读出并显示（主进程不解析容器）
    out.提示 = '时长与分辨率在预览窗口中查看'
    return out
  },

  /** 详情栏字段（key 对应 parse 返回的元数据） */
  detail: {
    fields: [
      { key: 'format', label: '格式', type: 'badge', style: { color: '#38bdf8' } },
      { key: 'fileSize', label: '文件大小', type: 'text' },
      { key: '状态', label: '状态', type: 'text' },
      { key: '提示', label: '说明', type: 'long', style: { rows: 2 } },
    ],
    style: { accent: '#38bdf8' },
    showMeta: true,
  },
}
