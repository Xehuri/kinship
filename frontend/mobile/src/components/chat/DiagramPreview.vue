<template>
  <!-- 全屏遮罩 -->
  <div
    ref="overlayRef"
    class="diagram-overlay"
    @wheel.prevent="onWheel"
    @mousedown="onDragStart"
    @mousemove="onDragMove"
    @mouseup="onDragEnd"
    @mouseleave="onDragEnd"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
    @dblclick="toggleZoom"
    @click.self="emit('close')"
    tabindex="0"
    @keydown="onKeydown"
  >
    <!-- 顶部工具栏 -->
    <div class="diagram-toolbar">
      <button v-if="props.type !== 'circuitjs'" class="diagram-btn" title="下载 PNG" @click="downloadPng">
        <!-- 下载图标 -->
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    </div>

    <!-- 关闭按钮 (右上角, 高对比) -->
    <button class="diagram-close-btn" title="关闭" @click="emit('close')">
      <!-- 关闭图标 -->
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>

    <!-- SVG 内容容器 -->
    <div v-if="props.type !== 'circuitjs'" class="diagram-content" ref="contentRef">
      <div
        class="diagram-svg-wrap"
        :style="svgWrapStyle"
        v-html="props.svg"
      />
    </div>

    <!-- CircuitJS 仿真器 (全屏: 完整 UI, 可编辑, 自动加载电路; 延迟 500ms 挂载给 GWT 初始化时间) -->
    <div v-else class="diagram-circuit-wrap">
      <div v-if="circuitReady" class="diagram-circuit-inner">
        <iframe
          :src="circuitSrc"
          class="diagram-circuit-frame"
          title="电路仿真器"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      </div>
      <div v-else class="diagram-circuit-loading">
        <span class="diagram-circuit-spinner"></span>
        <span>电路仿真器加载中...</span>
      </div>
    </div>

    <!-- 缩放百分比 -->
    <div v-if="props.type !== 'circuitjs'" class="diagram-zoom-badge">{{ zoomPercent }}%</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { fitSvgElement } from '@/utils/markdown'

const props = defineProps<{
  type?: 'svg' | 'circuitjs'
  svg?: string
  circuitCtz?: string
}>()

const emit = defineEmits<{
  close: []
}>()

/* ---- CircuitJS 全屏 src (完整 UI, 无 hide 参数, 带 ctz 自动加载电路) ---- */
const circuitSrc = computed(() =>
  // ctz 为 compressToEncodedURIComponent 产物, 字符集 URI-safe, 直接拼接 (不可 encodeURIComponent, 否则 + → %2B → GWT 解析为空格)
  import.meta.env.BASE_URL + 'circuitjs1/circuitjs.html?ctz=' + (props.circuitCtz || '')
)

/* ---- DOM 引用 ---- */
const contentRef = ref<HTMLElement | null>(null)
const overlayRef = ref<HTMLElement | null>(null)

/* ---- CircuitJS 延迟挂载 (给 GWT 模块初始化时间) ---- */
const circuitReady = ref(false)
let circuitTimer: number | undefined

/* ---- 缩放 / 平移状态 ---- */
const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const isDragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const lastPinchDist = ref(0)

const svgWrapStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
  cursor: isDragging.value ? 'grabbing' : 'grab',
  transition: isDragging.value ? 'none' : 'transform 0.2s ease',
}))

const zoomPercent = computed(() => Math.round(scale.value * 100))

/* ---- body overflow 控制 (组件自管理, 挂载锁定/卸载恢复) ---- */
onMounted(async () => {
  document.body.style.overflow = 'hidden'
  // 自动聚焦浮窗, 使 Esc / 键盘事件立即生效
  overlayRef.value?.focus()
  // CircuitJS 模式: 延迟 500ms 挂载 iframe, 给 GWT 内部模块充分初始化时间 (规避竞态)
  if (props.type === 'circuitjs') {
    circuitTimer = window.setTimeout(() => {
      circuitReady.value = true
    }, 500)
  }
  // v-html 注入后等 DOM 就绪: 自动扩展 viewBox (内容超出时) + 设置 aspect-ratio
  await nextTick()
  const svgEl = contentRef.value?.querySelector('svg') as SVGSVGElement | null
  if (svgEl) {
    fitSvgElement(svgEl)
  }
})

onBeforeUnmount(() => {
  if (circuitTimer) window.clearTimeout(circuitTimer)
  document.body.style.overflow = ''
})

/* ---- 鼠标滚轮缩放 ---- */
function onWheel(e: WheelEvent): void {
  if (props.type === 'circuitjs') return
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  let newScale = scale.value * (1 + delta)
  newScale = Math.min(10, Math.max(0.25, newScale))
  scale.value = newScale
}

/* ---- 鼠标拖拽 ---- */
function onDragStart(e: MouseEvent): void {
  if (props.type === 'circuitjs') return
  if (e.button !== 0) return
  isDragging.value = true
  dragStart.value = { x: e.clientX - panX.value, y: e.clientY - panY.value }
}

function onDragMove(e: MouseEvent): void {
  if (props.type === 'circuitjs') return
  if (!isDragging.value) return
  panX.value = e.clientX - dragStart.value.x
  panY.value = e.clientY - dragStart.value.y
}

function onDragEnd(): void {
  if (props.type === 'circuitjs') return
  isDragging.value = false
}

/* ---- 双击切换缩放 ---- */
function toggleZoom(): void {
  if (props.type === 'circuitjs') return
  if (scale.value < 1.5) {
    scale.value = 2
  } else {
    scale.value = 1
    panX.value = 0
    panY.value = 0
  }
}

/* ---- 触摸手势 ---- */
function onTouchStart(e: TouchEvent): void {
  if (props.type === 'circuitjs') return
  if (e.touches.length === 1) {
    isDragging.value = true
    dragStart.value = { x: e.touches[0].clientX - panX.value, y: e.touches[0].clientY - panY.value }
  } else if (e.touches.length === 2) {
    lastPinchDist.value = getTouchDist(e.touches)
  }
}

function onTouchMove(e: TouchEvent): void {
  if (props.type === 'circuitjs') return
  if (e.touches.length === 1 && isDragging.value) {
    panX.value = e.touches[0].clientX - dragStart.value.x
    panY.value = e.touches[0].clientY - dragStart.value.y
  } else if (e.touches.length === 2) {
    const dist = getTouchDist(e.touches)
    if (lastPinchDist.value > 0) {
      const ratio = dist / lastPinchDist.value
      let newScale = scale.value * ratio
      newScale = Math.min(10, Math.max(0.25, newScale))
      scale.value = newScale
    }
    lastPinchDist.value = dist
  }
}

function onTouchEnd(): void {
  if (props.type === 'circuitjs') return
  isDragging.value = false
  lastPinchDist.value = 0
}

function getTouchDist(touches: TouchList): number {
  if (touches.length < 2) return 0
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.hypot(dx, dy)
}

/* ---- 键盘事件 ---- */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close')
  }
}

/* ---- 下载 PNG ---- */
function downloadPng(): void {
  if (props.type === 'circuitjs') return
  const container = contentRef.value
  if (!container) return

  const svgEl = container.querySelector('svg')
  if (!svgEl) return

  // 序列化 SVG
  const svgStr = new XMLSerializer().serializeToString(svgEl)

  // 获取 SVG 尺寸: viewBox 优先, 回退 width/height 属性, 再回退 800x600
  let w = 800
  let h = 600
  const vb = svgEl.viewBox?.baseVal
  if (vb && vb.width && vb.height) {
    w = vb.width
    h = vb.height
  } else {
    const attrW = svgEl.getAttribute('width')
    const attrH = svgEl.getAttribute('height')
    if (attrW && attrH) {
      const parsedW = parseFloat(attrW)
      const parsedH = parseFloat(attrH)
      if (parsedW > 0 && parsedH > 0) {
        w = parsedW
        h = parsedH
      }
    }
  }

  // 2x 高清导出
  const canvas = document.createElement('canvas')
  canvas.width = w * 2
  canvas.height = h * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // 深色背景
  ctx.fillStyle = '#0d0d14'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // SVG → Image → canvas
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const img = new Image()

  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)

    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(pngBlob)
      a.download = 'diagram.png'
      a.click()
      URL.revokeObjectURL(a.href)
    }, 'image/png')
  }

  img.onerror = () => {
    URL.revokeObjectURL(url)
    console.error('[DiagramPreview] SVG 转图片失败, 无法导出 PNG')
  }

  img.src = url
}
</script>

<style scoped>
/* ---- 全屏遮罩 ---- */
.diagram-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
}

/* ---- 顶部工具栏 (下载按钮, 位于关闭按钮左侧) ---- */
.diagram-toolbar {
  position: fixed;
  /* 顶部让出 --app-top-inset, 避免被手机状态栏遮挡 / 重合 */
  top: calc(16px + var(--app-top-inset, 0px));
  right: 64px;
  z-index: 1001;
  display: flex;
  gap: 8px;
}

.diagram-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.diagram-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

/* ---- 关闭按钮 (右上角, 高对比白底) ---- */
.diagram-close-btn {
  position: fixed;
  /* 顶部让出 --app-top-inset, 避免被手机状态栏遮挡 / 重合 */
  top: calc(16px + var(--app-top-inset, 0px));
  right: 16px;
  z-index: 1002;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  border: none;
  color: #1a1a1a;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, transform 0.15s;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.diagram-close-btn:hover {
  background: #ffffff;
  transform: scale(1.08);
}

/* ---- 内容容器 ---- */
.diagram-content {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 90vw;
  height: 90vh;
  overflow: hidden;
}

.diagram-svg-wrap {
  width: 100%;
  max-width: 100%;
  max-height: 100%;
  will-change: transform;
  user-select: none;
  -webkit-user-drag: none;
}

.diagram-svg-wrap :deep(svg) {
  max-width: 100%;
  max-height: 80vh;
  width: auto;
  height: auto;
  display: block;
}

/* ---- CircuitJS 全屏仿真器 ---- */
.diagram-circuit-wrap {
  width: 100%;
  height: 100%;
  display: flex;
}

.diagram-circuit-inner {
  width: 100%;
  height: 100%;
}

.diagram-circuit-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #0d1117;
}

/* 加载占位 (延迟挂载期间显示) */
.diagram-circuit-loading {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
  background: #0d1117;
}

.diagram-circuit-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(255, 255, 255, 0.15);
  border-top-color: rgba(255, 255, 255, 0.6);
  border-radius: 50%;
  animation: circuit-spin 0.8s linear infinite;
}

@keyframes circuit-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---- 缩放百分比 ---- */
.diagram-zoom-badge {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 6px;
  font-family: monospace;
  z-index: 1001;
  pointer-events: none;
  user-select: none;
}
</style>
