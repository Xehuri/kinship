<template>
  <div class="ax-health-metric" data-testid="health-metric">
    <span class="ax-health-metric__label">
      <AppIcon :name="metric.icon" :size="13" />
      <span>{{ metric.label }}</span>
    </span>
    <span class="ax-health-metric__reading">
      <span class="ax-health-metric__value">{{ metric.value }}</span>
      <span
        v-if="metric.unit && metric.value !== EMPTY_VALUE"
        class="ax-health-metric__unit"
      >{{ metric.unit }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { HealthSummaryMetric } from '@/composables/useHealthSummary'

defineProps<{
  metric: HealthSummaryMetric
}>()

const EMPTY_VALUE = '—'
</script>

<style scoped>
.ax-health-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}

.ax-health-metric__label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-health-metric__reading {
  display: flex;
  align-items: baseline;
  gap: 2px;
  min-inline-size: 0;
}

.ax-health-metric__value {
  overflow: hidden;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-health-metric__unit {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}
</style>
