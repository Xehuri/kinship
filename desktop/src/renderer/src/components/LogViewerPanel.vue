<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  ArrowDown,
  CircleAlert,
  LoaderCircle,
  Monitor,
  RefreshCw,
  ScrollText,
  X,
} from 'lucide-vue-next'
import type { LogFileView, LogSource, LogStreamEvent } from '../../../shared/types'
import { useDesktopApi } from '../composables/useDesktopApi'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'open-folder'): void
}>()

const MAX_LINES = 2000
const FOLLOW_THRESHOLD_PX = 28
const api = useDesktopApi()

const activeTab = ref<LogSource>('desktop')
const loading = ref(false)
const error = ref<string | null>(null)
const streaming = ref(false)
const streamSupported = ref(true)
const following = ref(true)
const closeButton = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const logs = ref<Record<LogSource, LogFileView>>({
  desktop: { path: '', lines: [] },
  sensor: { path: '', lines: [] },
})
let unsubscribe: (() => void) | null = null
let openSequence = 0

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const activeFile = computed<LogFileView>(() => logs.value[activeTab.value])
const activeTabLabel = computed(() => (activeTab.value === 'desktop' ? '桌面端' : 'PC 采集端'))
const desktopCount = computed(() => logs.value.desktop.lines.length)
const sensorCount = computed(() => logs.value.sensor.lines.length)

function replaceFile(source: LogSource, file: LogFileView): void {
  logs.value = {
    ...logs.value,
    [source]: {
      path: file.path,
      lines: file.lines.slice(-MAX_LINES),
      ...(file.error !== undefined ? { error: file.error } : {}),
    },
  }
}

function appendLines(source: LogSource, path: string, lines: readonly string[]): void {
  const current = logs.value[source]
  logs.value = {
    ...logs.value,
    [source]: {
      path: path || current.path,
      lines: [...current.lines, ...lines].slice(-MAX_LINES),
      ...(current.error !== undefined ? { error: current.error } : {}),
    },
  }
}

function scrollToBottom(): void {
  void nextTick(() => {
    const element = contentRef.value
    if (element !== null) element.scrollTop = element.scrollHeight
  })
}

function onStreamEvent(event: LogStreamEvent): void {
  if (event.type === 'snapshot' || event.type === 'reset' || event.reset === true) {
    replaceFile(event.source, {
      path: event.path,
      lines: event.lines,
      ...(event.error !== undefined ? { error: event.error } : {}),
    })
  } else {
    appendLines(event.source, event.path, event.lines)
  }
  loading.value = false
  error.value = null
  if (following.value) scrollToBottom()
}

function onContentScroll(): void {
  const element = contentRef.value
  if (element === null) return
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight
  following.value = distance <= FOLLOW_THRESHOLD_PX
}

function toggleFollow(): void {
  following.value = !following.value
  if (following.value) scrollToBottom()
}

async function loadSnapshotFallback(): Promise<void> {
  loading.value = true
  error.value = null
  const response = await api.readLogs(300)
  loading.value = false
  if (!response.ok) {
    error.value =
      response.code === 'API_UNAVAILABLE'
        ? '当前桌面端不支持读取日志，请使用“打开日志文件夹”查看原始文件。'
        : response.error || '读取日志失败'
    return
  }
  replaceFile('desktop', response.data.desktop)
  replaceFile('sensor', response.data.sensor)
}

async function stopStream(): Promise<void> {
  openSequence += 1
  streaming.value = false
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
  if (streamSupported.value) await api.stopLogStream()
}

async function startStream(): Promise<void> {
  const sequence = openSequence
  loading.value = true
  error.value = null
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
  unsubscribe = api.onLogEvent((event) => {
    if (sequence !== openSequence) return
    onStreamEvent(event)
  })

  const response = await api.startLogStream({ lines: 300 })
  if (sequence !== openSequence) return
  if (response.ok) {
    streaming.value = true
    streamSupported.value = true
    if (following.value) scrollToBottom()
    return
  }

  streaming.value = false
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
  if (response.code === 'API_UNAVAILABLE') {
    streamSupported.value = false
    await loadSnapshotFallback()
    return
  }
  loading.value = false
  error.value = response.error || '无法启动日志流'
}

async function refresh(): Promise<void> {
  if (loading.value) return
  if (streamSupported.value) {
    await stopStream()
    await startStream()
    return
  }
  await loadSnapshotFallback()
}

function selectTab(tab: LogSource): void {
  activeTab.value = tab
  if (following.value) scrollToBottom()
}

function onTabKeydown(event: KeyboardEvent, tab: LogSource): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const next: LogSource = tab === 'desktop' ? 'sensor' : 'desktop'
  activeTab.value = next
  void nextTick(() => {
    document.getElementById(`log-tab-${next}`)?.focus()
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || panelRef.value === null) return
  const focusable = Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  )
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first?.focus()
  }
}

window.addEventListener('keydown', onKeydown)

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      await stopStream()
      return
    }
    activeTab.value = 'desktop'
    logs.value = {
      desktop: { path: '', lines: [] },
      sensor: { path: '', lines: [] },
    }
    error.value = null
    following.value = true
    streamSupported.value = true
    await nextTick()
    closeButton.value?.focus()
    await startStream()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  void stopStream()
})
</script>

<template>
  <div v-if="open" class="log-overlay" data-test="log-viewer" @click.self="emit('close')">
    <section
      ref="panelRef"
      class="log-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="log-viewer-title"
    >
      <header class="log-head">
        <div>
          <p class="eyebrow">DIAGNOSTICS</p>
          <h2 id="log-viewer-title">运行日志</h2>
          <p class="log-sub">
            <template v-if="streaming">实时跟随本机日志，初始最近 300 行；只读，不包含凭据。</template>
            <template v-else>最近 300 行，只读本机日志文件，不包含凭据。</template>
          </p>
        </div>
        <div class="log-head__actions">
          <button
            type="button"
            class="btn btn--sm"
            data-test="log-refresh"
            :disabled="loading"
            @click="refresh"
          >
            <LoaderCircle v-if="loading" class="spinner" :size="14" :stroke-width="2" />
            <RefreshCw v-else :size="14" :stroke-width="2" />
            {{ streaming ? '重新载入' : '刷新' }}
          </button>
          <button
            ref="closeButton"
            type="button"
            class="log-close"
            data-test="log-close"
            aria-label="关闭日志面板"
            @click="emit('close')"
          >
            <X :size="17" :stroke-width="2" />
          </button>
        </div>
      </header>

      <div class="log-tabs" role="tablist" aria-label="日志来源">
        <button
          id="log-tab-desktop"
          type="button"
          role="tab"
          class="log-tab"
          data-test="log-tab-desktop"
          :aria-selected="activeTab === 'desktop'"
          :tabindex="activeTab === 'desktop' ? 0 : -1"
          aria-controls="log-file-panel"
          @click="selectTab('desktop')"
          @keydown="onTabKeydown($event, 'desktop')"
        >
          <Monitor :size="14" :stroke-width="2" />
          桌面端
          <span class="log-tab__count">{{ desktopCount }}</span>
        </button>
        <button
          id="log-tab-sensor"
          type="button"
          role="tab"
          class="log-tab"
          data-test="log-tab-sensor"
          :aria-selected="activeTab === 'sensor'"
          :tabindex="activeTab === 'sensor' ? 0 : -1"
          aria-controls="log-file-panel"
          @click="selectTab('sensor')"
          @keydown="onTabKeydown($event, 'sensor')"
        >
          <ScrollText :size="14" :stroke-width="2" />
          PC 采集端
          <span class="log-tab__count">{{ sensorCount }}</span>
        </button>
        <span class="log-live" :data-live="streaming" aria-live="polite">
          <span class="status-dot" :class="streaming ? 'status-dot--ok status-dot--live' : 'status-dot--neutral'" aria-hidden="true" />
          {{ streaming ? '实时流' : '手动刷新' }}
        </span>
      </div>

      <div
        id="log-file-panel"
        class="log-body"
        role="tabpanel"
        :aria-labelledby="`log-tab-${activeTab}`"
      >
        <div v-if="loading" class="log-empty" role="status">
          <LoaderCircle class="spinner" :size="16" :stroke-width="2" />
          正在读取日志…
        </div>
        <div v-else-if="error" class="notice notice--danger" role="alert" data-test="log-error">
          <CircleAlert :size="15" :stroke-width="2" />
          <div>{{ error }}</div>
        </div>
        <template v-else>
          <div class="log-meta">
            <span class="log-path mono" :title="activeFile.path" :data-test="`log-path-${activeTab}`">
              {{ activeFile.path || '日志路径不可用' }}
            </span>
            <span class="log-count">{{ activeFile.lines.length }} 行</span>
            <button
              type="button"
              class="link-btn log-follow"
              data-test="log-follow"
              :aria-pressed="following"
              @click="toggleFollow"
            >
              <ArrowDown :size="13" :stroke-width="2" />
              {{ following ? '自动跟随' : '恢复跟随' }}
            </button>
            <button
              type="button"
              class="link-btn"
              data-test="log-open-folder"
              @click="emit('open-folder')"
            >
              打开日志文件夹
            </button>
          </div>
          <div
            v-if="activeFile.error"
            class="notice notice--warning"
            role="status"
            data-test="log-empty"
          >
            <CircleAlert :size="15" :stroke-width="2" />
            <div>{{ activeFile.error }}</div>
          </div>
          <div v-else-if="activeFile.lines.length === 0" class="log-empty" data-test="log-empty">
            日志文件为空或尚未生成。
          </div>
          <pre
            v-else
            ref="contentRef"
            class="log-content"
            data-test="log-content"
            tabindex="0"
            :aria-label="`${activeTabLabel}日志内容，共 ${activeFile.lines.length} 行`"
            @scroll.passive="onContentScroll"
          ><code><span v-for="(line, index) in activeFile.lines" :key="index" class="log-line">{{ line.length > 0 ? line : ' ' }}</span></code></pre>
        </template>
      </div>

      <footer class="log-foot">
        <span>{{ streaming ? '日志实时追加；向上滚动会暂停自动跟随。' : '当前为手动刷新模式。' }}</span>
        <button type="button" class="btn btn--sm btn--ghost" @click="emit('close')">
          关闭
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.log-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: color-mix(in srgb, #1f1c18 46%, transparent);
}

.log-panel {
  display: flex;
  flex-direction: column;
  width: min(960px, calc(100vw - 28px));
  max-height: calc(100vh - 40px);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.log-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-5) var(--space-3);
}

.log-head h2 {
  margin: 3px 0 0;
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: 600;
}

.log-sub {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.log-head__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
}

.log-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.log-close:hover {
  background: var(--inset);
  color: var(--ink);
}

.log-close:focus-visible,
.log-tab:focus-visible,
.log-content:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.log-tabs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--border);
}

.log-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
}

.log-tab:hover {
  color: var(--ink);
}

.log-tab[aria-selected='true'] {
  border-bottom-color: var(--accent);
  color: var(--ink);
}

.log-tab__count {
  min-width: 20px;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--inset);
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10px;
  text-align: center;
}

.log-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: var(--text-faint);
  font-size: 11px;
}

.log-live[data-live='true'] {
  color: var(--success-ink);
}

.log-body {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5) var(--space-5);
}

.log-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.log-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-count {
  flex: none;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.log-follow {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: none;
}

.log-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.log-content {
  flex: 1;
  min-height: 200px;
  max-height: 48vh;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  overflow: auto;
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  background: var(--code-surface);
  color: var(--code-text);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.7;
  counter-reset: log-line;
  tab-size: 2;
}

.log-content code {
  display: block;
  min-width: 0;
  font: inherit;
}

.log-line {
  position: relative;
  display: block;
  padding-left: 3.6em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  counter-increment: log-line;
}

.log-line::before {
  position: absolute;
  top: 0;
  left: 0;
  width: 2.6em;
  color: var(--code-line);
  text-align: right;
  content: counter(log-line);
  user-select: none;
}

.log-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-5);
  border-top: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-faint);
  font-size: var(--text-xs);
}

@media (max-width: 720px) {
  .log-overlay {
    padding: var(--space-2);
  }

  .log-panel {
    width: calc(100vw - 12px);
    max-height: calc(100vh - 12px);
  }

  .log-head {
    flex-direction: column;
    padding: var(--space-4);
  }

  .log-head__actions {
    align-self: flex-end;
  }

  .log-tabs,
  .log-body {
    padding-right: var(--space-4);
    padding-left: var(--space-4);
  }

  .log-foot {
    padding-right: var(--space-4);
    padding-left: var(--space-4);
  }
}
</style>
