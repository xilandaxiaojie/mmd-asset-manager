/**
 * 测试入口：一键跑全套
 *
 *   npm test              跑全部
 *   npm test -- asset     只跑名字含 "asset" 的测试文件
 *
 * ── 运行方式 ─────────────────────────────────────────────
 * 每个测试文件在**独立子进程**里用 Electron 跑（主进程环境），
 * 原因是测试要 require 主程序、建窗口、注册 IPC —— 同进程跑多个会互相污染
 * （require 缓存、单例 store、已注册的 protocol handler）。
 * 独立进程还保证某个测试崩了不会带走整轮。
 *
 * ── UI 测试的特殊之处 ─────────────────────────────────────
 * 界面测试必须由主程序自己拉起（它要往运行中的窗口注入断言），
 * 所以 ui.test.js 不是独立进程，而是通过 AMM_UI_TEST=1 让主程序加载它。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const TESTS_DIR = __dirname
const PROJECT = path.join(TESTS_DIR, '..')
const ELECTRON = path.join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 收集测试文件（_ 开头的是工具，不直接跑） */
function collectTests(filter) {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filter || f.includes(filter))
    .sort()
}

/**
 * 需要「主程序自己拉起」的测试。
 *
 * 这类测试要往**运行中的窗口**里注入断言、或要用主程序单例的 store / 协议处理器，
 * 所以不能当普通文件跑 —— 由主程序加载它们，路径经 AMM_UI_TEST 传给 smoke.js。
 *
 *   ui.test.js            界面断言
 *   video-thumb.test.js   视频缩略图（要真实离屏渲染窗口 + 真实视频文件）
 */
const HOSTED_TESTS = ['ui.test.js', 'video-thumb.test.js']

/** 该文件是否由主程序拉起 */
function isHosted(file) {
  return HOSTED_TESTS.includes(file)
}

/** UI 测试：由主程序拉起（设 AMM_UI_TEST） */
async function runUiTest(file) {
  return new Promise((resolve) => {
    // AMM_UI_TEST 传文件名时宿主会加载它，传 '1' 时默认 ui.test.js
    const envName = file === 'ui.test.js' ? '1' : file
    const child = spawn(ELECTRON, [path.join(PROJECT, 'src', 'main', 'index.js')], {
      cwd: PROJECT,
      stdio: 'inherit',
      env: { ...process.env, AMM_UI_TEST: envName, AMM_TEST_MODE: '1' },
      windowsHide: true,
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', (err) => { console.log(`  ✗ 无法启动: ${err.message}`); resolve(false) })
  })
}

/** 普通测试：独立 Electron 进程直接跑测试文件 */
async function runStandalone(file) {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON, [path.join(TESTS_DIR, file)], {
      cwd: PROJECT,
      stdio: 'inherit',
      env: { ...process.env, AMM_TEST: '1' },
      windowsHide: true,
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', (err) => { console.log(`  ✗ 无法启动: ${err.message}`); resolve(false) })
  })
}

async function main() {
  const filter = process.argv[2] || ''
  const files = collectTests(filter)
  if (!files.length) {
    console.log(filter ? `没有匹配 "${filter}" 的测试文件` : 'tests/ 下没有测试文件')
    process.exit(1)
  }

  console.log('')
  console.log('═'.repeat(56))
  console.log(`  素材管理器 · 测试套件（${files.length} 个文件）`)
  console.log('═'.repeat(56))

  const results = []
  for (const f of files) {
    console.log(`\n┌─ ${f} ${'─'.repeat(Math.max(0, 50 - f.length))}`)
    const ui = isHosted(f) // 需要主程序拉起的测试
    const ok = ui ? await runUiTest(f) : await runStandalone(f)
    results.push({ file: f, ok })
    console.log(`└─ ${ok ? '✓ 通过' : '✗ 失败'}`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log('═'.repeat(56))
  if (failed.length) {
    console.log(`  ✗ ${failed.length}/${results.length} 个测试文件失败:`)
    for (const r of failed) console.log(`      ${r.file}`)
    console.log('═'.repeat(56))
    finish(1)
    return
  }
  console.log(`  ✓ 全部 ${results.length} 个测试文件通过`)
  console.log('═'.repeat(56))
  finish(0)
}

/**
 * 退出。
 *
 * 必须用 Electron 的 app.exit 而不是 process.exit：
 * 在 Electron 主进程里 process.exit 的退出码不可靠（实测失败时仍返回 0），
 * 而且它的异步 stdout 缓冲会在退出后继续刷，出现「失败之后又打印全部通过」。
 */
function finish(code) {
  const { app } = require('electron')
  app.exit(code)
}

main()
