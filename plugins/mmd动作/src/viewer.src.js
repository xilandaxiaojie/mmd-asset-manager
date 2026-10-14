/**
 * MMD 动作预览渲染模块（viewer 源码）
 *
 * 由 esbuild 打包成自包含的 `viewer.mjs`（内含 three.js + MMDLoader +
 * MMDAnimationHelper），渲染进程通过 `import('file://…/viewer.mjs')` 加载，
 * 导出工厂：`export default (api) => ({ mount, load, start, stop, resize, snapshot, waitReady, dispose })`
 *
 * ── 三种素材，三种呈现 ──────────────────────────────────
 *   .vmd 动作  → 模型 + 播放动作（MMDAnimationHelper 驱动骨骼）
 *   .vmd 镜头  → 相机按镜头数据运动（不套模型也有意义）
 *   .vpd 姿势  → 模型摆成该姿势后**静止**（VPD 是单帧，不是动画）
 *   .mp3/.wav  → 纯音频播放器（canvas + <audio>，与模型无关）
 *
 * ── 模型从哪来 ─────────────────────────────────────────
 * viewer 没有 Node，只能走 asset://，而 asset:// **不放行 data/**，
 * 所以读不到 plugin-settings.json。解决办法在 index.cjs（主进程侧）：
 * 它把模型路径镜像到插件目录内的 `_runtime/settings.json`，
 * 本模块用 asset:// 读它 —— 插件目录本身是放行的。
 */
import * as THREE from 'three'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const DEFAULT_BG = '#1e1f24'
const ACCENT = '#a78bfa'

/** 绝对路径 → asset:// 协议 URL */
function toAssetUrl(absPath) {
  return 'asset://file/' + encodeURIComponent(absPath)
}

/** 取路径的目录部分（兼容 / 与 \） */
function dirOf(absPath) {
  const i = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
  return i > 0 ? absPath.slice(0, i) : absPath
}

/**
 * 本模块自己的目录（插件目录）。
 *
 * `import.meta.url` 形如 `file:///D:/…/plugins/mmd动作/viewer.mjs`，
 * 去掉最后一段就是插件目录 —— 这样不需要任何外部信息
 * 就能定位到插件目录内的 `_runtime/settings.json`。
 */
function selfDir() {
  try {
    const u = new URL(import.meta.url)
    let p = decodeURIComponent(u.pathname)
    // Windows 上 pathname 形如 `/D:/…`，开头的斜杠要去掉
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return dirOf(p.split('\\').join('/'))
  } catch {
    return ''
  }
}

/** 遍历对象树，收集每个 mesh 的材质数组 */
function eachMaterial(root, fn) {
  root.traverse((obj) => {
    const mat = obj.material
    if (!mat) return
    const list = Array.isArray(mat) ? mat : [mat]
    for (const m of list) fn(m, obj)
  })
}

/** 释放对象树占用的 GPU 资源 */
function disposeObject(root) {
  if (!root) return
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose()
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : []
    for (const m of mats) {
      for (const key of Object.keys(m)) {
        const v = m[key]
        if (v && v.isTexture) v.dispose()
      }
      m.dispose()
    }
  })
}

/**
 * three.js 边界情况：模型没有任何表情（morph）时，MMDLoader 仍会写入
 * `geometry.morphAttributes.position = []`（空数组，但为真值）→ 着色器编译失败，
 * 表现为「模型加载成功但画面全空」。摘掉空的 morph 属性即可。
 */
function dropEmptyMorphAttributes(root) {
  root.traverse((obj) => {
    const geo = obj.geometry
    if (!geo || !geo.morphAttributes) return
    for (const key of Object.keys(geo.morphAttributes)) {
      const list = geo.morphAttributes[key]
      if (Array.isArray(list) && list.length === 0) delete geo.morphAttributes[key]
    }
  })
}

/**
 * MMD 中 diffuse 的 alpha 为 0 表示该部件默认不绘制（裤袜、贴纸等可选部件）。
 * 置 visible=false 而不是设成全透明 —— 透明材质仍会写深度，会挡住后面的部件。
 */
function hideInvisibleMaterials(root) {
  eachMaterial(root, (mat) => {
    if (mat.opacity > 0) return
    mat.visible = false
  })
}

/**
 * 清掉材质的自发光。MMDLoader 把 MMD 的「環境色」映射成 emissive，
 * 而 emissive 不参与光照计算 —— 像一层白雾盖在贴图上（「贴图发白」）。
 */
function clearEmissive(root) {
  eachMaterial(root, (mat) => {
    if (mat.emissive && mat.emissive.getHex() !== 0) mat.emissive.setRGB(0, 0, 0)
  })
}

/** 秒 → mm:ss */
function fmtTime(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n < 0) return '--:--'
  const s = Math.floor(n)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (v) => String(v).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

/** 转义成 HTML 文本（文件名可能含 < & " 等字符） */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * 路径 → 清单文件名（与 index.cjs 里的算法必须完全一致）。
 *
 * 用 SHA-256 是因为素材路径可能很长且含中文，直接当文件名会超长/非法；
 * 哈希后是定长十六进制，作为文件名安全。
 * 两边算法必须一致 —— 改一边就要改另一边（各自文件里都有注释提醒）。
 */
async function hashPathKey(p) {
  const norm = String(p).replace(/\\/g, '/').toLowerCase()
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export default function createViewer(api) {
  const state = {
    container: null,
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    helper: null,
    model: null,
    raf: 0,
    running: false,
    background: DEFAULT_BG,
    onWindowResize: null,
    // 播放状态
    clip: null,
    mixerTime: 0,
    duration: 0,
    playing: false,
    audio: null,
    audioEl: null,
    // 同目录音频候选（由 index.cjs 写好的清单提供）：[{ name, path }]
    audioCandidates: null,
    audioIndex: 0,
    cameraMixer: null,
    mode: '',        // 'motion' | 'camera' | 'pose' | 'audio'
    frameHud: null,
  }

  const manager = new THREE.LoadingManager()
  let pending = 0
  let idleWaiters = []
  const settleIfIdle = () => {
    pending = Math.max(0, pending - 1)
    if (pending === 0) {
      const w = idleWaiters
      idleWaiters = []
      for (const fn of w) fn()
    }
  }
  manager.itemStart = () => { pending++ }
  manager.itemEnd = settleIfIdle
  manager.itemError = settleIfIdle

  const $ = (id) => document.getElementById(id)

  /** 读插件目录内的设置小抄（由 index.cjs 在主进程侧写入） */
  async function readRuntimeSettings() {
    const dir = selfDir()
    if (!dir) return null
    try {
      // 相对插件目录；注意用 / 拼接（asset:// 是 URL）
      const url = toAssetUrl(dir + '/_runtime/settings.json')
      const res = await fetch(url)
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  /** 把插件目录 + 相对路径拼成绝对路径 */
  function resolveInPlugin(rel) {
    const dir = selfDir()
    if (!dir || !rel) return null
    return dir + '/' + String(rel).split('\\').join('/')
  }

  function syncSize() {
    const el = state.canvas
    if (!el || !state.renderer) return { width: 1, height: 1 }
    const width = Math.max(1, Math.round(el.clientWidth || el.width || 1))
    const height = Math.max(1, Math.round(el.clientHeight || el.height || 1))
    state.renderer.setSize(width, height, false)
    if (state.camera) {
      state.camera.aspect = width / height
      state.camera.updateProjectionMatrix()
    }
    return { width, height }
  }

  function renderOnce() {
    if (state.renderer && state.scene && state.camera) {
      state.renderer.render(state.scene, state.camera)
    }
  }

  /** 把相机对准模型（按包围盒自动取景） */
  function frameCamera(root) {
    if (!root || !state.camera) return
    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z) || 1

    state.camera.position.set(center.x, center.y + size.y * 0.12, center.z + maxDim * 1.7)
    state.camera.near = maxDim / 100
    state.camera.far = maxDim * 100
    state.camera.updateProjectionMatrix()

    if (state.controls) {
      state.controls.target.set(center.x, center.y, center.z)
      state.controls.minDistance = maxDim * 0.35
      state.controls.maxDistance = maxDim * 8
      state.controls.update()
    }
  }

  function setStatus(text) {
    const el = $('hud-status')
    if (el) el.textContent = text || ''
  }

  function notifyHost(loaded) {
    const sub = $('host-sub')
    if (sub && loaded) sub.classList.add('loaded')
  }

  /** 更新底部播放信息（时间 / 总长） */
  function updatePlayHud() {
    const cur = $('hud-time')
    if (!cur) return
    cur.textContent = `${fmtTime(state.mixerTime)} / ${fmtTime(state.duration)}`
  }

  /* ── 3D 场景搭建 ─────────────────────────────────────── */

  function buildScene(canvas) {
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
    })
    // 缩略图宿主会指定确切的输出尺寸，此时 pixelRatio 必须是 1
    const fixedOutSize = Number(api && api.thumbSize) > 0
    renderer.setPixelRatio(fixedOutSize ? 1 : Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(new THREE.Color(state.background), 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    state.renderer = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(state.background)
    state.scene = scene

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000)
    camera.position.set(0, 12, 32)
    state.camera = camera

    // 光照对齐 MMD 本体的「環境光」水平（合计 0.5 左右）
    scene.add(new THREE.AmbientLight(0xffffff, 0.25))
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd7dce3, 0.25))
    const key = new THREE.DirectionalLight(0xffffff, 0.85)
    key.position.set(1, 2.4, 3)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.25)
    fill.position.set(-1.6, 1.2, -2.2)
    scene.add(fill)
    const rim = new THREE.DirectionalLight(0xffffff, 0.18)
    rim.position.set(0, 1, -3)
    scene.add(rim)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.09
    controls.rotateSpeed = 0.65
    controls.zoomSpeed = 0.9
    controls.screenSpacePanning = true
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    }
    controls.target.set(0, 10, 0)
    controls.update()
    state.controls = controls

    // MMDAnimationHelper 负责把 VMD 的骨骼/表情轨道驱动到模型上
    state.helper = new MMDAnimationHelper({ sync: false, afterglow: 0 })
  }

  /** 加载模型（.pmx / .pmd） */
  async function loadModel(absPath) {
    const loader = new MMDLoader(manager)
    loader.setResourcePath(toAssetUrl(dirOf(absPath)) + '/')

    const mesh = await new Promise((resolve, reject) => {
      loader.load(
        toAssetUrl(absPath),
        resolve,
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      )
    })

    dropEmptyMorphAttributes(mesh)
    clearEmissive(mesh)
    hideInvisibleMaterials(mesh)

    if (state.model) {
      if (state.helper) state.helper.remove(state.model)
      state.scene.remove(state.model)
      disposeObject(state.model)
    }
    state.model = mesh
    state.scene.add(mesh)
    return mesh
  }

  /* ── 三种加载模式 ────────────────────────────────────── */

  /**
   * 动作数据：模型 + VMD。
   *
   * 用 `helper.add(mesh, { animation, physics: false })` 而不是自己建
   * AnimationMixer —— helper 会正确处理 MMD 骨骼的 IK 与 grant 关系
   * （缺了这步，手臂/腿部会穿模或僵直）。
   */
  async function loadMotion(vmdPath, runtime) {
    state.mode = 'motion'
    const modelAbs = runtime && runtime.modelFile ? resolveInPlugin(runtime.modelFile) : null

    if (!modelAbs) {
      setStatus('尚未指定模型：请在「设置 → 插件管理 → MMD 动作插件 → 插件设置」里选择模型文件夹')
      showHint('未指定模型', '动作数据需要套用模型才能显示。\n\n请到「设置 → 插件管理 → MMD 动作插件」的插件设置里，\n用「浏览…」选择一个模型文件夹（.pmx/.pmd）。')
      return
    }

    setStatus('正在加载模型…')
    const mesh = await loadModel(modelAbs)
    frameCamera(mesh)

    setStatus('正在加载动作…')
    const loader = new MMDLoader(manager)
    loader.setResourcePath(toAssetUrl(dirOf(vmdPath)) + '/')

    const clip = await new Promise((resolve, reject) => {
      loader.loadAnimation(
        toAssetUrl(vmdPath),
        mesh,
        resolve,
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      )
    })

    state.clip = clip
    state.helper.add(mesh, { animation: clip, physics: false })
    state.duration = clip.duration || 0
    state.mixerTime = 0
    // 停在第 0 帧，等用户点「开始」
    state.playing = false
    seekMotion(0)

    /*
     * 自动找同目录下的音频。
     *
     * MMD 的动作和曲子通常放在一起（同一支舞的 .vmd + .mp3），
     * 用户打开动作时基本都希望配上曲子，所以默认就找。
     * 只有一个就直接用，多个则用下拉框让用户挑（默认第一个）。
     */
    await attachSiblingAudio(vmdPath)

    setStatus('')
    notifyHost(true)
    updatePlayHud()
    syncPlayButton()
    showPlaybar(true)
  }

  /**
   * 把动作时间跳到指定秒数，并**立刻把该时刻的姿势应用到模型上**。
   *
   * ── 三个坑 ──────────────────────────────────────────────
   *
   * ① `MMDAnimationHelper` **没有 setTime**（只有 AnimationMixer 有）。
   *    它内部为每个 mesh 各建一个 mixer，存在 `helper.objects` 这个 Map 里。
   *    直接写 `helper.setTime(...)` 会抛 "setTime is not a function"，
   *    被 load() 的 catch 接住后显示成「加载失败」。
   *
   * ② `mixer.setTime(t)` **只改 mixer.time 这个数字**，不碰骨骼 ——
   *    姿势是 AnimationAction 在 `mixer.update(delta)` 里插值写上去的。
   *    只调 setTime 的话模型纹丝不动（实测：拖到 188.7 秒和 0 秒的骨骼
   *    数值完全相同），而 load 之后从没 update 过，于是显示的是
   *    **模型的绑定姿势（T-pose）**，不是动作的第 0 帧。
   *
   * ③ 也不能用 `helper.update(0)` 去「让它算一次」：`_animateMesh` 里是
   *        _restoreBones(mesh); mixer.update(delta); _saveBones(mesh);
   *    delta=0 时 mixer 不推进，写回的仍是绑定姿势。
   *
   * 正确做法：把 mixer 的时间**置零**，再用一个等于目标时间的 delta
   * 走一次 `helper.update(dt)` —— 这样 mixer 从 0 推进 dt，
   * 正好落在目标时刻，且 IK / 表情 / 骨骼保存全都按正常流程走。
   *
   * @param {number} t 目标时间（秒）
   */
  function seekMotion(t) {
    const h = state.helper
    const mesh = state.model
    if (!h || !mesh || !h.objects) return
    try {
      const rec = h.objects.get(mesh)
      if (rec && rec.mixer) rec.mixer.setTime(0)
      // 从 0 推进到 t，让 helper 走一遍完整的姿势计算流程
      if (t > 0) h.update(t)
      else h.update(0.0001) // 目标就是 0 时给一个极小步长，确保姿势被写一次
    } catch {
      // 失败就只保留 state.mixerTime：画面可能没精确跳到该帧，但不影响播放
    }
  }

  /**
   * 找 vmdPath 同目录下的音频文件并挂上。
   *
   * 渲染层没有 fs，同目录有哪些文件只能问主进程 —— 但 viewer 也没有 IPC。
   * 所以走 index.cjs 在 parse 时写好的清单（`_runtime/audio/<哈希>.json`），
   * 里面记着这个 .vmd 同目录下所有音频的文件名。
   * 读不到清单就静默跳过（例如插件刚装上还没扫描过）。
   *
   * @param {string} vmdPath 动作文件绝对路径
   */
  async function attachSiblingAudio(vmdPath) {
    const names = await readSiblingAudioList(vmdPath)
    if (!names || !names.length) return

    // 清单里只有文件名（主进程侧这么写的，见 index.cjs 的 writeSiblingAudioList），
    // 这里和动作文件同目录拼成绝对路径 —— 跨机器/换盘符都不会失效
    const dir = dirOf(vmdPath)
    state.audioCandidates = names.map((n) => ({ name: n, path: dir + '/' + n }))
    // 只有一个 → 默认加载它；多个 → 默认第一个
    state.audioIndex = 0
    await useAudioCandidate(0)
    renderAudioPicker()
  }

  /** 读「同目录音频清单」（由 index.cjs 在主进程侧扫描后写入） */
  async function readSiblingAudioList(vmdPath) {
    const dir = selfDir()
    if (!dir) return null
    try {
      // 主进程侧用的哈希算法，这里复刻一份（见 index.cjs 的 audioListKey）
      const key = await hashPathKey(vmdPath)
      const url = toAssetUrl(dir + '/_runtime/audio/' + key + '.json')
      const res = await fetch(url)
      if (!res.ok) return null
      const j = await res.json()
      // 清单里存的是 [{name}]，这里取文件名数组
      return Array.isArray(j && j.files) ? j.files.map((f) => f && f.name).filter(Boolean) : null
    } catch {
      return null
    }
  }

  /** 用第 idx 个候选作为当前音频 */
  async function useAudioCandidate(idx) {
    const list = state.audioCandidates || []
    const item = list[idx]
    if (!item) return
    state.audioIndex = idx
    const el = state.audioEl
    if (!el) return
    el.src = toAssetUrl(item.path)
    el.load()
    // 与动作对齐：从头开始，保持暂停
    el.currentTime = 0
    el.pause()
  }

  /** 渲染（或刷新）音频选择下拉框 */
  function renderAudioPicker() {
    const wrap = $('motion-audio')
    const sel = $('motion-audio-select')
    const list = state.audioCandidates || []
    if (!wrap || !sel) return
    if (!list.length) { wrap.style.display = 'none'; return }
    wrap.style.display = 'flex'
    sel.innerHTML = list
      .map((a, i) => `<option value="${i}" ${i === state.audioIndex ? 'selected' : ''}>${escHtml(a.name)}</option>`)
      .join('')
  }

  /**
   * 姿势数据：模型 + VPD。
   *
   * VPD 是**单帧姿势**（不是动画），所以用 helper.pose() 一次性摆好，
   * 不建动画轨道、也不自动播放 —— 用户看到的就是这个姿势，可以自由旋转观察。
   */
  async function loadPose(vpdPath, runtime) {
    state.mode = 'pose'
    const modelAbs = runtime && runtime.modelFile ? resolveInPlugin(runtime.modelFile) : null

    if (!modelAbs) {
      setStatus('尚未指定模型：请在插件设置里选择模型文件夹')
      showHint('未指定模型', '姿势数据需要套用模型才能显示。\n\n请到「设置 → 插件管理 → MMD 动作插件」的插件设置里，\n用「浏览…」选择一个模型文件夹。')
      return
    }

    setStatus('正在加载模型…')
    const mesh = await loadModel(modelAbs)

    setStatus('正在套用姿势…')
    const loader = new MMDLoader(manager)
    const vpd = await new Promise((resolve, reject) => {
      loader.loadVPD(
        toAssetUrl(vpdPath),
        true, // isUnicode：现代 VPD 用 Shift-JIS 时这里其实会被 loader 内部的 mimeType 覆盖，失败有兜底
        resolve,
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      )
    })

    state.helper.pose(mesh, vpd, { ik: true, grant: true })
    frameCamera(mesh)

    setStatus('')
    notifyHost(true)
    showPlaybar(false)
    const hint = $('hud-pose-hint')
    if (hint) hint.style.display = 'block'
  }

  /**
   * 镜头数据：相机按 VMD 的相机轨道运动。
   *
   * 镜头数据不驱动骨骼，所以**不套模型也能看** —— 这里建一个空的
   * 相机动画，直接驱动 scene.camera。有模型时顺便加载模型当参照物。
   */
  async function loadCamera(vmdPath, runtime) {
    state.mode = 'camera'
    const modelAbs = runtime && runtime.modelFile ? resolveInPlugin(runtime.modelFile) : null

    // 镜头动画必须有绑定对象才能建轨道；用一个空 Object3D 承载相机轨道
    // 更简单可靠的做法：加载模型（有的话），把相机动画绑到相机自己身上
    if (modelAbs) {
      setStatus('正在加载模型…')
      try {
        const mesh = await loadModel(modelAbs)
        frameCamera(mesh)
      } catch {
        // 模型加载失败不影响镜头播放
      }
    } else {
      // 没有模型也给一个参照物，否则镜头运动看不出来
      const grid = new THREE.GridHelper(20, 20, 0x444a55, 0x2c313a)
      grid.name = '__camera_ref__'
      state.scene.add(grid)
      state.camera.position.set(0, 12, 32)
      state.controls.target.set(0, 10, 0)
      state.controls.update()
    }

    setStatus('正在加载镜头…')
    const loader = new MMDLoader(manager)
    const clip = await new Promise((resolve, reject) => {
      loader.loadAnimation(
        toAssetUrl(vmdPath),
        state.camera, // 把相机动画直接绑到相机对象上
        resolve,
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      )
    })

    state.clip = clip
    state.duration = clip.duration || 0
    state.mixerTime = 0

    /*
     * 镜头动画自己管一个 mixer：不能用 MMDAnimationHelper（它是为骨骼模型设计的）。
     * 轨道名是 '.position'/'.quaternion'，作用对象就是 state.camera。
     */
    state.cameraMixer = new THREE.AnimationMixer(state.camera)
    const action = state.cameraMixer.clipAction(clip)
    action.play()
    // 停在镜头数据的第 0 帧，等用户点「开始」（与动作一致）
    state.playing = false
    state.cameraMixer.setTime(0)
    // 镜头播放时禁用 OrbitControls，否则用户一转视角就和镜头数据打架
    if (state.controls) state.controls.enabled = false

    setStatus('')
    notifyHost(true)
    updatePlayHud()
    syncPlayButton()
    showPlaybar(true)
    const hint = $('hud-camera-hint')
    if (hint) hint.style.display = 'block'
    // 镜头文件旁边往往也放着同一支舞的曲子，一并配上
    await attachSiblingAudio(vmdPath)
  }

  /**
   * 音频：纯播放器，和模型无关。
   *
   * 用原生 <audio>（Chromium 自带 mp3/wav 解码），配一个自绘的波形/进度界面。
   * 之所以不做成「模型 + 音乐」的合并预览：音频素材被双击时用户想要的是
   * 「听一下这段音乐」，而不是被动打开一个 3D 窗口。
   */
  async function loadAudio(audioPath) {
    state.mode = 'audio'
    show3D(false)
    showAudioUi(true)

    const el = state.audioEl
    if (!el) return
    el.src = toAssetUrl(audioPath)
    el.load()

    const title = $('audio-name')
    if (title) {
      const parts = String(audioPath).split(/[\\/]/)
      title.textContent = parts[parts.length - 1] || ''
    }

    await new Promise((resolve) => {
      const done = () => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); resolve() }
      el.addEventListener('loadedmetadata', done)
      el.addEventListener('error', done)
      setTimeout(done, 8000)
    })

    state.duration = Number.isFinite(el.duration) ? el.duration : 0
    setStatus('')
    notifyHost(true)
    updateAudioHud()
    drawWaveform()
    try { await el.play() } catch { /* 自动播放被拒，用户手动点 */ }
  }

  /* ── 音频界面 ────────────────────────────────────────── */

  function show3D(on) {
    if (state.canvas) state.canvas.style.display = on ? 'block' : 'none'
    const el = $('audio-ui')
    if (el) el.style.display = on ? 'none' : 'flex'
    // 配乐选择只属于 3D 动作预览，音频播放器界面里不显示
    if (!on) {
      const ma = $('motion-audio')
      if (ma) ma.style.display = 'none'
    }
  }

  function showAudioUi(on) {
    const el = $('audio-ui')
    if (el) el.style.display = on ? 'flex' : 'none'
    if (state.canvas) state.canvas.style.display = on ? 'none' : 'block'
    if (on) {
      const ma = $('motion-audio')
      if (ma) ma.style.display = 'none'
    }
  }

  function updateAudioHud() {
    const cur = $('audio-time')
    const el = state.audioEl
    if (!cur || !el) return
    cur.textContent = `${fmtTime(el.currentTime)} / ${fmtTime(state.duration)}`
    const bar = $('audio-seek')
    if (bar && state.duration > 0) bar.value = String((el.currentTime / state.duration) * 1000)
  }

  /**
   * 画一个静态波形。
   *
   * 不是真的解析音频 —— 只是按文件名做确定性伪随机，
   * 给个「这里是一段声音」的视觉锚点。真解析要把整个文件解码成
   * PCM（几十 MB）再求包络，为了一个装饰性图形不值得。
   * 用文件名做种子保证同一个文件每次画出来一样，不会闪。
   */
  function drawWaveform() {
    const cv = $('audio-wave')
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = cv.clientWidth || 600
    const h = cv.clientHeight || 120
    cv.width = Math.max(1, Math.round(w * dpr))
    cv.height = Math.max(1, Math.round(h * dpr))
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const name = ($('audio-name') && $('audio-name').textContent) || 'audio'
    let seed = 0
    for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) >>> 0
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed / 4294967296
    }

    const bars = Math.max(24, Math.floor(w / 6))
    const mid = h / 2
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, ACCENT)
    grad.addColorStop(1, '#6d28d9')
    ctx.fillStyle = grad
    for (let i = 0; i < bars; i++) {
      // 两端衰减 + 随机起伏，像真实波形
      const t = i / (bars - 1)
      const env = Math.sin(Math.PI * t) ** 0.6
      const amp = (0.15 + rnd() * 0.85) * env * (h * 0.42)
      const x = (i / bars) * w
      const bw = Math.max(1.5, (w / bars) * 0.6)
      ctx.fillRect(x, mid - amp, bw, amp * 2)
    }
  }

  /** 音频控制条接线（只接一次） */
  function wireAudioControls() {
    const el = state.audioEl
    if (!el || el.__wired) return
    el.__wired = true

    const btn = $('audio-play')
    if (btn) {
      btn.addEventListener('click', async () => {
        if (el.paused) { try { await el.play() } catch {} } else el.pause()
      })
    }
    const restart = $('audio-restart')
    if (restart) {
      restart.addEventListener('click', async () => {
        el.currentTime = 0
        try { await el.play() } catch {}
      })
    }
    const seek = $('audio-seek')
    if (seek) {
      seek.addEventListener('input', () => {
        if (state.duration > 0) el.currentTime = (Number(seek.value) / 1000) * state.duration
      })
    }
    const vol = $('audio-vol')
    if (vol) {
      vol.addEventListener('input', () => { el.volume = Math.max(0, Math.min(1, Number(vol.value) / 100)) })
    }

    const sync = () => {
      if (btn) btn.textContent = el.paused ? '▶' : '❚❚'
      updateAudioHud()
    }
    el.addEventListener('play', sync)
    el.addEventListener('pause', sync)
    el.addEventListener('timeupdate', updateAudioHud)
    el.addEventListener('ended', sync)
    el.addEventListener('loadedmetadata', () => {
      state.duration = Number.isFinite(el.duration) ? el.duration : 0
      updateAudioHud()
    })
  }

  /* ── 播放控制条（3D 模式） ───────────────────────────── */

  function showPlaybar(on) {
    const bar = $('playbar')
    if (bar) bar.style.display = on ? 'flex' : 'none'
  }

  /** 让播放按钮的图标与 state.playing 一致 */
  function syncPlayButton() {
    const btn = $('play-toggle')
    if (btn) btn.textContent = state.playing ? '❚❚' : '▶'
  }

  /**
   * 播放/暂停：动作与音频**一起**动。
   *
   * 两者分开控制会很快错位（用户按暂停只有动作停、曲子继续跑），
   * 所以统一由这个按钮驱动，音频跟着走。
   */
  function setPlaying(on) {
    state.playing = !!on
    const el = state.audioEl
    if (el) {
      if (on) { el.play().catch(() => {}) } else el.pause()
    }
    syncPlayButton()
  }

  function wirePlayControls() {
    const btn = $('play-toggle')
    if (btn && !btn.__wired) {
      btn.__wired = true
      btn.addEventListener('click', () => setPlaying(!state.playing))
    }
    const seek = $('play-seek')
    if (seek && !seek.__wired) {
      seek.__wired = true
      seek.addEventListener('input', () => {
        if (state.duration > 0) {
          state.mixerTime = (Number(seek.value) / 1000) * state.duration
          /*
           * 必须真的把画面跳过去。
           * 之前这里只改了 state.mixerTime —— 数字变了但骨骼没动，
           * 拖动进度条时画面纹丝不动（暂停状态下尤其明显）。
           */
          if (state.mode === 'camera' && state.cameraMixer) state.cameraMixer.setTime(state.mixerTime)
          else seekMotion(state.mixerTime)
          // 拖动进度时音频跟着跳，否则画面和声音对不上
          if (state.audioEl) state.audioEl.currentTime = state.mixerTime
        }
      })
    }
    const restart = $('play-restart')
    if (restart && !restart.__wired) {
      restart.__wired = true
      restart.addEventListener('click', () => {
        state.mixerTime = 0
        seekMotion(0)
        if (state.cameraMixer) state.cameraMixer.setTime(0)
        if (state.audioEl) state.audioEl.currentTime = 0
      })
    }
    // 动作预览的音轨下拉框
    const sel = $('motion-audio-select')
    if (sel && !sel.__wired) {
      sel.__wired = true
      sel.addEventListener('change', async () => {
        const wasPlaying = state.playing
        await useAudioCandidate(Number(sel.value) || 0)
        // 换曲子后如果本来在播，就接着播新的
        if (wasPlaying) { try { await state.audioEl.play() } catch {} }
      })
    }
  }

  /** 显示一个居中的提示块（无模型等） */
  function showHint(title, body) {
    const el = $('viewer-hint')
    if (!el) return
    el.style.display = 'flex'
    const t = $('viewer-hint-title')
    const b = $('viewer-hint-body')
    if (t) t.textContent = title || ''
    if (b) b.textContent = body || ''
  }

  function hideHint() {
    const el = $('viewer-hint')
    if (el) el.style.display = 'none'
  }

  /* ── 主循环 ──────────────────────────────────────────── */

  /*
   * 推进动画。
   *
   * ── 为什么不能每帧固定推进 1/30 ──────────────────────
   * tick 是挂在 requestAnimationFrame 上的（见 start()），也就是**每显示帧调一次**。
   * 而 rAF 的频率取决于显示器：常见 60Hz、游戏本 144Hz、部分 165/240Hz。
   * 早期实现每帧固定推进 1/30 秒，于是：
   *     60Hz  → 每秒推进 60/30 = 2.0 秒的动画（两倍速）
   *     144Hz → 每秒推进 4.8 秒（接近五倍速）
   * 这就是「动作是加速的」的原因 —— 而且不同机器上快慢还不一样。
   *
   * 正确做法是按**真实流逝的时间**推进，与刷新率无关。
   * 单帧步长设上限（0.1s）：窗口被最小化/切走再回来时 rAF 会停一阵，
   * 恢复的那一帧 dt 可能有好几秒，直接推进会让动作瞬移一大段。
   */
  let lastFrameMs = 0

  function tick(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : performance.now()
    // 首帧没有上一帧时间戳，只记录、不推进（否则会用 0 或巨大值推进一次）
    if (!lastFrameMs) { lastFrameMs = now; renderOnce(); return }
    let dt = (now - lastFrameMs) / 1000
    lastFrameMs = now
    if (dt > 0.1) dt = 0.1 // 掉帧/切走回来时不要瞬移
    if (dt < 0) dt = 0

    if (state.playing) {
      if (state.mode === 'camera' && state.cameraMixer) {
        state.cameraMixer.update(dt)
        state.mixerTime += dt
        if (state.duration > 0 && state.mixerTime >= state.duration) {
          state.mixerTime = 0
          state.cameraMixer.setTime(0)
          // 循环回到开头时音频也回到开头，两者才对得上
          if (state.audioEl) state.audioEl.currentTime = 0
        }
      } else if (state.helper) {
        state.helper.update(dt)
        state.mixerTime += dt
        if (state.duration > 0 && state.mixerTime >= state.duration) {
          state.mixerTime = 0
          seekMotion(0)
          if (state.audioEl) state.audioEl.currentTime = 0
        }
      }
      const seek = $('play-seek')
      if (seek && state.duration > 0) seek.value = String((state.mixerTime / state.duration) * 1000)
      updatePlayHud()
    }    if (state.controls && state.controls.enabled) state.controls.update()
    renderOnce()
  }

  return {
    async mount(container) {
      state.container = container || document.body

      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none'
      state.container.appendChild(canvas)
      state.canvas = canvas
      buildScene(canvas)

      // 音频元素（三模式共用一个容器，切换时显示/隐藏）
      // 动作预览也用它放配乐，所以不是「音频模式专属」
      const audioEl = document.createElement('audio')
      audioEl.preload = 'metadata'
      audioEl.style.display = 'none'
      state.container.appendChild(audioEl)
      state.audioEl = audioEl
      wireAudioControls()
      wirePlayControls()

      state.onWindowResize = () => { syncSize(); drawWaveform() }
      window.addEventListener('resize', state.onWindowResize)

      syncSize()
      renderOnce()
    },

    /** 通用契约名 load() —— 按扩展名分派到三种模式 */
    async load(filePath, opts = {}) {
      const isThumb = !!(opts && opts.thumbnail)
      hideHint()
      const ext = String(filePath).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''

      /*
       * 上一个素材的播放状态不能留给下一个 —— 否则「上个动作在播」
       * 会让新打开的动作一进来就动，与「停在第 0 帧」的约定不符。
       * 音频也要停掉并清空，免得换了动作还在放上一首曲子。
       */
      state.playing = false
      state.mixerTime = 0
      state.audioCandidates = null
      state.audioIndex = 0
      if (state.audioEl) {
        state.audioEl.pause()
        state.audioEl.removeAttribute('src')
        state.audioEl.load()
      }
      syncPlayButton()

      try {
        // 缩略图宿主不支持这些类型（canThumbnail: false），到这里直接返回
        if (isThumb) return

        if (ext === '.mp3' || ext === '.wav') {
          await loadAudio(filePath)
          return
        }

        const runtime = await readRuntimeSettings()

        if (ext === '.vpd') {
          await loadPose(filePath, runtime)
          return
        }

        /*
         * .vmd 可能是动作也可能是镜头。viewer 这边没有主进程的解析结果，
         * 所以自己读头部判断 —— 读法必须和 index.cjs 保持一致。
         */
        const kind = await detectVmdKind(filePath)
        if (kind === 'camera') await loadCamera(filePath, runtime)
        else await loadMotion(filePath, runtime)
      } catch (err) {
        const msg = String((err && err.message) || err)
        setStatus('')
        showHint('加载失败', msg)
      }
    },

    async start() {
      if (state.running) return
      state.running = true
      // rAF 回调自带时间戳，直接透传给 tick —— 比在 tick 里再取一次 performance.now()
      // 更准（那是回调真正执行的时刻，与浏览器给的帧时刻可能差几毫秒）
      const loop = (ts) => {
        if (!state.running) return
        state.raf = requestAnimationFrame(loop)
        tick(ts)
      }
      loop()
      /*
       * 不在这里自动播放（用户要求：刚打开时停在第 0 帧，点开始才动）。
       * 由 load 流程决定初始状态 —— 见 loadMotion / loadCamera / loadAudio。
       */
    },

    stop() {
      state.running = false
      if (state.raf) cancelAnimationFrame(state.raf)
      state.raf = 0
    },

    resize() {
      syncSize()
      drawWaveform()
      return true
    },

    setBackground(color) {
      state.background = color || DEFAULT_BG
      if (state.scene) state.scene.background = new THREE.Color(state.background)
      if (state.renderer) state.renderer.setClearColor(new THREE.Color(state.background), 1)
      renderOnce()
    },

    async snapshot() {
      if (state.mode === 'audio') throw new Error('音频素材不支持生成预览图')
      syncSize()
      renderOnce()
      return state.renderer.domElement.toDataURL('image/png')
    },

    async waitReady(timeoutMs = 8000) {
      if (pending === 0) return
      await new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, timeoutMs)
        idleWaiters.push(finish)
      })
    },

    dispose() {
      this.stop()
      if (state.onWindowResize) window.removeEventListener('resize', state.onWindowResize)
      if (state.audioEl) {
        try { state.audioEl.pause() } catch {}
        state.audioEl.src = ''
      }
      if (state.helper && state.model) {
        try { state.helper.remove(state.model) } catch {}
      }
      if (state.model && state.scene) {
        state.scene.remove(state.model)
        disposeObject(state.model)
        state.model = null
      }
      if (state.controls) state.controls.dispose()
      if (state.renderer) state.renderer.dispose()
      if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas)
      if (state.audioEl && state.audioEl.parentNode) state.audioEl.parentNode.removeChild(state.audioEl)
      state.canvas = null
      state.audioEl = null
    },
  }
}

/**
 * 读 VMD 头部判断是动作还是镜头。
 *
 * 必须与 index.cjs 里的 readVmdHeader 用同一套布局（见那边的注释）：
 *   0..30   签名
 *   30..50  模型名
 *   50      骨骼帧数 u32
 *   之后    骨骼帧 × 111 → 表情帧数 u32 → 表情帧 × 23 → 相机帧数 u32
 */
async function detectVmdKind(filePath) {
  try {
    const res = await fetch(toAssetUrl(filePath), { headers: { Range: 'bytes=0-4095' } })
    if (!res.ok && res.status !== 206) return 'motion'
    const buf = await res.arrayBuffer()
    const dv = new DataView(buf)
    if (dv.byteLength < 54) return 'motion'
    const boneFrames = dv.getUint32(50, true)
    if (boneFrames === 0) return 'camera'
    return 'motion'
  } catch {
    return 'motion'
  }
}
