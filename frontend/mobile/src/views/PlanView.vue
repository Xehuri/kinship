<template>
  <AppShell title="计划" :meta="headerMeta">
    <template #actions>
      <button
        class="plan-replan"
        type="button"
        data-testid="plan-replan"
        :disabled="replanning"
        @click="handleReplan"
      >
        <AppIcon name="ArrowsClockwise" :size="15" />
        <span>{{ replanning ? '正在发送…' : '让 Loom 重排' }}</span>
      </button>
    </template>

    <div
      class="ax-page plan-page"
      data-testid="plan-page"
      :aria-busy="loading ? 'true' : undefined"
    >
      <div class="plan-toolbar">
        <div class="plan-date" role="group" aria-label="计划日期">
          <button
            class="plan-date__step"
            type="button"
            data-testid="plan-prev-day"
            aria-label="前一天"
            :disabled="loading"
            @click="shiftDate(-1)"
          >
            <AppIcon name="CaretLeft" :size="14" />
          </button>
          <time class="plan-date__value" :datetime="date" data-testid="plan-date">
            {{ date }}
          </time>
          <button
            class="plan-date__step"
            type="button"
            data-testid="plan-next-day"
            aria-label="后一天"
            :disabled="loading"
            @click="shiftDate(1)"
          >
            <AppIcon name="CaretRight" :size="14" />
          </button>
          <button
            v-if="!isToday"
            class="plan-date__today"
            type="button"
            data-testid="plan-today"
            :disabled="loading"
            @click="goToday"
          >
            今天
          </button>
        </div>

        <p v-if="plan" class="plan-docmeta" data-testid="plan-docmeta">
          <span class="plan-status" :data-status="planStatus" data-testid="plan-status">
            {{ statusLabel }}
          </span>
          <span class="plan-docmeta__item">v{{ planVersion }}</span>
          <span class="plan-docmeta__item" data-testid="plan-review">
            复盘 {{ reviewLabel }}
          </span>
        </p>
      </div>

      <p
        v-if="replanFeedback"
        class="plan-feedback"
        role="status"
        data-testid="plan-replan-feedback"
      >
        {{ replanFeedback }}
      </p>

      <div v-if="error" class="plan-alert" role="alert" data-testid="plan-error">
        <AppIcon name="WarningCircle" :size="16" class="plan-alert__icon" />
        <p class="plan-alert__body">{{ error }}</p>
        <button class="plan-alert__action" type="button" @click="handleRefresh">
          重试
        </button>
      </div>

      <p v-if="loading && plan" class="plan-loading-note" role="status">
        正在读取计划…
      </p>

      <div
        v-if="initialLoading"
        class="ax-list plan-loading"
        aria-busy="true"
        aria-label="正在加载计划"
        data-testid="plan-loading"
      >
        <div v-for="index in 5" :key="index" class="ax-skeleton">
          <span class="skeleton ax-skeleton__line" />
          <span class="skeleton ax-skeleton__line ax-skeleton__line--short" />
        </div>
      </div>

      <div v-else-if="!plan && !error" class="ax-state" data-testid="plan-empty">
        <h2 class="ax-state__title">
          {{ isToday ? '今天还没有计划' : '这一天还没有计划' }}
        </h2>
        <p class="ax-state__body">
          Loom 每天 05:00 生成计划；也可以让它现在重排。这个页面只读，不会修改计划文件。
        </p>
        <button class="ax-state__action" type="button" @click="handleRefresh">
          重试
        </button>
      </div>

      <template v-else-if="plan">
        <section
          v-if="warnings.length > 0"
          class="plan-warnings"
          aria-labelledby="plan-warnings-title"
          data-testid="plan-warnings"
        >
          <div class="plan-section__head">
            <h2 id="plan-warnings-title" class="plan-section__title">告警</h2>
            <span class="plan-section__meta">{{ warnings.length }} 条</span>
          </div>
          <ul class="plan-warnings__list">
            <li v-for="warning in warnings" :key="warning" class="plan-warnings__item">
              <AppIcon name="Warning" :size="13" class="plan-warnings__icon" />
              <span>{{ warning }}</span>
            </li>
          </ul>
        </section>

        <section class="plan-section" aria-labelledby="plan-coverage-title">
          <div class="plan-section__head">
            <h2 id="plan-coverage-title" class="plan-section__title">覆盖检查点</h2>
            <span class="plan-section__meta">
              {{ coverageProfile }} · {{ debtLabel }}
            </span>
          </div>
          <CoverageStrip :coverage="coverageView" :items="planItems" />
        </section>

        <section class="plan-section" aria-labelledby="plan-items-title">
          <div class="plan-section__head">
            <h2 id="plan-items-title" class="plan-section__title">计划条目</h2>
            <span class="plan-section__meta">{{ planItems.length }} 项</span>
          </div>
          <ul v-if="planItems.length > 0" class="plan-items">
            <li
              v-for="item in planItems"
              :key="item.id"
              class="plan-items__item"
            >
              <PlanItemRow :item="item" />
            </li>
          </ul>
          <p v-else class="plan-section__empty">这一天还没有计划条目。</p>
        </section>

        <section class="plan-section" aria-labelledby="plan-long-tasks-title">
          <div class="plan-section__head">
            <h2 id="plan-long-tasks-title" class="plan-section__title">到期长期任务</h2>
            <span class="plan-section__meta">{{ dueLongTasks.length }} 项</span>
          </div>
          <LongTaskList :tasks="dueLongTasks" />
        </section>

        <section
          v-if="planNotes.length > 0"
          class="plan-section"
          aria-labelledby="plan-notes-title"
        >
          <div class="plan-section__head">
            <h2 id="plan-notes-title" class="plan-section__title">计划备注</h2>
          </div>
          <ul class="plan-notes">
            <li v-for="note in planNotes" :key="note" class="plan-notes__item">
              {{ note }}
            </li>
          </ul>
        </section>
      </template>
    </div>
  </AppShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverageStrip from '@/components/plan/CoverageStrip.vue'
import PlanItemRow from '@/components/plan/PlanItemRow.vue'
import LongTaskList from '@/components/plan/LongTaskList.vue'
import { localPlanDate, usePlan } from '@/composables/usePlan'
import type { LongTask, PlanStatus } from '@/types'

const {
  date,
  plan,
  coverage,
  longTasks,
  warnings,
  loading,
  error,
  refresh,
  requestReplan,
} = usePlan()

const STATUS_LABELS: Record<PlanStatus, string> = {
  draft: '草案',
  committed: '已提交',
  closed: '已收口',
}

const replanning = ref(false)
const replanFeedback = ref('')

const isToday = computed<boolean>(() => date.value === localPlanDate())
const initialLoading = computed<boolean>(() => loading.value && plan.value === null)
const planStatus = computed<PlanStatus>(() => plan.value?.status ?? 'draft')
const planVersion = computed<number>(() => plan.value?.version ?? 0)
const planItems = computed(() => plan.value?.items ?? [])
const planNotes = computed(() => plan.value?.notes ?? [])
const statusLabel = computed<string>(() => STATUS_LABELS[planStatus.value])
const reviewLabel = computed<string>(() => formatUnix(plan.value?.review_at ?? 0))
const coverageView = computed(() => coverage.value ?? plan.value?.coverage ?? null)
const coverageProfile = computed<string>(() => coverageView.value?.profile ?? 'merged_7')
const debtLabel = computed<string>(() => {
  const count = coverageView.value?.debt.length ?? 0
  return count > 0 ? `${count} 项欠账` : '无欠账'
})

const headerMeta = computed<string>(() => {
  if (error.value && plan.value) return '读取失败 · 显示上次计划'
  if (error.value) return '读取失败'
  if (loading.value) return '正在读取'
  return '只读 · 由 Loom 维护'
})

const dueLongTasks = computed<LongTask[]>(() => {
  const targetDate = plan.value?.date ?? date.value
  return longTasks.value
    .filter((task) => task.status === 'active')
    .filter((task) => {
      const next = new Date(task.next_check)
      if (Number.isNaN(next.getTime())) return false
      return localPlanDate(next) <= targetDate
    })
    .sort((left, right) => left.next_check.localeCompare(right.next_check))
})

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatUnix(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shiftDate(delta: number): void {
  if (loading.value) return
  const [year, month, day] = date.value.split('-').map(Number)
  date.value = localPlanDate(new Date(year, month - 1, day + delta))
}

function goToday(): void {
  if (loading.value || isToday.value) return
  date.value = localPlanDate()
}

async function handleRefresh(): Promise<void> {
  await refresh()
}

async function handleReplan(): Promise<void> {
  if (replanning.value) return
  replanning.value = true
  replanFeedback.value = ''
  try {
    const sent = await requestReplan()
    if (sent) replanFeedback.value = '重排请求已发送给 Loom。'
  } finally {
    replanning.value = false
  }
}

watch(date, () => {
  void refresh()
})

onMounted(() => {
  void refresh()
})
</script>

<style scoped>
.plan-page {
  gap: var(--density-section-gap);
}

.plan-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  min-inline-size: 0;
}

.plan-date {
  display: inline-flex;
  align-items: center;
  min-inline-size: 0;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface);
}

.plan-date__step,
.plan-date__today {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-block-size: var(--tap);
}

.plan-date__step {
  inline-size: var(--tap);
  color: var(--muted);
}

.plan-date__step:hover:not(:disabled) {
  background: var(--inset);
  color: var(--ink);
}

.plan-date__step:disabled,
.plan-date__today:disabled {
  opacity: 0.45;
  cursor: default;
}

.plan-date__value {
  min-inline-size: 104px;
  padding-inline: var(--space-2);
  border-inline: 1px solid var(--hairline);
  font-family: var(--font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: var(--tap);
  text-align: center;
}

.plan-date__today {
  padding-inline: var(--space-3);
  border-inline-start: 1px solid var(--hairline);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
}

.plan-date__today:hover:not(:disabled) {
  background: var(--accent-soft);
}

.plan-docmeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  min-inline-size: 0;
}

.plan-docmeta__item {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  white-space: nowrap;
}

.plan-status {
  display: inline-flex;
  align-items: center;
  min-block-size: 24px;
  padding-inline: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.plan-status[data-status='committed'] {
  color: var(--accent);
}

.plan-status[data-status='closed'] {
  color: var(--success);
}

.plan-feedback {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.5;
}

.plan-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 7%, var(--surface));
}

.plan-alert__icon {
  flex: none;
  margin-block-start: 1px;
  color: var(--warning);
}

.plan-alert__body {
  flex: 1 1 auto;
  min-inline-size: 0;
  font-size: 12.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.plan-alert__action {
  flex: none;
  min-block-size: 32px;
  padding-inline: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink);
  font-size: 12px;
  font-weight: 500;
}

.plan-alert__action:hover {
  background: var(--inset);
}

.plan-loading-note {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
}

.plan-warnings {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 6%, var(--surface));
}

.plan-warnings .plan-section__head {
  border-block-end: 0;
  padding-block: 0;
}

.plan-warnings__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan-warnings__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: 12.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.plan-warnings__icon {
  flex: none;
  margin-block-start: 2px;
  color: var(--warning);
}

.plan-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-inline-size: 0;
}

.plan-section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding-block-end: var(--space-1);
}

.plan-section__title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.35;
}

.plan-section__meta {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  text-align: end;
}

.plan-section__empty {
  padding: var(--space-3) var(--space-2);
  border-block-start: 1px solid var(--hairline);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.plan-items {
  margin: 0;
  padding: 0;
  border-block-start: 1px solid var(--hairline);
  list-style: none;
}

.plan-items__item {
  min-inline-size: 0;
}

.plan-notes {
  margin: 0;
  padding: 0;
  border-block-start: 1px solid var(--hairline);
  list-style: none;
}

.plan-notes__item {
  padding: var(--density-row-pad) var(--space-2);
  border-block-end: 1px solid var(--hairline);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.plan-replan {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-block-size: var(--tap);
  padding-inline: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--ink);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
}

.plan-replan:hover:not(:disabled) {
  background: var(--inset);
}

.plan-replan:disabled {
  opacity: 0.55;
  cursor: default;
}

.plan-date__step:focus-visible,
.plan-date__today:focus-visible,
.plan-alert__action:focus-visible,
.plan-replan:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 767.98px) {
  .plan-page {
    padding-inline: var(--space-3);
  }

  .plan-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .plan-date {
    inline-size: 100%;
  }

  .plan-date__value {
    flex: 1 1 auto;
  }
}
</style>
