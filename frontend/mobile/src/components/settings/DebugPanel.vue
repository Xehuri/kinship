<template>
  <div class="debug-panel">
    <button class="debug-toggle" @click="expanded = !expanded">
      <span class="debug-toggle__label">
        <AppIcon name="Terminal" :size="14" />
        调试信息
      </span>
      <AppIcon
        name="CaretDown"
        :size="14"
        class="debug-toggle__arrow"
        :class="{ rotated: expanded }"
      />
    </button>

    <Transition name="debug-expand">
      <div v-if="expanded" class="debug-content">
        <!-- API 连接信息 -->
        <div class="debug-section">
          <h4 class="debug-section__title">
            <AppIcon name="Plugs" :size="14" />
            API 连接
          </h4>
          <div class="debug-row">
            <span class="debug-row__label">API 地址</span>
            <span class="debug-row__value">{{ apiBaseUrl }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">Token 状态</span>
            <span class="debug-row__value" :class="tokenStatusClass">
              {{ tokenStatusText }}
            </span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">Token (前8位)</span>
            <span class="debug-row__value debug-row__value--mono">{{ tokenPreview }}</span>
          </div>
        </div>

        <!-- 实时连接信息 -->
        <div class="debug-section">
          <h4 class="debug-section__title">
            <AppIcon name="Waveform" :size="14" />
            实时连接
          </h4>
          <div class="debug-row">
            <span class="debug-row__label">SSE 连接</span>
            <span class="debug-row__value" :class="sseConnected ? 'text-success' : 'text-error'">
              {{ sseConnected ? '已连接' : '未连接' }}
            </span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">WebSocket</span>
            <span class="debug-row__value" :class="wsConnected ? 'text-success' : 'text-error'">
              {{ wsConnected ? '已连接' : '未连接' }}
            </span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">连接状态</span>
            <span class="debug-row__value" :class="connectionStateClass">
              {{ connectionStateText }}
            </span>
          </div>
        </div>

        <!-- 会话信息 -->
        <div class="debug-section">
          <h4 class="debug-section__title">
            <AppIcon name="ChatCircleDots" :size="14" />
            会话信息
          </h4>
          <div class="debug-row">
            <span class="debug-row__label">会话数量</span>
            <span class="debug-row__value">{{ sessionCount }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">当前会话</span>
            <span class="debug-row__value debug-row__value--mono">{{ currentSessionId || '--' }}</span>
          </div>
        </div>

        <!-- 客户端信息 -->
        <div class="debug-section">
          <h4 class="debug-section__title">
            <AppIcon name="Info" :size="14" />
            客户端信息
          </h4>
          <div class="debug-row">
            <span class="debug-row__label">User Agent</span>
            <span class="debug-row__value debug-row__value--mono debug-row__value--truncate">{{ userAgent }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">屏幕尺寸</span>
            <span class="debug-row__value">{{ screenSize }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">DPR</span>
            <span class="debug-row__value">{{ devicePixelRatio }}</span>
          </div>
          <div class="debug-row">
            <span class="debug-row__label">在线状态</span>
            <span class="debug-row__value" :class="isOnline ? 'text-success' : 'text-error'">
              {{ isOnline ? '在线' : '离线' }}
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useApi } from '@/composables/useApi'
import { useRealTimeSingleton } from '@/composables/useRealTime'
import { listSessions, fetchCurrentSessionId } from '@/composables/useApi'

const expanded = ref(false)

// API 状态
const api = useApi()
const rt = useRealTimeSingleton()

const apiBaseUrl = computed(() => {
  return window.location.origin
})

const token = computed(() => api.token)

const tokenStatusClass = computed(() => {
  return token.value ? 'text-success' : 'text-error'
})

const tokenStatusText = computed(() => {
  return token.value ? '有效' : '未设置'
})

const tokenPreview = computed(() => {
  if (!token.value) return '--'
  return token.value.substring(0, 8) + '...'
})

// 实时连接状态
const sseConnected = computed(() => rt.sseConnected.value)
const wsConnected = computed(() => rt.wsConnected.value)

const connectionStateClass = computed(() => {
  const state = rt.connectionState.value
  if (state === 'connected') return 'text-success'
  if (state === 'connecting') return 'text-warning'
  return 'text-error'
})

const connectionStateText = computed(() => {
  const state = rt.connectionState.value
  if (state === 'connected') return '已连接'
  if (state === 'connecting') return '连接中...'
  return '已断开'
})

// 会话信息
const sessionCount = ref(0)
const currentSessionId = ref<string | null>(null)

async function loadSessionInfo(): Promise<void> {
  try {
    const sessions = await listSessions()
    sessionCount.value = sessions?.length ?? 0
    const sid = await fetchCurrentSessionId()
    currentSessionId.value = sid
  } catch {
    sessionCount.value = 0
    currentSessionId.value = null
  }
}

// 客户端信息
const userAgent = computed(() => {
  return navigator.userAgent || '--'
})

const screenSize = computed(() => {
  return window.screen.width + ' x ' + window.screen.height
})

const devicePixelRatio = computed(() => {
  return window.devicePixelRatio || 1
})

const isOnline = ref(navigator.onLine)

function handleOnline(): void {
  isOnline.value = true
}

function handleOffline(): void {
  isOnline.value = false
}

// 展开时刷新会话信息
watch(expanded, (val) => {
  if (val) {
    loadSessionInfo()
  }
})

onMounted(() => {
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  loadSessionInfo()
})

onUnmounted(() => {
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
})
</script>

<style scoped>
.debug-panel {
  background: var(--surface);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.debug-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: none;
  background: transparent;
  color: var(--text2);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}

.debug-toggle:active {
  background: var(--surface2);
}

.debug-toggle__label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.debug-toggle__label i,
.debug-toggle__label .icon {
  color: var(--primary-light);
  font-size: 15px;
  width: 20px;
  text-align: center;
}

.debug-toggle__arrow {
  font-size: 11px;
  color: var(--text3);
  transition: transform 0.2s;
}

.debug-toggle__arrow.rotated {
  transform: rotate(180deg);
}

.debug-content {
  border-top: 1px solid var(--border);
  padding: 4px 0;
}

.debug-section {
  padding: 12px 16px;
}

.debug-section + .debug-section {
  border-top: 1px solid var(--border);
}

.debug-section__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.debug-section__title i,
.debug-section__title .icon {
  font-size: 12px;
  width: 16px;
  text-align: center;
}

.debug-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
}

.debug-row__label {
  font-size: 13px;
  color: var(--text3);
  flex-shrink: 0;
}

.debug-row__value {
  font-size: 13px;
  color: var(--text);
  text-align: right;
  word-break: break-all;
}

.debug-row__value--mono {
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 12px;
  color: var(--text2);
}

.debug-row__value--truncate {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text-success {
  color: var(--legacy-accent) !important;
}

.text-error {
  color: var(--danger) !important;
}

.text-warning {
  color: var(--legacy-accent3) !important;
}

/* 展开/折叠动画 */
.debug-expand-enter-active,
.debug-expand-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}

.debug-expand-enter-from,
.debug-expand-leave-to {
  opacity: 0;
  max-height: 0;
}

.debug-expand-enter-to,
.debug-expand-leave-from {
  opacity: 1;
  max-height: 600px;
}
</style>
