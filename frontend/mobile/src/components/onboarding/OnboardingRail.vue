<template>
  <nav ref="railRef" class="onboarding-rail" aria-label="初始化步骤">
    <section
      v-for="segment in segments"
      :key="segment.phase"
      class="onboarding-rail__segment"
      :data-onboarding-rail-segment="segment.phase"
    >
      <header class="onboarding-rail__segment-head">
        <span class="onboarding-rail__segment-title">{{ segment.title }}</span>
        <span
          class="onboarding-rail__segment-count"
          :data-phase-progress="segment.phase"
        >{{ segment.done }}/{{ segment.total }}</span>
      </header>
      <ol class="onboarding-rail__list">
        <li v-for="item in segment.items" :key="item.step.id">
          <button
            class="onboarding-rail__item"
            type="button"
            :data-step-id="item.step.id"
            :data-step-phase="segment.phase"
            :data-step-state="stepState(item.step, item.index)"
            :data-step-required="item.step.required ? 'true' : 'false'"
            :data-step-skippable="item.step.skippable ? 'true' : 'false'"
            :aria-current="item.index === activeIndex ? 'step' : undefined"
            :disabled="!isClickable(item.step, item.index)"
            data-onboarding-step
            @click="emit('navigate', item.index)"
          >
            <span class="onboarding-rail__marker">
              <AppIcon :name="railIcon(item.step, item.index)" :size="15" />
            </span>
            <span class="onboarding-rail__text">
              <span class="onboarding-rail__title">{{ item.step.title }}</span>
              <span class="onboarding-rail__state" data-step-state-label>
                {{ stateLabel(item.step, item.index) }}
              </span>
            </span>
            <span class="onboarding-rail__badge" data-step-hint>{{ hint(item.step) }}</span>
          </button>
        </li>
      </ol>
    </section>
  </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import {
  PHASE_1_STEP_IDS,
  PHASE_2_STEP_IDS,
  isPhase1Complete,
  onboardingStepPhase,
  onboardingStepVisual,
  phaseProgress,
  type OnboardingPhase,
} from '@/config/onboardingSteps'
import type { OnboardingStepInfo, OnboardingStepState } from '@/api/system'

const props = defineProps<{
  steps: OnboardingStepInfo[]
  activeIndex: number
  completed: string[]
  skipped: string[]
}>()

const emit = defineEmits<{
  navigate: [index: number]
}>()

interface RailItem {
  step: OnboardingStepInfo
  index: number
}

interface RailSegment {
  phase: OnboardingPhase
  title: string
  items: RailItem[]
  done: number
  total: number
}

const railRef = ref<HTMLElement | null>(null)

const phase1Complete = computed(() => isPhase1Complete(props.steps))

const segments = computed<RailSegment[]>(() => {
  const groups: Record<OnboardingPhase, RailItem[]> = { 1: [], 2: [] }
  props.steps.forEach((step, index) => {
    groups[onboardingStepPhase(step.id)].push({ step, index })
  })
  const progress = (phase: OnboardingPhase) => phaseProgress(props.steps, phase)
  const build = (phase: OnboardingPhase, title: string): RailSegment => {
    const counts = progress(phase)
    return {
      phase,
      title,
      items: groups[phase],
      done: counts.done,
      total: phase === 1 ? PHASE_1_STEP_IDS.length : PHASE_2_STEP_IDS.length,
    }
  }
  return [build(1, '阶段 1 · 可用'), build(2, '阶段 2 · 可选')]
})

function stepState(step: OnboardingStepInfo, index: number): OnboardingStepState {
  if (index === props.activeIndex) return 'current'
  if (props.completed.includes(step.id)) return 'completed'
  if (props.skipped.includes(step.id)) return 'skipped'
  return 'pending'
}

function stateLabel(step: OnboardingStepInfo, index: number): string {
  const state = stepState(step, index)
  const labels: Record<OnboardingStepState, string> = {
    completed: '已完成',
    skipped: '已跳过',
    current: '进行中',
    pending: '待开始',
  }
  return labels[state]
}

function hint(step: OnboardingStepInfo): string {
  if (step.skippable) return '可跳过'
  if (!step.required) return '可选'
  return '必做'
}

function railIcon(step: OnboardingStepInfo, index: number): string {
  const state = stepState(step, index)
  if (state === 'completed') return 'Check'
  if (state === 'skipped') return 'ArrowRight'
  if (state === 'current') return 'CaretRight'
  return onboardingStepVisual(step.id).icon
}

function isClickable(step: OnboardingStepInfo, index: number): boolean {
  if (onboardingStepPhase(step.id) === 2 && !phase1Complete.value) return false
  if (index <= props.activeIndex) return true
  return props.completed.includes(step.id) || props.skipped.includes(step.id)
}

watch(
  () => props.activeIndex,
  async () => {
    await nextTick()
    const rail = railRef.value
    if (!rail) return
    const step = props.steps[props.activeIndex]
    if (!step) {
      rail
        .querySelectorAll<HTMLElement>('.onboarding-rail__list')
        .forEach((list) => {
          list.scrollLeft = 0
        })
      rail.scrollTop = 0
      return
    }
    const item = rail.querySelector<HTMLElement>(`[data-step-id="${step.id}"]`)
    if (!item) return
    const list = item.closest<HTMLElement>('.onboarding-rail__list')
    if (list && list.scrollWidth > list.clientWidth) {
      list.scrollLeft = item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2
    }
    if (rail.scrollHeight > rail.clientHeight) {
      rail.scrollTop = item.offsetTop - (rail.clientHeight - item.offsetHeight) / 2
    }
  },
)
</script>
