<template>
  <AppShell title="提醒" :meta="headerMeta">
    <template #actions>
      <button
        class="ax-reminders__history"
        type="button"
        data-testid="reminders-notifications"
        @click="handleOpenNotifications"
      >
        <AppIcon name="Bell" :size="16" />
        <span>通知历史</span>
      </button>
    </template>

    <div class="ax-page">
      <div v-if="state === 'error'" class="ax-state" role="alert">
        <h2 class="ax-state__title">加载失败</h2>
        <p class="ax-state__body">无法获取提醒板，请检查连接后重试。</p>
        <button class="ax-state__action" type="button" @click="loadBoard">
          重试
        </button>
      </div>

      <div
        v-else-if="state === 'loading'"
        class="ax-list"
        aria-busy="true"
        aria-label="正在加载提醒"
      >
        <div v-for="index in 4" :key="index" class="ax-skeleton">
          <span class="skeleton ax-skeleton__line" />
          <span class="skeleton ax-skeleton__line ax-skeleton__line--short" />
        </div>
      </div>

      <div v-else-if="lines.length === 0" class="ax-state">
        <h2 class="ax-state__title">暂无提醒</h2>
        <p class="ax-state__body">AI 写下的提醒会显示在这块只读提醒板上。</p>
      </div>

      <template v-else>
        <ul class="ax-reminders">
          <li
            v-for="(line, index) in lines"
            :key="index"
            class="ax-reminders__line"
          >
            <span class="ax-reminders__marker" aria-hidden="true">·</span>
            <span>{{ line }}</span>
          </li>
        </ul>
        <p v-if="updatedLabel" class="ax-reminders__updated">
          更新于 {{ updatedLabel }}
        </p>
      </template>
    </div>
  </AppShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useNotificationsSingleton } from '@/composables/useNotifications'
import { fetchReminders, type RemindersBoard } from '@/api/reminders'

type BoardState = 'loading' | 'ready' | 'error'

const state = ref<BoardState>('loading')
const board = ref<RemindersBoard | null>(null)

const { open: openNotifications } = useNotificationsSingleton()

function handleOpenNotifications(): void {
  void openNotifications()
}

const lines = computed<string[]>(() => {
  const text = board.value?.text ?? ''
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
})

const updatedLabel = computed<string>(() => {
  return formatUpdatedAt(board.value?.updated_at ?? 0)
})

const headerMeta = computed<string>(() => {
  if (state.value === 'error') return '加载失败'
  if (state.value === 'loading') return '正在加载'
  if (!updatedLabel.value) return '尚未更新'
  return `更新于 ${updatedLabel.value}`
})

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatUpdatedAt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function loadBoard(): Promise<void> {
  state.value = 'loading'
  const result = await fetchReminders()
  if (!result) {
    board.value = null
    state.value = 'error'
    return
  }
  board.value = result
  state.value = 'ready'
}

onMounted(() => {
  void loadBoard()
})
</script>

<style scoped>
.ax-reminders__history {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-block-size: var(--tap);
  padding-inline: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
}

.ax-reminders__history:hover {
  background: var(--inset);
}

.ax-reminders__history:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
