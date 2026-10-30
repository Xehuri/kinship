<template>
  <section
    class="ax-health"
    data-testid="health-summary"
    aria-label="健康数据摘要"
  >
    <div class="ax-health__head">
      <h2 class="ax-health__title">健康摘要</h2>
      <span v-if="date" class="ax-health__date">{{ displayDate }}</span>

      <div class="ax-health__actions">
        <button
          class="ax-health__action"
          type="button"
          data-testid="health-gps-action"
          @click="emit('gps')"
        >
          <AppIcon name="MapPin" :size="14" />
          GPS 轨迹
        </button>
        <button
          class="ax-health__action"
          type="button"
          data-testid="health-voiceprint-action"
          @click="emit('voiceprint')"
        >
          <AppIcon name="Waveform" :size="14" />
          声纹记录
        </button>
      </div>
    </div>

    <div
      v-if="error"
      class="ax-health__unavailable"
      role="status"
    >
      <span>健康数据暂不可用</span>
      <button
        class="ax-health__retry"
        type="button"
        data-testid="health-retry"
        @click="emit('retry')"
      >
        重试
      </button>
    </div>

    <div
      v-else-if="loading"
      class="ax-health__metrics"
      aria-busy="true"
      aria-label="正在加载健康数据"
    >
      <span
        v-for="index in 7"
        :key="index"
        class="skeleton ax-health__skeleton"
        aria-hidden="true"
      />
    </div>

    <div v-else class="ax-health__metrics">
      <HealthMetricChip
        v-for="metric in metrics"
        :key="metric.key"
        :metric="metric"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import HealthMetricChip from './HealthMetricChip.vue'
import type { HealthSummaryMetric } from '@/composables/useHealthSummary'

const props = withDefaults(
  defineProps<{
    date: string
    metrics: HealthSummaryMetric[]
    loading?: boolean
    error?: boolean
  }>(),
  {
    loading: false,
    error: false,
  },
)

const emit = defineEmits<{
  retry: []
  gps: []
  voiceprint: []
}>()

/** 2026-10-24 -> 10月24日; 非法日期原样返回 */
const displayDate = computed<string>(() => {
  const parts = props.date.split('-')
  if (parts.length !== 3) return props.date
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (!Number.isFinite(month) || !Number.isFinite(day)) return props.date
  return `${month}月${day}日`
})
</script>

<style scoped>
.ax-health {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-block: var(--space-2) var(--space-3);
  border-block-end: 1px solid var(--hairline);
}

.ax-health__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  min-inline-size: 0;
}

.ax-health__title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
}

.ax-health__date {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  white-space: nowrap;
}

.ax-health__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-inline-start: auto;
}

.ax-health__action,
.ax-health__retry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-block-size: var(--tap);
  padding-inline: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
}

.ax-health__action:hover,
.ax-health__retry:hover {
  background: var(--inset);
}

.ax-health__unavailable {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

.ax-health__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(74px, 1fr));
  gap: var(--space-2) var(--space-4);
  min-inline-size: 0;
}

.ax-health__skeleton {
  block-size: 30px;
  border-radius: var(--radius-sm);
}
</style>
