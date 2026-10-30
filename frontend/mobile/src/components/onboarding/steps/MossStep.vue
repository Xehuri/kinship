<template>
  <section class="onboarding-panel" data-onboarding-panel="moss">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">MOSS 深度音频</h3>
      <p class="onboarding-panel__desc">
        MOSS 是可选的深度音频理解服务，由外部 vLLM 端点提供。本向导只保存连接配置；服务本身在向导外启动，启用后后端才会消费其输出。
      </p>
    </header>

    <StepWhy step-id="moss" :detected="detected" />

    <label class="onboarding-checkbox moss-toggle" data-onboarding-moss-toggle-label>
      <input
        v-model="enabled"
        type="checkbox"
        data-onboarding-moss-toggle
        :disabled="busy"
      />
      <span class="moss-toggle__body">
        <strong>启用 MOSS 深度音频</strong>
        <span>关闭时仍会保存地址与模型，方便以后启用；不会启动或停止外部服务。</span>
      </span>
    </label>

    <p class="onboarding-hint" data-onboarding-moss-note>
      MOSS 服务是外部进程，不在本向导中启动；请先在服务器上运行 vLLM 端点，再填写地址与模型。
    </p>

    <div class="onboarding-fields">
      <FormField
        field-id="onboarding-moss-base-url"
        label="服务地址"
        hint="外部 vLLM 端点，例如 http://127.0.0.1:8100/v1。"
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
            placeholder="http://127.0.0.1:8100/v1"
            :aria-describedby="describedBy"
            data-onboarding-moss-base-url
          />
        </template>
      </FormField>

      <FormField
        field-id="onboarding-moss-model"
        label="模型 ID"
        hint="必须与端点 /v1/models 返回的模型 id 一致。"
        required
      >
        <template #default="{ fieldId, describedBy }">
          <input
            :id="fieldId"
            v-model="model"
            class="onboarding-input"
            type="text"
            autocomplete="off"
            placeholder="moss-audio-4b"
            :aria-describedby="describedBy"
            data-onboarding-moss-model
          />
        </template>
      </FormField>
    </div>

    <p
      v-if="displayError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-moss-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ displayError }}</span>
    </p>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-moss-save
        :data-busy="busy ? 'true' : undefined"
        :disabled="busy"
        @click="handleSave"
      >
        <AppIcon
          :name="busy ? 'CircleNotch' : 'CheckCircle'"
          :size="14"
          :class="busy ? 'onboarding-spinner' : undefined"
        />
        <span>{{ busy ? '保存中…' : '保存并继续' }}</span>
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
import type { MossConfig, MossConfigRequest } from '@/api/system'

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
  mossConfig: config,
  error: onboardingError,
  loadMossConfig,
  configureMoss,
  recordStep,
  refresh,
} = useOnboarding()

const enabled = ref(false)
const baseUrl = ref('')
const model = ref('')
const busy = ref(false)
const localError = ref('')
const hydrated = ref(false)

const displayError = computed(
  () => localError.value || onboardingError.value?.message || '',
)
const detected = computed<StepWhyDetectedItem[]>(() => {
  const current = config.value
  if (!current) return []
  const items: StepWhyDetectedItem[] = [
    { label: '当前配置', value: current.enabled ? '已启用' : '未启用' },
  ]
  if (current.base_url) items.push({ label: '服务地址', value: current.base_url })
  if (current.model) items.push({ label: '模型', value: current.model })
  return items
})

function syncFromConfig(value: MossConfig | null): void {
  if (!value || hydrated.value) return
  enabled.value = value.enabled
  baseUrl.value = value.base_url
  model.value = value.model
  hydrated.value = true
}

watch(config, syncFromConfig, { immediate: true })

onMounted(() => {
  void loadMossConfig()
})

function validate(): boolean {
  const url = baseUrl.value.trim()
  if (!url) {
    localError.value = '请填写 MOSS 服务地址。'
    return false
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
  } catch {
    localError.value = '服务地址必须是有效的 http:// 或 https:// URL。'
    return false
  }
  if (!model.value.trim()) {
    localError.value = '请填写 MOSS 模型 ID。'
    return false
  }
  return true
}

async function handleSave(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  if (!validate()) return

  busy.value = true
  try {
    const body: MossConfigRequest = {
      enabled: enabled.value,
      base_url: baseUrl.value.trim(),
      model: model.value.trim(),
      current_password: props.currentPassword,
    }
    const saved = await configureMoss(body)
    if (!saved) {
      localError.value =
        onboardingError.value?.message || '保存 MOSS 配置失败，请稍后重试。'
      return
    }

    enabled.value = saved.enabled
    baseUrl.value = saved.base_url
    model.value = saved.model

    const recorded = await recordStep('moss', 'completed', {
      enabled: saved.enabled,
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录 MOSS 步骤失败，请稍后重试。'
      return
    }

    await refresh()
    emit('next')
  } catch (error) {
    localError.value =
      error instanceof Error && error.message
        ? error.message
        : '保存 MOSS 配置失败，请稍后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.moss-toggle {
  align-items: flex-start;
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink);
}

.moss-toggle input {
  flex: none;
  inline-size: 18px;
  block-size: 18px;
  margin-block-start: 2px;
}

.moss-toggle__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.moss-toggle__body strong {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}
</style>
