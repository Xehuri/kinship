<template>
  <div class="md-root" ref="rootEl">
    <!-- 流式进行中: 纯文本渲染, 不解析 Markdown, 不挂载图块 (D4 决策) -->
    <div v-if="streaming" class="md-plain">{{ content }}</div>
    <!-- 流式结束: 一次性渲染完整 Markdown -->
    <div v-else class="md-content" v-html="renderedHtml" />
  </div>
  <DiagramPreview
    v-if="preview"
    :type="preview.type"
    :svg="preview.type === 'svg' ? preview.svg : undefined"
    :circuit-ctz="preview.type === 'circuitjs' ? preview.circuitCtz : undefined"
    @close="preview = null"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown, applySvgAspectRatio, fitSvgViewBox } from '@/utils/markdown'
import DiagramPreview from '@/components/chat/DiagramPreview.vue'
import mermaid from 'mermaid'
import { decompressFromEncodedURIComponent } from 'lz-string'
import 'katex/dist/katex.min.css'

const props = defineProps<{
  content: string
  /**
   * 是否仍在流式输出 (D4 决策)
   *
   * true 时只渲染纯文本, 不解析 Markdown、不挂载 mermaid/circuitjs;
   * 流式结束后再一次性渲染完整 Markdown 并挂载图块, 避免逐 token
   * 全量重解析 + v-html 重建导致图块反复重渲染、定时器无界增长。
   */
  streaming?: boolean
}>()

const rootEl = ref<HTMLElement | null>(null)

/* ---- CircuitJS GWT 全局 API 类型 (仅声明本文件用到的成员) ---- */
/** CircuitJS1 电路元件 (GWT 导出) */
interface CircuitJS1Element {
  getType(): string
}
/** CircuitJS1 全局 API (GWT 导出) */
interface CircuitJS1Api {
  getElements(): CircuitJS1Element[]
}
/** 挂载了 CircuitJS1 的 iframe contentWindow */
interface CircuitJS1Window extends Window {
  CircuitJS1?: CircuitJS1Api
}

/* ---- 图块全屏预览 ---- */
interface PreviewState {
  type: 'svg' | 'circuitjs'
  svg?: string
  circuitCtz?: string
}
const preview = ref<PreviewState | null>(null)

/** CircuitJS iframe 挂载延迟定时器集合 (组件卸载时清理) */
const _circuitjsTimers = new Set<number>()

/** 清理所有未执行的 CircuitJS 挂载定时器 (组件卸载或 v-html 重建前调用, 防止泄漏) */
function clearCircuitTimers(): void {
  _circuitjsTimers.forEach((t) => window.clearTimeout(t))
  _circuitjsTimers.clear()
}

/** 事件委托: 点击 circuitjs 放大按钮或 svg/mermaid 图块时打开全屏浮窗 */
function onDiagramClick(e: MouseEvent): void {
  const target = e.target as Element
  // 电路仿真放大按钮: 打开全屏 (完整 UI, 可编辑)
  const expandBtn = target.closest<HTMLElement>('.circuitjs-expand-btn')
  if (expandBtn) {
    e.preventDefault()
    e.stopPropagation()
    const block = expandBtn.closest<HTMLElement>('.circuitjs-block')
    preview.value = { type: 'circuitjs', circuitCtz: block?.dataset.ctz || '' }
    return
  }
  // svg-diagram / mermaid-block 内的 SVG
  const svgEl = target.closest('.svg-diagram svg, .mermaid-block svg')
  if (!svgEl) return
  e.preventDefault()
  e.stopPropagation()
  preview.value = { type: 'svg', svg: svgEl.outerHTML }
}

// mermaid 初始化 (手动渲染, 不自动扫描)
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  fontFamily: 'inherit',
})

const renderedHtml = computed<string>(() => {
  // 流式进行中不解析 Markdown (纯文本阶段), 避免逐 token 全量重解析与 v-html 重建
  if (props.streaming) return ''
  return renderMarkdown(props.content)
})

// 渲染 Mermaid 图块 (v-html 注入后查找 .mermaid-block 逐个渲染)
watch(renderedHtml, async () => {
  // 流式进行中不挂载图块 (纯文本阶段, 内容尚未定型)
  if (props.streaming) return
  // 重渲染前清理上一轮未执行的挂载定时器 (v-html 重建会丢弃旧 DOM 节点)
  clearCircuitTimers()
  await nextTick()
  // 给 svg-diagram 自动扩展 viewBox (内容超出时) + 设置 aspect-ratio (按 viewBox 比例缩放)
  if (rootEl.value) {
    fitSvgViewBox(rootEl.value)
    applySvgAspectRatio(rootEl.value)
  }
  const blocks = rootEl.value?.querySelectorAll<HTMLElement>('.mermaid-block')
  blocks?.forEach(async (block, idx) => {
    if (block.classList.contains('mermaid-rendered')) return
    const code = block.textContent || ''
    if (!code.trim()) return
    try {
      const { svg } = await mermaid.render('mmd-' + idx + '-' + Date.now(), code.trim())
      block.innerHTML = svg
      block.classList.add('mermaid-rendered')
      if (rootEl.value) applySvgAspectRatio(rootEl.value)
    } catch (e) {
      console.error('[MarkdownContent] Mermaid 渲染失败:', e)
      block.classList.add('mermaid-rendered')
    }
  })

  // CircuitJS 块: 延迟 500ms 挂载内嵌 iframe (给 GWT 模块充分初始化时间, 规避竞态)
  // + 右上角放大按钮。已 mounted 的块若 data-ctz 变化 (流式渲染中途内容更新), 则重建 iframe.src
  const cjsBlocks = rootEl.value?.querySelectorAll<HTMLElement>('.circuitjs-block')
  cjsBlocks?.forEach((block) => {
    const ctz = block.dataset.ctz || ''
    if (!ctz) return
    // 已挂载或挂载中则跳过 (防 watch 重复调度)
    if (block.classList.contains('circuitjs-mounted') || block.classList.contains('circuitjs-mounting')) return
    block.classList.add('circuitjs-mounting')
    // 延迟挂载 iframe, 让 GWT 内部模块有充足初始化时间 (首次 500ms)
    const timer = window.setTimeout(() => {
      // 定时器已触发: 从集合移除, 避免集合无界增长
      _circuitjsTimers.delete(timer)
      const blockEl = block as HTMLElement
      let iframe: HTMLIFrameElement | null = null
      for (const child of Array.from(blockEl.children)) {
        if (child.tagName === 'IFRAME') {
          iframe = child as HTMLIFrameElement
          break
        }
      }
      if (!iframe) {
        iframe = document.createElement('iframe')
        iframe.title = '电路仿真器'
        iframe.loading = 'lazy'
        // FE-M3: 给电路仿真 iframe 加 sandbox 限制。
        // 注意: CircuitJS 为 GWT 编译产物, 依赖 sessionStorage 在 loader 与主模块间
        // 传参, 因此必须保留 allow-same-origin, 否则 GWT 初始化会因 SecurityError 而失败。
        // 真正更严格的隔离需将仿真器部署到独立子域 (跨源), 见整改说明。
        iframe.setAttribute(
          'sandbox',
          'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
        )
        blockEl.appendChild(iframe)
        // 右上角放大按钮 (点击打开全屏预览, 由 onDiagramClick 事件委托处理)
        const expandBtn = document.createElement('button')
        expandBtn.className = 'circuitjs-expand-btn'
        expandBtn.title = '放大预览'
        expandBtn.setAttribute('aria-label', '放大预览电路仿真器')
        expandBtn.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="11" cy="11" r="8"></circle>' +
          '<line x1="21" y1="21" x2="16.65" y2="16.65"></line>' +
          '<line x1="11" y1="8" x2="11" y2="14"></line>' +
          '<line x1="8" y1="11" x2="14" y2="11"></line>' +
          '</svg>'
        blockEl.appendChild(expandBtn)
        blockEl.classList.remove('circuitjs-mounting')
        blockEl.classList.add('circuitjs-mounted')
      }
      // 流式渲染时压缩文本可能变化: 不一致则更新 iframe 加载内容
      if (iframe.dataset.ctz !== ctz) {
        iframe.dataset.ctz = ctz
        // 注意: ctz 由 compressToEncodedURIComponent 生成, 字符集为 A-Za-z0-9+-/$,
        // 不可再 encodeURIComponent (会把 + 编码为 %2B, GWT query 解析时 + 被当空格导致解压失败)
        const src =
          import.meta.env.BASE_URL +
          'circuitjs1/circuitjs.html?hideMenu=true&hideSidebar=true&editable=false&ctz=' +
          ctz
        // [诊断] 记录电路文本与挂载信息
        const decoded = decompressFromEncodedURIComponent(ctz) || ''
        console.log('[CircuitJS] 挂载 iframe | ctz长度:', ctz.length, '| 解码电路首行:', decoded.split('\n')[0], '| 总行数:', decoded.split('\n').length)
        console.log('[CircuitJS] 解码电路全文:\n' + decoded)
        iframe.src = src
        console.log('[CircuitJS] iframe.src =', src.slice(0, 120) + '...')
        // [诊断] iframe load 事件
        const onLoad = () => {
          console.log('[CircuitJS] iframe load 完成 | src:', (iframe as HTMLIFrameElement).src.slice(0, 80) + '...')
          // 轮询检查 GWT 就绪 + 元件类型 (判断是否默认 LRC 电路)
          let attempts = 0
          const poll = window.setInterval(() => {
            attempts++
            const win = (iframe as HTMLIFrameElement).contentWindow as CircuitJS1Window | null
            const api = win?.CircuitJS1
            if (api && typeof api.getElements === 'function') {
              const els = api.getElements()
              const types = els.map((e) => e.getType())
              console.log(`[CircuitJS] GWT 就绪 (${attempts}次轮询) | 元件数: ${els.length} | 类型: [${types.join(', ')}]`)
              window.clearInterval(poll)
            } else if (attempts >= 50) {
              console.warn('[CircuitJS] GWT 10秒未就绪, 可能显示默认电路')
              window.clearInterval(poll)
            }
          }, 200)
        }
        iframe.addEventListener('load', onLoad, { once: true })
      }
    }, 500)
    _circuitjsTimers.add(timer)
  })
}, { immediate: true })

/* ---- 挂载/卸载事件委托 ---- */
onMounted(() => {
  rootEl.value?.addEventListener('click', onDiagramClick)
})

onBeforeUnmount(() => {
  rootEl.value?.removeEventListener('click', onDiagramClick)
  // 清理未执行的 CircuitJS 挂载延迟定时器
  clearCircuitTimers()
  // 恢复 body overflow (防止组件卸载时浮窗未关闭)
  document.body.style.overflow = ''
})
</script>

<style scoped>
/* 流式纯文本: 与 .md-content 段落保持一致的字体/行高, 保留换行但不解析 Markdown */
.md-plain {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
