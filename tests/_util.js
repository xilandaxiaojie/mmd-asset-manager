/**
 * 测试公共工具：临时环境、素材库、插件、应用启动
 *
 * 所有测试都在**系统临时目录**里造环境，绝不碰用户的真实素材库和插件目录。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROJECT_ROOT = path.join(__dirname, '..')

/** 建一个临时目录，进程退出时自动清理 */
function tmpDir(prefix = 'amm-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  pending.push(d)
  return d
}

const pending = []
function cleanupAll() {
  for (const d of pending.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 收尾：先让主进程把异步写入（索引落盘等）跑完，再删临时目录。
 *
 * 直接 cleanup + exit 会在 store 还在写索引时把目录删掉，
 * 产生 `saveIndex 失败: ENOENT` 这类噪声（不影响断言，但会让输出看起来像出错）。
 */
async function finish(code) {
  await sleep(800)
  cleanupAll()
  require('electron').app.exit(code)
}

/**
 * 把当前进程切换到隔离环境（必须在 require 主程序**之前**调用）。
 *
 *   • AMM_DATA_DIR   → 临时数据目录（设置/索引不落到项目里）
 *   • AMM_TEST_MODE=1 → 主程序用临时 plugins 目录、userData 也隔离
 *
 * 注意：不要设 AMM_UI_TEST，那是「跑界面测试」的开关，
 * 设了会让任何测试都意外触发 UI 测试。
 *
 * @returns {{ dataDir: string }} 供测试读取的路径
 */
function isolateEnv() {
  const dataDir = tmpDir('amm-data-')
  process.env.AMM_DATA_DIR = dataDir
  process.env.AMM_TEST_MODE = '1'
  // 防御：若外部环境残留了 UI 测试开关，清掉，避免主程序去跑 ui.test.js
  delete process.env.AMM_UI_TEST
  return { dataDir }
}

/** 建一个素材库目录，返回路径（contents 为文件名 → 内容） */
function makeLibrary(contents) {
  const dir = tmpDir('amm-lib-')
  for (const [name, content] of Object.entries(contents)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

/** 1x1 透明 PNG（做缩略图/图片素材用） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** 测试插件源码（自包含，声明指定的扩展名与能力） */
function pluginSource({ id, name, exts, canThumbnail = false, canPreview = false }) {
  return `/**
 * 测试插件（由测试临时生成，用完即删）
 */
module.exports = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  version: '1.0.0',
  exts: ${JSON.stringify(exts)},
  kind: { key: ${JSON.stringify(id)}, label: ${JSON.stringify(name)}, color: '#6366f1' },
  canThumbnail: ${canThumbnail},
  canPreview: ${canPreview},
  viewer: null,
  previewHtml: null,
  parse: async () => ({ author: 'test', 来源: 'automated' }),
  detail: {
    fields: [
      { key: 'author', label: '作者', type: 'text' },
      { key: '来源', label: '来源', type: 'badge' },
    ],
    showMeta: true,
  },
  settings: [],
}
`
}

/** 等待条件成立（轮询），超时返回 false */
async function waitFor(fn, { timeout = 10000, interval = 100 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(interval)
  }
  return false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = {
  PROJECT_ROOT,
  tmpDir,
  cleanupAll,
  finish,
  isolateEnv,
  makeLibrary,
  TINY_PNG,
  pluginSource,
  waitFor,
  sleep,
}
