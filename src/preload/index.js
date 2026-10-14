/**
 * preload：contextBridge 暴露最小 API（仅白名单方法，参数直通主进程）
 */
const { contextBridge, ipcRenderer } = require('electron')
const { IpcChannels, IpcEvents } = require('../shared/ipcChannels')

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)
const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  // 素材库
  listRoots: invoke(IpcChannels.LIB_LIST),
  addRoot: invoke(IpcChannels.LIB_ADD),
  removeRoot: invoke(IpcChannels.LIB_REMOVE),
  setRootEnabled: invoke(IpcChannels.LIB_SET_ENABLED),
  scan: invoke(IpcChannels.LIB_SCAN),
  pickDir: invoke(IpcChannels.LIB_PICK_DIR),
  // 素材查询
  queryAssets: invoke(IpcChannels.ASSETS_QUERY),
  getStats: invoke(IpcChannels.ASSETS_STATS),
  getAsset: invoke(IpcChannels.ASSET_GET_BY_PATH),
  // 标签/收藏/备注
  patchAsset: invoke(IpcChannels.ASSET_PATCH),
  batchPatch: invoke(IpcChannels.ASSET_BATCH_PATCH),
  // 目录树
  getDirTree: invoke(IpcChannels.DIR_TREE),
  listDir: invoke(IpcChannels.DIR_LIST),
  folderView: invoke(IpcChannels.FOLDER_VIEW),
  // 每个文件夹的排序方案（记住用户在各目录里选的排序）
  getFolderSort: invoke(IpcChannels.FOLDER_SORT_GET),
  setFolderSort: invoke(IpcChannels.FOLDER_SORT_SET),
  // 手动指定文件夹封面（把某素材的缩略图作为它所在文件夹的封面）
  setFolderThumb: invoke(IpcChannels.FOLDER_THUMB_SET),
  clearFolderThumb: invoke(IpcChannels.FOLDER_THUMB_CLEAR),
  getFolderThumb: invoke(IpcChannels.FOLDER_THUMB_GET),
  useChildFolderThumb: invoke(IpcChannels.FOLDER_THUMB_FROM_CHILD),
  // 文件操作
  openFile: invoke(IpcChannels.FILE_OPEN),
  previewFile: invoke(IpcChannels.FILE_PREVIEW),
  revealFile: invoke(IpcChannels.FILE_REVEAL),
  getThumbUrl: invoke(IpcChannels.THUMB_URL),
  generateThumbnails: invoke(IpcChannels.THUMB_GENERATE),
  getThumbPending: invoke(IpcChannels.THUMB_PENDING),
  clearThumbnails: invoke(IpcChannels.THUMB_CLEAR),
  rebuildThumb: invoke(IpcChannels.THUMB_REBUILD),
  // 设置
  getSettings: invoke(IpcChannels.SETTINGS_GET),
  setSettings: invoke(IpcChannels.SETTINGS_SET),
  // 长任务取消（进度条上的「停止」按钮）
  cancelTask: invoke(IpcChannels.TASK_CANCEL),
  // 插件
  listPlugins: invoke(IpcChannels.PLUGIN_LIST),
  pluginLoadErrors: invoke(IpcChannels.PLUGIN_LOAD_ERRORS),
  installPlugin: invoke(IpcChannels.PLUGIN_INSTALL),
  uninstallPlugin: invoke(IpcChannels.PLUGIN_UNINSTALL),
  setPluginEnabled: invoke(IpcChannels.PLUGIN_SET_ENABLED),
  savePluginSettings: invoke(IpcChannels.PLUGIN_SETTINGS_SAVE),
  runPluginAction: invoke(IpcChannels.PLUGIN_ACTIONS),
  runPluginButton: invoke(IpcChannels.PLUGIN_BUTTON),
  pickPluginZip: invoke(IpcChannels.PLUGIN_PICK_ZIP),
  createPlugin: invoke(IpcChannels.PLUGIN_CREATE),
  updatePlugin: invoke(IpcChannels.PLUGIN_UPDATE),
  pickPluginIcon: invoke(IpcChannels.PLUGIN_PICK_ICON),
  discardPluginIcon: invoke(IpcChannels.PLUGIN_DISCARD_ICON),
  // 插件设置项 type:'dir' —— 选文件夹拷进插件目录 / 清除
  pickPluginDir: invoke(IpcChannels.PLUGIN_PICK_DIR),
  deletePluginDir: invoke(IpcChannels.PLUGIN_DELETE_DIR),
  // 插件设置项 type:'file' —— 列出已选文件夹里的候选文件
  listPluginFiles: invoke(IpcChannels.PLUGIN_LIST_FILES),
  // 事件
  onScanProgress: on(IpcEvents.SCAN_PROGRESS),
  onScanDone: on(IpcEvents.SCAN_DONE),
  onScanError: on(IpcEvents.SCAN_ERROR),
  onThumbProgress: on(IpcEvents.THUMB_PROGRESS),
  onThumbDone: on(IpcEvents.THUMB_DONE),
  onThumbError: on(IpcEvents.THUMB_ERROR),
  // 预览窗口里「生成预览图」改了某一个素材的预览图 → 界面就地刷新那一张
  onThumbChanged: on(IpcEvents.THUMB_CHANGED),
})
