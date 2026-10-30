<template>
  <section
    v-if="why"
    class="step-why"
    data-onboarding-step-why
    :data-step-id="stepId"
  >
    <p class="step-why__reason" data-onboarding-step-why-reason>
      <AppIcon name="Info" :size="14" />
      <span><strong>为什么需要：</strong>{{ why }}</span>
    </p>

    <div
      v-if="detectedItems.length > 0"
      class="step-why__detected"
      data-onboarding-step-why-detected
    >
      <span class="step-why__detected-title">自动检测</span>
      <dl class="step-why__list">
        <div v-for="item in detectedItems" :key="item.label" class="step-why__row">
          <dt>{{ item.label }}</dt>
          <dd>{{ item.value }}</dd>
        </div>
      </dl>
    </div>

    <SkipConsequenceNote :step-id="stepId" />
  </section>
</template>

<script lang="ts">
export interface StepWhyDetectedItem {
  label: string
  value: string
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SkipConsequenceNote from '@/components/onboarding/SkipConsequenceNote.vue'
import { whyFor } from '@/config/onboardingSteps'

const props = withDefaults(
  defineProps<{
    stepId: string
    detected?: StepWhyDetectedItem[]
  }>(),
  {
    detected: () => [],
  },
)

const why = computed(() => whyFor(props.stepId))
const detectedItems = computed(() =>
  props.detected.filter((item) => item.value.trim() !== ''),
)
</script>

<style scoped>
.step-why {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 12px;
  line-height: 1.55;
}

.step-why__reason {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.step-why__reason :deep(svg) {
  flex: none;
  margin-block-start: 2px;
  color: var(--accent);
}

.step-why__reason strong {
  color: var(--ink);
  font-weight: 600;
}

.step-why__detected {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-block-start: var(--space-2);
  border-block-start: 1px solid var(--hairline);
}

.step-why__detected-title {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.step-why__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
}

.step-why__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
}

.step-why__row dt {
  flex: none;
  min-inline-size: 84px;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.step-why__row dd {
  flex: 1 1 180px;
  margin: 0;
  color: var(--ink);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
