<template>
  <div
    class="system-config-field"
    :data-field-path="field.path"
    :data-field-type="field.type"
    :data-apply-strategy="field.apply_strategy"
  >
    <div class="system-config-field__meta">
      <code class="system-config-field__path">{{ field.path }}</code>
      <span v-if="field.core" class="system-config-field__tag system-config-field__tag--core">核心</span>
      <span v-else-if="field.advanced" class="system-config-field__tag">高级</span>
      <span v-if="field.sensitive" class="system-config-field__tag system-config-field__tag--sensitive">敏感</span>
      <span v-if="field.deprecated" class="system-config-field__tag system-config-field__tag--deprecated">已废弃</span>
      <span
        class="system-config-field__tag"
        :class="`system-config-field__tag--${field.apply_strategy}`"
      >
        {{ strategyLabel }}
      </span>
    </div>

    <FormToggle
      v-if="field.type === 'bool'"
      :field-id="fieldId"
      :model-value="boolValue"
      :label="field.title"
      :hint="field.help"
      :disabled="locked"
      @update:model-value="emit('update:modelValue', $event)"
    />

    <FormSelect
      v-else-if="field.type === 'enum'"
      :field-id="fieldId"
      :model-value="enumValue"
      :options="enumOptions"
      :label="field.title"
      :hint="field.help"
      :error="error"
      :disabled="locked"
      @update:model-value="emit('update:modelValue', $event)"
    />

    <template v-else-if="field.type === 'secret'">
      <FormField
        :field-id="fieldId"
        :label="field.title"
        :hint="field.help"
        :error="error"
      >
        <template #default="{ fieldId: controlId, describedBy, invalid }">
          <input
            :id="controlId"
            class="system-config-field__input"
            type="password"
            :value="secretDraft"
            :placeholder="existingMasked ? '***' : '未设置'"
            autocomplete="new-password"
            :disabled="locked"
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
            @input="handleSecretInput"
          />
        </template>
      </FormField>
      <div v-if="existingMasked" class="system-config-field__secret-actions">
        <button
          class="system-config-field__clear"
          type="button"
          :disabled="locked"
          @click="emit('clear')"
        >
          清除
        </button>
        <span class="system-config-field__note">清除后保存即删除该密钥</span>
      </div>
    </template>

    <template v-else-if="field.type === 'list' || field.type === 'dict'">
      <FormField
        :field-id="fieldId"
        :label="field.title"
        :hint="field.help"
        :error="error"
      >
        <template #default="{ fieldId: controlId, describedBy, invalid }">
          <textarea
            :id="controlId"
            class="system-config-field__input system-config-field__textarea"
            :value="jsonText"
            spellcheck="false"
            :disabled="locked"
            :aria-describedby="describedBy"
            :aria-invalid="invalid || jsonError ? 'true' : undefined"
            @input="handleJsonInput"
          />
        </template>
      </FormField>
      <p v-if="jsonError" class="system-config-field__json-error" role="alert">
        {{ jsonError }}
      </p>
    </template>

    <template v-else>
      <FormField
        :field-id="fieldId"
        :label="field.title"
        :hint="field.help"
        :error="error"
      >
        <template #default="{ fieldId: controlId, describedBy, invalid }">
          <input
            v-if="field.type === 'int' || field.type === 'float'"
            :id="controlId"
            class="system-config-field__input"
            type="number"
            :value="numberValue"
            :min="field.min"
            :max="field.max"
            :step="field.type === 'int' ? 1 : 'any'"
            :disabled="locked"
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
            @input="handleNumberInput"
          />
          <input
            v-else
            :id="controlId"
            class="system-config-field__input"
            :class="{ 'system-config-field__input--path': field.type === 'path' }"
            type="text"
            :value="stringValue"
            :disabled="locked"
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
            @input="handleTextInput"
          />
        </template>
      </FormField>
      <p v-if="field.type === 'path'" class="system-config-field__path-hint">
        相对路径按项目根解析。
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import FormField from './form/FormField.vue'
import FormSelect from './form/FormSelect.vue'
import FormToggle from './form/FormToggle.vue'
import type { ConfigField } from '@/api/system'
import './system-config.css'

const props = withDefaults(
  defineProps<{
    field: ConfigField
    modelValue: unknown
    disabled?: boolean
    error?: string
  }>(),
  {
    disabled: false,
    error: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: unknown]
  clear: []
}>()

const STRATEGY_LABELS: Record<string, string> = {
  hot: '即时生效',
  reconnect: '重连生效',
  respawn: '内核重启',
  deployment: '部署接线(只读)',
  none: '废弃',
}

const fieldId = computed(
  () => `system-config-${props.field.path.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
)

const strategyLabel = computed(
  () => STRATEGY_LABELS[props.field.apply_strategy] ?? props.field.apply_strategy,
)

const locked = computed(
  () =>
    props.disabled ||
    props.field.apply_strategy === 'deployment' ||
    props.field.apply_strategy === 'none',
)

const boolValue = computed(() => props.modelValue === true)

const enumValue = computed(() => String(props.modelValue ?? ''))

const enumOptions = computed(() =>
  (props.field.enum ?? []).map((value) => ({
    value: String(value),
    label: String(value),
  })),
)

const numberValue = computed(() => {
  const value = props.modelValue
  if (typeof value === 'number') return value
  if (value === null || value === undefined) return ''
  return String(value)
})

const stringValue = computed(() => {
  const value = props.modelValue
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
})

// ==================== Secret ====================

const secretDraft = ref('')
const existingMasked = computed(() => props.modelValue === '***')

watch(
  () => props.modelValue,
  (value) => {
    if (value === '***' || value === '' || value === null || value === undefined) {
      secretDraft.value = ''
    }
  },
)

function handleSecretInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  secretDraft.value = target.value
  emit('update:modelValue', target.value)
}

// ==================== JSON ====================

function toJsonText(value: unknown): string {
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

const jsonText = ref(toJsonText(props.modelValue))
const jsonError = ref('')

function textMatchesValue(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value)
  } catch {
    return false
  }
}

watch(
  () => props.modelValue,
  (value) => {
    if (!textMatchesValue(jsonText.value, value)) {
      jsonText.value = toJsonText(value)
    }
  },
  { deep: true },
)

function handleJsonInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement)) return
  jsonText.value = target.value
  jsonError.value = ''

  if (target.value.trim() === '') {
    return
  }

  try {
    emit('update:modelValue', JSON.parse(target.value))
  } catch {
    jsonError.value = 'JSON 格式无效，请输入合法的 JSON 后再保存。'
  }
}

// ==================== Scalar inputs ====================

function handleNumberInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  if (target.value === '') return
  const parsed = Number(target.value)
  if (!Number.isFinite(parsed)) return
  emit('update:modelValue', props.field.type === 'int' ? Math.trunc(parsed) : parsed)
}

function handleTextInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  emit('update:modelValue', target.value)
}
</script>
