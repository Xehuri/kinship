<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    label: string
    disabled?: boolean
    testId?: string
  }>(),
  {
    disabled: false,
    testId: undefined,
  },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="switch"
    :class="{ 'is-on': modelValue }"
    :aria-checked="modelValue"
    :aria-label="label"
    :data-test="testId"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="sr-only">{{ modelValue ? '已开启' : '已关闭' }}</span>
  </button>
</template>
