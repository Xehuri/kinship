<template>
  <button
    class="ax-row ax-report-row"
    type="button"
    @click="emit('open', report)"
  >
    <span class="ax-report-row__body">
      <span class="ax-row__title">{{ report.title }}</span>
    </span>
    <span
      class="ax-report-row__kind"
      data-label="类型"
    >{{ typeLabel }}</span>
    <span class="ax-row__mono" data-label="日期">{{ report.date }}</span>
    <span
      v-if="typeof report.size_bytes === 'number'"
      class="ax-row__mono"
      data-label="大小"
    >{{ formatSize(report.size_bytes) }}</span>
    <span v-else class="ax-report-row__empty" data-label="大小">—</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatSize } from '@/utils/format'
import { FAMILY_LABELS } from '@/types'
import type { ReportItem, ReportKind } from '@/types'

const props = defineProps<{
  report: ReportItem
}>()

const emit = defineEmits<{
  open: [report: ReportItem]
}>()

const KIND_LABELS: Record<ReportKind, string> = {
  daily: '日报',
  weekly: '周报',
  monthly: '月报',
  audit: '审计',
  other: '其他',
}

const typeLabel = computed<string>(() => {
  const family = props.report.family
  if (family) return FAMILY_LABELS[family] ?? '—'
  const kind = props.report.kind
  if (kind) return KIND_LABELS[kind] ?? '—'
  return '—'
})
</script>
