<template>
  <div class="preview-image-wrap">
    <img
      :src="imageSrc"
      :alt="alt"
      class="preview-img"
      :class="{ 'preview-img--hidden': loading || error }"
      @load="onImgLoad"
      @error="onImgError"
      @click="fullscreen = true"
    />

    <div v-if="loading" class="preview-image-loading">加载中...</div>
    <div v-if="error" class="preview-image-error">加载失败</div>

    <div
      v-if="fullscreen"
      class="preview-fs-overlay"
      @wheel.prevent="onWheel"
      @mousedown="onDragStart"
      @mousemove="onDragMove"
      @mouseup="onDragEnd"
      @mouseleave="onDragEnd"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend.passive="onTouchEnd"
      @dblclick="toggleZoom"
      tabindex="0"
      @keydown="onKeydown"
    >
      <button class="fs-close-btn" type="button" aria-label="关闭全屏预览" @click="fullscreen = false">
        <AppIcon name="X" :size="20" />
      </button>

      <div ref="imgWrapRef" class="fs-img-wrap">
        <img
          :src="fullscreenSrc"
          :alt="alt"
          :style="imgStyle"
          draggable="false"
          :class="{ dragging: isDragging }"
          @load="onFsImgLoad"
        />
      </div>

      <div class="fs-zoom-badge">{{ zoomPercent }}%</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { getFileRawUrl } from '@/api/files'

const props = defineProps<{
  src: string
  alt?: string
}>()

const imageSrc = ref('')
const fullscreenSrc = ref('')

async function resolveUrl(raw: string): Promise<string> {
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/api/')) {
    return raw
  }
  return getFileRawUrl(raw)
}

watch(
  () => props.src,
  async (val) => {
    imageSrc.value = await resolveUrl(val)
  },
  { immediate: true },
)

const loading = ref(true)
const error = ref(false)

function onImgError(): void {
  loading.value = false
  error.value = true
}

function onImgLoad(): void {
  loading.value = false
}

const fullscreen = ref(false)
const imgWrapRef = ref<HTMLElement | null>(null)

const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const isDragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const lastPinchDist = ref(0)
let naturalW = 0
let naturalH = 0
const fitScale = ref(1)

const imgStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
  cursor: isDragging.value ? 'grabbing' : 'grab',
}))

const zoomPercent = computed(() => Math.round(scale.value * 100))

let prevBodyOverflow = ''

watch(fullscreen, (val) => {
  if (val) {
    prevBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = prevBodyOverflow
  }
})

onUnmounted(() => {
  if (fullscreen.value) {
    document.body.style.overflow = prevBodyOverflow
  }
})

watch(fullscreen, async (val) => {
  if (val) {
    scale.value = 1
    panX.value = 0
    panY.value = 0
    fullscreenSrc.value = await resolveUrl(props.src)
    await nextTick()
    recalcFitScale()
  }
})

function recalcFitScale(): void {
  const wrap = imgWrapRef.value
  if (wrap && naturalW && naturalH) {
    const cw = wrap.clientWidth
    const ch = wrap.clientHeight
    if (cw && ch) {
      fitScale.value = Math.min(cw / naturalW, ch / naturalH)
    }
  }
}

function onFsImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement
  naturalW = img.naturalWidth
  naturalH = img.naturalHeight
  recalcFitScale()
}

function onWheel(e: WheelEvent): void {
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  const next = scale.value * (1 + delta)
  scale.value = Math.min(10, Math.max(0.25, next))
}

function onDragStart(e: MouseEvent): void {
  if (e.button !== 0) return
  isDragging.value = true
  dragStart.value = { x: e.clientX - panX.value, y: e.clientY - panY.value }
}

function onDragMove(e: MouseEvent): void {
  if (!isDragging.value) return
  panX.value = e.clientX - dragStart.value.x
  panY.value = e.clientY - dragStart.value.y
}

function onDragEnd(): void {
  isDragging.value = false
}

function toggleZoom(): void {
  if (scale.value < 1.5) {
    scale.value = fitScale.value
  } else {
    scale.value = 1
    panX.value = 0
    panY.value = 0
  }
}

function onTouchStart(e: TouchEvent): void {
  if (e.touches.length === 1) {
    isDragging.value = true
    dragStart.value = {
      x: e.touches[0].clientX - panX.value,
      y: e.touches[0].clientY - panY.value,
    }
  } else if (e.touches.length === 2) {
    lastPinchDist.value = getTouchDist(e.touches)
  }
}

function onTouchMove(e: TouchEvent): void {
  if (e.touches.length === 1 && isDragging.value) {
    panX.value = e.touches[0].clientX - dragStart.value.x
    panY.value = e.touches[0].clientY - dragStart.value.y
  } else if (e.touches.length === 2) {
    const dist = getTouchDist(e.touches)
    if (lastPinchDist.value > 0) {
      const next = scale.value * (dist / lastPinchDist.value)
      scale.value = Math.min(10, Math.max(0.25, next))
    }
    lastPinchDist.value = dist
  }
}

function onTouchEnd(): void {
  isDragging.value = false
  lastPinchDist.value = 0
}

function getTouchDist(touches: TouchList): number {
  if (touches.length < 2) return 0
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.hypot(dx, dy)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    fullscreen.value = false
  }
}
</script>

<style scoped>
.preview-image-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 200px;
}

.preview-img {
  max-inline-size: 100%;
  max-block-size: 70vh;
  border-radius: var(--radius-sm);
  object-fit: contain;
  cursor: pointer;
  box-shadow: 0 4px 24px color-mix(in srgb, var(--ink) 22%, transparent);
  transition:
    opacity var(--motion-fast) ease,
    transform var(--motion-fast) ease;
  user-select: none;
  -webkit-user-drag: none;
}

.preview-img:hover {
  transform: scale(1.02);
}

.preview-img:active {
  transform: scale(0.98);
}

.preview-img--hidden {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.preview-image-loading,
.preview-image-error {
  padding: var(--space-6) var(--space-4);
  font-size: 14px;
  text-align: center;
}

.preview-image-loading {
  color: var(--muted);
}

.preview-image-error {
  color: var(--danger);
}

.preview-fs-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 96%, transparent);
  backdrop-filter: blur(20px);
  outline: none;
}

.fs-close-btn {
  position: fixed;
  top: calc(var(--space-4) + var(--app-top-inset, 0px));
  right: var(--space-4);
  z-index: calc(var(--z-sheet) + 1);
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: var(--tap);
  block-size: var(--tap);
  padding: 0;
  border: 1px solid var(--hairline);
  border-radius: 50%;
  background: var(--surface-raised);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
  transition: background var(--motion-fast) ease;
}

.fs-close-btn:hover {
  background: var(--inset);
}

.fs-img-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 90vw;
  block-size: 90vh;
  overflow: hidden;
}

.fs-img-wrap img {
  max-inline-size: 100%;
  max-block-size: 100%;
  object-fit: contain;
  transition: transform var(--motion-fast) ease;
  user-select: none;
  -webkit-user-drag: none;
  will-change: transform;
}

.fs-img-wrap img.dragging {
  transition: none;
}

.fs-zoom-badge {
  position: fixed;
  right: var(--space-5);
  bottom: var(--space-5);
  z-index: calc(var(--z-sheet) + 1);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 13px;
  pointer-events: none;
  user-select: none;
}
</style>
