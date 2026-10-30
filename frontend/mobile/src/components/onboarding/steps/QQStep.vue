<template>
  <section class="onboarding-panel" data-onboarding-panel="qq">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">QQ 网关</h3>
      <p class="onboarding-panel__desc">
        可选。启用后 Loom 可以通过 NapCat 收发 QQ 消息。配置先保存，网关服务在完成引导后才启动。
      </p>
    </header>

    <StepWhy step-id="qq" :detected="detected" />

    <p v-if="loading && !status" class="onboarding-alert" data-onboarding-qq-loading>
      <AppIcon name="CircleNotch" :size="14" class="onboarding-spinner" />
      <span>正在读取 QQ 网关状态…</span>
    </p>

    <label class="step-toggle" data-onboarding-qq-toggle-label>
      <input
        v-model="enabled"
        class="step-toggle__input"
        type="checkbox"
        role="switch"
        :disabled="busy"
        data-onboarding-qq-toggle
      />
      <span class="step-toggle__track" aria-hidden="true">
        <span class="step-toggle__thumb" />
      </span>
      <span class="step-toggle__text">
        <strong>启用 QQ 网关</strong>
        <span>关闭时保留现有配置，不启动网关。</span>
      </span>
    </label>

    <div v-if="enabled" class="onboarding-fields" data-onboarding-qq-fields>
      <FormField
        field-id="onboarding-qq-self"
        label="机器人 QQ 号"
        hint="用于 NapCat 登录的 QQ 号，必须是纯数字。"
        :error="fieldError('self_qq')"
        data-onboarding-qq-field="self_qq"
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="selfQq"
            class="onboarding-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            placeholder="123456789"
            :aria-describedby="describedBy"
            data-onboarding-qq-self
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-qq-ws-url"
        label="NapCat WebSocket"
        hint="NapCat 的 WebSocket 地址，必须以 ws:// 或 wss:// 开头。"
        :error="fieldError('ws_url')"
        data-onboarding-qq-field="ws_url"
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="wsUrl"
            class="onboarding-input"
            type="url"
            inputmode="url"
            autocomplete="off"
            placeholder="ws://127.0.0.1:3001"
            :aria-describedby="describedBy"
            data-onboarding-qq-ws-url
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-qq-ws-token"
        :label="wsTokenLabel"
        :hint="wsTokenHint"
        :error="fieldError('ws_token')"
        data-onboarding-qq-field="ws_token"
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="wsToken"
            class="onboarding-input"
            type="password"
            autocomplete="new-password"
            placeholder="留空保持不变"
            :aria-describedby="describedBy"
            data-onboarding-qq-ws-token
          />
        </template>
      </FormField>
    </div>

    <p v-if="enabled" class="onboarding-hint" data-onboarding-qq-finish-note>
      MCP token 由服务端自动生成；QQ 网关只在完成引导（finish）后启动。
    </p>

    <p
      v-if="generalError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-qq-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ generalError }}</span>
    </p>
    <p
      v-else-if="onboardingError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-qq-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ onboardingError.message }}</span>
    </p>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-qq-save
        :data-busy="busy ? 'true' : undefined"
        :disabled="busy"
        @click="handleSave"
      >
        <AppIcon
          v-if="busy"
          name="CircleNotch"
          :size="14"
          class="onboarding-spinner"
        />
        <span>{{ busy ? '保存中…' : '保存并继续' }}</span>
        <AppIcon name="ArrowRight" :size="14" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import FormField from '@/components/settings/form/FormField.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import type { QqConfigError, QqConfigRequest } from '@/api/system'

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
  qq: status,
  error: onboardingError,
  loadQq,
  validateQq,
  configureQq,
  recordStep,
} = useOnboarding()

const FIELD_KEYS = new Set(['self_qq', 'ws_url', 'ws_token'])

const enabled = ref(false)
const selfQq = ref('')
const wsUrl = ref('')
const wsToken = ref('')
const loading = ref(false)
const busy = ref(false)
const hydrated = ref(false)
const generalError = ref('')
const fieldErrors = ref<Record<string, string>>({})

const wsTokenConfigured = computed(
  () => status.value?.ws_token_configured === true,
)

const wsTokenLabel = computed(() =>
  wsTokenConfigured.value ? 'WS Token（已配置，留空保持不变）' : 'WS Token',
)

const wsTokenHint = computed(() =>
  wsTokenConfigured.value
    ? '已配置，留空保持不变。'
    : 'NapCat 的 WebSocket Token；可留空。',
)

const detected = computed<StepWhyDetectedItem[]>(() => {
  const current = status.value
  if (!current) return []
  const items: StepWhyDetectedItem[] = [
    { label: '当前配置', value: current.enabled ? '已启用' : '未启用' },
  ]
  if (current.self_qq) items.push({ label: '机器人 QQ', value: current.self_qq })
  return items
})

function syncFromStatus(): void {
  const current = status.value
  if (!current || hydrated.value) return
  enabled.value = current.enabled
  selfQq.value = current.self_qq
  wsUrl.value = current.ws_url
  hydrated.value = true
}

watch(status, syncFromStatus, { immediate: true })

onMounted(() => {
  void loadStatus()
})

async function loadStatus(): Promise<void> {
  loading.value = true
  try {
    await loadQq()
  } finally {
    loading.value = false
  }
}

function errorText(fallback: string): string {
  return onboardingError.value?.message || fallback
}

function fieldError(field: string): string {
  return fieldErrors.value[field] ?? ''
}

function clearErrors(): void {
  generalError.value = ''
  fieldErrors.value = {}
}

function applyValidationErrors(errors: QqConfigError[]): void {
  const mapped: Record<string, string> = {}
  const unmapped: string[] = []
  for (const error of errors) {
    if (FIELD_KEYS.has(error.field)) {
      mapped[error.field] = error.message
    } else {
      unmapped.push(error.message)
    }
  }
  fieldErrors.value = mapped
  if (unmapped.length > 0) {
    generalError.value = unmapped.join('；')
  }
}

function baseBody(): QqConfigRequest {
  return {
    enabled: enabled.value,
    self_qq: selfQq.value.trim(),
    ws_url: wsUrl.value.trim(),
    current_password: props.currentPassword,
  }
}

function enabledBody(): QqConfigRequest {
  const body = baseBody()
  const token = wsToken.value.trim()
  if (token) body.ws_token = token
  return body
}

async function handleSave(): Promise<void> {
  if (busy.value) return
  clearErrors()
  busy.value = true
  try {
    if (!enabled.value) {
      const saved = await configureQq(baseBody())
      if (!saved) {
        generalError.value = errorText('保存 QQ 网关配置失败，请稍后重试。')
        return
      }
      const recorded = await recordStep('qq', 'completed', { enabled: false })
      if (!recorded) {
        generalError.value = errorText('记录 QQ 网关步骤失败，请稍后重试。')
        return
      }
      emit('next')
      return
    }

    const body = enabledBody()
    const validation = await validateQq(body)
    if (!validation) {
      generalError.value = errorText('校验 QQ 网关配置失败，请稍后重试。')
      return
    }
    if (!validation.valid) {
      applyValidationErrors(validation.errors)
      if (!generalError.value && validation.errors.length === 0) {
        generalError.value = 'QQ 网关配置未通过校验，请检查填写内容。'
      }
      return
    }

    const saved = await configureQq(body)
    if (!saved) {
      generalError.value = errorText('保存 QQ 网关配置失败，请稍后重试。')
      return
    }
    const recorded = await recordStep('qq', 'completed', { enabled: true })
    if (!recorded) {
      generalError.value = errorText('记录 QQ 网关步骤失败，请稍后重试。')
      return
    }
    wsToken.value = ''
    emit('next')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.step-toggle {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
}

.step-toggle__input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.step-toggle__track {
  position: relative;
  flex: none;
  inline-size: 40px;
  block-size: 22px;
  margin-block-start: 1px;
  border-radius: 999px;
  background: var(--inset);
  transition: background var(--motion-fast) ease;
}

.step-toggle__thumb {
  position: absolute;
  inset-block-start: 3px;
  inset-inline-start: 3px;
  inline-size: 16px;
  block-size: 16px;
  border-radius: 50%;
  background: var(--surface-raised);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 24%, transparent);
  transition: transform var(--motion-fast) ease;
}

.step-toggle__input:checked + .step-toggle__track {
  background: var(--accent);
}

.step-toggle__input:checked + .step-toggle__track .step-toggle__thumb {
  transform: translateX(18px);
}

.step-toggle__input:focus-visible + .step-toggle__track {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.step-toggle__input:disabled + .step-toggle__track {
  opacity: 0.6;
}

.step-toggle__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.step-toggle__text strong {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}
</style>
