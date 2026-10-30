<template>
  <SettingsSection title="调试" description="诊断信息与开发开关">
    <button
      class="settings-row"
      type="button"
      data-setting-row="debug-panel"
      :aria-expanded="showDebug"
      @click="showDebug = !showDebug"
    >
      <span class="settings-row__icon">
        <AppIcon name="Terminal" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">调试面板</span>
        <span class="settings-row__hint">连接状态、Token、会话与客户端信息</span>
      </span>
      <span class="settings-row__chevron">
        <AppIcon name="CaretRight" :size="14" />
      </span>
    </button>

    <button
      class="settings-row"
      type="button"
      data-setting-row="realtime-debug"
      :aria-pressed="realtimeDebug"
      @click="toggleRealtimeDebug"
    >
      <span class="settings-row__icon">
        <AppIcon name="Waveform" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">实时连接调试日志</span>
        <span class="settings-row__hint">SSE / WS 事件输出到浏览器控制台；原始消息见下方<span class="settings-nowrap">「WS 日志」</span></span>
      </span>
      <span class="settings-row__value">{{ realtimeDebug ? '已开启' : '已关闭' }}</span>
    </button>

    <button
      class="settings-row"
      type="button"
      data-setting-row="ws-log"
      @click="openWsLog"
    >
      <span class="settings-row__icon">
        <AppIcon name="Plugs" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">WS 日志</span>
        <span class="settings-row__hint">查看 WebSocket 原始消息，最多保留 200 条</span>
      </span>
      <span class="settings-row__chevron">
        <AppIcon name="CaretRight" :size="14" />
      </span>
    </button>

    <button class="settings-row" type="button" data-setting-row="refresh" @click="refreshPage">
      <span class="settings-row__icon">
        <AppIcon name="ArrowClockwise" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">刷新页面</span>
        <span class="settings-row__hint">重新加载当前 SPA 与实时连接</span>
      </span>
      <span class="settings-row__chevron">
        <AppIcon name="ArrowsClockwise" :size="14" />
      </span>
    </button>

    <button
      class="settings-row"
      type="button"
      data-setting-row="mock-data"
      :aria-pressed="mockDataEnabled"
      @click="toggleMockData"
    >
      <span class="settings-row__icon">
        <AppIcon name="Database" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">演示模式</span>
        <span class="settings-row__hint">使用内置演示对话替代真实会话；切换后<span class="settings-nowrap">刷新生效</span></span>
      </span>
      <span class="settings-row__value">{{ mockDataEnabled ? '已开启' : '已关闭' }}</span>
    </button>
  </SettingsSection>

  <Teleport to="body">
    <Transition name="settings-fade">
      <div v-if="showDebug" class="settings-debug-overlay">
        <div class="settings-debug-overlay__header">
          <span class="settings-debug-overlay__title">
            <AppIcon name="Terminal" :size="16" />
            <span>调试面板</span>
          </span>
          <button
            class="settings-debug-overlay__close"
            type="button"
            aria-label="关闭调试面板"
            @click="showDebug = false"
          >
            <AppIcon name="X" :size="18" />
          </button>
        </div>
        <div class="settings-debug-overlay__body">
          <DebugPanel />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import DebugPanel from './DebugPanel.vue'
import SettingsSection from './SettingsSection.vue'
import { USE_MOCK_DATA, setMockDataEnabled } from '@/composables/useMockData'
import { isSSEDebugEnabled, setSSEDebug } from '@/composables/streaming/debug'
import { useWsLog } from '@/composables/useWsLog'

const showDebug = ref(false)
const mockDataEnabled = ref(USE_MOCK_DATA)
const realtimeDebug = ref(isSSEDebugEnabled())
const { open: openWsLog } = useWsLog()

function toggleRealtimeDebug(): void {
  realtimeDebug.value = !realtimeDebug.value
  setSSEDebug(realtimeDebug.value)
  try {
    localStorage.setItem('axeuh_sse_debug', realtimeDebug.value ? '1' : '0')
  } catch {
    // localStorage 不可用时只保留本次会话的开关
  }
}

function refreshPage(): void {
  window.location.reload()
}

function toggleMockData(): void {
  mockDataEnabled.value = !mockDataEnabled.value
  setMockDataEnabled(mockDataEnabled.value)
  window.location.reload()
}
</script>
