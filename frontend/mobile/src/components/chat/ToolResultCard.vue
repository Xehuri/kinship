<script setup lang="ts">
import { computed } from 'vue'
import type { ToolStep } from '@/types/turn'
import {
  byteLength,
  formatToolArguments,
  INLINE_ARGS_LIMIT,
  inlineResultText,
  isOmittedImageText,
  resultNeedsFocus,
  type ToolFocusPayload,
} from '@/utils/toolDisplay'
import { toolDescriptor } from '@/utils/toolRegistry'

interface DiffLine {
  key: string
  kind: 'add' | 'remove' | 'hunk' | 'context'
  text: string
}

const props = withDefaults(
  defineProps<{
    step: ToolStep
    showFocus?: boolean
  }>(),
  {
    showFocus: true,
  },
)

const emit = defineEmits<{
  'open-focus': [payload: ToolFocusPayload]
}>()

const descriptor = computed(() => toolDescriptor(props.step.name))
const kind = computed(() => descriptor.value.resultKind)
const input = computed(() =>
  formatToolArguments(props.step.arguments, INLINE_ARGS_LIMIT),
)
const result = computed(() => props.step.result)
const imageOmitted = computed(
  () => result.value !== undefined && isOmittedImageText(result.value.text),
)
const output = computed(() => {
  const value = result.value
  if (value === undefined) {
    return ''
  }
  return imageOmitted.value ? '' : inlineResultText(value)
})
const outputLines = computed(() =>
  output.value.length === 0 ? [] : output.value.split(/\r?\n/),
)
const needsFocus = computed(() =>
  result.value === undefined ? false : resultNeedsFocus(result.value),
)
const tone = computed<'error' | 'warning' | undefined>(() => {
  if (props.step.status === 'abandoned') {
    return 'warning'
  }
  if (props.step.status === 'error' || result.value?.isError === true) {
    return 'error'
  }
  return undefined
})
const diffLines = computed<DiffLine[]>(() =>
  outputLines.value.map((text, index) => {
    let lineKind: DiffLine['kind'] = 'context'
    if (text.startsWith('@@')) {
      lineKind = 'hunk'
    } else if (text.startsWith('+')) {
      lineKind = 'add'
    } else if (text.startsWith('-')) {
      lineKind = 'remove'
    }
    return { key: `${index}-${text.slice(0, 12)}`, kind: lineKind, text }
  }),
)
const isTerminal = computed(() => kind.value === 'terminal')
const inputText = computed(() => {
  if (!isTerminal.value) {
    return input.value
  }
  return input.value.trimStart().startsWith('$') ? input.value : `$ ${input.value}`
})

function openFocus(): void {
  const value = result.value
  if (value === undefined) {
    return
  }
  emit('open-focus', {
    title: `${props.step.name} 输出`,
    content: value.text,
    bytes: byteLength(value.text),
    truncated: value.truncated,
  })
}
</script>

<template>
  <section
    class="tool-result-card"
    data-testid="tool-result-card"
    :data-card-kind="kind"
    :data-tone="tone"
  >
    <div class="tool-result-card__scroll">
      <div class="tool-result-card__section">
        <span class="tool-result-card__label">IN</span>
        <pre class="tool-result-card__input" data-testid="tool-args">{{ inputText }}</pre>
      </div>

      <div class="tool-result-card__section tool-result-card__section--out">
        <span class="tool-result-card__label">OUT</span>

        <div
          v-if="kind === 'diff' && output.length > 0"
          class="tool-result-card__diff"
        >
          <span
            v-for="line in diffLines"
            :key="line.key"
            class="tool-result-card__diff-line"
            :class="`tool-result-card__diff-line--${line.kind}`"
          >{{ line.text || ' ' }}</span>
        </div>

        <div
          v-else-if="kind === 'search' && output.length > 0"
          class="tool-result-card__matches"
        >
          <span
            v-for="(line, index) in outputLines"
            :key="`match-${index}`"
            class="tool-result-card__match"
          >{{ line }}</span>
        </div>

        <div
          v-else-if="kind === 'image'"
          class="tool-result-card__media"
        >
          <p
            v-if="imageOmitted"
            class="tool-result-card__omitted"
          >
            图片数据已省略（不渲染 base64）
          </p>
          <pre
            v-else-if="output.length > 0"
            class="tool-result-card__output"
          >{{ output }}</pre>
          <p
            v-else
            class="tool-result-card__empty"
          >
            无输出
          </p>
        </div>

        <pre
          v-else-if="output.length > 0"
          class="tool-result-card__output"
        >{{ output }}</pre>

        <p
          v-else
          class="tool-result-card__empty"
        >
          无输出
        </p>
      </div>
    </div>

    <footer
      v-if="showFocus && needsFocus"
      class="tool-result-card__footer"
    >
      <button
        class="tool-result-card__focus"
        type="button"
        data-testid="tool-result-card__focus"
        @click="openFocus"
      >
        打开完整输出
      </button>
    </footer>
  </section>
</template>

<style scoped>
.tool-result-card {
  display: flex;
  flex-direction: column;
  max-block-size: 320px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-raised);
  overflow: hidden;
}

.tool-result-card__scroll {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-block-size: 0;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
}

.tool-result-card__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
}

.tool-result-card__label {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.4;
}

.tool-result-card[data-tone="error"] .tool-result-card__output,
.tool-result-card[data-tone="error"] .tool-result-card__input {
  color: var(--danger);
}

.tool-result-card[data-tone="warning"] .tool-result-card__output,
.tool-result-card[data-tone="warning"] .tool-result-card__input {
  color: var(--warning);
}

.tool-result-card__input,
.tool-result-card__output,
.tool-result-card__empty {
  margin: 0;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.tool-result-card__input {
  color: var(--muted);
}

.tool-result-card__empty {
  color: var(--muted);
}

.tool-result-card__diff,
.tool-result-card__matches {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
}

.tool-result-card__diff-line,
.tool-result-card__match {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.tool-result-card__diff-line--add {
  color: var(--success);
}

.tool-result-card__diff-line--remove {
  color: var(--danger);
}

.tool-result-card__diff-line--hunk {
  color: var(--muted);
}

.tool-result-card__diff-line--context {
  color: var(--ink);
}

.tool-result-card__match {
  color: var(--ink);
}

.tool-result-card__media {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-inline-size: 0;
}

.tool-result-card__omitted {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.tool-result-card__footer {
  display: flex;
  flex: none;
  padding: var(--space-1) var(--space-3);
  border-block-start: 1px solid var(--hairline);
}

.tool-result-card__focus {
  min-block-size: var(--tap);
  color: var(--accent);
  font-size: 12px;
  text-align: start;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

@media (min-width: 768px) and (pointer: fine) {
  .tool-result-card__focus {
    min-block-size: 24px;
  }
}
</style>
