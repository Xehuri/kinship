<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { TurnView } from '@/types/turn'
import {
  buildProcessGroups,
  processHeader,
  type ProcessHeaderInfo,
} from '@/utils/processGroups'
import type { ToolFocusPayload } from '@/utils/toolDisplay'
import ProcessGroup from './ProcessGroup.vue'

const props = withDefaults(
  defineProps<{
    turn: TurnView
    defaultExpanded?: boolean
  }>(),
  {
    defaultExpanded: false,
  },
)

const emit = defineEmits<{
  'open-focus': [payload: ToolFocusPayload]
}>()

const groups = computed(() => buildProcessGroups(props.turn))
const expanded = ref(props.defaultExpanded)
const userToggled = ref(false)
const bodyId = `process-body-${useId()}`

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

function stopTicker(): void {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}

function syncTicker(): void {
  stopTicker()
  if (props.turn.live) {
    ticker = setInterval(() => {
      now.value = Date.now()
    }, 500)
  }
}

watch(
  () => props.turn.live,
  () => {
    now.value = Date.now()
    syncTicker()
  },
  { immediate: true },
)

watch(
  () => props.defaultExpanded,
  (value) => {
    if (!userToggled.value) {
      expanded.value = value
    }
  },
)

onBeforeUnmount(stopTicker)

const header = computed<ProcessHeaderInfo>(() => processHeader(props.turn, now.value))

function toggle(): void {
  userToggled.value = true
  expanded.value = !expanded.value
}
</script>

<template>
  <section
    v-if="groups.length > 0"
    class="process-disclosure"
    :class="{ 'process-disclosure--running': header.state === 'running' }"
    data-testid="process-disclosure"
    :data-state="expanded ? 'expanded' : 'collapsed'"
    :data-status="header.state"
  >
    <button
      class="process-disclosure__summary"
      type="button"
      data-testid="process-toggle"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-controls="bodyId"
      @click="toggle"
    >
      <span class="process-disclosure__label">{{ header.label }}</span>
      <AppIcon
        class="process-disclosure__chevron"
        name="CaretRight"
        :size="12"
        weight="bold"
      />
    </button>

    <div
      v-if="expanded"
      :id="bodyId"
      class="process-disclosure__body"
      data-testid="process-body"
    >
      <ProcessGroup
        v-for="group in groups"
        :key="group.key"
        :group="group"
        :live="header.state === 'running'"
        @open-focus="emit('open-focus', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.process-disclosure {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
}

.process-disclosure__summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-block-size: var(--tap);
  color: var(--muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  text-align: start;
}

.process-disclosure__summary:hover {
  color: var(--ink);
}

.process-disclosure__label {
  min-inline-size: 0;
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .process-disclosure--running .process-disclosure__label {
    background: linear-gradient(90deg, var(--muted) 0%, var(--ink) 45%, var(--muted) 90%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: process-shimmer 1.6s linear infinite;
  }
}

.process-disclosure__chevron {
  flex: none;
  transition: transform var(--motion-fast) ease;
}

.process-disclosure__summary[aria-expanded="true"] .process-disclosure__chevron {
  transform: rotate(90deg);
}

.process-disclosure__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-block: var(--space-3) var(--space-1);
  border-block-start: 1px solid var(--hairline);
}

@keyframes process-shimmer {
  from {
    background-position: 200% 0;
  }

  to {
    background-position: -200% 0;
  }
}

@media (min-width: 768px) and (pointer: fine) {
  .process-disclosure__summary {
    min-block-size: 28px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .process-disclosure__chevron {
    transition: none;
  }

  .process-disclosure--running .process-disclosure__label {
    animation: none;
    background: none;
    color: var(--muted);
  }
}
</style>
