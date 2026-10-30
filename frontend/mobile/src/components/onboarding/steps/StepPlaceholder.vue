<template>
  <section class="onboarding-panel" :data-onboarding-panel="stepId">
    <header class="onboarding-panel__head">
      <p class="onboarding-eyebrow">后续接入</p>
      <h3 class="onboarding-panel__title">{{ title }}</h3>
      <p v-if="description" class="onboarding-panel__desc">{{ description }}</p>
    </header>

    <div class="onboarding-placeholder" data-onboarding-placeholder>
      <span class="onboarding-placeholder__icon">
        <AppIcon name="Wrench" :size="18" />
      </span>
      <span class="onboarding-placeholder__body">
        <strong>待接入</strong>
        <span>{{ note }}</span>
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'

withDefaults(
  defineProps<{
    stepId: string
    title: string
    description?: string
    note?: string
  }>(),
  {
    description: '',
    note: '该步骤的界面与操作将在后续任务接入；当前不会执行任何操作，也不会伪造完成状态。',
  },
)
</script>
