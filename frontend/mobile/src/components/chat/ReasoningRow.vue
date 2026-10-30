<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { formatDurationMs } from '@/utils/toolDisplay'

const props = withDefaults(
  defineProps<{
    text: string
    durationMs?: number | null
    live?: boolean
    defaultExpanded?: boolean
  }>(),
  {
    durationMs: null,
    live: false,
    defaultExpanded: false,
  },
)

const expanded = ref(props.defaultExpanded)
const bodyId = `reasoning-body-${useId()}`

const preview = computed(() => props.text.replace(/\s+/g, ' ').trim())
const durationText = computed(() => formatDurationMs(props.durationMs))

function toggle(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <article
    class="reasoning-row"
    data-testid="reasoning-row"
    :data-state="expanded ? 'expanded' : 'collapsed'"
    :data-live="live ? 'true' : undefined"
  >
    <button
      class="reasoning-row__header"
      type="button"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-controls="bodyId"
      @click="toggle"
    >
      <AppIcon
        class="reasoning-row__icon"
        name="Brain"
        :size="14"
      />
      <span class="reasoning-row__label">思考</span>
      <span
        v-if="!expanded"
        class="reasoning-row__dot"
        aria-hidden="true"
      />
      <span
        v-if="!expanded"
        class="reasoning-row__preview"
        data-testid="reasoning-preview"
        aria-hidden="true"
      >{{ preview }}</span>
      <span
        v-if="durationText"
        class="reasoning-row__duration"
        data-testid="reasoning-duration"
      >{{ durationText }}</span>
    </button>

    <p
      v-if="expanded"
      :id="bodyId"
      class="reasoning-row__text"
      data-testid="reasoning-body"
    >
      {{ text }}
    </p>
  </article>
</template>

<style scoped>
.reasoning-row {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
}

.reasoning-row__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  inline-size: 100%;
  min-block-size: var(--tap);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
  text-align: start;
}

.reasoning-row__icon {
  color: var(--muted);
}

.reasoning-row__label {
  flex: none;
  color: var(--ink);
  white-space: nowrap;
}

.reasoning-row__dot {
  flex: none;
  inline-size: 2px;
  block-size: 2px;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.7;
}

.reasoning-row__preview {
  flex: 1 1 auto;
  min-inline-size: 0;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reasoning-row__duration {
  flex: none;
  margin-inline-start: auto;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.reasoning-row__header:hover .reasoning-row__label {
  color: var(--accent);
}

.reasoning-row__text {
  margin: 0 0 var(--space-2);
  padding-inline-start: 22px;
  color: var(--muted);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .reasoning-row[data-live="true"] .reasoning-row__label,
  .reasoning-row[data-live="true"] .reasoning-row__preview {
    background: linear-gradient(90deg, var(--muted) 0%, var(--ink) 45%, var(--muted) 90%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: reasoning-shimmer 1.6s linear infinite;
  }
}

@keyframes reasoning-shimmer {
  from {
    background-position: 200% 0;
  }

  to {
    background-position: -200% 0;
  }
}

@media (min-width: 768px) and (pointer: fine) {
  .reasoning-row__header {
    min-block-size: 24px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning-row[data-live="true"] .reasoning-row__label,
  .reasoning-row[data-live="true"] .reasoning-row__preview {
    animation: none;
    background: none;
    color: var(--muted);
  }
}

:root[data-motion="reduced"] .reasoning-row[data-live="true"] .reasoning-row__label,
:root[data-motion="reduced"] .reasoning-row[data-live="true"] .reasoning-row__preview {
  animation: none;
  background: none;
  color: var(--muted);
}
</style>
