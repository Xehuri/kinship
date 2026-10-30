<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import MarkdownContent from '@/components/chat/MarkdownContent.vue'
import { formatClockTime } from '@/utils/toolDisplay'

const props = withDefaults(
  defineProps<{
    text?: string
    live?: boolean
    at?: number | null
  }>(),
  {
    text: '',
    live: false,
    at: null,
  },
)

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const empty = computed(() => props.text.trim().length === 0)
const canCopy = computed(
  () =>
    typeof navigator !== 'undefined' &&
    navigator.clipboard !== undefined &&
    typeof navigator.clipboard.writeText === 'function',
)
const timeText = computed(() => (empty.value ? '' : formatClockTime(props.at)))
const showFooter = computed(() => !empty.value && (canCopy.value || timeText.value.length > 0))

async function copyText(): Promise<void> {
  if (!canCopy.value) {
    return
  }
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    if (copiedTimer !== undefined) {
      clearTimeout(copiedTimer)
    }
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    copied.value = false
  }
}

onBeforeUnmount(() => {
  if (copiedTimer !== undefined) {
    clearTimeout(copiedTimer)
  }
})
</script>

<template>
  <article
    v-if="!empty || live"
    class="assistant-message"
    data-testid="assistant-message"
    :data-live="live ? 'true' : undefined"
  >
    <div
      v-if="!empty"
      class="assistant-message__prose"
      data-testid="assistant-prose"
    >
      <MarkdownContent
        :content="text"
        :streaming="live"
      />
    </div>

    <footer
      v-if="showFooter"
      class="assistant-message__footer"
    >
      <time
        v-if="timeText"
        class="assistant-message__time"
      >{{ timeText }}</time>
      <button
        v-if="canCopy"
        class="assistant-message__copy"
        type="button"
        data-testid="assistant-copy"
        @click="copyText"
      >
        <AppIcon
          name="Copy"
          :size="12"
        />
        <span aria-live="polite">{{ copied ? '已复制' : '复制' }}</span>
      </button>
    </footer>
  </article>
</template>

<style scoped>
.assistant-message {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-inline-size: 0;
}

.assistant-message__prose {
  max-inline-size: var(--prose-measure);
  color: var(--ink);
  font-size: 16px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}

.assistant-message__prose :deep(.md-content),
.assistant-message__prose :deep(.md-plain) {
  font-size: 16px;
  line-height: 1.8;
  color: var(--ink);
}

.assistant-message__prose :deep(.md-content p),
.assistant-message__prose :deep(.md-content li) {
  font-size: inherit;
  line-height: inherit;
  color: inherit;
}

.assistant-message__prose :deep(.md-content h1),
.assistant-message__prose :deep(.md-content h2),
.assistant-message__prose :deep(.md-content h3) {
  color: var(--ink);
}

.assistant-message__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  min-block-size: 24px;
}

.assistant-message__time {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}

.assistant-message__copy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-block-size: 28px;
  padding-inline: var(--space-1);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}

.assistant-message__copy:hover {
  background: var(--inset);
  color: var(--ink);
}
</style>
