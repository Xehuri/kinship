<template>
  <article
    class="plan-item"
    data-testid="plan-item-row"
    :data-status="item.status"
    :data-kind="item.kind"
  >
    <header class="plan-item__head">
      <span class="plan-item__status">{{ statusLabel }}</span>
      <span class="plan-item__kind">{{ kindLabel }}</span>
      <span v-if="item.window" class="plan-item__meta">
        <AppIcon name="Clock" :size="12" />
        <span>{{ item.window }}</span>
      </span>
      <span v-if="item.checkpoint_id" class="plan-item__checkpoint">
        {{ item.checkpoint_id }}
      </span>
      <span v-if="item.target_date" class="plan-item__meta">
        目标 {{ item.target_date }}
      </span>
    </header>

    <p class="plan-item__intent" data-testid="plan-item-intent">{{ item.intent }}</p>

    <dl v-if="hasFacts" class="plan-item__facts">
      <div v-if="item.done_when" class="plan-item__fact">
        <dt>完成条件</dt>
        <dd>{{ item.done_when }}</dd>
      </div>
      <div v-if="item.not_do" class="plan-item__fact">
        <dt>不做</dt>
        <dd>{{ item.not_do }}</dd>
      </div>
      <div v-if="item.note" class="plan-item__fact">
        <dt>备注</dt>
        <dd>{{ item.note }}</dd>
      </div>
      <div v-if="item.source" class="plan-item__fact">
        <dt>来源</dt>
        <dd>{{ item.source }}</dd>
      </div>
    </dl>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { PlanItem, PlanItemKind, PlanItemStatus } from '@/types'

const props = defineProps<{
  item: PlanItem
}>()

const STATUS_LABELS: Record<PlanItemStatus, string> = {
  planned: '计划中',
  done: '已完成',
  skipped: '已跳过',
  carried: '顺延',
  blocked: '受阻',
}

const KIND_LABELS: Record<PlanItemKind, string> = {
  care: '照看',
  coverage: '覆盖',
  review: '复盘',
  long_task: '长期任务',
  note: '备注',
}

const statusLabel = computed<string>(() => STATUS_LABELS[props.item.status])
const kindLabel = computed<string>(() => KIND_LABELS[props.item.kind])
const hasFacts = computed<boolean>(
  () =>
    Boolean(props.item.done_when) ||
    Boolean(props.item.not_do) ||
    Boolean(props.item.note) ||
    Boolean(props.item.source),
)
</script>

<style scoped>
.plan-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-inline-size: 0;
  padding: var(--space-3) var(--space-2) var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.plan-item__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  min-inline-size: 0;
}

.plan-item__status {
  display: inline-flex;
  align-items: center;
  min-block-size: 22px;
  padding-inline: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.plan-item[data-status='done'] .plan-item__status {
  color: var(--success);
}

.plan-item[data-status='carried'] .plan-item__status {
  color: var(--warning);
}

.plan-item[data-status='blocked'] .plan-item__status {
  color: var(--danger);
}

.plan-item__kind {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.4;
  white-space: nowrap;
}

.plan-item__meta,
.plan-item__checkpoint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  white-space: nowrap;
}

.plan-item__checkpoint {
  padding-inline: var(--space-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}

.plan-item__intent {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.plan-item__facts {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
}

.plan-item__fact {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: var(--space-2);
  font-size: 12.5px;
  line-height: 1.55;
}

.plan-item__fact dt {
  color: var(--muted);
}

.plan-item__fact dd {
  margin: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 420px) {
  .plan-item__fact {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}
</style>
