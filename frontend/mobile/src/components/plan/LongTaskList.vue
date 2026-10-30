<template>
  <div class="plan-long-tasks" data-testid="long-task-list">
    <ul v-if="tasks.length > 0" class="plan-long-tasks__list">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="plan-long-task"
        data-testid="long-task-row"
        :data-status="task.status"
      >
        <div class="plan-long-task__body">
          <span class="plan-long-task__title">{{ task.title }}</span>
          <span v-if="task.intent" class="plan-long-task__intent">{{ task.intent }}</span>
        </div>
        <span class="plan-long-task__meta">{{ cadenceLabel(task) }}</span>
        <span class="plan-long-task__meta">下次 {{ formatNextCheck(task.next_check) }}</span>
        <span class="plan-long-task__status">{{ statusLabel(task) }}</span>
      </li>
    </ul>
    <p v-else class="plan-long-tasks__empty" data-testid="long-task-empty">
      今天没有到期的长期任务。
    </p>
  </div>
</template>

<script setup lang="ts">
import type { LongTask, LongTaskCadence, LongTaskStatus } from '@/types'

defineProps<{
  tasks: LongTask[]
}>()

const CADENCE_LABELS: Record<LongTaskCadence, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  once: '一次',
}

const STATUS_LABELS: Record<LongTaskStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  archived: '已归档',
}

function cadenceLabel(task: LongTask): string {
  return CADENCE_LABELS[task.cadence] ?? '—'
}

function statusLabel(task: LongTask): string {
  return STATUS_LABELS[task.status] ?? '—'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatNextCheck(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<style scoped>
.plan-long-tasks {
  min-inline-size: 0;
}

.plan-long-tasks__list {
  margin: 0;
  padding: 0;
  border-block-start: 1px solid var(--hairline);
  list-style: none;
}

.plan-long-task {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 56px 148px 64px;
  align-items: center;
  gap: var(--space-2);
  min-inline-size: 0;
  padding: var(--density-row-pad) var(--space-2);
  border-block-end: 1px solid var(--hairline);
}

.plan-long-task__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}

.plan-long-task__title {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-long-task__intent {
  overflow: hidden;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-long-task__meta {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  white-space: nowrap;
}

.plan-long-task__status {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.4;
  text-align: end;
}

.plan-long-task[data-status='active'] .plan-long-task__status {
  color: var(--success);
}

.plan-long-task[data-status='paused'] .plan-long-task__status {
  color: var(--warning);
}

.plan-long-tasks__empty {
  padding: var(--space-3) var(--space-2);
  border-block-start: 1px solid var(--hairline);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

@media (max-width: 767.98px) {
  .plan-long-task {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: var(--space-1);
  }

  .plan-long-task__body {
    grid-column: 1 / -1;
  }

  .plan-long-task__title,
  .plan-long-task__intent {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .plan-long-task__status {
    justify-self: end;
  }
}
</style>
