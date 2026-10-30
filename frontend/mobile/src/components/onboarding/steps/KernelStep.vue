<template>
  <section class="onboarding-panel" data-onboarding-panel="kernel">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">音频内核</h3>
      <p class="onboarding-panel__desc">
        安装或复用音频内核程序，确认 Python 运行时可用。发行版下载安装，源码检出在本地构建。
      </p>
    </header>

    <p
      v-if="assetsLoading && !assets"
      class="onboarding-alert"
      data-onboarding-kernel-loading
    >
      <AppIcon name="CircleNotch" :size="14" class="onboarding-spinner" />
      <span>正在读取内核状态…</span>
    </p>

    <StepWhy step-id="kernel" :detected="detected" />

    <section class="kernel-status" data-onboarding-kernel-summary>
      <div class="kernel-status__head">
        <span
          class="kernel-status__badge"
          :data-status="statusKind"
          data-onboarding-kernel-status
        >
          {{ statusLabel }}
        </span>
        <span class="kernel-status__hint">{{ statusDetail }}</span>
      </div>

      <dl class="onboarding-kv">
        <div class="onboarding-kv__row">
          <dt>来源</dt>
          <dd data-onboarding-kernel-source>{{ sourceLabel }}</dd>
        </div>
        <div class="onboarding-kv__row">
          <dt>版本</dt>
          <dd data-onboarding-kernel-version>{{ kernel?.version || '未知' }}</dd>
        </div>
        <div class="onboarding-kv__row">
          <dt>目录</dt>
          <dd><code class="onboarding-code">{{ kernel?.dir || '—' }}</code></dd>
        </div>
        <div class="onboarding-kv__row">
          <dt>Python</dt>
          <dd
            data-onboarding-kernel-python
            :data-ready="python?.exists ? 'true' : 'false'"
          >
            {{ python?.exists ? '已就绪' : '未找到' }}
            <template v-if="python?.path">
              · <code class="onboarding-code">{{ python.path }}</code>
            </template>
          </dd>
        </div>
        <div class="onboarding-kv__row">
          <dt>进程</dt>
          <dd data-onboarding-kernel-health>{{ healthLabel }}</dd>
        </div>
      </dl>
    </section>

    <p
      v-if="guardMessage"
      class="onboarding-alert onboarding-alert--warning"
      data-onboarding-kernel-guard
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ guardMessage }}</span>
    </p>

    <p
      v-if="kernel && !sourceCheckout && installable"
      class="onboarding-alert"
      data-onboarding-kernel-runtime-note
    >
      <AppIcon name="Info" :size="14" />
      <span>
        下载内核后会一并安装内核运行时（.venv-kernel）：自动检测 GPU，CPU 约 1.1GB / CUDA 约 6.3GB，需要数分钟。安装在后端继续运行，关闭页面不会中断，重新打开可继续查看进度。
      </span>
    </p>

    <p
      v-if="python && !python.exists"
      class="onboarding-alert onboarding-alert--warning"
      data-onboarding-kernel-python-missing
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>
        未找到可用的内核 Python 运行时，音频内核无法启动。请安装内核运行时（venv），或在配置中指定 kernel.python 后重新检测。
      </span>
    </p>

    <p
      v-if="jobNotice"
      class="onboarding-alert onboarding-alert--success"
      data-onboarding-kernel-job-notice
    >
      <AppIcon name="CheckCircle" :size="14" />
      <span>{{ jobNotice }}</span>
    </p>

    <OnboardingJobProgress
      v-if="jobs.job.value"
      :job="jobs.job.value"
      :error="jobs.error.value?.message ?? null"
      heading="内核安装进度"
    />

    <p v-if="localError" class="onboarding-alert onboarding-alert--error" data-onboarding-kernel-error role="alert">
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ localError }}</span>
    </p>
    <p
      v-else-if="onboardingError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-kernel-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ onboardingError.message }}</span>
    </p>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button"
        type="button"
        data-onboarding-kernel-install
        :data-busy="pendingAction === 'install' || jobActive ? 'true' : undefined"
        :disabled="busy || jobActive || !installable"
        @click="handleInstall"
      >
        <AppIcon
          v-if="pendingAction === 'install' || jobActive"
          name="CircleNotch"
          :size="14"
          class="onboarding-spinner"
        />
        <AppIcon v-else name="Download" :size="14" />
        <span>{{ installButtonLabel }}</span>
      </button>
      <button
        class="onboarding-button"
        type="button"
        data-onboarding-kernel-verify
        :data-busy="verifying ? 'true' : undefined"
        :disabled="busy"
        @click="handleVerify"
      >
        <AppIcon
          :name="verifying ? 'CircleNotch' : 'ArrowClockwise'"
          :size="14"
          :class="verifying ? 'onboarding-spinner' : undefined"
        />
        <span>{{ verifying ? '检测中…' : '重新检测' }}</span>
      </button>
      <button
        v-if="ready"
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-kernel-continue
        :data-busy="pendingAction === 'continue' ? 'true' : undefined"
        :disabled="busy"
        @click="handleContinue"
      >
        <AppIcon
          v-if="pendingAction === 'continue'"
          name="CircleNotch"
          :size="14"
          class="onboarding-spinner"
        />
        <span>{{ continueLabel }}</span>
        <AppIcon v-if="pendingAction !== 'continue'" name="ArrowRight" :size="14" />
      </button>
      <button
        class="onboarding-button"
        type="button"
        data-onboarding-kernel-skip
        :data-busy="pendingAction === 'skip' ? 'true' : undefined"
        :disabled="busy || jobActive"
        @click="handleSkip"
      >
        <AppIcon
          v-if="pendingAction === 'skip'"
          name="CircleNotch"
          :size="14"
          class="onboarding-spinner"
        />
        <span>{{ skipLabel }}</span>
        <AppIcon v-if="pendingAction !== 'skip'" name="ArrowRight" :size="14" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import OnboardingJobProgress from '@/components/onboarding/OnboardingJobProgress.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import {
  isTerminalJobState,
  useOnboardingJobs,
} from '@/composables/useOnboardingJobs'
import {
  formatBytes,
  kernelGuardMessage,
  kernelSourceLabel,
} from '@/components/onboarding/onboardingStatus'

const props = withDefaults(
  defineProps<{
    currentPassword?: string
  }>(),
  {
    currentPassword: '',
  },
)

const emit = defineEmits<{
  next: []
}>()

const {
  assets,
  assetsLoading,
  error: onboardingError,
  job: sharedJob,
  refresh,
  loadAssets,
  startAssetDownload,
  recordStep,
} = useOnboarding()

const jobs = useOnboardingJobs()
type PendingAction = '' | 'install' | 'verify' | 'continue' | 'skip'
const pendingAction = ref<PendingAction>('')
const busy = computed(() => pendingAction.value !== '')
const verifying = computed(() => pendingAction.value === 'verify')
const localError = ref('')
const jobNotice = ref('')
const handledTerminal = ref('')

const deps = computed(() => assets.value?.dependencies ?? null)
const kernel = computed(() => deps.value?.kernel ?? null)
const python = computed(() => deps.value?.python ?? null)
const health = computed(() => deps.value?.health ?? null)
const kernelAssetSize = computed(() => {
  const size = assets.value?.assets?.kernel?.size
  return typeof size === 'number' && size > 0 ? size : null
})

const statusKind = computed(() => {
  if (!kernel.value) return 'unknown'
  if (!kernel.value.present) return 'missing'
  if (kernel.value.source === 'source') return 'source'
  if (kernel.value.source === 'release') return 'installed'
  return 'unknown'
})

const STATUS_LABELS: Record<string, string> = {
  missing: '未安装',
  source: '源码检出',
  installed: '已安装',
  unknown: '未识别',
}

const statusLabel = computed(() => STATUS_LABELS[statusKind.value] ?? '未知')

const statusDetail = computed(() => {
  const current = kernel.value
  if (!current) return '尚未读取内核状态'
  if (!current.present) return 'kernel/ 目录不存在，可下载发行包安装。'
  if (current.source === 'source') return '当前使用源码检出的内核，安装将执行本地构建（开发模式）。'
  if (current.source === 'release') return '发行版内核已安装。'
  return 'kernel/ 目录存在，但缺少可识别的内核程序。'
})

const sourceLabel = computed(() => kernelSourceLabel(kernel.value?.source))
const pythonReady = computed(() => python.value?.exists === true)
const installed = computed(
  () =>
    kernel.value?.present === true &&
    (kernel.value.source === 'release' || kernel.value.source === 'source'),
)
const sourceCheckout = computed(
  () =>
    kernel.value?.source === 'source' ||
    kernel.value?.install_blocked_reason === 'kernel_install_forbidden_dev_checkout',
)
const ready = computed(() => installed.value && pythonReady.value)
const installable = computed(() => {
  const reason = kernel.value?.install_blocked_reason
  if (!reason) return true
  return reason === 'kernel_install_forbidden_dev_checkout'
})
const installLabel = computed(() =>
  kernel.value?.source === 'source' ? '本地构建内核（开发）' : '下载内核',
)
const installButtonLabel = computed(() => {
  if (pendingAction.value === 'install') return '正在启动安装…'
  if (jobActive.value) return '安装中…'
  return installLabel.value
})
const continueLabel = computed(() =>
  pendingAction.value === 'continue' ? '正在确认…' : '确认内核就绪并继续',
)
const skipLabel = computed(() =>
  pendingAction.value === 'skip' ? '正在跳过…' : '跳过内核（降级）',
)

const detected = computed<StepWhyDetectedItem[]>(() => {
  const items: StepWhyDetectedItem[] = []
  if (kernel.value) {
    items.push({ label: '来源', value: sourceLabel.value })
    items.push({ label: '版本', value: kernel.value.version || '未知' })
    if (kernel.value.source !== 'source') {
      items.push({
        label: '发行包',
        value: kernelAssetSize.value ? formatBytes(kernelAssetSize.value) : '约 70MB',
      })
    }
  }
  if (python.value) {
    items.push({
      label: 'Python',
      value: python.value.exists ? '已就绪' : '未找到',
    })
  }
  return items
})

const guardMessage = computed(() => {
  const current = kernel.value
  if (!current) return ''
  if (sourceCheckout.value) {
    return '当前为源码检出的内核，安装将执行本地构建（开发模式），不会下载发行包。'
  }
  if (current.install_blocked_reason) {
    return kernelGuardMessage(current.install_blocked_reason)
  }
  return ''
})

const healthLabel = computed(() => {
  const current = health.value
  if (!current) return '未读取'
  if (current.healthy) {
    return current.port ? `运行中（端口 ${current.port}）` : '运行中'
  }
  if (current.alive) return '进程存在，健康检查未通过'
  if (current.found) return '进程未运行（后端按需拉起）'
  return '未启动（后端按需拉起）'
})

const jobActive = computed(() => {
  const current = jobs.job.value
  return current !== null && !isTerminalJobState(current.state)
})

watch(
  () => jobs.job.value,
  async (current) => {
    if (!current || current.asset !== 'kernel') return
    if (!isTerminalJobState(current.state)) return
    if (handledTerminal.value === current.id) return
    handledTerminal.value = current.id
    await loadAssets()
    if (current.state === 'done') {
      jobNotice.value = '内核安装完成，请确认下方状态后继续。'
    } else if (current.state === 'failed') {
      jobNotice.value = ''
    }
  },
)

onMounted(async () => {
  await loadAssets()
  const existing = sharedJob.value
  if (existing && existing.asset === 'kernel') {
    jobs.start(existing)
  } else {
    jobs.restore('kernel')
  }
})

function requirePassword(): boolean {
  if (props.currentPassword.trim()) return true
  localError.value = '缺少入口密码，请输入当前管理员密码后再安装内核。'
  return false
}

async function handleInstall(): Promise<void> {
  if (busy.value || jobActive.value) return
  localError.value = ''
  jobNotice.value = ''
  if (!installable.value) {
    localError.value = guardMessage.value || '当前内核目录不允许发行包覆盖。'
    return
  }
  if (!requirePassword()) return

  pendingAction.value = 'install'
  try {
    const started = await startAssetDownload(
      'kernel',
      undefined,
      props.currentPassword,
    )
    if (!started) {
      localError.value =
        onboardingError.value?.message || '启动内核安装失败，请稍后重试。'
      return
    }
    sharedJob.value = started
    jobs.start(started)
  } finally {
    pendingAction.value = ''
  }
}

async function handleVerify(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  pendingAction.value = 'verify'
  try {
    await Promise.all([loadAssets(), refresh()])
  } finally {
    pendingAction.value = ''
  }
}

async function handleContinue(): Promise<void> {
  if (busy.value || !ready.value) return
  localError.value = ''
  pendingAction.value = 'continue'
  try {
    const recorded = await recordStep('kernel', 'completed', {
      source: kernel.value?.source ?? null,
      version: kernel.value?.version ?? null,
      dir: kernel.value?.dir ?? '',
      python: python.value?.path ?? '',
      python_source: python.value?.source ?? '',
      installed_from_release: kernel.value?.installed_from_release ?? false,
      healthy: health.value?.healthy ?? false,
      degraded: false,
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录内核步骤失败，请稍后重试。'
      return
    }
    await Promise.all([refresh(), loadAssets()])
    emit('next')
  } finally {
    pendingAction.value = ''
  }
}

async function handleSkip(): Promise<void> {
  if (busy.value || jobActive.value) return
  localError.value = ''
  pendingAction.value = 'skip'
  try {
    const recorded = await recordStep('kernel', 'skipped', {
      skipped: true,
      degraded: true,
      reason: kernel.value?.present ? 'kernel_not_ready' : 'kernel_skipped',
      warning: 'audio_pipeline_unavailable',
      source: kernel.value?.source ?? null,
      python_ready: pythonReady.value,
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录跳过内核失败，请稍后重试。'
      return
    }
    await Promise.all([refresh(), loadAssets()])
    emit('next')
  } finally {
    pendingAction.value = ''
  }
}
</script>

<style scoped>
.kernel-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.kernel-status__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2) var(--space-3);
}

.kernel-status__badge {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.kernel-status__badge[data-status='installed'],
.kernel-status__badge[data-status='source'] {
  color: var(--success);
}

.kernel-status__badge[data-status='missing'] {
  color: var(--warning);
}

.kernel-status__badge[data-status='unknown'] {
  color: var(--muted);
}

.kernel-status__hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
</style>
