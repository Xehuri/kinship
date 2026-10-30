<template>
  <SettingsSection
    v-if="mode === 'full'"
    title="服务状态"
    description="后台进程的编排状态，每 5 秒自动刷新"
  >
    <template #actions>
      <button
        class="settings-button settings-button--compact"
        type="button"
        data-services-refresh
        :disabled="state === 'loading'"
        @click="load(true)"
      >
        {{ state === 'loading' ? '读取中…' : '刷新' }}
      </button>
    </template>

    <ServiceStatusList
      :services="services"
      :state="state"
      :orchestrator="orchestrator"
      :error-message="errorMessage"
      :refresh-error="refreshError"
      :retrying-id="retryingId"
      :action-message="actionMessage"
      :action-error="actionError"
      :updated-at-ms="updatedAtMs"
      @configure="goConfigure"
      @retry="handleRetry"
    />
  </SettingsSection>

  <ServiceStatusList
    v-else
    compact
    :services="services"
    :state="state"
    :orchestrator="orchestrator"
    :error-message="errorMessage"
    :refresh-error="refreshError"
    :retrying-id="retryingId"
    :action-message="actionMessage"
    :action-error="actionError"
    :updated-at-ms="updatedAtMs"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SettingsSection from './SettingsSection.vue'
import ServiceStatusList from './ServiceStatusList.vue'
import {
  fetchServicesStatus,
  retryConfigApply,
  type RetryApplyFailureReason,
  type ServiceStatusEntry,
  type ServicesStatusFailureReason,
} from '@/api/services'
import './services.css'

withDefaults(
  defineProps<{
    /** full = 设置页卡片；compact = 引导里程碑页（仅 critical 服务）。 */
    mode?: 'full' | 'compact'
  }>(),
  {
    mode: 'full',
  },
)

type LoadState = 'loading' | 'ready' | 'error'

const POLL_INTERVAL_MS = 5000

const FAILURE_TEXT: Record<ServicesStatusFailureReason, string> = {
  unauthorized: '登录状态已失效，服务状态不可用，请重新登录后再试。',
  not_found: '当前后端不支持服务状态接口，无法读取编排状态。',
  unavailable: '无法读取服务状态，请检查连接后重试。',
}

const RETRY_FAILURE_TEXT: Record<RetryApplyFailureReason, string> = {
  unauthorized: '登录状态已失效，请重新登录后再试。',
  not_found: '当前后端不支持配置重试接口。',
  forbidden: '重试需要密码校验，请在「系统配置」中完成重试。',
  rejected: '重试请求未被接受，请稍后再试。',
  unavailable: '重试请求失败，请稍后再试。',
}

/**
 * service_id -> 设置页落点。
 *
 * 三个服务的配置键都归「系统与关于 > 系统配置」卡片；后续若某个服务有
 * 独立设置分组，只改这里的映射，不动渲染逻辑。
 */
const SERVICE_SETTINGS_ROUTE: Record<string, string> = {
  kernel: '/settings#settings-group-system',
  moss_watcher: '/settings#settings-group-system',
  loom: '/settings#settings-group-system',
}

const DEFAULT_SETTINGS_ROUTE = '/settings#settings-group-system'

const router = useRouter()

const state = ref<LoadState>('loading')
const services = ref<ServiceStatusEntry[]>([])
const orchestrator = ref('')
const errorMessage = ref('')
const refreshError = ref('')
const updatedAtMs = ref(0)
const retryingId = ref('')
const actionMessage = ref('')
const actionError = ref('')

/** 请求序号：只接受最后一次发起的结果，避免轮询与手动刷新互相覆盖。 */
let requestSeq = 0
let timer: ReturnType<typeof setInterval> | null = null

async function load(showLoading = false): Promise<void> {
  const seq = ++requestSeq
  if (showLoading) {
    state.value = 'loading'
    errorMessage.value = ''
  }

  const result = await fetchServicesStatus()
  if (seq !== requestSeq) return

  if (result.ok) {
    services.value = result.services
    orchestrator.value = result.orchestrator
    updatedAtMs.value = Date.now()
    errorMessage.value = ''
    refreshError.value = ''
    state.value = 'ready'
    return
  }

  // 轮询失败时保留上一次成功结果，避免状态面板闪成错误页。
  if (state.value === 'ready') {
    refreshError.value = FAILURE_TEXT[result.reason]
    return
  }

  services.value = []
  orchestrator.value = ''
  updatedAtMs.value = 0
  errorMessage.value = FAILURE_TEXT[result.reason]
  state.value = 'error'
}

function goConfigure(serviceId: string): void {
  const route = SERVICE_SETTINGS_ROUTE[serviceId] ?? DEFAULT_SETTINGS_ROUTE
  void router.push(route).then(() => {
    const anchorIndex = route.indexOf('#')
    if (anchorIndex < 0 || typeof document === 'undefined') return
    const anchor = route.slice(anchorIndex + 1)
    document.getElementById(anchor)?.scrollIntoView({ block: 'start' })
  })
}

async function handleRetry(serviceId: string): Promise<void> {
  if (retryingId.value !== '') return
  retryingId.value = serviceId
  actionMessage.value = ''
  actionError.value = ''

  const result = await retryConfigApply()
  retryingId.value = ''

  if (!result.ok) {
    actionError.value = RETRY_FAILURE_TEXT[result.reason]
    return
  }

  actionMessage.value = result.partial
    ? '部分失败项已重新应用，正在刷新服务状态…'
    : '重试已提交，正在刷新服务状态…'
  await load(false)
}

onMounted(() => {
  void load()
  timer = setInterval(() => {
    void load(false)
  }, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
})
</script>
