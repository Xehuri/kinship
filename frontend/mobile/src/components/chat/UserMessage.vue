<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { TurnAttachment } from '@/types/turn'
import { formatClockTime } from '@/utils/toolDisplay'

const props = withDefaults(
  defineProps<{
    text: string
    attachments?: TurnAttachment[]
    at?: number | null
  }>(),
  {
    attachments: () => [],
    at: null,
  },
)

const timeText = computed(() => formatClockTime(props.at))
const hasText = computed(() => props.text.trim().length > 0)
</script>

<template>
  <div
    class="user-message"
    data-testid="user-message"
  >
    <div class="user-message__bubble">
      <p
        v-if="hasText"
        class="user-message__text"
      >
        {{ text }}
      </p>

      <div
        v-if="attachments.length > 0"
        class="user-message__attachments"
      >
        <span
          v-for="attachment in attachments"
          :key="attachment.id"
          class="user-message__attachment"
          :data-kind="attachment.kind"
        >
          <AppIcon
            name="Paperclip"
            :size="12"
          />
          <span class="user-message__attachment-name">{{ attachment.name }}</span>
        </span>
      </div>

      <time
        v-if="timeText"
        class="user-message__time"
      >{{ timeText }}</time>
    </div>
  </div>
</template>

<style scoped>
.user-message {
  display: flex;
  justify-content: flex-end;
  min-inline-size: 0;
}

.user-message__bubble {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-inline-size: min(68ch, 88%);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius);
  background: var(--inset);
  color: var(--ink);
}

.user-message__text {
  margin: 0;
  font-size: 15px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.user-message__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.user-message__attachment {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-inline-size: 0;
  max-inline-size: 100%;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.user-message__attachment-name {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-message__time {
  align-self: flex-end;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
</style>
