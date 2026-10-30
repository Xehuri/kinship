<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CircleAlert, LoaderCircle, ScrollText, ShieldAlert, X } from 'lucide-vue-next'
import { useDesktopApi } from '../composables/useDesktopApi'

const RESET_PHRASE = '重置'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

const api = useDesktopApi()
const step = ref<1 | 2>(1)
const phrase = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const phraseInput = ref<HTMLInputElement | null>(null)

const phraseMatches = computed(() => phrase.value === RESET_PHRASE)

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      step.value = 1
      phrase.value = ''
      busy.value = false
      error.value = null
      return
    }
    step.value = 1
    phrase.value = ''
    busy.value = false
    error.value = null
    await nextTick()
    cancelButton.value?.focus()
  },
  { immediate: true },
)

async function continueToFinal(): Promise<void> {
  if (busy.value) return
  step.value = 2
  error.value = null
  await nextTick()
  phraseInput.value?.focus()
}

function requestClose(): void {
  if (busy.value) return
  emit('close')
}

async function confirmReset(): Promise<void> {
  if (busy.value || !phraseMatches.value) return
  busy.value = true
  error.value = null
  const response = await api.resetAll()
  busy.value = false

  if (!response.ok) {
    error.value = response.error || '重置失败，请稍后重试'
    await nextTick()
    phraseInput.value?.focus()
    return
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  if (event.key !== 'Tab' || panelRef.value === null) return

  const focusable = Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  )
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first?.focus()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    v-if="open"
    class="reset-overlay"
    data-test="reset-dialog"
    @click.self="requestClose"
  >
    <section
      ref="panelRef"
      class="reset-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-dialog-title"
      aria-describedby="reset-dialog-desc"
    >
      <header class="reset-head">
        <div class="reset-head__main">
          <span class="reset-emblem" aria-hidden="true">
            <ShieldAlert :size="18" :stroke-width="2" />
          </span>
          <div>
            <p class="eyebrow">DANGER ZONE · 第 {{ step }} / 2 步</p>
            <h2 id="reset-dialog-title">
              {{ step === 1 ? '重置所有参数？' : '最后确认' }}
            </h2>
            <p id="reset-dialog-desc" class="reset-sub">
              {{
                step === 1
                  ? '桌面端将清除本机保存的全部参数，并回到首次启动设置。'
                  : '重置完成后需要重新填写服务器地址并配置 PC 采集端。'
              }}
            </p>
          </div>
        </div>
        <button
          type="button"
          class="reset-close"
          data-test="reset-close"
          aria-label="关闭重置对话框"
          :disabled="busy"
          @click="requestClose"
        >
          <X :size="18" :stroke-width="2" />
        </button>
      </header>

      <div v-if="step === 1" class="reset-body" data-test="reset-confirm">
        <div class="notice notice--danger" role="alert">
          <CircleAlert :size="16" :stroke-width="2" />
          <div>
            <strong>此操作不可撤销</strong>
            本机配置删除后无法恢复，需要重新完成首次设置。
          </div>
        </div>

        <div class="reset-scope">
          <p class="reset-scope__title">将被清除</p>
          <ul class="reset-list">
            <li>服务器地址</li>
            <li>证书信任与 CA 证书</li>
            <li>网络端点</li>
            <li>PC 采集端账号与访问令牌</li>
            <li>采集参数</li>
            <li>窗口设置</li>
          </ul>
        </div>

        <p class="reset-keep">
          <ScrollText :size="14" :stroke-width="2" aria-hidden="true" />
          运行日志会保留，不会被删除。
        </p>
      </div>

      <div v-else class="reset-body" data-test="reset-confirm-final">
        <div class="notice notice--danger" role="alert">
          <CircleAlert :size="16" :stroke-width="2" />
          <div>
            <strong>确认重置本机全部参数</strong>
            重置后桌面端会回到首次启动设置。
          </div>
        </div>

        <div class="field">
          <label class="field__label" for="reset-phrase">
            输入 <span class="mono reset-phrase-hint">重置</span> 以继续
          </label>
          <input
            id="reset-phrase"
            ref="phraseInput"
            data-test="reset-phrase"
            v-model="phrase"
            class="input mono"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
            aria-describedby="reset-phrase-hint"
          />
          <p id="reset-phrase-hint" class="field__hint">
            必须与上方文字完全一致，按钮才会启用。
          </p>
        </div>

        <div v-if="error" class="notice notice--danger" role="alert" data-test="reset-error">
          <CircleAlert :size="16" :stroke-width="2" />
          <div>{{ error }}</div>
        </div>
      </div>

      <footer class="reset-foot">
        <span class="reset-foot__note">
          {{ step === 1 ? '继续后会再要求输入确认文字。' : '日志会保留。' }}
        </span>
        <div class="inline-actions">
          <button
            v-if="step === 1"
            ref="cancelButton"
            type="button"
            class="btn btn--ghost"
            data-test="reset-cancel"
            :disabled="busy"
            @click="requestClose"
          >
            取消
          </button>
          <button
            v-if="step === 1"
            type="button"
            class="btn btn--danger"
            data-test="reset-continue"
            :disabled="busy"
            @click="continueToFinal"
          >
            继续
          </button>

          <button
            v-if="step === 2"
            type="button"
            class="btn btn--ghost"
            data-test="reset-cancel"
            :disabled="busy"
            @click="requestClose"
          >
            取消
          </button>
          <button
            v-if="step === 2"
            type="button"
            class="btn btn--danger"
            data-test="reset-final"
            :disabled="busy || !phraseMatches"
            @click="confirmReset"
          >
            <LoaderCircle v-if="busy" class="spinner" :size="15" :stroke-width="2" />
            {{ busy ? '正在重置…' : '确认重置' }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.reset-overlay {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: grid;
  place-items: center;
  padding: var(--space-5);
  background: color-mix(in srgb, #1f1c18 46%, transparent);
  animation: reset-fade var(--motion) var(--ease);
}

.reset-panel {
  display: flex;
  flex-direction: column;
  width: min(600px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: hidden;
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-md);
  background: var(--surface);
  animation: reset-rise var(--motion) var(--ease);
}

.reset-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6) var(--space-4);
  border-bottom: 1px solid var(--border);
}

.reset-head__main {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.reset-emblem {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: none;
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-md);
  background: var(--danger-surface);
  color: var(--danger-ink);
}

.reset-head h2 {
  margin: 5px 0 0;
  font-size: var(--text-xl);
  font-weight: 680;
  letter-spacing: -0.02em;
}

.reset-sub {
  max-width: 46ch;
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.reset-close {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--ease),
    border-color var(--motion-fast) var(--ease),
    opacity var(--motion-fast) var(--ease);
}

.reset-close:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.reset-close:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.reset-close:focus-visible,
.reset-panel input:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.reset-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6);
  overflow-y: auto;
}

.reset-scope {
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
}

.reset-scope__title {
  margin: 0;
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.reset-list {
  display: grid;
  gap: 7px;
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: 1.55;
}

.reset-list li {
  position: relative;
  padding-left: 16px;
}

.reset-list li::before {
  position: absolute;
  top: 0.55em;
  left: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--danger);
  content: '';
}

.reset-keep {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.reset-keep svg {
  flex: none;
  color: var(--text-faint);
}

.reset-phrase-hint {
  padding: 1px 6px;
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-sm);
  background: var(--danger-surface);
  color: var(--danger-ink);
}

.reset-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-6);
  border-top: 1px solid var(--border);
  background: var(--surface-sunken);
}

.reset-foot__note {
  color: var(--text-faint);
  font-size: var(--text-xs);
}

@keyframes reset-fade {
  from {
    opacity: 0;
  }
}

@keyframes reset-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

@media (max-width: 720px) {
  .reset-overlay {
    padding: var(--space-2);
  }

  .reset-panel {
    width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
  }

  .reset-head,
  .reset-body,
  .reset-foot {
    padding-right: var(--space-4);
    padding-left: var(--space-4);
  }

  .reset-foot {
    align-items: stretch;
    flex-direction: column;
  }

  .reset-foot .inline-actions {
    justify-content: flex-end;
  }
}
</style>
