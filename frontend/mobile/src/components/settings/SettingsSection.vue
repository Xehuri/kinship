<template>
  <section class="settings-section">
    <header class="settings-section__head">
      <div class="settings-section__heading">
        <h3 class="settings-section__title">
          {{ title }}
        </h3>
        <p v-if="description" class="settings-section__desc">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="settings-section__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="settings-section__body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  {
    description: '',
  },
)
</script>
