<template>
  <div class="ax-page-header">
    <div class="ax-page-header__text">
      <h1 class="ax-page-header__title">
        {{ title }}
      </h1>
      <p v-if="meta" class="ax-page-header__meta">
        {{ meta }}
      </p>
    </div>
    <div v-if="$slots.actions" class="ax-page-header__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    meta?: string
  }>(),
  {
    meta: '',
  },
)
</script>
