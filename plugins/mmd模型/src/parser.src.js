/**
 * PMX / PMD 解析器（主进程侧使用的打包入口）
 *
 * 复用 three.js 内置的 mmd-parser（MIT），由 esbuild 打包成 CommonJS 的 `parser.cjs`，
 * 供插件入口 index.cjs 在主进程 require。这样插件目录无需携带 node_modules。
 *
 * mmd-parser 会完整解析模型（顶点/面/材质/骨骼/表情…），
 * 返回 { metadata, vertices, faces, materials, bones, morphs, textures, ... }。
 * 注意：解析失败时它抛出的是**字符串**而非 Error，调用方需自行包装。
 */
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js'

const parser = new MMDParser.Parser()

/**
 * @param {ArrayBuffer} arrayBuffer 模型文件内容
 * @param {string} ext 扩展名（.pmx / .pmd），其它值按 PMX 处理
 * @returns {Object} mmd-parser 的解析结果
 */
export function parseModel(arrayBuffer, ext) {
  const e = String(ext || '').toLowerCase()
  return e === '.pmd' ? parser.parsePmd(arrayBuffer, true) : parser.parsePmx(arrayBuffer, true)
}
