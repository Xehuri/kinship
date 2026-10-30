<script setup lang="ts">
import { computed } from 'vue'
import { Activity } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    size?: number
    compact?: boolean
  }>(),
  {
    size: 36,
    compact: false,
  },
)

const markStyle = computed(() => ({ '--mark-size': `${props.size}px` }))
const glyphSize = computed(() => Math.round(props.size * 0.52))
</script>

<template>
  <div class="app-mark" :style="markStyle">
    <span class="app-mark__glyph" aria-hidden="true">
      <Activity :size="glyphSize" :stroke-width="2.2" />
    </span>
    <span v-if="!compact" class="app-mark__text">
      <strong>Kinship</strong>
      <small>桌面端</small>
    </span>
  </div>
</template>

<style scoped>
.app-mark {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.app-mark__glyph {
  display: grid;
  place-items: center;
  width: var(--mark-size);
  height: var(--mark-size);
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-contrast);
}

.app-mark__text {
  min-width: 0;
}

.app-mark__text strong {
  display: block;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.2;
}

.app-mark__text small {
  display: block;
  margin-top: 1px;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.04em;
}
</style>
