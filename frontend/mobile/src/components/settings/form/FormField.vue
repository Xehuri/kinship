<template>
  <div class="ax-form-field">
    <label class="ax-form-field__label" :for="fieldId">
      <span class="ax-form-field__label-text">{{ label }}</span>
      <span v-if="required" class="ax-form-field__required" aria-hidden="true">*</span>
      <span v-if="required" class="ax-form-field__sr">必填</span>
    </label>
    <div class="ax-form-field__control">
      <FormControl />
    </div>
    <p v-if="hint" :id="`${fieldId}-hint`" class="ax-form-field__hint">{{ hint }}</p>
    <p v-if="error" :id="`${fieldId}-error`" class="ax-form-field__error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { cloneVNode, computed, type VNode } from 'vue'
import './form.css'

interface FormFieldSlotProps {
  fieldId: string
  describedBy?: string
  invalid: boolean
}

const props = withDefaults(
  defineProps<{
    fieldId: string
    label: string
    hint?: string
    error?: string
    required?: boolean
  }>(),
  {
    hint: '',
    error: '',
    required: false,
  },
)

const slots = defineSlots<{
  default?: (slotProps: FormFieldSlotProps) => VNode[]
}>()

const describedBy = computed<string | undefined>(() => {
  const ids: string[] = []
  if (props.hint) ids.push(`${props.fieldId}-hint`)
  if (props.error) ids.push(`${props.fieldId}-error`)
  return ids.length > 0 ? ids.join(' ') : undefined
})

function FormControl(): VNode[] {
  const nodes =
    slots.default?.({
      fieldId: props.fieldId,
      describedBy: describedBy.value,
      invalid: Boolean(props.error),
    }) ?? []

  return nodes.map((node) => {
    if (typeof node.type !== 'string') return node

    const attrs: Record<string, string> = {}
    if (describedBy.value) attrs['aria-describedby'] = describedBy.value
    if (props.error) attrs['aria-invalid'] = 'true'
    if (props.required) attrs['aria-required'] = 'true'
    return Object.keys(attrs).length > 0 ? cloneVNode(node, attrs) : node
  })
}
</script>
