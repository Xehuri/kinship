<template>
  <div class="ax-form-field ax-form-select">
    <label class="ax-form-field__label" :for="fieldId">
      <span class="ax-form-field__label-text">{{ label }}</span>
    </label>
    <div class="ax-form-field__control">
      <select
        :id="fieldId"
        class="ax-form-select__control"
        :value="modelValue"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        @change="handleChange"
      >
        <option v-for="option in options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </div>
    <p v-if="hint" :id="`${fieldId}-hint`" class="ax-form-field__hint">{{ hint }}</p>
    <p v-if="error" :id="`${fieldId}-error`" class="ax-form-field__error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import './form.css'

interface SelectOption {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: readonly SelectOption[]
    label: string
    hint?: string
    error?: string
    disabled?: boolean
    fieldId: string
  }>(),
  {
    hint: '',
    error: '',
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const describedBy = computed<string | undefined>(() => {
  const ids: string[] = []
  if (props.hint) ids.push(`${props.fieldId}-hint`)
  if (props.error) ids.push(`${props.fieldId}-error`)
  return ids.length > 0 ? ids.join(' ') : undefined
})

function handleChange(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  emit('update:modelValue', target.value)
}
</script>
