<template>
  <section class="onboarding-panel" data-onboarding-panel="loom">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">AI 助手</h3>
      <p class="onboarding-panel__desc">
        Loom 负责对话、报告与自动化。填写模型渠道后，后端会写入配置、启动 Loom 并完成健康检查。
      </p>
    </header>

    <StepWhy step-id="loom" :detected="detected" />

    <div class="onboarding-fields">
      <FormField
        field-id="onboarding-loom-port"
        label="端口"
        hint="Loom 监听的本机端口，默认 5100；已有地址会自动带入。"
        required
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="port"
            class="onboarding-input"
            type="number"
            inputmode="numeric"
            min="1"
            max="65535"
            :aria-describedby="describedBy"
            data-onboarding-loom-port
            @input="portTouched = true"
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-loom-provider"
        label="提供商"
        hint="渠道（provider）名称，例如 new-api 或 deepseek。"
        required
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="provider"
            class="onboarding-input"
            type="text"
            autocomplete="off"
            placeholder="deepseek"
            :aria-describedby="describedBy"
            data-onboarding-loom-provider
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-loom-base-url"
        label="Base URL"
        hint="OpenAI 兼容端点，例如 https://api.example.com/v1。"
        required
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="baseUrl"
            class="onboarding-input"
            type="url"
            inputmode="url"
            autocomplete="off"
            placeholder="https://api.example.com/v1"
            :aria-describedby="describedBy"
            data-onboarding-loom-base-url
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-loom-model"
        label="模型"
        hint="主模型 ID，例如 deepseek-flash。"
        required
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="model"
            class="onboarding-input"
            type="text"
            autocomplete="off"
            placeholder="deepseek-flash"
            :aria-describedby="describedBy"
            data-onboarding-loom-model
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-loom-context-window"
        label="上下文上限"
        hint="模型单次可接收的上下文 token 数，按模型能力填写；默认 128000。"
        required
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="contextWindow"
            class="onboarding-input"
            type="number"
            inputmode="numeric"
            min="1024"
            max="10000000"
            :aria-describedby="describedBy"
            data-onboarding-loom-context-window
            @input="contextTouched = true"
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-loom-api-key"
        label="API Key"
        hint="密钥只写入 Loom 配置，不会回显到页面。"
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="apiKey"
            class="onboarding-input"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            placeholder="sk-..."
            :aria-describedby="describedBy"
            data-onboarding-loom-api-key
          />
        </template>
      </FormField>
    </div>

    <p
      v-if="keyConfigured"
      class="onboarding-hint"
      data-onboarding-loom-key-note
    >
      已配置，留空保持不变。
    </p>

    <p
      v-if="result"
      class="onboarding-alert"
      :class="result.ok ? 'onboarding-alert--success' : 'onboarding-alert--error'"
      :data-state="result.ok ? 'ok' : 'failed'"
      :role="result.ok ? 'status' : 'alert'"
      data-onboarding-loom-result
    >
      <AppIcon :name="result.ok ? 'CheckCircle' : 'WarningCircle'" :size="14" />
      <span>{{ result.ok ? successSummary : failureSummary }}</span>
    </p>

    <p
      v-if="displayError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-loom-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ displayError }}</span>
    </p>

    <LongTaskProgress
      :active="pendingAction === 'setup'"
      label="正在应用 Loom 配置并启动服务"
    />

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-loom-setup
        :data-busy="busy ? 'true' : undefined"
        :disabled="busy"
        @click="handleSetup"
      >
        <AppIcon
          :name="busy ? 'CircleNotch' : 'Play'"
          :size="14"
          :class="busy ? 'onboarding-spinner' : undefined"
        />
        <span>{{ setupLabel }}</span>
      </button>
      <button
        class="onboarding-button"
        type="button"
        data-onboarding-loom-skip
        :data-busy="pendingAction === 'skip' ? 'true' : undefined"
        :disabled="busy"
        @click="handleSkip"
      >
        <AppIcon
          v-if="pendingAction === 'skip'"
          name="CircleNotch"
          :size="14"
          class="onboarding-spinner"
        />
        <span>{{ skipLabel }}</span>
        <AppIcon v-if="pendingAction !== 'skip'" name="ArrowRight" :size="14" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import FormField from '@/components/settings/form/FormField.vue'
import LongTaskProgress from '@/components/onboarding/LongTaskProgress.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import type {
  LoomSetupRequest,
  LoomSetupResult,
  LoomStatus,
} from '@/api/system'

const props = withDefaults(
  defineProps<{
    currentPassword?: string
  }>(),
  {
    currentPassword: '',
  },
)

const emit = defineEmits<{
  next: []
}>()

const {
  loom: loomStatus,
  error: onboardingError,
  loadLoom,
  setupLoom,
  recordStep,
  refresh,
} = useOnboarding()

const DEFAULT_PORT = '5100'
const DEFAULT_CONTEXT_WINDOW = '128000'
const MIN_CONTEXT_WINDOW = 1024
const MAX_CONTEXT_WINDOW = 10_000_000

const port = ref<string | number>(DEFAULT_PORT)
const provider = ref('')
const baseUrl = ref('')
const model = ref('')
const contextWindow = ref<string | number>(DEFAULT_CONTEXT_WINDOW)
const apiKey = ref('')
type PendingAction = '' | 'setup' | 'skip'
const pendingAction = ref<PendingAction>('')
const busy = computed(() => pendingAction.value !== '')
const localError = ref('')
const result = ref<LoomSetupResult | null>(null)
const portTouched = ref(false)
const contextTouched = ref(false)

const displayError = computed(
  () => localError.value || onboardingError.value?.message || '',
)
const setupLabel = computed(() =>
  pendingAction.value === 'setup' ? '正在启动并应用…' : '启动并应用',
)
const skipLabel = computed(() =>
  pendingAction.value === 'skip' ? '正在跳过…' : '跳过 AI 助手',
)
const detected = computed<StepWhyDetectedItem[]>(() => {
  const status = loomStatus.value
  if (!status) return []
  const items: StepWhyDetectedItem[] = [
    { label: '现有地址', value: status.url || '未配置' },
  ]
  const mainModel = status.main_model?.id || status.models[0]?.id
  if (mainModel) items.push({ label: '主模型', value: mainModel })
  return items
})

const keyConfigured = computed(
  () => (loomStatus.value?.credentials.length ?? 0) > 0,
)

const successSummary = computed(() => {
  const info = result.value?.loom
  if (!info) return 'Loom 已启动。'
  const parts = ['Loom 已启动', `端口 ${info.port ?? port.value}`]
  if (info.mode) parts.push(`模式 ${info.mode}`)
  parts.push(`健康 ${info.health?.status || '未知'}`)
  if (info.health?.version) parts.push(`版本 ${info.health.version}`)
  return parts.join(' · ')
})

const failureSummary = computed(() => {
  const current = result.value
  if (!current) return ''
  const message = current.message || '初始化 Loom 失败。'
  const code = current.code ? `（${current.code}）` : ''
  const stage = current.stage ? `阶段 ${current.stage}` : ''
  return [`${message}${code}`, stage].filter(Boolean).join(' · ')
})

function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url)
    const value = Number(parsed.port)
    if (Number.isInteger(value) && value > 0 && value <= 65535) return value
  } catch {
    return null
  }
  return null
}

function applyLoomStatus(status: LoomStatus | null): void {
  if (!status) return
  if (!portTouched.value) {
    const existing = portFromUrl(status.url)
    if (existing !== null) port.value = String(existing)
  }
  if (!provider.value) {
    provider.value =
      status.main_model?.provider || status.models[0]?.provider || ''
  }
  if (!model.value) {
    model.value = status.main_model?.id || status.models[0]?.id || ''
  }
  if (!contextTouched.value) {
    const existing =
      status.main_model?.contextWindow ?? status.models[0]?.contextWindow
    if (typeof existing === 'number' && existing > 0) {
      contextWindow.value = String(existing)
    }
  }
}

onMounted(async () => {
  try {
    applyLoomStatus(await loadLoom())
  } catch {
    // 读取现有状态失败时保留默认端口，错误由 composable 统一暴露。
  }
})

interface LoomLimits {
  port: number
  contextWindow: number
}

function validate(): LoomLimits | null {
  const rawPort = String(port.value ?? '').trim()
  const portNumber = Number(rawPort)
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65535
  ) {
    localError.value = '端口必须是 1-65535 的整数。'
    return null
  }
  if (!provider.value.trim()) {
    localError.value = '请填写提供商（provider）。'
    return null
  }
  const url = baseUrl.value.trim()
  if (!url) {
    localError.value = '请填写 Base URL。'
    return null
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
  } catch {
    localError.value = 'Base URL 必须是有效的 http:// 或 https:// 地址。'
    return null
  }
  if (!model.value.trim()) {
    localError.value = '请填写模型 ID。'
    return null
  }
  const rawContext = String(contextWindow.value ?? '').trim()
  const contextNumber = Number(rawContext)
  if (
    !/^\d+$/.test(rawContext) ||
    !Number.isInteger(contextNumber) ||
    contextNumber < MIN_CONTEXT_WINDOW ||
    contextNumber > MAX_CONTEXT_WINDOW
  ) {
    localError.value = '上下文上限必须是 1024-10000000 的整数。'
    return null
  }
  return { port: portNumber, contextWindow: contextNumber }
}

async function handleSetup(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  result.value = null
  const limits = validate()
  if (limits === null) return

  const body: LoomSetupRequest = {
    port: limits.port,
    provider: provider.value.trim(),
    base_url: baseUrl.value.trim(),
    model: model.value.trim(),
    context_window: limits.contextWindow,
    current_password: props.currentPassword,
  }
  const key = apiKey.value.trim()
  if (key) body.api_key = key

  pendingAction.value = 'setup'
  try {
    const response = await setupLoom(body)
    if (!response) {
      localError.value =
        onboardingError.value?.message || '初始化 Loom 失败，请稍后重试。'
      return
    }
    result.value = response
    if (!response.ok) return

    apiKey.value = ''
    const recorded = await recordStep('loom', 'completed', {
      port: limits.port,
      provider: body.provider,
      model: body.model,
      context_window: limits.contextWindow,
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录 Loom 步骤失败，请稍后重试。'
      return
    }

    await refresh()
    emit('next')
  } catch (error) {
    localError.value =
      error instanceof Error && error.message
        ? error.message
        : '初始化 Loom 失败，请稍后重试。'
  } finally {
    pendingAction.value = ''
  }
}

async function handleSkip(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  result.value = null
  pendingAction.value = 'skip'
  try {
    const recorded = await recordStep('loom', 'skipped', {
      reason: 'user_skipped',
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录跳过状态失败，请稍后重试。'
      return
    }
    await refresh()
    emit('next')
  } catch (error) {
    localError.value =
      error instanceof Error && error.message
        ? error.message
        : '记录跳过状态失败，请稍后重试。'
  } finally {
    pendingAction.value = ''
  }
}
</script>
