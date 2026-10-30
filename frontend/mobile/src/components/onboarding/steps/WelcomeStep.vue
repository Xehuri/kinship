<template>
  <section class="onboarding-panel onboarding-welcome" data-onboarding-panel="welcome">
    <div class="onboarding-welcome__hero">
      <p class="onboarding-eyebrow">Kinship · 首次启动</p>
      <h3 class="onboarding-welcome__title">先认识你，再开始记录</h3>
      <p class="onboarding-welcome__lede">
        Kinship 把你的日常数据留在自己的服务器上，由 AI 慢慢读懂你的作息、习惯与变化。
        接下来几步会创建管理员账号、准备运行依赖，并把 AI 助手接上。
      </p>
    </div>

    <StepWhy step-id="welcome" />

    <ul class="onboarding-welcome__points">
      <li>
        <span class="onboarding-welcome__point-icon"><AppIcon name="Database" :size="16" /></span>
        <span>
          <strong>数据归你所有</strong>
          <span>采集与报告都落在这台服务器，不经过第三方云端。</span>
        </span>
      </li>
      <li>
        <span class="onboarding-welcome__point-icon"><AppIcon name="User" :size="16" /></span>
        <span>
          <strong>先建账号，再改配置</strong>
          <span>管理员账号是后续所有写入操作的凭据。</span>
        </span>
      </li>
      <li>
        <span class="onboarding-welcome__point-icon"><AppIcon name="CheckCircle" :size="16" /></span>
        <span>
          <strong>可选组件随时能补</strong>
          <span>音频内核、模型、MOSS 与 AI 助手都可以稍后完成。</span>
        </span>
      </li>
    </ul>

    <section
      class="onboarding-section"
      data-onboarding-ai-handoff
      data-testid="onboarding-ai-handoff"
    >
      <h4 class="onboarding-section__title">让 AI 帮你配置</h4>
      <p>如果想让 AI 完成配置，把下面这个路径交给你的 harness：</p>
      <div class="onboarding-inline-action">
        <code class="onboarding-code" data-onboarding-ai-handoff-path data-testid="onboarding-ai-handoff-path">{{ HARNESS_DOC_PATH }}</code>
        <button
          v-if="canCopy"
          class="onboarding-button"
          type="button"
          data-onboarding-ai-handoff-copy
          data-testid="onboarding-ai-handoff-copy"
          @click="copyPath"
        >
          <AppIcon :name="copied ? 'Check' : 'Copy'" :size="14" />
          <span>{{ copied ? '已复制' : '复制路径' }}</span>
        </button>
      </div>
      <p
        v-if="!canCopy"
        class="onboarding-hint"
        data-onboarding-ai-handoff-status
      >
        当前浏览器不支持自动复制，请手动选择上面的路径。
      </p>
      <p
        v-else-if="copyFailed"
        class="onboarding-hint"
        data-onboarding-ai-handoff-status
      >
        复制失败，请手动选择上面的路径。
      </p>
      <p class="onboarding-hint">
        文档覆盖 GUI 与 harness 部署、Windows / Linux 差异、启动验证与安全红线。这是仓库内路径，不是网页链接。
      </p>
    </section>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-welcome-start
        @click="emit('start')"
      >
        <span>开始初始化</span>
        <AppIcon name="ArrowRight" :size="14" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import StepWhy from '@/components/onboarding/StepWhy.vue'

const HARNESS_DOC_PATH = 'docs/ai-harness-setup.md'

const emit = defineEmits<{
  start: []
}>()

const canCopy =
  typeof navigator !== 'undefined' &&
  navigator.clipboard !== undefined &&
  typeof navigator.clipboard.writeText === 'function'
const copied = ref(false)
const copyFailed = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyPath(): Promise<void> {
  if (!canCopy) return
  try {
    await navigator.clipboard.writeText(HARNESS_DOC_PATH)
    copied.value = true
    copyFailed.value = false
    if (copiedTimer !== undefined) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    copied.value = false
    copyFailed.value = true
  }
}

onBeforeUnmount(() => {
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
})
</script>
