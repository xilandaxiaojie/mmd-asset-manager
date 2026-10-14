/**
 * 插件契约定义（主程序 ↔ 插件 的接口约定 —— 权威定义）
 *
 * ── 插件形态 ──────────────────────────────────────────────
 * 每个插件 = plugins/<id>/ 的一个文件夹：
 *
 *   plugins/<id>/
 *     index.cjs      插件声明（必需）: 全部能力与接口
 *     parser.cjs     主进程解析实现（可选，插件自带）
 *     viewer.mjs     渲染模块（预览 + 缩略图，渲染进程动态 import；可选）
 *     其他文件       插件私有实现（自由）
 *
 * ── 插件声明结构（index.cjs 的 module.exports）───────────
 * @typedef {Object} PluginManifest
 * @property {string} id                唯一标识。**以插件文件夹名为准**：加载时主程序用
 *                                      plugins/<文件夹名> 覆盖 manifest.id，因此「改名」
 *                                      等价于改文件夹名，不需要（也不允许）主程序改插件代码。
 *                                      插件自行声明 id 只为单独加载该模块时可用。
 * @property {string} name              显示名，如 '模型插件'
 * @property {string} [version]         版本号，如 '1.0.0'
 * @property {string} [description]     一句话描述
 * @property {string} [icon]            插件图标文件名（相对插件文件夹），如 'icon.svg'
 * @property {string[]} exts            负责的扩展名，如 ['.pmx', '.pmd']（小写含点）
 * @property {{key:string,label:string,color:string}} kind
 *                                      类别标注，如 { key:'model', label:'模型', color:'#6366f1' }
 * @property {boolean} [simple]         由主程序「新建插件」生成的**简易插件**：只声明文件类型，
 *                                      无 parse/viewer/缩略图/预览能力。主程序在插件列表里给它
 *                                      打标识，并允许在「插件设置」弹窗里增删支持的扩展名。
 *                                      缺省时按「只有声明、没有任何实现代码」自动判定（兼容早期版本
 *                                      生成的简易插件）。
 *
 * ── 用户在界面上的改动存在哪 ──────────────────────────────
 * 「插件设置」弹窗改的 显示名 / 文件夹名 / 扩展名 / 图标 / 类别色 **不会写回插件文件**，
 * 而是记在数据目录的 plugin-overrides.json（键 = 插件文件夹名），加载时叠加到 manifest 上。
 * 这样手写插件永远不会被主程序改动；改文件夹名 = 重命名目录 + 迁移覆盖与索引归属。
 *
 * ── 能力声明（渲染能力：主程序只有通用开关，没有类型假设） ──
 * @property {boolean} canThumbnail     能否按需渲染缩略图。主程序不自动调用：由顶栏
 *                                      「缩略图」按钮触发，只对「声明 canThumbnail +
 *                                      提供 viewer + 当前没有缩略图」的素材渲染，
 *                                      结果写到素材同目录的 <素材文件名>.preview.png（不覆盖已有缩略图）
 * @property {boolean} canPreview       能否实时预览（插件提供 viewer → 主程序提供预览宿主）
 * @property {string} [viewer]          渲染模块文件名，如 'viewer.mjs'
 * @property {string} [previewHtml]     预览窗口页面模板文件名（相对插件文件夹），如 'preview.html。
 *                                      含窗口样式与内容容器（元素 id 用 host-content）；
 *                                      缺省回退主程序通用宿主页。
 *                                      独立预览窗口的样式一律由该文件定义。
 * @property {Function} [parse]         (filePath, buf, deep) => metadata 主进程元数据解析
 * @property {'preview'|'open'|'none'} [dblclick]
 *                                      双击素材卡片时的行为：
 *                                        'preview' 打开预览窗口（需要 canPreview + viewer）
 *                                        'open'    用系统默认程序打开
 *                                        'none'    双击不做任何事
 *                                      不写 = 用全局默认（'preview'）。
 *                                      用户在设置页可为每个插件单独覆盖，覆盖值优先。
 *                                      注：素材不支持预览时，'preview' 会自动退化为 'open'，
 *                                      不会出现「双击没反应」。
 *
 * ── 界面定制 ──────────────────────────────────────────────
 * @property {Array<{id:string,label:string,scope:'single'|'multi',run:Function}>} [actions]
 *                                      自定义操作：single=素材右键菜单，multi=批量操作条
 * @property {Object} [detail]          详情栏信息与样式：
 *   @property {Array<{key,label,type,style}>} [fields] 详情栏通用键值字段
 *       key: 'name'|'size'|'mtime'|'meta.*'|'note'...   value 取自条目或 parse 元数据
 *       type: 'text'|'color'|'link'|'badge'|'long'     渲染方式
 *       style: { color, bold, block, rows, button }     内联样式 / 展示形态
 *           block: true    该字段独占一行，值不再右对齐（长文本用）
 *           rows:  number  初始显示行数，超出滚动（只在长文本下生效）
 *           button: string 在该字段正文下方挂一个按钮，值为 buttons 里声明的 id
 *                          —— 正文通常只放预览，点按钮才弹完整内容
 *   @property {Array<{id,label,run}>} [buttons] 详情栏按钮（见下）
 *       与 actions 的区别：actions 进右键菜单、只返回一句提示；
 *       buttons 由 fields 的 style.button 引用，**挂在那个字段下方**，
 *       可拿到返回值并在界面呈现结果（长文本 → 弹窗）。
 *   @property {Object} [style]         详情面板样式：{ headerBg, accent }
 *   @property {boolean} [showMeta]     是否在详情栏展示 parse 返回的元数据键值（默认 true）
 * @property {Array<{key,label,type,options,default}>} [settings]
 *                                      插件自定义设置项（用户在设置页可编辑）
 *       type: 'text'|'number'|'boolean'|'select'
 *
 * ── 主程序如何使用 ────────────────────────────────────────
 *   • 扫描：扩展名 → 插件 完全来自注册表；无插件声明 → 不索引不显示
 *   • 类别：来自 kind；缩略图：显示只取同目录 `<素材文件名>.preview.*` 的图片；
 *     生成则由「缩略图」按钮按 canThumbnail 触发（产物同命名，之后与手动放置的走同一条显示路径）
 *   • 预览：canPreview → 预览宿主（独立窗口 + 空内容容器 + API 注入）；
 *     容器里放什么由插件决定，主程序不假设内容形态
 *   • 双击：dblclick（插件声明，可被设置页里的用户覆盖）→ 预览 / 打开 / 不操作
 *   • 自定义操作：actions → 右键菜单 / 批量操作条
 *   • 详情栏：detail.fields / parse 元数据 → 通用键值渲染；
 *     detail.buttons 由 fields 的 style.button 引用，挂在对应字段下方，
 *     返回值由界面呈现（文本 → 长文本弹窗）
 *   • 设置：settings → 设置页可编辑，持久化在 userData/plugin-settings.json
 */
const path = require('path')

/** 通用类别常量（无插件时 UI 占位） */
const Kind = {
  OTHER: { key: 'other', label: '其他', color: '#8a8f98' },
}

/**
 * 插件渲染模块（viewer.mjs）导出的统一 viewer 接口约定。
 *
 * ── 通用性（重要）──────────────────────────────────────────
 * 主程序不知道素材是 3D 模型、视频、音频还是文档。它只提供**窗口框架**：
 * 一个空容器元素 + 注入的 api；容器里放什么完全由插件决定
 * （<canvas> / <video> / <audio> / <iframe> / 任意 DOM）。
 *
 * 因此下列方法里，除 mount / dispose 外**全部可选** —— 主程序一律用
 * `typeof viewer.x === 'function'` 探测，缺了就跳过对应步骤。
 */
const ViewerInterface = {
  // ── 核心（应实现）──
  mount: '(container) => Promise|void', // 挂载到主程序给的内容容器元素
  dispose: '() => void', // 释放资源（停止循环、销毁渲染器、解绑事件）

  // ── 可选：加载与播放 ──
  load: '(path, opts) => Promise', // 加载素材主文件；缩略图渲染时 opts = { size, thumbnail: true }
  start: '() => void', // 开始播放/渲染循环（静态内容可忽略）
  stop: '() => void', // 停止播放/渲染循环

  // ── 可选：环境响应 ──
  resize: '(w, h) => void', // 容器尺寸变化
  setBackground: '(color) => void', // 背景色

  // ── 可选：缩略图 ──
  snapshot: '() => Promise<dataURL>', // 生成缩略图时由主程序调用（api.thumbSize 为档位尺寸）
  waitReady: '() => Promise', // 等异步资源就绪后再快照；旧契约名 waitForTextures 仍被兼容

  // ── 可选：类型专属扩展（主程序不主动调用，由插件自用）──
  loadMotion: '(path) => Promise', // 例如 MMD 的动作文件
}

class PluginRegistry {
  constructor() {
    this._plugins = new Map() // id -> manifest
    this._signature = ''
  }

  register(manifest) {
    if (!manifest || typeof manifest.id !== 'string' || !manifest.id) return false
    this._plugins.set(manifest.id, manifest)
    this._signature = this._computeSignature()
    return true
  }

  unregister(id) {
    const removed = this._plugins.delete(id)
    if (removed) this._signature = this._computeSignature()
    return removed
  }

  /**
   * 注册插件集合的内容指纹（id + exts 排序后拼接）。
   *
   * 不能用「注册次数」这类计数器：只改插件 id（例如把插件目录 mmd 改名为 mmd模型）
   * 而插件数量不变时计数器不变 → 扫描器认为插件没变 → 增量复用缓存条目 →
   * 条目里残留的旧 pluginId 再也解析不到插件（预览、缩略图集体失效），
   * 而且点多少次「扫描」都不会自愈（目录指纹也没变）。
   * 内容指纹只要插件集合有任何变化就会变，从而触发一次全量重扫把条目刷正。
   */
  _computeSignature() {
    return [...this._plugins.values()]
      .map((m) => `${m.id}\u0000${(m.exts || []).join(',')}`)
      .sort()
      .join('\u0001')
  }

  /** 插件集合的版本标识（内容指纹；变化即需全量重扫） */
  version() {
    return this._signature
  }

  getById(id) {
    return this._plugins.get(id) || null
  }

  getByExt(ext) {
    if (!ext || typeof ext !== 'string') return undefined
    const key = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
    for (const manifest of this._plugins.values()) {
      if (Array.isArray(manifest.exts) && manifest.exts.map((e) => e.toLowerCase()).includes(key)) {
        return manifest
      }
    }
    return undefined
  }

  list() {
    return [...this._plugins.values()]
  }

  /** 清空注册表（重载插件前调用） */
  clear() {
    if (this._plugins.size === 0) return
    this._plugins.clear()
    this._signature = ''
  }

  get size() {
    return this._plugins.size
  }
}

/** 全局唯一注册表实例 */
const registry = new PluginRegistry()

module.exports = { Kind, PluginRegistry, registry, ViewerInterface }
