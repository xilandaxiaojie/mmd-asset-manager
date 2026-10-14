# 测试

零依赖,用项目自带的 Electron 跑。

## 运行

```cmd
test.cmd              跑全部
test.cmd asset        只跑文件名含 "asset" 的测试
```

装了 npm 也可以用 `npm test`(等价)。

退出码 0 = 全部通过,1 = 有失败。

## 测试文件

| 文件 | 覆盖内容 |
|---|---|
| `asset.test.js` | `asset://` 协议的路径归属校验(拒绝库外/同前缀/`..`穿越/系统文件;允许库内素材、未索引纹理、插件目录) |
| `folder-sort.test.js` | 每文件夹排序记录(相对路径键、键拼接不歧义、删/改名后的记录迁移与清理、多实例不串味) |
| `icon.test.js` | 插件图标「选择即拷入插件目录」流程(拷入 → 预览 → 保存定稿 / 放弃清理;防目录穿越) |
| `renderhost.test.js` | 渲染宿主契约(空容器、`load()`/`waitReady()`、中性全局名、缩略图输出尺寸) |
| `pluginguard.test.js` | 插件调用兜底(异常隔离、超时放弃等待、返回值保留、非对象返回值拒绝) |
| `thumb.test.js` | 缩略图命名(`<素材文件名>.preview.<图片扩展名>`；同主名不同扩展名不撞车；只认 `.preview.` 命名) |
| `ui.test.js` | 界面端到端(素材索引、网格/列表、详情、搜索、文件夹视图、面包屑、设置页、右键菜单、双击行为、目录树定位与展开、深层目录可读性) |
| `video.test.js` | 视频插件(声明/parse/边界；`asset://` 的 Range 语义：206·416·200) |
| `video-thumb.test.js` | 视频抽帧生成缩略图(走真实离屏渲染管线；产物尺寸按档位缩放) |

## 设计要点

**每个测试文件跑在独立 Electron 子进程里。** 测试要 require 主程序、建窗口、
注册 IPC —— 同进程跑多个会互相污染(require 缓存、单例 store、已注册的
protocol handler)。独立进程还保证某个测试崩了不会带走整轮。

**`ui.test.js` / `video-thumb.test.js` 是例外**:它们必须由主程序自己拉起
(要往运行中的窗口注入断言、用主程序的单例 store 和离屏渲染宿主),
所以通过 `AMM_UI_TEST=<文件名>` 让主程序加载,而不是独立进程直接跑。
需要这样跑的测试列在 `run.js` 的 `HOSTED_TESTS` 里。

**全部测试都在系统临时目录里造环境**,绝不碰用户的真实素材库和插件目录。

**视频测试不依赖外部素材**:样本是内嵌在 `_sample-webm.json` 里的
一段极小 VP8 WebM(用 Chromium 自己的 MediaRecorder 录出来的,
所以一定能被同一个 Chromium 解码)。

## 环境变量

| 变量 | 作用 |
|---|---|
| `AMM_TEST_MODE=1` | 把数据目录、userData、plugins 目录指向临时沙箱 |
| `AMM_UI_TEST=1` | 在沙箱基础上,窗口就绪后加载 `ui.test.js` 跑界面断言 |
| `AMM_UI_TEST=<文件>` | 改加载指定的测试文件(供 `video-thumb.test.js` 等「由主程序拉起」的测试用) |
| `AMM_DATA_DIR=<路径>` | 直接指定数据目录(主程序本身就支持的覆盖入口) |
| `UI_SMOKE_SHOT=<png路径>` | UI 测试结束时截图存盘(人工确认界面用) |

> 早期版本把「隔离环境」和「跑界面测试」合在一个 `UI_SMOKE` 变量里,
> 导致任何设了该变量的测试都会意外触发界面测试。现已拆成两个变量。

## 目录约定

- `_harness.js` — 断言、分组、统计(被各测试文件 import)
- `_util.js` — 临时环境、素材库、插件生成等公共工具
- `run.js` — 入口,收集 `*.test.js` 并逐个拉起
- `*.test.js` — 测试文件

`src/main/smoke.js` 只负责**环境准备**(隔离目录 + 建窗口),不含任何断言 ——
这样生产代码里不会出现示例素材名或具体文件类型。

## 加新测试

```js
// tests/mytest.test.js
const { test, run } = require('./_harness')
const U = require('./_util')

U.isolateEnv()               // 必须在 require 主程序之前
require('../src/main/index.js')

const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  await U.sleep(4000)         // 等主程序建好窗口
  const win = BrowserWindow.getAllWindows()[0]

  test('我的分组', async (t) => {
    t.ok(cond, '断言描述')
    t.eq(actual, expected, '断言描述')
  })

  const ok = await run()
  await U.finish(ok ? 0 : 1)
})
```

注意:
- `U.finish()` 而不是 `app.exit()` —— 它会先等异步写入落盘再清理临时目录
- 退出必须用 Electron 的 `app.exit`,不要用 `process.exit`(在主进程里退出码不可靠)
