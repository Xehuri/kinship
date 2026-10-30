<template>
  <SettingsSection
    title="数据源"
    description="后端可验证的采集与连接状态"
  >
    <template #actions>
      <button
        class="settings-button settings-button--compact sources-refresh-btn"
        type="button"
        :disabled="state === 'loading'"
        @click="load"
      >
        {{ state === 'loading' ? '读取中…' : '刷新' }}
      </button>
    </template>

    <div
      v-if="state === 'loading'"
      class="settings-source-list"
      aria-busy="true"
      aria-label="正在读取数据源状态"
    >
      <div v-for="index in 4" :key="index" class="settings-source">
        <span class="skeleton settings-source__loading" />
        <span class="skeleton settings-source__loading settings-source__loading--short" />
      </div>
    </div>

    <div v-else-if="state === 'error'" class="settings-message settings-message--error" role="alert">
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ errorMessage }}</span>
    </div>

    <template v-else>
      <p v-if="sources.length === 0" class="settings-message settings-message--note">
        <AppIcon name="Info" :size="14" />
        <span>后端未返回任何数据源状态。</span>
      </p>
      <ul v-else class="settings-source-list">
        <li
          v-for="source in sources"
          :key="source.id"
          class="settings-source"
          :data-source-id="source.id"
        >
          <span class="settings-source__name">
            <AppIcon name="Database" :size="15" />
            <span class="settings-row__title">{{ source.name }}</span>
          </span>
          <span class="settings-status" :class="`settings-status--${source.status}`">
            <AppIcon :name="statusMeta(source.status).icon" :size="13" />
            <span>{{ statusMeta(source.status).label }}</span>
          </span>
          <span class="settings-source__meta">
            <span>最后同步 {{ formatSync(source.last_sync) }}</span>
            <span>记录 {{ formatRecords(source.records) }}</span>
            <span v-if="source.detail" class="settings-source__detail">{{ source.detail }}</span>
          </span>
        </li>
      </ul>
      <p v-if="generatedLabel" class="settings-generated">
        {{ generatedLabel }}
      </p>
    </template>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import {
  fetchSourcesHealth,
  type SourceHealthItem,
  type SourceStatus,
  type SourcesHealthFailureReason,
} from '@/api/sources'
import { formatDate, formatTime } from '@/utils/format'

type LoadState = 'loading' | 'ready' | 'error'

interface StatusMeta {
  label: string
  icon: string
}

const STATUS_META: Record<SourceStatus, StatusMeta> = {
  ok: { label: '正常', icon: 'CheckCircle' },
  degraded: { label: '降级', icon: 'Warning' },
  stale: { label: '过期', icon: 'Clock' },
  offline: { label: '离线', icon: 'XCircle' },
  unknown: { label: '未知', icon: 'Circle' },
}

const FAILURE_TEXT: Record<SourcesHealthFailureReason, string> = {
  unauthorized: '登录状态已失效，数据源状态不可用，请重新登录后再试。',
  not_found: '当前后端不支持数据源健康接口，数据源状态不可用。',
  unavailable: '无法读取数据源状态，请检查连接后重试。',
}

const state = ref<LoadState>('loading')
const sources = ref<SourceHealthItem[]>([])
const generatedAt = ref('')
const errorMessage = ref('')

/** 请求序号: 只接受最后一次发起的结果, 避免连点刷新时旧响应覆盖新状态 */
let requestSeq = 0

const generatedLabel = computed(() => {
  if (!generatedAt.value) return ''
  const parsed = new Date(generatedAt.value)
  if (Number.isNaN(parsed.getTime())) return ''
  return `生成于 ${formatDate(generatedAt.value)} ${formatTime(generatedAt.value)}`
})

function statusMeta(status: SourceStatus): StatusMeta {
  return STATUS_META[status] ?? STATUS_META.unknown
}

function formatSync(value: string | null): string {
  if (!value) return '无同步时间'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return `${formatDate(value)} ${formatTime(value)}`
}

function formatRecords(value: number | null): string {
  return value === null ? '未知' : `${value} 条`
}

async function load(): Promise<void> {
  const seq = ++requestSeq
  state.value = 'loading'
  errorMessage.value = ''

  const result = await fetchSourcesHealth()
  if (seq !== requestSeq) return

  if (result.ok) {
    sources.value = result.sources
    generatedAt.value = result.generatedAt
    state.value = 'ready'
    return
  }

  sources.value = []
  generatedAt.value = ''
  errorMessage.value = FAILURE_TEXT[result.reason]
  state.value = 'error'
}

onMounted(load)
</script>
