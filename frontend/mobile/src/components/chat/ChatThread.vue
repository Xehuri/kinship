<script setup lang="ts">
import { computed } from 'vue'
import type { CompactionStep, TurnView } from '@/types/turn'
import {
  buildProcessGroups,
  processDurationMs,
  type ProcessGroupView,
} from '@/utils/processGroups'
import type { ToolFocusPayload } from '@/utils/toolDisplay'
import AssistantMessage from './AssistantMessage.vue'
import ProcessDisclosure from './ProcessDisclosure.vue'
import TerminalRow from './TerminalRow.vue'
import ThreadDivider from './ThreadDivider.vue'
import UserMessage from './UserMessage.vue'

interface ThreadRow {
  turn: TurnView
  groups: ProcessGroupView[]
  compactions: CompactionStep[]
  hasUserContent: boolean
  dividerOnly: boolean
}

const props = defineProps<{
  turns: TurnView[]
}>()

const emit = defineEmits<{
  'open-focus': [payload: ToolFocusPayload]
}>()

const rows = computed<ThreadRow[]>(() =>
  props.turns.map((turn) => {
    const groups = buildProcessGroups(turn)
    const compactions: CompactionStep[] = []
    for (const step of turn.steps) {
      if (step.type === 'compaction') {
        compactions.push(step)
      }
    }
    const hasUserContent =
      turn.userText.trim().length > 0 || turn.attachments.length > 0
    const dividerOnly =
      !hasUserContent &&
      turn.reply.trim().length === 0 &&
      turn.steps.length > 0 &&
      compactions.length === turn.steps.length

    return { turn, groups, compactions, hasUserContent, dividerOnly }
  }),
)

const latestProcessTurnId = computed<string | null>(() => {
  for (let index = rows.value.length - 1; index >= 0; index -= 1) {
    const row = rows.value[index]
    if (row === undefined || !row.hasUserContent) {
      continue
    }
    return row.groups.length > 0 ? row.turn.id : null
  }
  return null
})
</script>

<template>
  <div
    class="chat-thread"
    data-testid="chat-thread"
    role="feed"
    aria-label="对话"
  >
    <template
      v-for="row in rows"
      :key="row.turn.id"
    >
      <div
        v-if="row.dividerOnly"
        class="chat-thread__divider"
      >
        <ThreadDivider
          v-for="(step, index) in row.compactions"
          :key="`${row.turn.id}:compaction:${index}`"
          :step="step"
          @open-focus="emit('open-focus', $event)"
        />
      </div>

      <article
        v-else
        class="chat-thread__turn"
        data-testid="chat-turn"
        :data-turn-id="row.turn.id"
        :data-live="row.turn.live ? 'true' : undefined"
      >
        <UserMessage
          v-if="row.hasUserContent"
          :text="row.turn.userText"
          :attachments="row.turn.attachments"
        />

        <ProcessDisclosure
          v-if="row.groups.length > 0"
          :turn="row.turn"
          :default-expanded="row.turn.id === latestProcessTurnId"
          @open-focus="emit('open-focus', $event)"
        />

        <div
          v-if="row.compactions.length > 0"
          class="chat-thread__compactions"
        >
          <ThreadDivider
            v-for="(step, index) in row.compactions"
            :key="`${row.turn.id}:compaction:${index}`"
            :step="step"
            @open-focus="emit('open-focus', $event)"
          />
        </div>

        <AssistantMessage
          :text="row.turn.reply"
          :live="row.turn.live"
        />

        <TerminalRow
          v-if="row.turn.terminal"
          :terminal="row.turn.terminal"
          :duration-ms="processDurationMs(row.turn)"
        />
      </article>
    </template>
  </div>
</template>

<style scoped>
.chat-thread {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  inline-size: 100%;
  max-inline-size: var(--chat-column);
  min-inline-size: 0;
  margin-inline: auto;
  padding: var(--space-5) var(--space-4) var(--space-8);
}

.chat-thread__divider {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-inline-size: 0;
}

.chat-thread__turn {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-inline-size: 0;
}

.chat-thread__compactions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-inline-size: 0;
}

@media (min-width: 768px) {
  .chat-thread {
    gap: var(--space-7);
    padding-inline: var(--space-5);
  }
}
</style>
