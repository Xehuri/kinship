<template>
  <div class="code-surface" data-testid="code-surface" :data-language="displayLanguage">
    <div class="code-surface__header">
      <span class="code-surface__lang">{{ displayLanguage }}</span>
      <span v-if="name" class="code-surface__name" :title="name">{{ name }}</span>
      <span class="code-surface__count">{{ lineCount }} 行</span>
    </div>
    <div v-if="isEmpty" class="code-surface__empty">文件内容为空</div>
    <div v-else class="code-surface__scroller">
      <div v-if="lineNumbers" class="code-surface__gutter" aria-hidden="true">
        <span v-for="lineNumber in lineNumberList" :key="lineNumber" class="code-surface__ln">
          {{ lineNumber }}
        </span>
      </div>
      <pre class="code-surface__pre"><code class="code-surface__code">{{ displayCode }}</code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { prettyJson, splitCodeLines } from '@/utils/codeFormat'

const props = withDefaults(
  defineProps<{
    code: string
    language?: string
    name?: string
    lineNumbers?: boolean
  }>(),
  {
    language: 'text',
    lineNumbers: true,
  },
)

const displayLanguage = computed(() => props.language.trim().toLowerCase() || 'text')

const displayCode = computed(() => {
  const source = displayLanguage.value === 'json' ? prettyJson(props.code) : props.code
  return splitCodeLines(source).join('\n')
})

const lines = computed(() => splitCodeLines(displayCode.value))

const lineCount = computed(() => lines.value.length)

const isEmpty = computed(() => displayCode.value === '')

const lineNumberList = computed(() => lines.value.map((_line, index) => index + 1))
</script>
