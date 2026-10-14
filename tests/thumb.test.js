/**
 * 缩略图命名测试
 *
 * 缩略图 = 素材同目录、名为 `<素材文件名>.preview.<图片扩展名>` 的图片。
 * 例如 `a.blend` → `a.blend.preview.png`。
 *
 * 命名里有两层信息：
 *   • 保留素材完整扩展名 → `a.blend` 与 `a.pmx` 各自独立，不共用一张图
 *   • `.preview.` 标记    → 「哪些文件是缩略图」一目了然；
 *                           「清除缩略图」只删这一类，绝不碰用户自己的图片
 *
 * 本测试锁定这两条规则。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test, run } = require('./_harness')

const T = require(path.join(__dirname, '..', 'src', 'main', 'thumbs.js'))

/** 造一个临时目录，写入给定文件 */
function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-thumb-'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

test('命名：生成路径 = <素材文件名>.preview.png', async (t) => {
  const dir = makeDir({ 'a.blend': 'x', 'b.pmx': 'x' })
  t.eq(path.basename(T.thumbOutPathFor(path.join(dir, 'a.blend'))), 'a.blend.preview.png', 'a.blend → a.blend.preview.png')
  t.eq(path.basename(T.thumbOutPathFor(path.join(dir, 'b.pmx'))), 'b.pmx.preview.png', 'b.pmx → b.pmx.preview.png')
  t.eq(path.basename(T.thumbOutPathFor(path.join(dir, 'x.tar.gz'))), 'x.tar.gz.preview.png', '多段扩展名完整保留')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('查找：只认带 .preview. 的命名', async (t) => {
  const dir = makeDir({
    'a.blend': 'x',
    'a.blend.preview.png': 'preview-img',
    'a.blend.png': 'user-img', // 用户自己命名的，不该被当缩略图
  })
  const found = T.findSiblingImage(path.join(dir, 'a.blend'))
  t.ok(!!found, '找到缩略图')
  t.eq(path.basename(found), 'a.blend.preview.png', '取的是 .preview 命名的那个，不是用户图片')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('查找：没有 .preview 文件时返回 null', async (t) => {
  const dir = makeDir({ 'a.blend': 'x', 'a.blend.png': 'user-img' })
  t.eq(T.findSiblingImage(path.join(dir, 'a.blend')), null, '用户的 a.blend.png 不算缩略图')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('查找：同主名不同扩展名各自独立（撞名回归）', async (t) => {
  const dir = makeDir({
    'a.blend': 'x', 'a.pmx': 'x',
    'a.blend.preview.png': 'blend-img', 'a.pmx.preview.png': 'pmx-img',
  })
  const forBlend = T.findSiblingImage(path.join(dir, 'a.blend'))
  const forPmx = T.findSiblingImage(path.join(dir, 'a.pmx'))
  t.eq(path.basename(forBlend), 'a.blend.preview.png', 'a.blend 用自己的缩略图')
  t.eq(path.basename(forPmx), 'a.pmx.preview.png', 'a.pmx 用自己的缩略图')
  t.ok(forBlend !== forPmx, '两者不是同一张图（核心）')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('查找：多候选扩展名时按 png 优先', async (t) => {
  const dir = makeDir({ 'a.blend': 'x', 'a.blend.preview.jpg': 'j', 'a.blend.preview.png': 'p' })
  t.eq(path.basename(T.findSiblingImage(path.join(dir, 'a.blend'))), 'a.blend.preview.png', 'png 优先于 jpg')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('查找：文件名本身含点也能正确匹配', async (t) => {
  const dir = makeDir({ 'my.file.blend': 'x', 'my.file.blend.preview.png': 'img' })
  const found = T.findSiblingImage(path.join(dir, 'my.file.blend'))
  t.eq(path.basename(found), 'my.file.blend.preview.png', '多段文件名不误判')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('isPreviewFile：判定依据就是文件名里的 .preview.', async (t) => {
  t.eq(T.isPreviewFile('C:\\lib\\a.blend.preview.png'), true, '带 .preview. → 是缩略图')
  t.eq(T.isPreviewFile('C:\\lib\\a.pmx.preview.jpg'), true, '其它图片格式同样识别')
  t.eq(T.isPreviewFile('C:\\lib\\a.blend.png'), false, '用户命名的图片 → 不是缩略图')
  t.eq(T.isPreviewFile('C:\\lib\\a.blend'), false, '素材本身 → 不是缩略图')
  t.eq(T.isPreviewFile(''), false, '空路径安全')
  t.eq(T.isPreviewFile(null), false, 'null 安全')
})

test('resolveThumbnail：有缩略图 → image', async (t) => {
  const dir = makeDir({ 'a.blend': 'x', 'a.blend.preview.png': 'img' })
  const r = T.resolveThumbnail({ path: path.join(dir, 'a.blend'), mtime: 1, thumbPath: null })
  t.eq(r.type, 'image', '识别为图片')
  t.eq(path.basename(r.path), 'a.blend.preview.png', '路径指向缩略图')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveThumbnail：索引缓存失效时回退磁盘查找', async (t) => {
  const dir = makeDir({ 'a.blend': 'x', 'a.blend.preview.png': 'img' })
  const r = T.resolveThumbnail({
    path: path.join(dir, 'a.blend'), mtime: 1,
    thumbPath: path.join(dir, '已不存在.png'),
  })
  t.eq(r.type, 'image', '缓存指向的文件没了，仍能找到真的缩略图')
  t.eq(path.basename(r.path), 'a.blend.preview.png', '回退到磁盘查找')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveThumbnail：没有缩略图 → placeholder', async (t) => {
  const dir = makeDir({ 'c.blend': 'x' })
  const r = T.resolveThumbnail({ path: path.join(dir, 'c.blend'), mtime: 1, thumbPath: null })
  t.eq(r.type, 'placeholder', '回退占位')
  t.eq(r.ext, '.blend', '带上扩展名供取色')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveThumbnail：用户的同名图片不会被当缩略图', async (t) => {
  const dir = makeDir({ 'a.blend': 'x', 'a.blend.png': 'user-img' })
  const r = T.resolveThumbnail({ path: path.join(dir, 'a.blend'), mtime: 1, thumbPath: null })
  t.eq(r.type, 'placeholder', '用户图片不参与显示，回退占位')
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 调度入口（CJS 无顶层 await，必须包一层 async） */
async function main() {
  const ok = await run()
  process.exit(ok ? 0 : 1)
}

main()
