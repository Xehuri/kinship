<template>
  <section class="onboarding-panel" data-onboarding-panel="dependencies">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">依赖检查</h3>
      <p class="onboarding-panel__desc">
        逐项读取 AI 工作目录、音频内核、Python 运行时、模型目录与磁盘空间。
      </p>
    </header>

    <p
      v-if="assetsLoading && !assets"
      class="onboarding-alert"
      data-onboarding-dependencies-loading
    >
      <AppIcon name="CircleNotch" :size="14" class="onboarding-spinner" />
      <span>正在读取依赖状态…</span>
    </p>

    <p
      v-if="assets?.error"
      class="onboarding-alert onboarding-alert--warning"
      data-onboarding-dependencies-assets-error
    >
      <AppIcon name="Warning" :size="14" />
      <span>发行资产清单不可用：{{ assets.error }}</span>
    </p>

    <StepWhy step-id="dependencies" :detected="detected" />

    <div class="dep-grid" data-onboarding-dependency-cards>
      <article
        v-for="card in cards"
        :key="card.id"
        class="dep-card"
        :data-onboarding-dependency-card="card.id"
        :data-status="card.status"
      >
        <header class="dep-card__head">
          <span class="dep-card__label">{{ card.label }}</span>
          <span class="dep-card__status" :data-status="card.status">
            {{ card.statusLabel }}
          </span>
        </header>
        <p class="dep-card__detail">{{ card.detail }}</p>
        <p v-if="card.meta" class="dep-card__meta">{{ card.meta }}</p>
      </article>
    </div>

    <p class="onboarding-hint" data-onboarding-dependencies-ai-note>
      这里只检查并记录结果，不会下载任何东西；音频内核与模型分别在后续步骤下载。
    </p>

    <SecurityConnectionPanel :current-password="currentPassword" />

    <p v-if="localError" class="onboarding-alert onboarding-alert--error" data-onboarding-dependencies-error role="alert">
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ localError }}</span>
    </p>
    <p
      v-else-if="onboardingError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-dependencies-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ onboardingError.message }}</span>
    </p>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-dependencies-continue
        :data-busy="busy ? 'true' : undefined"
        :disabled="busy"
        @click="handleContinue"
      >
        <AppIcon v-if="busy" name="CircleNotch" :size="14" class="onboarding-spinner" />
        <span>{{ busy ? '正在记录检查结果…' : '继续' }}</span>
        <AppIcon v-if="!busy" name="ArrowRight" :size="14" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SecurityConnectionPanel from '@/components/onboarding/SecurityConnectionPanel.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import { formatBytes } from '@/components/onboarding/onboardingStatus'

withDefaults(
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
  preflight,
  assets,
  assetsLoading,
  error: onboardingError,
  refresh,
  loadAssets,
  recordStep,
} = useOnboarding()

const busy = ref(false)
const localError = ref('')

type CardStatus = 'ok' | 'warn' | 'fail' | 'unknown'

interface DependencyCard {
  id: string
  label: string
  status: CardStatus
  statusLabel: string
  detail: string
  meta: string
}

const deps = computed(() => assets.value?.dependencies ?? null)
const aiCheck = computed(
  () => preflight.value?.checks.find((check) => check.id === 'ai_dir') ?? null,
)

const STATUS_LABELS: Record<CardStatus, string> = {
  ok: '正常',
  warn: '注意',
  fail: '缺失',
  unknown: '未知',
}

function card(
  id: string,
  label: string,
  status: CardStatus,
  detail: string,
  meta = '',
): DependencyCard {
  return { id, label, status, statusLabel: STATUS_LABELS[status], detail, meta }
}

const aiCard = computed<DependencyCard>(() => {
  const check = aiCheck.value
  if (!check) return card('ai_dir', 'AI 工作目录', 'unknown', '尚未读取预检结果')
  const status: CardStatus =
    check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'fail'
  return card('ai_dir', 'AI 工作目录', status, check.detail || check.label)
})

const kernelCard = computed<DependencyCard>(() => {
  const kernel = deps.value?.kernel
  if (!kernel) return card('kernel', '内核程序', 'unknown', '尚未读取内核状态')
  if (!kernel.present) return card('kernel', '内核程序', 'warn', 'kernel/ 目录不存在', kernel.dir)
  const version = kernel.version ? `版本 ${kernel.version}` : '版本未知'
  if (kernel.source === 'source') {
    return card('kernel', '内核程序', 'ok', `源码检出，${version}`, kernel.dir)
  }
  if (kernel.source === 'release') {
    return card('kernel', '内核程序', 'ok', `发行版已安装，${version}`, kernel.dir)
  }
  return card('kernel', '内核程序', 'warn', 'kernel/ 目录存在但无法识别内核程序', kernel.dir)
})

const pythonCard = computed<DependencyCard>(() => {
  const python = deps.value?.python
  if (!python) return card('python', '内核 Python', 'unknown', '尚未读取运行时状态')
  if (python.exists) {
    return card('python', '内核 Python', 'ok', '运行时可用', `${python.path}（${python.source}）`)
  }
  const expected = python.configured || python.path
  return card(
    'python',
    '内核 Python',
    'fail',
    '未找到可用的内核运行时',
    expected ? `期望路径：${expected}` : '请在配置中指定 kernel.python',
  )
})

const modelsCard = computed<DependencyCard>(() => {
  const models = deps.value?.models
  if (!models) return card('models', '模型目录', 'unknown', '尚未读取模型目录状态')
  if (models.exists) return card('models', '模型目录', 'ok', '模型目录已创建', models.model_dir)
  return card('models', '模型目录', 'warn', '模型目录尚未创建，下载模型后自动生成', models.model_dir)
})

const diskCard = computed<DependencyCard>(() => {
  const disk = deps.value?.disk
  if (!disk) return card('disk', '磁盘空间', 'unknown', '尚未读取磁盘空间')
  const detail = `可用 ${formatBytes(disk.free)} / 预留 ${formatBytes(disk.required)}`
  return card('disk', '磁盘空间', disk.sufficient ? 'ok' : 'fail', detail, disk.path)
})

const cards = computed(() => [
  aiCard.value,
  kernelCard.value,
  pythonCard.value,
  modelsCard.value,
  diskCard.value,
])

const detected = computed<StepWhyDetectedItem[]>(() => {
  const list = cards.value
  if (list.every((item) => item.status === 'unknown')) return []
  const count = (status: CardStatus): number =>
    list.filter((item) => item.status === status).length
  return [
    {
      label: '检查结果',
      value: `${list.length} 项 · 正常 ${count('ok')} · 注意 ${count('warn')} · 缺失 ${count('fail')}`,
    },
  ]
})

onMounted(async () => {
  await Promise.all([refresh(), loadAssets()])
})

function dependencySnapshot(): Record<string, unknown> {
  const kernel = deps.value?.kernel
  const python = deps.value?.python
  const models = deps.value?.models
  const disk = deps.value?.disk
  return {
    ai_dir: aiCheck.value
      ? { status: aiCheck.value.status, detail: aiCheck.value.detail }
      : null,
    kernel: kernel
      ? {
          present: kernel.present,
          source: kernel.source,
          version: kernel.version,
          installable: kernel.installable,
        }
      : null,
    python: python ? { exists: python.exists, source: python.source } : null,
    models: models ? { exists: models.exists } : null,
    disk: disk
      ? { free: disk.free, required: disk.required, sufficient: disk.sufficient }
      : null,
  }
}

async function handleContinue(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  busy.value = true
  try {
    const recorded = await recordStep('dependencies', 'completed', {
      choice: 'checks',
      degraded: false,
      audio_pipeline: 'pending',
      dependencies: dependencySnapshot(),
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录依赖步骤失败，请稍后重试。'
      return
    }
    await refresh()
    emit('next')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.dep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--space-2);
}

.dep-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.dep-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-1) var(--space-2);
}

.dep-card__label {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}

.dep-card__status {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.dep-card__status[data-status='ok'] {
  color: var(--success);
}

.dep-card__status[data-status='warn'] {
  color: var(--warning);
}

.dep-card__status[data-status='fail'] {
  color: var(--danger);
}

.dep-card__status[data-status='unknown'] {
  color: var(--muted);
}

.dep-card__detail,
.dep-card__meta {
  margin: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.dep-card__meta {
  font-family: var(--font-mono);
  font-size: 10.5px;
}
</style>
