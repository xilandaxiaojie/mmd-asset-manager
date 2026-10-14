/**
 * MMD 模型查看器（viewer 模块源码）
 *
 * 由 esbuild 打包成自包含的 `viewer.mjs`（内含 three.js + MMDLoader），
 * 渲染进程通过 `import('file://…/viewer.mjs')` 动态加载，导出工厂：
 *
 *   export default (api) => ({ mount, load, start, stop, resize,
 *                              setBackground, snapshot, waitReady, dispose })
 *
 * ── 与宿主的约定（通用宿主，非 MMD 专用）─────────────────────────
 * 主程序只提供**窗口框架**：一个撑满窗口的空容器（api.container）+ API。
 * 容器里放什么由插件决定 —— 本插件自行创建 <canvas> 塞进容器；
 * 音视频类插件会在同一个容器里放 <video>/<audio>，互不影响。
 *
 * 读取本地文件的方式：渲染进程没有 fs 权限，统一走主程序已注册的 `asset://` 协议
 *   - 模型文件：asset://file/<encodeURIComponent(绝对路径)>
 *   - 纹理    ：以模型所在目录为 resourcePath，MMDLoader 自行拼接纹理相对路径
 *
 * ── 为什么这里不再自带 XHR 加载器 ────────────────────────────────
 * 早期版本主程序注册 asset:// 时没有开启 supportFetchAPI，导致 three.js 的
 * FileLoader（内部用 fetch）读不到本地文件，本插件只好自带 XhrFileLoader /
 * XhrTGALoader 顶替（模型文件与 .tga 面部贴图各一个）。
 *
 * 主程序后来把 asset:// 登记为特权协议（standard + secure + supportFetchAPI + stream）
 * 并实现了 Range 响应，fetch 已能正常读取，这些兜底类因此全部删除。
 * 现在模型与贴图都走 three.js 原生加载路径，没有自定义分支。
 */
import * as THREE from 'three'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const DEFAULT_BG = '#1e1f24'

/** 绝对路径 → asset:// 协议 URL */
function toAssetUrl(absPath) {
  return 'asset://file/' + encodeURIComponent(absPath)
}

/** 取路径的目录部分（兼容 / 与 \） */
function dirOf(absPath) {
  const i = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
  return i > 0 ? absPath.slice(0, i) : absPath
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
 * `geometry.morphAttributes.position = []`（空数组，但为真值）。
 * 于是 WebGLProgram 定义了 USE_MORPHTARGETS，却因为 morphTargetsCount === 0
 * 不定义 MORPHTARGETS_COUNT / MORPHTARGETS_TEXTURE_STRIDE —— 顶点着色器编译失败，
 * 表现为「模型加载成功但画面全空」（控制台报 drawElements: no valid shader program）。
 * 这里把空的 morph 属性摘掉，让 three 走正常的非 morph 分支。
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
 * MMD 中 diffuse 的 alpha 为 0 表示该部件默认不绘制。
 * 模型作者大量用它做「按材质 morph 才显形」的可选部件（裤袜、贴纸、纹身等），
 * 素材库里这类材质占比很高，不处理就会「多出一堆本该藏起来的部件」。
 * MMD 自身对 alpha=0 的材质是完全不绘制（不写颜色也不写深度），
 * 所以置 visible=false 而不是设成全透明 —— 透明材质仍会写深度，会挡住后面的部件。
 */
function hideInvisibleMaterials(root) {
  eachMaterial(root, (mat) => {
    if (mat.opacity > 0) return
    mat.visible = false
  })
}

/**
 * 清掉材质的自发光。three 的 MMDLoader 把 MMD 材质的「環境色」直接映射成 emissive，
 * 而 emissive 是自发光、不参与光照计算 —— 像一层恒定白雾盖在贴图上（表现为「贴图发白」）。
 * 清零后把環境色的职责交还给场景里的 AmbientLight / HemisphereLight。
 */
function clearEmissive(root) {
  eachMaterial(root, (mat) => {
    if (mat.emissive && mat.emissive.getHex() !== 0) mat.emissive.setRGB(0, 0, 0)
  })
}

export default function createViewer(api) {
  const state = {
    container: null, // 主程序给的内容容器（空元素，内部元素由本插件创建）
    canvas: null, // 本插件自建的渲染画布
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    model: null,
    raf: 0,
    running: false,
    background: DEFAULT_BG,
    onWindowResize: null,
  }

  // 自己管一个 LoadingManager：MMDLoader 的 onLoad 在「模型结构解析完」时就触发，
  // 此时贴图仍在异步加载中。waitReady() 依赖它判断「真的都好了」。
  const manager = new THREE.LoadingManager()
  let pending = 0
  let idleWaiters = []
  const settleIfIdle = () => {
    pending = Math.max(0, pending - 1)
    if (pending === 0) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const fn of waiters) fn()
    }
  }
  manager.itemStart = () => { pending++ }
  manager.itemEnd = settleIfIdle
  manager.itemError = settleIfIdle // 失败也要递减，否则等待永不结束

  // .tga 贴图（MMD 模型的面部贴图普遍是 .tga）现在走 MMDLoader 的原生分支：
  // 它内部会按扩展名兜底到 TGALoader，而 TGALoader 用的 FileLoader 已经能读 asset://
  // （主程序开启了 supportFetchAPI）。早期为绕开这一点注册的 XHR handler 已删除。

  /**
   * 按渲染画布的 CSS 尺寸同步渲染器与相机。
   *
   * 注意：宿主给的 `container` 是**空容器元素**（不保证是 canvas）——
   * 主程序已通用化，视频/音频插件会往同一位置放 <video>/<audio>。
   * 所以本插件在 mount() 里自行创建 <canvas> 并塞进容器，
   * 这里同步的是**自己创建的那块画布**。
   */
  function syncSize() {
    const el = state.canvas
    if (!el || !state.renderer) return { width: 1, height: 1 }
    const width = Math.max(1, Math.round(el.clientWidth || el.width || 1))
    const height = Math.max(1, Math.round(el.clientHeight || el.height || 1))
    state.renderer.setSize(width, height, false)
    state.camera.aspect = width / height
    state.camera.updateProjectionMatrix()
    return { width, height }
  }

  function renderOnce() {
    if (state.renderer && state.scene && state.camera) {
      state.renderer.render(state.scene, state.camera)
    }
  }

  /** 通知宿主页面（preview.html）：加载完成 / 加载失败 */
  function notifyHost(ok, message) {
    const el = document.getElementById('host-sub')
    if (!el) return
    if (ok) {
      el.classList.add('loaded')
    } else {
      el.classList.remove('loaded')
      el.textContent = message
    }
  }

  /** 让相机完整框住模型（不移动模型本身，保留模型原有位置） */
  function frameCamera(obj) {
    obj.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) return

    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    if (!Number.isFinite(maxDim) || maxDim <= 0) return

    /*
     * FRAME_PADDING 是「画面可视范围 ÷ 模型最大边长」的倍数，也就是留白系数：
     *   1.0 → 模型正好顶满画面；1.30 → 主轴两端各留 15% 空白。
     * 实测（素材库 15 个模型）1.55 时模型纵向平均只占画面 65.7%、上下各空 17%，
     * 卡片上显得偏小，故收紧到 1.30（纵向约 77%、留白约 11.5%）。
     * 因 target 取的是包围盒中心、投影是绕画面中心缩放，只要系数 > 1 就不会裁切模型。
     */
    const FRAME_PADDING = 1.3

    const fov = (state.camera.fov * Math.PI) / 180
    let dist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * FRAME_PADDING
    if (!Number.isFinite(dist) || dist <= 0) dist = maxDim * 2.2

    const target = new THREE.Vector3(center.x, center.y, center.z)
    // MMD 模型朝向 +Z，相机放在 +Z 侧即为正面
    state.camera.position.set(target.x, target.y + size.y * 0.04, target.z + dist)
    state.camera.near = Math.max(dist / 200, 0.05)
    state.camera.far = dist * 120
    state.camera.updateProjectionMatrix()
    state.camera.lookAt(target)

    if (state.controls) {
      state.controls.target.copy(target)
      state.controls.minDistance = maxDim * 0.35
      state.controls.maxDistance = maxDim * 8
      state.controls.update()
    }
  }

  return {
    /**
     * 挂载到主程序给的**内容容器**。
     *
     * 宿主已通用化：它只保证给一个撑满窗口的空元素，不保证是画布
     * （视频/音频插件会往同一个位置放别的元素）。所以本插件自行创建
     * <canvas> 并塞进容器 —— 这正是通用宿主期望的用法。
     */
    async mount(container) {
      state.container = container || document.body

      // 自建画布：铺满容器，由本插件负责它的尺寸与内容
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none'
      state.container.appendChild(canvas)
      state.canvas = canvas

      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true, // 便于取快照
      })
      /*
       * 生成缩略图时，宿主会通过 api.thumbSize 给出**确定的输出尺寸**，且
       * snapshot() 是直接 `domElement.toDataURL()` —— 取的就是画布后备缓冲区。
       * 此时 pixelRatio 必须是 1，否则后备缓冲区 = 档位 × devicePixelRatio：
       * 在 125% 缩放的显示器上设置 1024 会产出 1280×1280（150% → 1536）。
       * 交互式预览（openPreview）不传 thumbSize，仍按 dpr 提升清晰度。
       */
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

      /*
       * 光照强度对照 MMD 本体的「環境光」水平。AmbientLight + HemisphereLight 合计 0.5，
       * 再低就压不住暗部；再高会把所有面抬到接近纯白、贴图颜色被冲淡（表现为「贴图发白」）。
       */
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
      controls.enablePan = true
      // 沿相机平面平移；默认沿地面平移，模型一歪就很难对准
      controls.screenSpacePanning = true
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      }
      controls.target.set(0, 10, 0)
      controls.update()
      state.controls = controls

      state.onWindowResize = () => syncSize()
      window.addEventListener('resize', state.onWindowResize)

      syncSize()
      renderOnce()
    },

    /** 加载素材主文件（.pmx / .pmd）—— 通用契约名 load() */
    async load(modelPath) {
      const url = toAssetUrl(modelPath)
      const resourcePath = toAssetUrl(dirOf(modelPath)) + '/'

      const loader = new MMDLoader(manager)
      loader.setResourcePath(resourcePath)

      const mesh = await new Promise((resolve, reject) => {
        loader.load(
          url,
          resolve,
          undefined,
          (err) => reject(err instanceof Error ? err : new Error(String(err)))
        )
      })

      // 加载后的三处修正（原因见各函数注释）
      dropEmptyMorphAttributes(mesh)
      clearEmissive(mesh)
      hideInvisibleMaterials(mesh)

      if (state.model) {
        state.scene.remove(state.model)
        disposeObject(state.model)
      }
      state.model = mesh
      state.scene.add(mesh)

      frameCamera(mesh)
      renderOnce()
      notifyHost(true)
      return mesh
    },

    /** 等纹理等异步资源就绪（超时兜底，避免永久等待）—— 通用契约名 waitReady() */
    async waitReady(timeoutMs = 4000) {
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

    start() {
      if (state.running) return
      state.running = true
      const loop = () => {
        if (!state.running) return
        state.raf = requestAnimationFrame(loop)
        if (state.controls) state.controls.update()
        renderOnce()
      }
      loop()
    },

    stop() {
      state.running = false
      if (state.raf) cancelAnimationFrame(state.raf)
      state.raf = 0
    },

    resize() {
      return syncSize()
    },

    setBackground(color) {
      state.background = color || DEFAULT_BG
      if (state.scene) state.scene.background = new THREE.Color(state.background)
      if (state.renderer) state.renderer.setClearColor(new THREE.Color(state.background), 1)
      renderOnce()
    },

    async snapshot() {
      syncSize()
      renderOnce()
      return state.renderer.domElement.toDataURL('image/png')
    },

    dispose() {
      this.stop()
      if (state.onWindowResize) window.removeEventListener('resize', state.onWindowResize)
      if (state.model && state.scene) {
        state.scene.remove(state.model)
        disposeObject(state.model)
        state.model = null
      }
      if (state.controls) state.controls.dispose()
      if (state.renderer) state.renderer.dispose()
      // 自建的画布由自己清走，别在主程序给的容器里留垃圾
      if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas)
      state.canvas = null
    },
  }
}
