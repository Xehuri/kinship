<template>
  <button
    :id="fieldId"
    class="ax-form-toggle"
    type="button"
    role="switch"
    :aria-checked="checked ? 'true' : 'false'"
    :aria-labelledby="`${fieldId}-label`"
    :aria-describedby="hint ? `${fieldId}-hint` : undefined"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="ax-form-toggle__text">
      <span :id="`${fieldId}-label`" class="ax-form-toggle__label">{{ label }}</span>
      <span v-if="hint" :id="`${fieldId}-hint`" class="ax-form-toggle__hint">{{ hint }}</span>
    </span>
    <span class="ax-form-toggle__track" aria-hidden="true">
      <span class="ax-form-toggle__knob" />
    </span>
  </button>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import './form.css'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    label: string
    hint?: string
    disabled?: boolean
    fieldId: string
  }>(),
  {
    hint: '',
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const checked = ref(props.modelValue)

watch(
  () => props.modelValue,
  (value) => {
    checked.value = value
  },
)

function toggle(): void {
  if (props.disabled) return
  checked.value = !checked.value
  emit('update:modelValue', checked.value)
}
</script>
