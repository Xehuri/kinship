<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  value: number
  max: number
  label: string
}>()

const safeMax = computed(() =>
  Number.isFinite(props.max) && props.max > 0 ? props.max : 0,
)

const clampedValue = computed(() => {
  if (!Number.isFinite(props.value)) return 0
  return Math.min(Math.max(props.value, 0), safeMax.value)
})

const percent = computed(() => {
  if (safeMax.value === 0) return 0
  return (clampedValue.value / safeMax.value) * 100
})
</script>

<template>
  <div
    class="meter"
    role="progressbar"
    :aria-label="label"
    :aria-valuemin="0"
    :aria-valuemax="safeMax"
    :aria-valuenow="clampedValue"
    :aria-valuetext="`${clampedValue} / ${safeMax}`"
  >
    <div class="meter__track">
      <div class="meter__fill" :style="{ inlineSize: `${percent}%` }" />
    </div>
  </div>
</template>

<style scoped>
.meter {
  inline-size: 100%;
}

.meter__track {
  overflow: hidden;
  inline-size: 100%;
  block-size: 6px;
  border-radius: var(--radius-sm);
  background: var(--inset);
}

.meter__fill {
  block-size: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: inline-size var(--motion-fast) ease;
}

@media (prefers-reduced-motion: reduce) {
  .meter__fill {
    transition: none;
  }
}
</style>
