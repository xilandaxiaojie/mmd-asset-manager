/**
 * 预览窗口专用 preload。
 *
 * 预览窗口默认没有 preload：插件页面直接跑，不碰 Node。
 * 但「生成预览图」需要把 snapshot 的 dataURL 交给主进程落盘 ——
 * 落盘路径由主程序的命名约定决定（`<素材名>.preview.png`），
 * 插件不该知道，所以只能由主进程代写。
 *
 * 这里只暴露**一个**函数，且只做一件事：把 dataURL 存成当前素材的预览图。
 * 路径不接受渲染层传入 —— entry 在 preload 里由 additionalArguments 固定，
 * 页面无法通过改参数把文件写到别处。
 */
const { contextBridge, ipcRenderer } = require('electron')

// 主进程通过 additionalArguments 把入口路径传进来（--host-entry=<path>）
const arg = process.argv.find((a) => a.startsWith('--host-entry=')) || ''
const ENTRY_PATH = arg.slice('--host-entry='.length)

contextBridge.exposeInMainWorld('__hostSaveSnapshot__', async (dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { ok: false, error: '不是有效的图片数据' }
  }
  // 只传 dataURL；素材路径由主进程按受信来源解析，页面改不了
  return ipcRenderer.invoke('host:save-snapshot', { entryPath: ENTRY_PATH, dataUrl })
})
