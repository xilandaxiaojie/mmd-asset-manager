/**
 * 自动化测试的环境夹具（开发 / CI 专用，不参与正常启动）
 *
 * ── 这个文件只做「环境准备」，不含任何断言 ──────────────────
 * 断言逻辑全部在 tests/ 目录里。
 *
 * ── 两个独立的环境变量（职责分离）────────────────────────────
 *   AMM_TEST_MODE=1  把 userData / 数据目录 / plugins 目录指向临时沙箱。
 *                    任何测试进程都该开它 —— 防止污染真实数据。
 *   AMM_UI_TEST=1    在沙箱基础上，窗口就绪后加载 tests/ui.test.js 跑界面断言。
 *                    只有 UI 测试需要它；其他测试（如协议、插件）不该被牵连。
 *
 * 早期版本把这两件事合在一个 UI_SMOKE 变量里，导致任何设了该变量的测试
 * 都会意外触发 UI 测试。分开后每个测试只做自己声明的事。
 *
 * ── 启动冒烟 ──────────────────────────────────────────────
 *   electron . --smoke-test —— 页面加载成功即打印 SMOKE_OK 退出
 *
 * 正常启动（双击 start-app.cmd / npm start）不会走到本模块的任何分支。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app } = require('electron')

/** 是否处于测试沙箱模式（隔离数据目录与插件目录） */
function isTestMode() {
  return !!process.env.AMM_TEST_MODE
}

/** 是否要跑 UI 测试（窗口就绪后交给 tests/ui.test.js） */
function isUiSmoke() {
  return !!process.env.AMM_UI_TEST
}

/**
 * UI 测试入口文件。
 *
 * 默认 tests/ui.test.js；设 AMM_UI_TEST=<相对路径> 可指向别的测试文件，
 * 这样同一个宿主能给多个「需要真实窗口 + store 实例」的测试复用
 * （例如协议层验证），不必各自再写一份启动夹具。
 */
function uiTestFile() {
  const name = process.env.AMM_UI_TEST
  const rel = name && name !== '1' ? name : 'ui.test.js'
  // 只允许 tests/ 下的文件名，防止环境变量把测试指向任意路径
  const safe = path.basename(rel)
  return path.join(__dirname, '..', '..', 'tests', safe)
}

/** 是否处于启动冒烟模式（命令行参数触发） */
function isStartupSmoke() {
  return process.argv.includes('--smoke-test')
}

/**
 * 测试模式：把 userData 重定向到临时目录，避免污染真实数据。
 * 必须在 app ready 之前调用。
 */
function isolateUserData() {
  app.setPath('userData', path.join(app.getPath('temp'), `amm-test-userdata-${Date.now()}`))
}

/**
 * 测试模式：把**数据目录**也指向独立沙箱。
 *
 * 必须在 index.js 求值 DATA_DIR 之前调用 —— 否则测试会往用户的真实素材库里
 * 添加临时根、写脏 settings.json。实现方式是设 AMM_DATA_DIR 环境变量
 * （主程序本来就支持的覆盖入口，不是给测试开的后门）。
 */
function isolateDataDir() {
  if (!process.env.AMM_DATA_DIR) {
    process.env.AMM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-test-data-'))
  }
}

/** 测试模式使用的临时 plugins 目录（避免往真实插件目录里写测试插件） */
function smokePluginsDir() {
  return path.join(app.getPath('temp'), `amm-test-plugins-${Date.now()}`)
}

/**
 * 启动冒烟：页面加载完成 → 打印信号 → 退出。
 * @param {import('electron').BrowserWindow} win 主窗口
 */
function attachStartupSmoke(win) {
  win.webContents.once('did-finish-load', () => {
    console.log('SMOKE_OK window-loaded')
    setTimeout(() => app.quit(), 800)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('SMOKE_FAIL', code, desc)
    app.exit(1)
  })
}

/**
 * 测试模式：窗口就绪后把控制权交给 tests/ui.test.js。
 *
 * 测试文件不存在时直接报错退出 —— 静默跳过会让人以为「测试通过了」。
 *
 * @param {import('electron').BrowserWindow} win 主窗口
 * @param {string} pluginsDir 本次测试使用的 plugins 目录
 * @param {Object} store 主程序的 Store 实例（测试要往它里面加临时素材库）
 */
function attachUiSmoke(win, pluginsDir, store) {
  win.webContents.on('console-message', (_e, level, msg) => {
    console.log('RENDERER_CONSOLE [' + level + '] ' + msg)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const testFile = uiTestFile()
      if (!fs.existsSync(testFile)) {
        console.error('[test] 找不到测试文件:', testFile)
        app.exit(1)
        return
      }
      try {
        const runUiTests = require(testFile)
        await runUiTests({ win, pluginsDir, store })
      } catch (err) {
        console.error('[test] UI 测试异常:', (err && err.stack) || err)
        app.exit(1)
      }
    }, 1200)
  })
}

module.exports = {
  isTestMode,
  isUiSmoke,
  uiTestFile,
  isStartupSmoke,
  isolateUserData,
  isolateDataDir,
  smokePluginsDir,
  attachStartupSmoke,
  attachUiSmoke,
}
