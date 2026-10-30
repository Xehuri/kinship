<template>
  <nav class="ax-nav" aria-label="主导航">
    <div class="ax-nav__brand">
      <p class="ax-nav__brand-name">Kinship</p>
      <p class="ax-nav__brand-sub">知己</p>
    </div>

    <ul class="ax-nav__list">
      <li
        v-for="item in items"
        :key="item.id"
        class="ax-nav__item-wrap"
      >
        <button
          class="ax-nav__item"
          :class="{ 'ax-nav__item--active': item.id === active }"
          type="button"
          :aria-label="item.label"
          :aria-current="item.id === active ? 'page' : undefined"
          :title="item.label"
          @click="emit('select', item.id)"
        >
          <AppIcon :name="item.icon" :size="18" />
          <span class="ax-nav__label">{{ item.label }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { NavV2Id, NavV2Item } from '@/config/navV2'

defineProps<{
  items: readonly NavV2Item[]
  active: NavV2Id | null
}>()

const emit = defineEmits<{
  select: [id: NavV2Id]
}>()
</script>
