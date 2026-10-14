/**
 * 测试框架（零依赖）
 *
 * 提供断言、分组、统计与退出码。所有测试文件都用它,保证输出格式一致。
 *
 * 用法：
 *   const { test, run } = require('./_harness')
 *   test('分组名', async (t) => {
 *     t.ok(cond, '断言描述')
 *     t.eq(actual, expected, '断言描述')
 *   })
 */
const results = { passed: 0, failed: 0, skipped: 0, groups: [] }
let currentGroup = null

function test(name, fn) {
  results.groups.push({ name, fn })
}

/** 断言收集器：传给每个 test 回调 */
function makeAsserter(groupName) {
  const t = {
    ok(cond, label, detail = '') {
      if (cond) {
        results.passed++
        console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`)
      } else {
        results.failed++
        console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
      }
      return !!cond
    },
    eq(actual, expected, label) {
      const pass = actual === expected
      return t.ok(pass, label, pass ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    },
    /** 数组长度至少 n */
    atLeast(actual, n, label) {
      const pass = Number(actual) >= n
      return t.ok(pass, label, pass ? `(${actual})` : `期望 >= ${n}，实际 ${actual}`)
    },
    skip(label) {
      results.skipped++
      console.log(`  ○ ${label}（跳过）`)
    },
  }
  return t
}

const tests = [] // 收集到的测试文件运行函数

/** 注册一个测试文件（由 run.js 调用） */
function register(fn) {
  tests.push(fn)
}

async function run() {
  console.log('')
  for (const group of results.groups) {
    console.log(`▸ ${group.name}`)
    currentGroup = group.name
    const t = makeAsserter(group.name)
    try {
      await group.fn(t)
    } catch (err) {
      results.failed++
      console.log(`  ✗ 异常: ${err && err.stack || err}`)
    }
    console.log('')
  }
  const total = results.passed + results.failed
  const ok = results.failed === 0
  console.log('─'.repeat(50))
  console.log(`${ok ? '✓ 全部通过' : '✗ 存在失败'}  ${results.passed}/${total} 通过` +
    (results.skipped ? `，${results.skipped} 跳过` : ''))
  console.log('─'.repeat(50))
  return ok
}

module.exports = { test, register, run, results, getTests: () => tests }
