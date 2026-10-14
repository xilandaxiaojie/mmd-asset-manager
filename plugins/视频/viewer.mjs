/**
 * 视频预览渲染模块
 *
 * 契约（见 docs/PLUGIN-INTERFACE.md 第 5 节）：
 *   mount(container)        建 <video> 并塞进宿主给的容器
 *   load(path, opts)        加载素材；缩略图渲染时 opts.thumbnail=true
 *   snapshot()              返回当前帧的 dataURL（缩略图）
 *   dispose()               释放资源
 *
 * ── 为什么用原生 <video> 而不是什么播放库 ────────────────
 * mp4/webm/mov 这三种容器的解码 Chromium 自带，<video> 直接就能放。
 * 引第三方播放器（hls.js / flv.js / plyr…）只会让插件包变大，
 * 而它们解决的是「浏览器原生放不了的格式」——那些格式本插件不声明（见 index.cjs）。
 *
 * ── asset:// 与 seek ─────────────────────────────────────
 * 主程序已为 asset:// 实现 Range（206）响应，所以 <video> 能正常拖动进度条。
 * 这里只需把 src 指向 asset:// 即可，无需自己做分片。
 */

const PLAY_RATES = [0.5, 1, 1.25, 1.5, 2]

/**
 * 秒 → mm:ss / h:mm:ss。
 *
 * 必须挡住非有限值：某些 WebM（MediaRecorder 录制、无时长头）的
 * `video.duration` 是 Infinity，直接算会显示成「Infinity:NaN:NaN」。
 * 这类文件时长未知，用 `--:--` 表示，比一串 NaN 体面得多。
 */
function fmtTime(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n < 0) return '--:--'
  const s = Math.floor(n)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n2) => String(n2).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

/** asset:// 协议 URL（主程序注册，渲染层唯一的文件读取通道） */
function assetUrl(absPath) {
  return 'asset://file/' + encodeURIComponent(absPath)
}

export default function createViewer(api) {
  let video = null
  let container = null
  let rafId = 0
  let idleTimer = 0
  let clickTimer = 0   // 单击延迟计时（用来区分单击/双击）
  let readyWaiters = []  // 等元数据的等待者（loadedmetadata / 出错时一起放行）
  let disposed = false
  let thumbSize = 256   // 缩略图长边上限（由 load 的 opts.size 覆盖）

  const $ = (id) => document.getElementById(id)

  /**
   * 等元数据就绪（抽帧 / 播放前必须的）。
   *
   * 注意不能只看 `readyState >= 1` 就立刻返回：`video.load()` 之后、元数据
   * 真正解出来之前，readyState 可能仍是上一次的值（0 或旧值），此时返回会让
   * 调用方在「没有数据」的状态下 play()，播放器把这次 play 挂起等待数据，
   * 表现为**窗口打开了但停在第一帧、paused 仍是 true**。
   * 所以这里改为：数据已就绪 → 立即返回；否则挂起等 loadedmetadata（带超时兜底）。
   */
  function waitReady() {
    if (video && video.readyState >= 1) return Promise.resolve()
    return new Promise((resolve) => {
      // 多个等待者：存成队列，loadedmetadata 时一起放行
      readyWaiters.push(resolve)
      setTimeout(() => {
        const i = readyWaiters.indexOf(resolve)
        if (i >= 0) readyWaiters.splice(i, 1)
        resolve() // 超时不无限挂起
      }, 15000)
    })
  }

  /**
   * 等「可以播了」（readyState >= 3）。
   *
   * play() 在只有元数据时不会立刻开始，会挂起等数据 —— 那样窗口打开后
   * 会停在第一帧，看起来像自动播放没生效。等 canplay 再调 play()，
   * 才能真正做到「打开即播放」。带超时兜底，坏文件不会永远卡住。
   */
  function waitCanPlay(timeoutMs = 8000) {
    if (!video || video.readyState >= 3) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        video.removeEventListener('canplay', finish)
        video.removeEventListener('error', finish)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      video.addEventListener('canplay', finish)
      video.addEventListener('error', finish)
    })
  }

  /** 放行所有等元数据的调用方（loadedmetadata / error / dispose 时调用） */
  function flushReady() {
    const ws = readyWaiters
    readyWaiters = []
    for (const w of ws) w()
  }

  function showError(title, detail) {
    const box = $('hud-error')
    if (!box) return
    $('err-title').textContent = title
    $('err-detail').textContent = detail || ''
    box.classList.add('show')
    const st = $('hud-status')
    if (st) st.textContent = ''
  }

  /** 把当前帧画到 canvas 并导出 PNG dataURL */
  function grabFrame(maxSize) {
    if (!video || !video.videoWidth) return null
    let w = video.videoWidth
    let h = video.videoHeight
    /*
     * 缩略图档位：把长边缩到 maxSize 内（保持宽高比），否则 256 档位会
     * 抽出一张 1920×1080 的图 —— 既浪费磁盘，也让卡片加载变慢。
     */
    if (maxSize > 0 && (w > maxSize || h > maxSize)) {
      const k = Math.min(maxSize / w, maxSize / h)
      w = Math.max(1, Math.round(w * k))
      h = Math.max(1, Math.round(h * k))
    }
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.drawImage(video, 0, 0, w, h)
    try {
      return c.toDataURL('image/png')
    } catch (err) {
      // 同源策略/受污染画布：asset:// 是已登记的特权协议，正常不会走到这
      console.warn('[video] 抽帧失败:', err)
      return null
    }
  }

  /** seek 到指定时间并等待帧真正就绪 */
  function seekTo(t) {
    return new Promise((resolve) => {
      if (!video) return resolve()
      const done = () => {
        video.removeEventListener('seeked', done)
        resolve()
      }
      video.addEventListener('seeked', done)
      // 超时兜底：某些容器在异常位置上不会触发 seeked，不能永久挂起
      setTimeout(() => {
        video.removeEventListener('seeked', done)
        resolve()
      }, 4000)
      try { video.currentTime = t } catch { resolve() }
    })
  }

  function updateTimeUI() {
    if (!video) return
    const dur = Number.isFinite(video.duration) ? video.duration : 0
    const now = video.currentTime || 0
    const seek = $('seek')
    if (seek && dur > 0) {
      // 拖动中不要回写，否则会和用户的手打架
      if (!seek.dataset.dragging) seek.value = String(Math.round((now / dur) * 1000))
    }
    const tn = $('time-now')
    if (tn) tn.textContent = fmtTime(now)
  }

  function setMetaText() {
    if (!video) return
    const el = $('hud-meta')
    if (!el) return
    const parts = []
    if (video.videoWidth) parts.push(`${video.videoWidth}×${video.videoHeight}`)
    if (Number.isFinite(video.duration)) parts.push(fmtTime(video.duration))
    el.textContent = parts.join('  ·  ') || ''
  }

  function togglePlay() {
    if (!video) return
    if (video.paused) video.play().catch((err) => {
      showError('无法播放', String((err && err.message) || err))
    })
    else video.pause()
  }

  /**
   * 切换全屏（双击画面 / 按钮都能调）。
   *
   * 全屏的是**整个页面**而不是 <video>：自绘的控制条是 video 的兄弟节点，
   * 只让 video 全屏的话进度条、音量、退出按钮全都不见了，只能按 Esc 退出。
   *
   * requestFullscreen 失败（极少数策略环境）时不静默吞掉 —— 在状态栏给一句
   * 提示，否则用户会觉得双击没反应。
   */
  function toggleFullscreen() {
    const el = document.fullscreenElement
    const fail = (err) => {
      const st = $('hud-status')
      if (st) st.textContent = '无法切换全屏：' + String((err && err.message) || err)
    }
    if (el) {
      document.exitFullscreen().catch(fail)
    } else {
      document.documentElement.requestFullscreen().catch(fail)
    }
  }

  function bindUI() {
    $('btn-play')?.addEventListener('click', togglePlay)
    $('btn-fs')?.addEventListener('click', toggleFullscreen)

    const seek = $('seek')
    if (seek) {
      seek.addEventListener('pointerdown', () => { seek.dataset.dragging = '1' })
      const commit = () => {
        delete seek.dataset.dragging
        if (!video || !Number.isFinite(video.duration)) return
        video.currentTime = (Number(seek.value) / 1000) * video.duration
      }
      seek.addEventListener('change', commit)
      seek.addEventListener('pointerup', commit)
      // 键盘也能调进度（range 自带，但要同步到视频）
      seek.addEventListener('input', () => {
        if (!video || !Number.isFinite(video.duration)) return
        const t = (Number(seek.value) / 1000) * video.duration
        const tn = $('time-now')
        if (tn) tn.textContent = fmtTime(t)
      })
    }

    $('btn-mute')?.addEventListener('click', () => {
      if (!video) return
      video.muted = !video.muted
      const b = $('btn-mute')
      if (b) {
        b.textContent = video.muted ? '🔇 静音' : '🔊 声音'
        b.classList.toggle('on', video.muted)
      }
    })

    $('volume')?.addEventListener('input', (e) => {
      if (!video) return
      video.volume = Number(e.target.value) / 100
    })

    // 倍速循环切换
    let rateIdx = 1
    $('btn-rate')?.addEventListener('click', () => {
      if (!video) return
      rateIdx = (rateIdx + 1) % PLAY_RATES.length
      video.playbackRate = PLAY_RATES[rateIdx]
      const b = $('btn-rate')
      if (b) b.textContent = PLAY_RATES[rateIdx].toFixed(2).replace(/0$/, '').replace(/\.$/, '.0') + '×'
    })

    // 「适应窗口」↔「原始尺寸」
    let fit = true
    $('btn-fit')?.addEventListener('click', () => {
      if (!video) return
      fit = !fit
      video.style.maxWidth = fit ? '100%' : 'none'
      video.style.maxHeight = fit ? '100%' : 'none'
      const b = $('btn-fit')
      if (b) b.textContent = fit ? '适应窗口' : '原始尺寸'
    })

    // 空格 / 方向键
    document.addEventListener('keydown', (e) => {
      if (!video) return
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5) }
      else if (e.code === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 5) }
    })

    // 鼠标静止时淡出控制条（仅在播放中）
    document.addEventListener('mousemove', () => {
      document.body.classList.remove('idle')
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => document.body.classList.add('idle'), 2200)
    })

    /*
     * 画面上的点击手势：单击 = 播放/暂停，双击 = 全屏。
     *
     * 浏览器把双击拆成「click ×2 + dblclick ×1」，直接绑两个事件会导致
     * 双击时先暂停再全屏（画面状态被意外改掉）。所以单击延迟 220ms 再执行，
     * 期间若来了第二击就取消它 —— 这是这类播放器的标准做法。
     */
    const surface = $('host-content') || document.body
    surface.addEventListener('click', (e) => {
      // 点在控制条/按钮上时不当作「点画面」
      if (e.target.closest('.hud-bottom') || e.target.closest('.hud-btn')) return
      clearTimeout(clickTimer)
      clickTimer = setTimeout(() => togglePlay(), 220)
    })
    surface.addEventListener('dblclick', (e) => {
      if (e.target.closest('.hud-bottom') || e.target.closest('.hud-btn')) return
      clearTimeout(clickTimer) // 取消那一次待执行的单击
      toggleFullscreen()
    })

    // 全屏状态变化时同步按钮文案（含按 Esc 退出的情况）
    document.addEventListener('fullscreenchange', () => {
      const b = $('btn-fs')
      if (b) b.textContent = document.fullscreenElement ? '退出全屏' : '全屏'
      // 全屏切换后容器尺寸变了，让 <video> 重新适配
      if (video) { video.style.maxWidth = '100%'; video.style.maxHeight = '100%' }
    })
  }

  return {
    /** 建 <video> 并挂进宿主容器 */
    async mount(el) {
      container = el
      video = document.createElement('video')
      video.controls = false        // 用自绘控制条（原生条在暗色窗口里太突兀）
      /*
       * preload='auto'：预览窗口打开即播放，只加载元数据会导致 play() 挂起
       * 等数据（表现为停在第一帧）。抽缩略图时用不到这么多缓冲，但代价可接受，
       * 而且 asset:// 是本地文件流，不会真的走网络。
       */
      video.preload = 'auto'
      video.playsInline = true
      video.style.maxWidth = '100%'
      video.style.maxHeight = '100%'

      video.addEventListener('loadedmetadata', () => {
        setMetaText()
        const tt = $('time-total')
        if (tt) tt.textContent = fmtTime(video.duration)
        const st = $('hud-status')
        if (st) st.textContent = ''
        flushReady()
      })
      video.addEventListener('timeupdate', updateTimeUI)
      video.addEventListener('play', () => {
        document.body.classList.add('playing')
        const b = $('btn-play'); if (b) b.textContent = '❚❚'
      })
      video.addEventListener('pause', () => {
        document.body.classList.remove('playing', 'idle')
        const b = $('btn-play'); if (b) b.textContent = '▶'
      })
      video.addEventListener('error', () => {
        const code = video.error ? video.error.code : 0
        const map = {
          1: '加载被中止',
          2: '网络错误（读取文件失败）',
          3: '解码失败：文件可能损坏',
          4: '格式不受支持：Chromium 无法解码该视频的容器或编码',
        }
        showError('无法播放', (map[code] || '未知错误') +
          '\n\n如果这是 MKV / AVI / HEVC 编码，请用系统默认播放器打开。')
        flushReady()
      })

      container.innerHTML = ''
      container.appendChild(video)
      bindUI()
      return video
    },

    /**
     * 加载素材。
     * opts.thumbnail = true 时是缩略图渲染宿主（无预览界面元素），
     * 此时所有 $() 取到的都是 null，逻辑要能容忍。
     */
    async load(filePath, opts = {}) {
      if (!video) return
      const isThumb = !!(opts && opts.thumbnail)
      if (isThumb && Number(opts.size) > 0) thumbSize = Number(opts.size)
      const st = $('hud-status')
      if (st) st.textContent = '正在加载…'

      video.src = assetUrl(filePath)
      video.load()

      // 缩略图：等元数据 → 跳到 10% 处抽一帧（避开片头黑场）
      if (isThumb) {
        await waitReady()
        const dur = Number.isFinite(video.duration) ? video.duration : 0
        const at = dur > 1 ? Math.min(dur * 0.1, 10) : 0
        if (at > 0) await seekTo(at)
        return
      }

      await waitReady()
      /*
       * 预览窗口：打开即自动播放。
       *
       * 先把音量同步到控制条（界面默认 100，但 video 元素的初始音量要用
       * 界面值覆盖，否则改过音量后重新打开又变回默认）。
       *
       * 自动播放策略：Electron 里由用户主动打开窗口通常放行；万一 play() 被
       * 拒绝，就静音重试一次 —— 保证「至少画面在动」，而不是打开后停在首帧。
       */
      const volEl = $('volume')
      if (volEl) video.volume = Math.max(0, Math.min(1, Number(volEl.value) / 100))

      await waitCanPlay()
      try {
        await video.play()
      } catch {
        try {
          video.muted = true
          const b = $('btn-mute')
          if (b) { b.textContent = '🔇 静音'; b.classList.add('on') }
          await video.play()
        } catch { /* 仍失败就停在首帧，用户可手动点播放 */ }
      }
      setMetaText()
      if (st) st.textContent = ''
    },

    start() { /* 静态帧即可，无需渲染循环 */ },
    stop() { /* 同上 */ },

    /** 缩略图：返回当前帧（按档位缩放） */
    async snapshot() {
      await waitReady()
      const url = grabFrame(thumbSize)
      if (!url) throw new Error('无法从视频抽帧')
      return url
    },

    /** 缩略图宿主会调：等首帧可画再快照 */
    async waitReady() { return waitReady() },

    resize() { /* <video> 用 CSS 自适应，无需处理 */ },
    setBackground(color) { if (container) container.style.background = color },

    dispose() {
      disposed = true
      cancelAnimationFrame(rafId)
      clearTimeout(idleTimer)
      if (video) {
        try { video.pause() } catch {}
        video.removeAttribute('src')
        video.load()   // 断开解码器与文件句柄
        video.remove()
      }
      video = null
      container = null
      void disposed
    },
  }
}
