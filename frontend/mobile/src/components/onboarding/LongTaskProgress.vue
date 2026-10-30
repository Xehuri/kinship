<template>
  <section
    v-if="active"
    class="long-task"
    data-onboarding-long-task
    :data-elapsed-seconds="elapsedSeconds"
    aria-live="polite"
  >
    <header class="long-task__head">
      <AppIcon name="CircleNotch" :size="14" class="onboarding-spinner" />
      <span class="long-task__label">{{ label }}</span>
      <span class="long-task__elapsed" data-onboarding-long-task-elapsed>
        已用时 {{ elapsedSeconds }} 秒
      </span>
    </header>

    <ol class="long-task__stages">
      <li
        v-for="(stage, index) in stages"
        :key="stage"
        :data-stage-state="stageState(index)"
      >
        <span class="long-task__marker">
          <AppIcon
            :name="stageIcon(index)"
            :size="12"
            :class="stageState(index) === 'active' ? 'onboarding-spinner' : undefined"
          />
        </span>
        <span>{{ stage }}</span>
      </li>
    </ol>

    <p class="long-task__note" data-onboarding-long-task-note>
      通常 5-20 秒，请勿关闭
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    active: boolean
    label?: string
    stages?: string[]
  }>(),
  {
    label: '正在应用配置',
    stages: () => ['写入配置草稿', '启动并检查服务', '收尾校验'],
  },
)

const STAGE_THRESHOLDS_SECONDS = [0, 4, 10]

const elapsedSeconds = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
let startedAt = 0

const currentStage = computed(() => {
  let index = 0
  for (let step = 0; step < STAGE_THRESHOLDS_SECONDS.length; step += 1) {
    if (elapsedSeconds.value >= STAGE_THRESHOLDS_SECONDS[step]) index = step
  }
  return index
})

function stageState(index: number): 'done' | 'active' | 'pending' {
  if (index < currentStage.value) return 'done'
  if (index === currentStage.value) return 'active'
  return 'pending'
}

function stageIcon(index: number): string {
  return stageState(index) === 'done' ? 'Check' : stageState(index) === 'active' ? 'CircleNotch' : 'Circle'
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function start(): void {
  stop()
  elapsedSeconds.value = 0
  startedAt = Date.now()
  timer = setInterval(() => {
    elapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000)
  }, 1000)
}

watch(
  () => props.active,
  (active) => {
    if (active) start()
    else stop()
  },
  { immediate: true },
)

onBeforeUnmount(stop)
</script>

<style scoped>
.long-task {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.long-task__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
}

.long-task__head :deep(svg) {
  color: var(--accent);
}

.long-task__label {
  flex: 1 1 auto;
  min-inline-size: 0;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.5;
}

.long-task__elapsed {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}

.long-task__stages {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
  list-style: none;
}

.long-task__stages li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.long-task__stages li[data-stage-state='active'] {
  color: var(--ink);
}

.long-task__stages li[data-stage-state='done'] .long-task__marker {
  color: var(--success);
}

.long-task__stages li[data-stage-state='active'] .long-task__marker {
  color: var(--accent);
}

.long-task__marker {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 16px;
  block-size: 16px;
  color: var(--muted);
}

.long-task__note {
  margin: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
}
</style>
