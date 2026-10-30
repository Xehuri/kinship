<template>
  <p
    v-if="text"
    class="onboarding-hint onboarding-skip-consequence"
    data-onboarding-skip-consequence
    :data-skip-consequence-step="stepId"
  >
    <AppIcon name="Info" :size="14" />
    <span><strong>跳过会怎样：</strong>{{ text }}</span>
  </p>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { skipConsequenceFor } from '@/config/onboardingSteps'

const props = defineProps<{
  stepId: string
}>()

const text = computed(() => skipConsequenceFor(props.stepId))
</script>

<style scoped>
.onboarding-skip-consequence {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.onboarding-skip-consequence :deep(svg) {
  flex: none;
  margin-block-start: 2px;
}
</style>
