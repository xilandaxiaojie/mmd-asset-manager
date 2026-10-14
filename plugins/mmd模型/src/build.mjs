/**
 * 构建脚本：把 src/ 下的源码打包成插件目录内的自包含单文件。
 *
 *   viewer.src.js  →  ../viewer.mjs  （ESM，含 three.js + MMDLoader，供渲染进程动态 import）
 *   parser.src.js  →  ../parser.cjs  （CommonJS，含 mmd-parser，供主进程 require）
 *
 * 用法（依赖装在插件目录之外，插件目录保持干净、无 node_modules）：
 *   npm i three@0.170.0 esbuild
 *   node build.mjs <node_modules 的绝对路径>
 *
 * 说明：脚本用 createRequire 锚定到传入的 node_modules，因此可以放在插件目录内运行。
 * three 版本固定 0.170.0：MMDLoader 在 r172 起被移除，换版本前请先确认其仍在。
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // plugins/mmd/src
const OUT = path.resolve(HERE, '..') // plugins/mmd

const nodeModules = process.argv[2] ? path.resolve(process.argv[2]) : null
const anchor = path.join(nodeModules || path.resolve(HERE, '..'), '__build__.js')
const require = createRequire(anchor)
const esbuild = require('esbuild')

const shared = {
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  nodePaths: nodeModules ? [nodeModules] : undefined,
}

await esbuild.build({
  ...shared,
  entryPoints: [path.join(HERE, 'viewer.src.js')],
  format: 'esm',
  outfile: path.join(OUT, 'viewer.mjs'),
})

await esbuild.build({
  ...shared,
  entryPoints: [path.join(HERE, 'parser.src.js')],
  format: 'cjs',
  outfile: path.join(OUT, 'parser.cjs'),
})
