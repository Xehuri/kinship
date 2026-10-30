<template>
  <section
    class="onboarding-section job-progress"
    data-onboarding-job
    :data-onboarding-job-state="job.state"
  >
    <header class="job-progress__head">
      <h4 class="onboarding-section__title">{{ heading }}</h4>
      <span class="job-progress__state" :data-job-state="job.state">
        {{ stateLabel }}
      </span>
    </header>

    <p v-if="job.current" class="job-progress__current">
      当前：<code class="onboarding-code">{{ job.current }}</code>
    </p>

    <div
      class="job-progress__track"
      role="progressbar"
      aria-label="下载进度"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent"
      :data-onboarding-job-progress="percent"
    >
      <span class="job-progress__fill" :style="{ transform: `scaleX(${percent / 100})` }"></span>
    </div>
    <p class="job-progress__meta" data-onboarding-job-progress-text>
      {{ progressText }}
    </p>

    <p
      v-if="!terminal"
      class="job-progress__leave-note"
      data-onboarding-job-leave-note
    >
      可关闭页面，任务会继续；重新打开可继续查看
    </p>

    <p
      v-if="job.error"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-job-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ job.error }}</span>
    </p>
    <p
      v-else-if="error"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-job-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ error }}</span>
    </p>

    <ul
      v-if="job.logs_tail.length > 0"
      class="job-progress__logs"
      data-onboarding-job-logs
    >
      <li v-for="(line, index) in job.logs_tail" :key="`${index}-${line}`">
        {{ line }}
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { DownloadJob } from '@/api/system'
import { isTerminalJobState } from '@/composables/useOnboardingJobs'
import { formatBytes, jobStateLabel } from '@/components/onboarding/onboardingStatus'

const props = withDefaults(
  defineProps<{
    job: DownloadJob
    heading?: string
    error?: string | null
  }>(),
  {
    heading: '作业进度',
    error: null,
  },
)

const percent = computed(() =>
  Math.min(100, Math.max(0, Math.round(props.job.progress.pct || 0))),
)
const stateLabel = computed(() => jobStateLabel(props.job.state))
const terminal = computed(() => isTerminalJobState(props.job.state))
const progressText = computed(() => {
  const { bytes, total } = props.job.progress
  if (total && total > 0) {
    return `${formatBytes(bytes)} / ${formatBytes(total)}（${percent.value}%）`
  }
  return bytes > 0 ? `已处理 ${formatBytes(bytes)}` : '等待开始'
})
</script>

<style scoped>
.job-progress {
  gap: var(--space-2);
}

.job-progress__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-1) var(--space-3);
}

.job-progress__state {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.job-progress__state[data-job-state='done'] {
  color: var(--success);
}

.job-progress__state[data-job-state='failed'],
.job-progress__state[data-job-state='cancelled'] {
  color: var(--danger);
}

.job-progress__state[data-job-state='running'],
.job-progress__state[data-job-state='queued'] {
  color: var(--accent);
}

.job-progress__current,
.job-progress__meta {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.job-progress__leave-note {
  margin: 0;
  color: var(--accent);
  font-size: 11.5px;
  line-height: 1.5;
}

.job-progress__track {
  overflow: hidden;
  block-size: 6px;
  border-radius: 999px;
  background: var(--inset);
}

.job-progress__fill {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  border-radius: inherit;
  background: var(--accent);
  transform-origin: left center;
  transition: transform var(--motion-fast) ease;
}

.job-progress__logs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-block-size: 180px;
  margin: 0;
  padding: var(--space-2);
  overflow-y: auto;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--inset);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  list-style: none;
  overflow-wrap: anywhere;
}
</style>
