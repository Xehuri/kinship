<template>
  <div
    class="services-panel"
    :class="{ 'services-panel--compact': compact }"
    data-services-panel
    :data-services-orchestrator="orchestrator"
  >
    <div
      v-if="state === 'loading'"
      class="services-panel__list"
      aria-busy="true"
      aria-label="正在读取服务状态"
    >
      <div
        v-for="index in (compact ? 1 : 3)"
        :key="index"
        class="services-panel__row services-panel__row--skeleton"
      >
        <span class="skeleton services-panel__dot services-panel__dot--skeleton" />
        <span class="skeleton services-panel__line" />
        <span class="skeleton services-panel__line services-panel__line--short" />
      </div>
    </div>

    <p
      v-else-if="state === 'error'"
      class="services-panel__message services-panel__message--error"
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ errorMessage }}</span>
    </p>

    <template v-else>
      <p
        v-if="orchestrator === 'off'"
        class="services-panel__message services-panel__message--note"
      >
        <AppIcon name="Info" :size="14" />
        <span>服务编排器未启用，当前不管理后台进程。</span>
      </p>
      <p
        v-else-if="visibleServices.length === 0"
        class="services-panel__message services-panel__message--note"
      >
        <AppIcon name="Info" :size="14" />
        <span>{{ compact ? '暂无关键服务状态。' : '后端未返回任何服务状态。' }}</span>
      </p>
      <ul v-else class="services-panel__list">
        <li
          v-for="service in visibleServices"
          :key="service.id"
          class="services-panel__row"
          :data-service-id="service.id"
          :data-service-state="service.state"
        >
          <span
            class="services-panel__dot"
            :class="`services-panel__dot--${dotTone(service.state)}`"
            aria-hidden="true"
          />
          <span class="services-panel__name">
            <span class="services-panel__title">{{ serviceName(service.id) }}</span>
            <span v-if="service.critical" class="services-panel__chip">关键</span>
          </span>
          <span v-if="!compact" class="services-panel__action">
            <button
              v-if="service.state === 'blocked'"
              class="services-panel__button"
              type="button"
              data-service-action="configure"
              @click="emit('configure', service.id)"
            >
              去配置
            </button>
            <button
              v-else-if="service.state === 'failed'"
              class="services-panel__button"
              type="button"
              :disabled="retryingId !== ''"
              data-service-action="retry"
              @click="emit('retry', service.id)"
            >
              {{ retryingId === service.id ? '重试中…' : '重试' }}
            </button>
          </span>
          <span class="services-panel__meta">
            <span class="services-panel__state">{{ stateText(service.state) }}</span>
            <span v-if="service.state === 'ready'">{{ pidText(service.pid) }}</span>
            <span v-else-if="service.state === 'blocked'">
              {{ reasonText(service.reason_code) }}
            </span>
            <span v-else-if="service.state === 'failed'">{{ failedDetail(service) }}</span>
          </span>
        </li>
      </ul>

      <p
        v-if="refreshError"
        class="services-panel__message services-panel__message--note"
        data-services-refresh-error
      >
        <AppIcon name="Warning" :size="14" />
        <span>{{ refreshError }}</span>
      </p>
      <p
        v-if="actionMessage"
        class="services-panel__message services-panel__message--success"
        role="status"
        data-services-action-message
      >
        <AppIcon name="CheckCircle" :size="14" />
        <span>{{ actionMessage }}</span>
      </p>
      <p
        v-if="actionError"
        class="services-panel__message services-panel__message--error"
        role="alert"
        data-services-action-error
      >
        <AppIcon name="WarningCircle" :size="14" />
        <span>{{ actionError }}</span>
      </p>
      <p
        v-if="updatedAtMs > 0"
        class="services-panel__updated"
        data-services-updated-at
        :data-updated-ms="updatedAtMs"
      >
        更新于 {{ clockText }} · 每 5 秒刷新
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { ServiceStatusEntry } from '@/api/services'

const props = withDefaults(
  defineProps<{
    services: ServiceStatusEntry[]
    state: 'loading' | 'ready' | 'error'
    orchestrator: string
    errorMessage?: string
    refreshError?: string
    retryingId?: string
    actionMessage?: string
    actionError?: string
    updatedAtMs?: number
    compact?: boolean
  }>(),
  {
    errorMessage: '',
    refreshError: '',
    retryingId: '',
    actionMessage: '',
    actionError: '',
    updatedAtMs: 0,
    compact: false,
  },
)

const emit = defineEmits<{
  configure: [serviceId: string]
  retry: [serviceId: string]
}>()

/** 服务 id 只用于展示名映射；未知 id 原样显示，不推断服务能力。 */
const SERVICE_NAMES: Record<string, string> = {
  kernel: '音频内核',
  moss_watcher: 'MOSS 监听',
  loom: 'AI 助手（Loom）',
}

const REASON_TEXT: Record<string, string> = {
  missing_config: '缺少必要配置',
  disabled: '未启用',
  gate_failed: '启动条件未满足',
  spawn_failed: '进程启动失败',
  crashed: '运行中异常退出',
  restart_exhausted: '多次重启后已停止',
  stopped: '已停止',
  manually_paused: '已手动暂停',
}

const STATE_TEXT: Record<string, string> = {
  starting: '启动中',
  ready: '运行中',
  stopping: '停止中',
  blocked: '待配置',
  failed: '异常',
  stopped: '已停止',
}

/** 看起来像堆栈/系统错误原文的片段一律不直接展示。 */
const TECHNICAL_DETAIL =
  /(traceback|stack trace|file\s+"|line\s+\d+|exception|errno|oserror|http\s+\d{3}|exit code|return\s*code|signal\s+\d+|raised|handshake|start action|port\/|\bpid\b|stdout|stderr|\{\}|\\|_[a-z]|[a-z]_|\/[a-z])/i

const visibleServices = computed(() =>
  props.compact ? props.services.filter((service) => service.critical) : props.services,
)

const clockText = computed(() => {
  const date = new Date(props.updatedAtMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
})

function serviceName(serviceId: string): string {
  return SERVICE_NAMES[serviceId] ?? serviceId
}

function stateText(state: string): string {
  return STATE_TEXT[state] ?? '状态待确认'
}

function reasonText(reasonCode: string): string {
  return REASON_TEXT[reasonCode] ?? '状态待确认'
}

function dotTone(state: string): string {
  switch (state) {
    case 'ready':
      return 'ready'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    case 'starting':
    case 'stopping':
      return 'pending'
    case 'stopped':
      return 'stopped'
    default:
      return 'unknown'
  }
}

function pidText(pid: number | null): string {
  return pid === null ? '已在运行' : `PID ${pid}`
}

/** 去掉后端 detail 可能带的 reason 前缀，保留纯人话摘要。 */
function stripReasonPrefix(detail: string): string {
  return detail.replace(
    /^(missing_config|disabled|gate_failed|spawn_failed|crashed|restart_exhausted|stopped|manually_paused)\s*:\s*/i,
    '',
  )
}

function safeDetail(detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed) return ''
  // 面板只展示中文人话；纯英文/技术原文一律回退到 reason 文案。
  if (!/[\u4e00-\u9fff]/.test(trimmed)) return ''
  if (TECHNICAL_DETAIL.test(trimmed)) return ''
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed
}

function failedDetail(service: ServiceStatusEntry): string {
  const safe = safeDetail(stripReasonPrefix(service.detail))
  if (safe) return safe
  const reason = reasonText(service.reason_code)
  return reason === '状态待确认' ? '服务运行异常，请重试。' : reason
}
</script>
