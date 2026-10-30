<template>
  <div class="plan-coverage" data-testid="coverage-strip">
    <ol class="plan-coverage__track" aria-label="Coverage 检查点">
      <li
        v-for="row in rows"
        :key="row.id"
        class="plan-coverage__row"
        data-testid="coverage-row"
        :data-checkpoint="row.id"
        :data-state="row.status"
        :data-debt="row.debt ? 'true' : undefined"
      >
        <div class="plan-coverage__top">
          <span class="plan-coverage__mark" aria-hidden="true">
            <AppIcon v-if="row.status === 'done'" name="Check" :size="11" />
            <AppIcon
              v-else-if="row.debt"
              name="Warning"
              :size="11"
            />
            <span v-else class="plan-coverage__dot" />
          </span>
          <span class="plan-coverage__time">{{ row.time }}</span>
        </div>
        <span class="plan-coverage__window">{{ row.window }}</span>
        <span v-if="row.target === 'yesterday'" class="plan-coverage__target">
          目标昨天
        </span>
        <span class="plan-coverage__state">{{ row.statusLabel }}</span>
        <span
          v-if="row.debt"
          class="plan-coverage__debt"
          data-testid="coverage-debt"
        >{{ row.debt }}</span>
      </li>
    </ol>
    <p
      v-if="unmappedDebts.length > 0"
      class="plan-coverage__unmapped"
      data-testid="coverage-unmapped-debt"
    >
      未归位欠账：{{ unmappedDebts.join('；') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { PlanCoverage, PlanItem, PlanItemStatus } from '@/types'

interface CheckpointRow {
  id: string
  time: string
  window: string
  target?: 'yesterday'
}

interface CoverageViewRow extends CheckpointRow {
  status: PlanItemStatus
  statusLabel: string
  debt: string | null
}

const props = withDefaults(
  defineProps<{
    coverage: PlanCoverage | null
    items?: PlanItem[]
  }>(),
  {
    items: () => [],
  },
)

const MERGED_7: readonly CheckpointRow[] = [
  { id: 'cov-00', time: '00:00（分析昨天）', window: '22:00–00:00', target: 'yesterday' },
  { id: 'cov-06', time: '06:00', window: '00:00–06:00' },
  { id: 'cov-08', time: '08:00', window: '06:00–08:00' },
  { id: 'cov-12', time: '12:00', window: '08:00–12:00' },
  { id: 'cov-16', time: '16:00', window: '12:00–16:00' },
  { id: 'cov-20', time: '20:00', window: '16:00–20:00' },
  { id: 'cov-22', time: '22:00', window: '20:00–22:00' },
]

const MERGED_6: readonly CheckpointRow[] = [
  { id: 'cov-night', time: '22:00–06:00', window: '夜间合并', target: 'yesterday' },
  { id: 'cov-08', time: '08:00', window: '06:00–08:00' },
  { id: 'cov-12', time: '12:00', window: '08:00–12:00' },
  { id: 'cov-16', time: '16:00', window: '12:00–16:00' },
  { id: 'cov-20', time: '20:00', window: '16:00–20:00' },
  { id: 'cov-22', time: '22:00', window: '20:00–22:00' },
]

const STATUS_LABELS: Record<PlanItemStatus, string> = {
  planned: '待执行',
  done: '已过',
  skipped: '已跳过',
  carried: '顺延',
  blocked: '受阻',
}

const checkpointSource = computed<readonly CheckpointRow[]>(() =>
  props.coverage?.profile === 'merged_6' ? MERGED_6 : MERGED_7,
)

function itemFor(row: CheckpointRow): PlanItem | undefined {
  if (row.id === 'cov-night') {
    return props.items.find(
      (item) =>
        item.checkpoint_id === 'cov-night' ||
        item.checkpoint_id === 'cov-00' ||
        item.checkpoint_id === 'cov-06',
    )
  }
  return props.items.find((item) => item.checkpoint_id === row.id)
}

function debtFor(row: CheckpointRow): string | null {
  const debts = props.coverage?.debt ?? []
  const start = row.window.split('–')[0]
  const matches = debts.filter(
    (debt) =>
      debt.includes(row.id) ||
      debt.includes(row.time) ||
      debt.includes(row.window) ||
      (start.length > 0 && debt.includes(start)),
  )
  return matches.length > 0 ? matches.join('；') : null
}

const rows = computed<CoverageViewRow[]>(() =>
  checkpointSource.value.map((row) => {
    const item = itemFor(row)
    const status = item?.status ?? 'planned'
    return {
      ...row,
      status,
      statusLabel: STATUS_LABELS[status],
      debt: debtFor(row),
    }
  }),
)

const unmappedDebts = computed<string[]>(() => {
  const debts = props.coverage?.debt ?? []
  return debts.filter(
    (debt) =>
      !checkpointSource.value.some((row) => {
        const start = row.window.split('–')[0]
        return (
          debt.includes(row.id) ||
          debt.includes(row.time) ||
          debt.includes(row.window) ||
          (start.length > 0 && debt.includes(start))
        )
      }),
  )
})
</script>

<style scoped>
.plan-coverage {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-inline-size: 0;
}

.plan-coverage__track {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  border-block-start: 1px solid var(--hairline);
  list-style: none;
}

.plan-coverage__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
  padding: var(--space-3) var(--space-3) var(--space-4);
  border-block-end: 1px solid var(--hairline);
  border-inline-end: 1px solid var(--hairline);
}

.plan-coverage__row:last-child {
  border-inline-end: 0;
}

.plan-coverage__top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-inline-size: 0;
}

.plan-coverage__mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 20px;
  block-size: 20px;
  border: 1px solid var(--hairline);
  border-radius: 50%;
  background: var(--surface);
  color: var(--muted);
}

.plan-coverage__dot {
  inline-size: 4px;
  block-size: 4px;
  border-radius: 50%;
  background: currentColor;
}

.plan-coverage__row[data-state='done'] .plan-coverage__mark {
  border-color: currentColor;
  color: var(--success);
}

.plan-coverage__row[data-state='blocked'] .plan-coverage__mark {
  border-color: currentColor;
  color: var(--danger);
}

.plan-coverage__row[data-debt='true'] .plan-coverage__mark {
  border-color: currentColor;
  color: var(--warning);
}

.plan-coverage__time {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-coverage__window {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.4;
  white-space: nowrap;
}

.plan-coverage__target,
.plan-coverage__state {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
}

.plan-coverage__row[data-state='done'] .plan-coverage__state {
  color: var(--success);
}

.plan-coverage__row[data-state='carried'] .plan-coverage__state {
  color: var(--warning);
}

.plan-coverage__row[data-state='blocked'] .plan-coverage__state {
  color: var(--danger);
}

.plan-coverage__debt {
  color: var(--warning);
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.plan-coverage__unmapped {
  color: var(--warning);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

@media (max-width: 767.98px) {
  .plan-coverage {
    overflow-x: auto;
    overscroll-behavior-inline: contain;
  }

  .plan-coverage__track {
    grid-template-columns: none;
    grid-auto-columns: minmax(148px, 1fr);
    grid-auto-flow: column;
    min-inline-size: max-content;
  }
}
</style>
