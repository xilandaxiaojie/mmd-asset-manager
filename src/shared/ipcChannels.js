/**
 * IPC 通道名常量（主程序与渲染进程的唯一通信约定）
 * 所有 invoke/handle 都使用这些通道名，避免魔法字符串。
 */
const IpcChannels = {
  // ── 素材库管理 ─────────────────────────────
  LIB_LIST: 'lib:list',
  LIB_ADD: 'lib:add',
  LIB_REMOVE: 'lib:remove',
  LIB_SET_ENABLED: 'lib:setEnabled',
  LIB_SCAN: 'lib:scan',
  LIB_PICK_DIR: 'lib:pickDir',
  LIB_SCAN_STATUS: 'lib:scanStatus', // 主进程 → 渲染进程 事件

  // ── 素材条目查询 ───────────────────────────
  ASSETS_QUERY: 'assets:query',
  ASSETS_STATS: 'assets:stats', // 全部/收藏/丢失 计数
  ASSET_GET_BY_PATH: 'assets:getByPath',

  // ── 标签 / 收藏 / 备注 ─────────────────────
  ASSET_PATCH: 'asset:patch', // 单条修改（标签/收藏/备注）
  ASSET_BATCH_PATCH: 'asset:batchPatch', // 批量

  // ── 浏览（目录树） ─────────────────────────
  DIR_TREE: 'dir:tree', // 按根目录构建目录树
  DIR_LIST: 'dir:list', // 列出某目录的直接子项（用于树懒加载）
  FOLDER_VIEW: 'folder:view', // 文件夹视图：面包屑+子文件夹+本目录素材

  // ── 每个文件夹的排序方案 ───────────────────
  // 进目录时读（没有记录 → 回落全局默认），改排序时写；失效记录由主进程清理
  FOLDER_SORT_GET: 'folder:sortGet', // (rootId, relPath) → { sort, order } | null
  FOLDER_SORT_SET: 'folder:sortSet', // (rootId, relPath, sort, order) → { ok }

  // ── 手动指定文件夹封面 ─────────────────────
  // (rootId, dirPath, 素材名)。只影响该文件夹自己的显示；
  // 父文件夹会跟着变是因为它本来就走「子文件夹优先」取子级的封面。
  FOLDER_THUMB_SET: 'folder:thumbSet', // → { ok } | { ok:false, error }
  FOLDER_THUMB_CLEAR: 'folder:thumbClear', // → { ok, removed }
  FOLDER_THUMB_GET: 'folder:thumbGet', // → 素材名 | null（右键菜单判断显示「取消封面」）
  FOLDER_THUMB_FROM_CHILD: 'folder:thumbFromChild', // 把子文件夹当前封面用于父文件夹

  // ── 文件操作 ───────────────────────────────
  // 注意：这里**刻意不提供任何删除/修改素材的通道**。软件只被允许增删缩略图，
  // 素材文件本身只能由用户在文件管理器中处理。
  FILE_OPEN: 'file:open', // 系统默认程序打开
  FILE_PREVIEW: 'file:preview', // 预览（插件宿主）
  FILE_REVEAL: 'file:reveal', // 打开所在目录并选中
  THUMB_URL: 'thumb:url', // 取缩略图 URL（asset:// 协议）
  THUMB_GENERATE: 'thumb:generate', // 按需生成缩略图（插件 canThumbnail → <素材文件名>.preview.png）
  THUMB_PENDING: 'thumb:pending', // 统计范围内「可生成但还没有缩略图」的素材数（顶栏按钮括号里的数字）
  THUMB_CLEAR: 'thumb:clear', // 清除范围内带 `.preview.` 命名的缩略图（移入回收站；其它文件不动）
  THUMB_REBUILD: 'thumb:rebuild', // 重建单个素材的缩略图（删旧 + 重新生成）

  // ── 设置 ───────────────────────────────────
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // ── 长任务取消 ─────────────────────────────
  TASK_CANCEL: 'task:cancel', // 请求停止正在运行的长任务（kind: 'scan' | 'thumb'）

  // ── 插件 ─────────────────────────────────────
  PLUGIN_LIST: 'plugin:list', // 返回注册表内容（含启用状态/设置/能力）
  PLUGIN_INSTALL: 'plugin:install', // 安装：zip 压缩包 → 解压校验 → 复制到 plugins/
  PLUGIN_UNINSTALL: 'plugin:uninstall', // 卸载（删除整个插件目录，不可还原，即时生效）
  PLUGIN_SET_ENABLED: 'plugin:setEnabled', // 启用/禁用（即时生效）
  PLUGIN_SETTINGS_SAVE: 'plugin:settingsSave', // 保存插件自定义设置
  PLUGIN_ACTIONS: 'plugin:actions', // 执行插件自定义操作
  PLUGIN_BUTTON: 'plugin:button', // 执行插件详情栏按钮，返回值给界面呈现
  PLUGIN_PICK_ZIP: 'plugin:pickZip', // 选择插件 zip 压缩包（安装用）
  PLUGIN_CREATE: 'plugin:create', // 新建简单插件（仅声明文件类型，无缩略图/预览）
  PLUGIN_UPDATE: 'plugin:update', // 插件设置：改名/改文件夹名/类型颜色/类型图标/简易插件增删扩展名
  PLUGIN_PICK_ICON: 'plugin:pickIcon', // 选择类型图标（拷进插件目录后返回路径）
  PLUGIN_DISCARD_ICON: 'plugin:discardIcon', // 丢弃未保存的临时图标（换图/取消时清理）
  PLUGIN_PICK_DIR: 'plugin:pickDir', // 选择文件夹并拷进插件目录（设置项 type:'dir' 用）
  PLUGIN_DELETE_DIR: 'plugin:deleteDir', // 删除插件目录下由本程序拷入的资源文件夹
  PLUGIN_LIST_FILES: 'plugin:listFiles', // 列出插件目录内某文件夹下的候选文件（设置项 type:'file' 用）
  PLUGIN_LOAD_ERRORS: 'plugin:loadErrors', // 最近一次加载失败清单 [{dir, error}]（插件为何「不见了」）
}

/** 主进程 → 渲染进程 的推送事件名 */
const IpcEvents = {
  SCAN_PROGRESS: 'scan:progress', // { taskId, rootId, current, total, message, queued? }
  SCAN_DONE: 'scan:done', // { taskId, rootId, added, updated, removed, durationMs, cancelled? }
  SCAN_ERROR: 'scan:error', // { taskId, message }
  THUMB_PROGRESS: 'thumb:progress', // { taskId, current, total, message, queued? }
  THUMB_DONE: 'thumb:done', // { taskId, total, generated, failed, skipped, durationMs, message, cancelled? }
  THUMB_ERROR: 'thumb:error', // { taskId, message }
  /*
   * 单个素材的预览图被替换/新增（预览窗口的「生成预览图」按钮）。
   * 与 THUMB_DONE 的区别：那个是批量任务的结果，这个是用户在预览窗口里
   * 手动改了**一个**素材，界面要就地把那一张图刷新掉。
   * payload: { path, thumbPath, replaced }
   */
  THUMB_CHANGED: 'thumb:changed',
}

module.exports = { IpcChannels, IpcEvents }
