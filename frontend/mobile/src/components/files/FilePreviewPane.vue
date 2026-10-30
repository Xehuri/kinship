<template>
  <div class="ax-preview-pane" data-testid="file-preview-pane">
    <header class="ax-preview-pane__header">
      <div class="ax-preview-pane__identity">
        <AppIcon :name="iconName" :size="16" class="ax-preview-pane__icon" />
        <span class="ax-preview-pane__name" :title="name">{{ name }}</span>
        <span class="ax-preview-pane__kind">{{ kindLabel }}</span>
      </div>
      <div class="ax-preview-pane__actions">
        <button
          class="ax-preview-pane__action"
          type="button"
          aria-label="下载文件"
          @click="handleDownload"
        >
          <AppIcon name="Download" :size="16" />
        </button>
        <button
          class="ax-preview-pane__action"
          type="button"
          aria-label="关闭预览"
          @click="emit('close')"
        >
          <AppIcon name="X" :size="16" />
        </button>
      </div>
    </header>

    <div class="ax-preview-pane__body">
      <div v-if="loading" class="ax-preview-pane__loading" aria-busy="true" aria-label="正在加载文件">
        <span class="skeleton ax-preview-pane__line" />
        <span class="skeleton ax-preview-pane__line" />
        <span class="skeleton ax-preview-pane__line ax-preview-pane__line--short" />
      </div>

      <div v-else-if="error" class="ax-state ax-preview-pane__state" role="alert">
        <h2 class="ax-state__title">加载失败</h2>
        <p class="ax-state__body">{{ error }}</p>
        <button class="ax-state__action" type="button" @click="loadContent">重试</button>
      </div>

      <ImagePreview v-else-if="kind === 'image'" :src="path" :alt="name" />

      <AudioPreview v-else-if="kind === 'audio'" :path="path" />

      <MarkdownContent v-else-if="kind === 'md'" :content="rawText" />

      <CodeSurface
        v-else-if="
          kind === 'code' ||
          kind === 'text' ||
          kind === 'json' ||
          kind === 'jsonl'
        "
        :code="surfaceCode"
        :language="codeLanguage"
        :name="name"
      />

      <div v-else class="ax-state ax-preview-pane__state">
        <AppIcon name="FileText" :size="24" />
        <p class="ax-state__body">无法预览此文件，可直接下载后查看。</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import MarkdownContent from '@/components/chat/MarkdownContent.vue'
import CodeSurface from '@/components/code/CodeSurface.vue'
import { fetchFileContentVerbose, getFileRawUrl } from '@/api/files'
import { prettyJson } from '@/utils/codeFormat'
import type { FileContentJsonResponse, FilePreviewKind } from '@/types/files'
import ImagePreview from './ImagePreview.vue'
import AudioPreview from './AudioPreview.vue'
import { getCodeLanguage } from './preview'

const props = defineProps<{
  path: string
  name: string
  kind: FilePreviewKind
}>()

const emit = defineEmits<{
  close: []
}>()

const KIND_LABELS: Record<FilePreviewKind, string> = {
  md: 'Markdown',
  json: 'JSON',
  jsonl: 'JSONL',
  text: '文本',
  image: '图片',
  audio: '音频',
  code: '代码',
  unsupported: '文件',
}

const ICON_NAMES: Record<FilePreviewKind, string> = {
  md: 'FileText',
  json: 'Database',
  jsonl: 'Database',
  text: 'FileText',
  image: 'Image',
  audio: 'Waveform',
  code: 'Code',
  unsupported: 'FileText',
}

const loading = ref(false)
const error = ref('')
const rawText = ref('')

let loadSeq = 0

const kindLabel = computed(() => KIND_LABELS[props.kind])
const iconName = computed(() => ICON_NAMES[props.kind])
const codeLanguage = computed(() => getCodeLanguage(props.name))
const surfaceCode = computed(() =>
  props.kind === 'json' ? prettyJson(rawText.value) : rawText.value,
)

function describeReadError(
  status: number,
  ok: boolean,
  hasData: boolean,
): string {
  if (status === 401) return '登录已失效'
  if (status === 403) return '无权限读取（HTTP 403）'
  if (status === 404) return '文件不存在（HTTP 404）'
  if (status === 0) return '网络连接失败'
  if (status >= 500) return `服务端错误（HTTP ${status}）`
  if (!ok) return `读取失败（HTTP ${status}）`
  if (!hasData) return '无法读取文件内容'
  return ''
}

function extractText(result: FileContentJsonResponse | string | null): string | null {
  if (result === null) return null
  if (typeof result === 'string') return result
  if (typeof result.content === 'string') return result.content
  if (Array.isArray(result.objects)) {
    return result.objects.map((obj) => JSON.stringify(obj)).join('\n')
  }
  return null
}

async function loadContent(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  rawText.value = ''

  if (!props.path) {
    loading.value = false
    return
  }

  if (
    props.kind === 'image' ||
    props.kind === 'audio' ||
    props.kind === 'unsupported'
  ) {
    loading.value = false
    return
  }

  const result = await fetchFileContentVerbose(props.path)
  if (seq !== loadSeq) return

  const text =
    result.ok && result.data !== null ? extractText(result.data) : null
  if (text === null) {
    error.value =
      describeReadError(result.status, result.ok, result.data !== null) ||
      '无法读取文件内容'
    loading.value = false
    return
  }

  rawText.value = text
  loading.value = false
}

async function handleDownload(): Promise<void> {
  if (!props.path) return
  const url = await getFileRawUrl(props.path)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = props.name
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
}

watch(() => [props.path, props.kind], loadContent, { immediate: true })
</script>

<style scoped>
.ax-preview-pane {
  display: flex;
  flex-direction: column;
  block-size: 100%;
  min-block-size: 0;
  background: var(--bg);
}

.ax-preview-pane__header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-block-end: 1px solid var(--hairline);
  background: var(--surface);
}

.ax-preview-pane__identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-inline-size: 0;
}

.ax-preview-pane__icon {
  flex: none;
  color: var(--muted);
}

.ax-preview-pane__name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-preview-pane__kind {
  flex: none;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
}

.ax-preview-pane__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
}

.ax-preview-pane__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: var(--tap);
  block-size: var(--tap);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}

.ax-preview-pane__action:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-preview-pane__body {
  flex: 1 1 auto;
  min-block-size: 0;
  padding: var(--space-3);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ax-preview-pane__loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ax-preview-pane__line {
  block-size: 12px;
  inline-size: 100%;
}

.ax-preview-pane__line--short {
  inline-size: 60%;
}

.ax-preview-pane__state {
  align-items: center;
  text-align: center;
}

.ax-preview-pane__state .ax-state__action {
  background: transparent;
  padding-block: 0;
  font: inherit;
  cursor: pointer;
}
</style>
