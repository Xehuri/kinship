<template>
  <section class="onboarding-panel" data-onboarding-panel="kernel_models">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">内核模型</h3>
      <p class="onboarding-panel__desc">
        选择模型档位，下载或校验语音识别、声纹、说话人分离与环境声分析所需的模型文件。
      </p>
    </header>

    <StepWhy step-id="kernel_models" :detected="detected" />

    <KernelModelsStorageSection
      :current-password="props.currentPassword"
      :disabled="busy || jobActive"
      @saved="handleStorageSaved"
    />

    <p
      v-if="catalogLoading && !catalog"
      class="onboarding-alert"
      data-onboarding-models-loading
    >
      <AppIcon name="CircleNotch" :size="14" class="onboarding-spinner" />
      <span>正在读取模型清单…</span>
    </p>

    <p
      v-if="catalogError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-models-load-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ catalogError }}</span>
    </p>

    <p v-if="catalog" class="onboarding-hint" data-onboarding-models-manifest>
      清单版本 {{ catalog.manifest_version || '未知' }} · 全部模型
      {{ formatBytes(catalog.total_size_bytes) }} · 必需模型
      {{ formatBytes(catalog.required_size_bytes) }}
    </p>

    <section v-if="catalog" class="onboarding-section" data-onboarding-models-tiers>
      <h4 class="onboarding-section__title">档位选择</h4>
      <div class="tier-row tier-row--head" aria-hidden="true">
        <span>档位</span>
        <span>模型</span>
        <span>状态</span>
      </div>
      <div
        v-for="tier in catalog.tiers"
        :key="tier.id"
        class="tier-row"
        :data-onboarding-model-tier="tier.id"
        :data-selected="isTierSelected(tier.id) ? 'true' : 'false'"
      >
        <label class="tier-check">
          <input
            type="checkbox"
            :checked="isTierSelected(tier.id)"
            :disabled="tier.id === 'required' || busy || jobActive"
            :data-onboarding-model-tier-check="tier.id"
            @change="toggleTier(tier.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="tier-check__body">
            <strong>{{ modelTierLabel(tier.id) }}</strong>
            <span>{{ modelTierDescription(tier.id) }}</span>
          </span>
        </label>
        <span class="tier-row__models">
          {{ tier.model_ids.length }} 个 · {{ formatBytes(tier.total_size_bytes) }}
          <template v-if="tier.missing_size_bytes > 0">
            · 缺 {{ formatBytes(tier.missing_size_bytes) }}
          </template>
        </span>
        <span class="tier-row__state" :data-ready="tierPresentCount(tier) === tier.model_ids.length">
          {{ tierPresentCount(tier) }} / {{ tier.model_ids.length }} 已就绪
        </span>
      </div>
    </section>

    <section v-if="catalog" class="onboarding-section" data-onboarding-models-list>
      <h4 class="onboarding-section__title">模型明细</h4>
      <ul class="model-list">
        <li
          v-for="model in catalog.models"
          :key="model.id"
          class="model-row"
          :data-onboarding-model-row="model.id"
          :data-status="modelStatus(model)"
        >
          <div class="model-row__head">
            <span class="model-row__name">{{ model.id }}</span>
            <span class="model-row__status" :data-status="modelStatus(model)">
              {{ modelStatusLabel(model) }}
            </span>
          </div>
          <p class="model-row__meta">
            {{ modelTierLabel(model.tier) }} · {{ modelSourceLabel(model.source) }} ·
            {{ formatBytes(model.size_bytes) }}
          </p>
          <p v-if="model.present" class="model-row__detail" data-onboarding-model-present>
            已就绪
          </p>
          <p
            v-else-if="model.gated"
            class="model-row__detail model-row__detail--warning"
            data-onboarding-model-gated
          >
            受限模型：需要 HuggingFace 授权（HF_TOKEN）。未配置时下载会失败，不会标记为成功。
          </p>
          <p v-else class="model-row__detail" data-onboarding-model-missing>
            缺失
            <template v-if="model.missing_files.length > 0">
              · 缺少 {{ model.missing_files.join('、') }}
            </template>
          </p>
          <p v-if="model.error" class="model-row__detail model-row__detail--error">
            错误：{{ model.error }}
          </p>
        </li>
      </ul>
    </section>

    <p
      v-if="catalog && selectedMissingBytes > 0"
      class="onboarding-hint"
      data-onboarding-models-total
    >
      本次预计下载 {{ formatBytes(selectedMissingBytes) }}（{{ selectedMissing.length }} 个模型）。
    </p>

    <p
      v-if="gatedSelected.length > 0"
      class="onboarding-alert onboarding-alert--warning"
      data-onboarding-models-gated-warning
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>
        所选档位包含受限模型：{{ gatedSelected.map((model) => model.id).join('、') }}。需要 HuggingFace 授权与 HF_TOKEN；未配置时下载会如实失败，不会显示成功。
      </span>
    </p>

    <p
      v-if="diskWarning"
      class="onboarding-alert onboarding-alert--warning"
      data-onboarding-models-disk-warning
    >
      <AppIcon name="Warning" :size="14" />
      <span>{{ diskWarning }}</span>
    </p>

    <p
      v-if="jobNotice"
      class="onboarding-alert onboarding-alert--success"
      data-onboarding-models-job-notice
    >
      <AppIcon name="CheckCircle" :size="14" />
      <span>{{ jobNotice }}</span>
    </p>

    <OnboardingJobProgress
      v-if="jobs.job.value"
      :job="jobs.job.value"
      :error="jobs.error.value?.message ?? null"
      heading="模型下载进度"
    />

    <p v-if="localError" class="onboarding-alert onboarding-alert--error" data-onboarding-models-error role="alert">
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ localError }}</span>
    </p>
    <p
      v-else-if="onboardingError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-models-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ onboardingError.message }}</span>
    </p>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-models-download
        :data-busy="pendingAction === 'download' || jobActive ? 'true' : undefined"
        :disabled="busy || jobActive || !catalog || !hasDownloadWork"
        @click="handleDownload"
      >
        <AppIcon
          v-if="pendingAction === 'download' || jobActive"
          name="CircleNotch"
          :size="14"
          class="onboarding-spinner"
        />
        <AppIcon v-else name="Download" :size="14" />
        <span>{{ downloadButtonLabel }}</span>
      </button>
      <button
        class="onboarding-button"
        type="button"
        data-onboarding-models-verify
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
        v-if="requiredReady"
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-models-continue
        :data-busy="pendingAction === 'continue' ? 'true' : undefined"
        :disabled="busy || jobActive"
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
        data-onboarding-models-skip
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
import KernelModelsStorageSection from '@/components/onboarding/KernelModelsStorageSection.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import {
  isTerminalJobState,
  useOnboardingJobs,
} from '@/composables/useOnboardingJobs'
import {
  getKernelModels,
  startKernelModelsDownload,
  type KernelModelAssetStatus,
  type KernelModelCatalog,
  type KernelModelTierStatus,
} from '@/api/system'
import {
  formatBytes,
  modelSourceLabel,
  modelTierDescription,
  modelTierLabel,
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
  error: onboardingError,
  job: sharedJob,
  refresh,
  loadAssets,
  recordStep,
} = useOnboarding()

const jobs = useOnboardingJobs()
type PendingAction = '' | 'download' | 'verify' | 'continue' | 'skip'
const pendingAction = ref<PendingAction>('')
const busy = computed(() => pendingAction.value !== '')
const verifying = computed(() => pendingAction.value === 'verify')
const catalog = ref<KernelModelCatalog | null>(null)
const catalogLoading = ref(true)
const catalogError = ref('')
const selectedTiers = ref<string[]>([])
const localError = ref('')
const jobNotice = ref('')
const handledTerminal = ref('')

const jobActive = computed(() => {
  const current = jobs.job.value
  return current !== null && !isTerminalJobState(current.state)
})

const defaultTierSelection = (tiers: KernelModelTierStatus[]): string[] => {
  const available = new Set(tiers.map((tier) => tier.id))
  const preset = ['required', 'recommended'].filter((id) => available.has(id))
  return preset.length > 0 ? preset : tiers.map((tier) => tier.id)
}

watch(
  catalog,
  (value) => {
    if (!value || selectedTiers.value.length > 0) return
    selectedTiers.value = defaultTierSelection(value.tiers)
  },
  { immediate: true },
)

const effectiveTiers = computed<string[]>(() => {
  const tiers = catalog.value?.tiers ?? []
  const selected = new Set(selectedTiers.value)
  if (tiers.some((tier) => tier.id === 'required')) selected.add('required')
  return tiers.map((tier) => tier.id).filter((id) => selected.has(id))
})

const selectedModels = computed<KernelModelAssetStatus[]>(() => {
  const selected = new Set(effectiveTiers.value)
  return (catalog.value?.models ?? []).filter((model) => selected.has(model.tier))
})

const selectedMissing = computed(() =>
  selectedModels.value.filter((model) => !model.present),
)
const selectedMissingBytes = computed(() =>
  selectedMissing.value.reduce((sum, model) => sum + model.size_bytes, 0),
)
const gatedSelected = computed(() =>
  selectedMissing.value.filter((model) => model.gated),
)
const requiredModels = computed(() =>
  (catalog.value?.models ?? []).filter((model) => model.tier === 'required'),
)
const requiredReady = computed(
  () =>
    requiredModels.value.length > 0 &&
    requiredModels.value.every((model) => model.present),
)
const hasDownloadWork = computed(() => selectedMissing.value.length > 0)
const diskWarning = computed(() => {
  const disk = assets.value?.disk
  if (!disk || selectedMissingBytes.value === 0) return ''
  if (disk.free >= selectedMissingBytes.value) return ''
  return `磁盘可用 ${formatBytes(disk.free)}，本次预计下载 ${formatBytes(selectedMissingBytes.value)}，空间不足，请清理后重试。`
})

const downloadLabel = computed(() =>
  hasDownloadWork.value ? '下载所选模型' : '所选模型已就绪',
)
const downloadButtonLabel = computed(() => {
  if (pendingAction.value === 'download') return '正在启动下载…'
  if (jobActive.value) return '下载中…'
  return downloadLabel.value
})
const continueLabel = computed(() =>
  pendingAction.value === 'continue' ? '正在确认…' : '确认模型就绪并继续',
)
const skipLabel = computed(() =>
  pendingAction.value === 'skip' ? '正在跳过…' : '跳过模型（降级）',
)

const detected = computed<StepWhyDetectedItem[]>(() => {
  const value = catalog.value
  if (!value) return []
  const required = value.models.filter((model) => model.tier === 'required')
  const ready = required.filter((model) => model.present).length
  return [
    { label: '必需模型', value: `${ready} / ${required.length} 已就绪` },
    {
      label: '本次待下载',
      value:
        selectedMissingBytes.value > 0
          ? formatBytes(selectedMissingBytes.value)
          : '无',
    },
  ]
})

function isTierSelected(tierId: string): boolean {
  return tierId === 'required' || selectedTiers.value.includes(tierId)
}

function toggleTier(tierId: string, checked: boolean): void {
  if (tierId === 'required') return
  const next = new Set(selectedTiers.value)
  if (checked) next.add(tierId)
  else next.delete(tierId)
  if (catalog.value?.tiers.some((tier) => tier.id === 'required')) next.add('required')
  selectedTiers.value = (catalog.value?.tiers ?? [])
    .map((tier) => tier.id)
    .filter((id) => next.has(id))
}

function tierPresentCount(tier: KernelModelTierStatus): number {
  const models = catalog.value?.models ?? []
  return tier.model_ids.filter((id) => models.some((model) => model.id === id && model.present))
    .length
}

function modelStatus(model: KernelModelAssetStatus): string {
  if (model.present) return 'present'
  if (model.gated) return 'gated'
  if (jobActive.value && effectiveTiers.value.includes(model.tier)) {
    return 'downloading'
  }
  return 'missing'
}

function modelStatusLabel(model: KernelModelAssetStatus): string {
  switch (modelStatus(model)) {
    case 'present':
      return '已就绪'
    case 'gated':
      return '受限'
    case 'downloading':
      return '下载中'
    default:
      return '缺失'
  }
}

function describeError(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim()) return value.message
  return fallback
}

async function loadCatalog(keepError = false): Promise<void> {
  catalogLoading.value = true
  if (!keepError) catalogError.value = ''
  try {
    catalog.value = await getKernelModels()
  } catch (error) {
    catalogError.value = describeError(error, '读取模型清单失败，请稍后重试。')
  } finally {
    catalogLoading.value = false
  }
}

watch(
  () => jobs.job.value,
  async (current) => {
    if (!current || current.asset !== 'models') return
    if (!isTerminalJobState(current.state)) return
    if (handledTerminal.value === current.id) return
    handledTerminal.value = current.id
    await Promise.all([loadCatalog(true), loadAssets()])
    if (current.state === 'done') {
      jobNotice.value = '模型下载结束，已重新检测；请查看明细状态后继续。'
      localError.value = ''
    } else if (current.state === 'failed') {
      jobNotice.value = ''
      localError.value =
        current.error || '模型下载未完成，请查看日志与明细状态后重试。'
    }
  },
)

onMounted(async () => {
  await Promise.all([loadCatalog(), loadAssets()])
  const existing = sharedJob.value
  if (existing && existing.asset === 'models') {
    jobs.start(existing)
  } else {
    jobs.restore('models')
  }
})

function requirePassword(): boolean {
  if (props.currentPassword.trim()) return true
  localError.value = '缺少入口密码，请输入当前管理员密码后再下载模型。'
  return false
}

async function handleDownload(): Promise<void> {
  if (busy.value || jobActive.value || !catalog.value) return
  localError.value = ''
  jobNotice.value = ''
  if (!hasDownloadWork.value) {
    localError.value = '所选档位的模型均已就绪，无需下载。'
    return
  }
  if (!requirePassword()) return

  pendingAction.value = 'download'
  try {
    const started = await startKernelModelsDownload(
      { tiers: effectiveTiers.value },
      undefined,
      props.currentPassword,
    )
    sharedJob.value = started
    jobs.start(started)
  } catch (error) {
    localError.value = describeError(error, '启动模型下载失败，请稍后重试。')
  } finally {
    pendingAction.value = ''
  }
}

async function handleVerify(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  pendingAction.value = 'verify'
  try {
    await Promise.all([loadCatalog(), loadAssets(), refresh()])
  } finally {
    pendingAction.value = ''
  }
}

async function handleStorageSaved(): Promise<void> {
  await Promise.all([loadCatalog(true), loadAssets()])
}

async function handleContinue(): Promise<void> {
  if (busy.value || jobActive.value || !requiredReady.value) return
  localError.value = ''
  pendingAction.value = 'continue'
  try {
    const recorded = await recordStep('kernel_models', 'completed', {
      tiers: effectiveTiers.value,
      required_ready: true,
      present: (catalog.value?.models ?? [])
        .filter((model) => model.present)
        .map((model) => model.id),
      missing: selectedMissing.value.map((model) => model.id),
      gated: gatedSelected.value.map((model) => model.id),
      degraded: false,
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录模型步骤失败，请稍后重试。'
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
    const recorded = await recordStep('kernel_models', 'skipped', {
      skipped: true,
      degraded: true,
      reason: 'models_skipped',
      warning: 'audio_pipeline_unavailable',
      required_missing: requiredModels.value
        .filter((model) => !model.present)
        .map((model) => model.id),
    })
    if (!recorded) {
      localError.value =
        onboardingError.value?.message || '记录跳过模型失败，请稍后重试。'
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
.tier-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) minmax(120px, 1fr) auto;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) 0;
  border-block-end: 1px solid var(--hairline);
}

.tier-row:last-child {
  border-block-end: 0;
}

.tier-row--head {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.tier-check {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-inline-size: 0;
  cursor: pointer;
}

.tier-check input {
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  margin-block-start: 2px;
  accent-color: var(--accent);
}

.tier-check input:disabled {
  cursor: not-allowed;
}

.tier-check__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-inline-size: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.45;
}

.tier-check__body strong {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}

.tier-row__models,
.tier-row__state {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.45;
}

.tier-row__state[data-ready='true'] {
  color: var(--success);
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.model-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
}

.model-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-1) var(--space-2);
}

.model-row__name {
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.model-row__status {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.model-row__status[data-status='present'] {
  color: var(--success);
}

.model-row__status[data-status='downloading'] {
  color: var(--accent);
}

.model-row__status[data-status='gated'] {
  color: var(--warning);
}

.model-row__status[data-status='missing'] {
  color: var(--warning);
}

.model-row__meta,
.model-row__detail {
  margin: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.model-row__detail--warning {
  color: var(--warning);
}

.model-row__detail--error {
  color: var(--danger);
}

@media (max-width: 560px) {
  .tier-row {
    grid-template-columns: 1fr auto;
  }

  .tier-row--head {
    display: none;
  }

  .tier-check {
    grid-column: 1;
    grid-row: 1;
  }

  .tier-row__state {
    grid-column: 2;
    grid-row: 1;
    text-align: end;
  }

  .tier-row__models {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
