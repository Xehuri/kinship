<template>
  <nav class="ax-mobile-nav" aria-label="底部导航">
    <button
      v-for="item in items"
      :key="item.id"
      class="ax-mobile-nav__item"
      :class="{ 'ax-mobile-nav__item--active': item.id === active }"
      type="button"
      :aria-current="item.id === active ? 'page' : undefined"
      @click="emit('select', item.id)"
    >
      <AppIcon :name="item.icon" :size="20" />
      <span class="ax-mobile-nav__label">{{ item.label }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { MobileNavV2Id, MobileNavV2Item } from '@/config/navV2'

defineProps<{
  items: readonly MobileNavV2Item[]
  active: MobileNavV2Id | null
}>()

const emit = defineEmits<{
  select: [id: MobileNavV2Id]
}>()
</script>
