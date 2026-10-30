<template>
  <Teleport to="body">
    <Transition name="onboarding-fade">
      <div
        v-if="visible"
        ref="overlayRef"
        class="onboarding-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabindex="-1"
        data-onboarding-wizard
      >
        <header class="onboarding-header">
          <div class="onboarding-header__heading">
            <h2 id="onboarding-title" class="onboarding-header__title">
              <AppIcon name="Wrench" :size="18" />
              <span>初始化引导</span>
            </h2>
            <span v-if="testMode" class="onboarding-badge" data-onboarding-test-mode>
              <AppIcon name="Warning" :size="12" />
              <span>测试模式：保存会真实生效</span>
            </span>
          </div>
          <div class="onboarding-header__actions">
            <span class="onboarding-header__progress" data-onboarding-progress>
              {{
                milestoneActive
                  ? '阶段 1 完成'
                  : `第 ${activeIndex + 1} / ${stepCount} 步`
              }}
            </span>
            <button
              class="onboarding-icon-button"
              type="button"
              aria-label="关闭初始化引导"
              data-onboarding-close
              @click="handleClose"
            >
              <AppIcon name="X" :size="18" />
            </button>
          </div>
        </header>

        <div class="onboarding-body">
          <OnboardingRail
            :steps="steps"
            :active-index="milestoneActive ? -1 : activeIndex"
            :completed="completedSteps"
            :skipped="skippedSteps"
            @navigate="navigateTo"
          />

          <main class="onboarding-main">
            <div class="onboarding-main__scroll">
              <section
                v-if="gateOpen"
                class="onboarding-panel onboarding-gate"
                data-onboarding-gate
                aria-labelledby="onboarding-gate-title"
              >
                <header class="onboarding-panel__head">
                  <p class="onboarding-eyebrow">身份验证</p>
                  <h3 id="onboarding-gate-title" class="onboarding-panel__title">
                    输入管理员密码
                  </h3>
                  <p class="onboarding-panel__desc">
                    配置写入需要当前密码。验证通过后密码只保留在本次引导会话的内存中，关闭后立即清除。
                  </p>
                </header>
                <form class="onboarding-gate__form" @submit.prevent="handleUnlock">
                  <FormField
                    field-id="onboarding-password"
                    label="当前密码"
                    hint="密码不会写入浏览器存储。"
                  >
                    <template #default="{ fieldId, describedBy }">
                      <input
                        :id="fieldId"
                        v-model="password"
                        class="onboarding-input"
                        type="password"
                        autocomplete="current-password"
                        placeholder="输入当前管理员密码"
                        :aria-describedby="describedBy"
                        data-onboarding-password
                      />
                    </template>
                  </FormField>
                  <p
                    v-if="gateError"
                    class="onboarding-alert onboarding-alert--error"
                    data-onboarding-gate-error
                    role="alert"
                  >
                    <AppIcon name="WarningCircle" :size="14" />
                    <span>{{ gateError }}</span>
                  </p>
                  <div class="onboarding-panel__actions">
                    <button
                      class="onboarding-button onboarding-button--primary"
                      type="submit"
                      data-onboarding-unlock-submit
                      :data-busy="gateBusy ? 'true' : undefined"
                      :disabled="gateBusy"
                    >
                      <AppIcon
                        :name="gateBusy ? 'CircleNotch' : 'User'"
                        :size="14"
                        :class="gateBusy ? 'onboarding-spinner' : undefined"
                      />
                      <span>{{ gateBusy ? '验证中…' : '解锁配置' }}</span>
                    </button>
                  </div>
                </form>
              </section>

              <template v-else-if="statusLoaded">
                <p
                  v-if="onboardingError"
                  class="onboarding-alert onboarding-alert--error"
                  data-onboarding-status-error
                  role="alert"
                >
                  <AppIcon name="WarningCircle" :size="14" />
                  <span>{{ onboardingError.message }}</span>
                </p>

                <section
                  v-if="milestoneActive"
                  class="onboarding-panel onboarding-milestone"
                  data-onboarding-milestone
                  aria-labelledby="onboarding-milestone-title"
                >
                  <header class="onboarding-panel__head">
                    <p class="onboarding-eyebrow">阶段 1 完成</p>
                    <h3 id="onboarding-milestone-title" class="onboarding-panel__title">
                      已可用
                    </h3>
                    <p class="onboarding-panel__desc">
                      阶段 1 已完成，系统现在就可以开始使用。用手机浏览器打开下面的地址即可。
                    </p>
                  </header>

                  <section class="onboarding-section" data-onboarding-milestone-access>
                    <h4 class="onboarding-section__title">手机访问地址</h4>
                    <p>
                      <code class="onboarding-code" data-onboarding-milestone-url>{{ accessUrl }}</code>
                    </p>
                    <p class="onboarding-hint">
                      Android 端用该地址登录；桌面端首次启动时填写同一地址。
                    </p>
                  </section>

                  <section class="onboarding-section" data-onboarding-milestone-services>
                    <h4 class="onboarding-section__title">核心服务</h4>
                    <ServicesPanel mode="compact" />
                  </section>

                  <p class="onboarding-hint" data-onboarding-milestone-remaining>
                    阶段 2 还有 {{ optionalCount }} 项可选：小米健康云、QQ 网关、MOSS 深度音频与 AI 助手，其余为内核模型、客户端与完成校验。
                  </p>

                  <div class="onboarding-panel__actions">
                    <button
                      class="onboarding-button onboarding-button--primary"
                      type="button"
                      data-onboarding-milestone-continue
                      @click="handleMilestoneContinue"
                    >
                      <span>继续配置可选步骤</span>
                      <AppIcon name="ArrowRight" :size="14" />
                    </button>
                    <button
                      class="onboarding-button"
                      type="button"
                      data-onboarding-milestone-finish
                      @click="handleMilestoneFinish"
                    >
                      <AppIcon name="Check" :size="14" />
                      <span>直接完成初始化</span>
                    </button>
                  </div>
                </section>

                <component
                  :is="activePanel"
                  v-else-if="activeStep"
                  :key="activeStep.id"
                  v-bind="panelProps"
                  @start="goNext"
                  @created="handleAccountCreated"
                  @next="goNext"
                  @completed="handleEnterMain"
                  @close="handleClose"
                />
              </template>
            </div>

            <footer v-if="!gateOpen && statusLoaded && !milestoneActive" class="onboarding-footer">
              <p v-if="pendingCount > 0" class="onboarding-footer__pending" data-onboarding-pending-badge>
                <AppIcon name="Clock" :size="14" />
                <span>{{ pendingCount }} 项变更将在完成时统一应用</span>
              </p>
              <p v-if="progressWarning" class="onboarding-footer__warning" data-onboarding-footer-warning>
                {{ progressWarning }}
              </p>
              <p
                v-else-if="nextBlocked && activeStep?.id === 'account' && needsSetup"
                class="onboarding-footer__warning"
                data-onboarding-account-required
              >
                请先在「管理员账号」步骤创建管理员账号。
              </p>
              <p
                v-else-if="nextBlocked && footerBlockReason"
                class="onboarding-footer__warning"
                data-onboarding-step-blocked
              >
                {{ footerBlockReason }}
              </p>
              <div class="onboarding-footer__bar">
                <button
                  class="onboarding-button"
                  type="button"
                  data-onboarding-back
                  :disabled="activeIndex === 0"
                  @click="goBack"
                >
                  <AppIcon name="CaretLeft" :size="14" />
                  <span>上一步</span>
                </button>
                <button
                  v-if="!isLastStep"
                  class="onboarding-button onboarding-button--primary"
                  type="button"
                  data-onboarding-next
                  :disabled="nextBlocked"
                  @click="goNext"
                >
                  <span>下一步</span>
                  <AppIcon name="ArrowRight" :size="14" />
                </button>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import FormField from '@/components/settings/form/FormField.vue'
import ServicesPanel from '@/components/settings/ServicesPanel.vue'
import OnboardingRail from '@/components/onboarding/OnboardingRail.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import { useSystemConfig } from '@/composables/useSystemConfig'
import { useApi } from '@/composables/useApi'
import { fetchConfigPending } from '@/api/configDraft'
import {
  OPTIONAL_CAPABILITY_STEP_IDS,
  isPhase1Complete,
  onboardingStepPhase,
  onboardingStepVisual,
} from '@/config/onboardingSteps'
import { currentPhoneAccessUrl } from '@/components/onboarding/onboardingAccess'
import type { OnboardingStepInfo } from '@/api/system'
import WelcomeStep from '@/components/onboarding/steps/WelcomeStep.vue'
import AccountStep from '@/components/onboarding/steps/AccountStep.vue'
import DependenciesStep from '@/components/onboarding/steps/DependenciesStep.vue'
import KernelStep from '@/components/onboarding/steps/KernelStep.vue'
import KernelModelsStep from '@/components/onboarding/steps/KernelModelsStep.vue'
import XiaomiStep from '@/components/onboarding/steps/XiaomiStep.vue'
import QQStep from '@/components/onboarding/steps/QQStep.vue'
import MossStep from '@/components/onboarding/steps/MossStep.vue'
import LoomStep from '@/components/onboarding/steps/LoomStep.vue'
import ClientsStep from '@/components/onboarding/steps/ClientsStep.vue'
import FinishStep from '@/components/onboarding/steps/FinishStep.vue'
import StepPlaceholder from '@/components/onboarding/steps/StepPlaceholder.vue'
import './onboarding.css'

const props = withDefaults(
  defineProps<{
    visible: boolean
    testMode?: boolean
  }>(),
  {
    testMode: false,
  },
)

const emit = defineEmits<{
  close: []
  completed: []
}>()

const {
  status,
  error: onboardingError,
  steps,
  needsSetup,
  completedSteps,
  skippedSteps,
  refresh,
  recordStep,
} = useOnboarding()

const { snapshot, load } = useSystemConfig()
const { verifyPassword } = useApi()

const COMPONENTS: Record<string, Component> = {
  WelcomeStep,
  AccountStep,
  DependenciesStep,
  KernelStep,
  KernelModelsStep,
  XiaomiStep,
  QQStep,
  MossStep,
  LoomStep,
  ClientsStep,
  FinishStep,
}

const PASSWORD_PANEL_IDS = new Set([
  'dependencies',
  'kernel',
  'kernel_models',
  'xiaomi',
  'qq',
  'moss',
  'loom',
  'finish',
])

const overlayRef = ref<HTMLElement | null>(null)
const activeIndex = ref(0)
const password = ref('')
const unlocked = ref(false)
const gateBusy = ref(false)
const gateError = ref('')
const statusLoaded = ref(false)
const progressWarning = ref('')
const pendingCount = ref(0)

const milestoneActive = ref(false)
const milestoneAcknowledged = ref(false)
const accessUrl = currentPhoneAccessUrl()
const optionalCount = OPTIONAL_CAPABILITY_STEP_IDS.length

const gateOpen = computed(
  () => props.visible && statusLoaded.value && !needsSetup.value && !unlocked.value,
)
const accountIndex = computed(() =>
  steps.value.findIndex((step) => step.id === 'account'),
)
const accountIncomplete = computed(
  () => needsSetup.value && !completedSteps.value.includes('account'),
)

const stepCount = computed(() => Math.max(steps.value.length, 1))
const phase1Complete = computed(() => isPhase1Complete(steps.value))
const phase2StartIndex = computed(() =>
  steps.value.findIndex((step) => onboardingStepPhase(step.id) === 2),
)
const activeStep = computed<OnboardingStepInfo | null>(
  () => steps.value[activeIndex.value] ?? steps.value[0] ?? null,
)
const isLastStep = computed(
  () => activeIndex.value >= steps.value.length - 1 || activeStep.value?.id === 'finish',
)
const activeStepHandled = computed(() => {
  const step = activeStep.value
  if (!step) return false
  return (
    completedSteps.value.includes(step.id) || skippedSteps.value.includes(step.id)
  )
})
const nextBlocked = computed(() => {
  const step = activeStep.value
  if (!step) return true
  if (step.id === 'finish') return true
  if (step.id === 'account' && needsSetup.value) return true
  return step.required && !activeStepHandled.value
})
const footerBlockReason = computed(() => {
  if (!nextBlocked.value) return ''
  const step = activeStep.value
  if (!step) return ''
  if (step.id === 'account' && needsSetup.value) return ''
  if (step.id === 'finish') {
    return finishReady.value ? '' : '前面还有未完成的步骤，请先完成或跳过。'
  }
  return '请先在本步骤完成或跳过后再继续。'
})
const setupTokenRequired = computed(
  () => readPath(snapshot.value?.config, 'auth.setup_require_token') === true,
)
const finishIndex = computed(() =>
  steps.value.findIndex((step) => step.id === 'finish'),
)
const finishReady = computed(() => {
  const index = finishIndex.value
  if (index <= 0) return false
  return steps.value
    .slice(0, index)
    .every(
      (step) =>
        completedSteps.value.includes(step.id) || skippedSteps.value.includes(step.id),
    )
})

const activePanel = computed<Component>(() => {
  const stepId = activeStep.value?.id
  if (!stepId) return StepPlaceholder
  return COMPONENTS[onboardingStepVisual(stepId).component] ?? StepPlaceholder
})

const panelProps = computed<Record<string, unknown>>(() => {
  const stepId = activeStep.value?.id
  if (stepId === 'account') {
    return {
      needsSetup: needsSetup.value,
      setupTokenRequired: setupTokenRequired.value,
    }
  }
  if (stepId && PASSWORD_PANEL_IDS.has(stepId)) {
    return { currentPassword: password.value }
  }
  return {}
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPath(source: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!source) return undefined
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function clampStepIndex(index: number): number {
  if (!accountIncomplete.value) return index
  const limit = accountIndex.value
  if (limit < 0) return index
  return Math.min(index, limit)
}

function resolveActiveIndex(): number {
  const list = steps.value
  if (list.length === 0) return 0
  const currentId = status.value?.state.current_step ?? ''
  let index = list.findIndex((step) => step.state === 'current')
  if (index < 0 && currentId) index = list.findIndex((step) => step.id === currentId)
  if (index < 0) {
    index = list.findIndex(
      (step) => step.state !== 'completed' && step.state !== 'skipped',
    )
  }
  return clampStepIndex(index < 0 ? list.length - 1 : index)
}

function clearSecrets(): void {
  password.value = ''
  unlocked.value = false
  gateBusy.value = false
  gateError.value = ''
}

function resetTransient(): void {
  activeIndex.value = 0
  milestoneActive.value = false
  milestoneAcknowledged.value = false
  clearSecrets()
  statusLoaded.value = false
  progressWarning.value = ''
  pendingCount.value = 0
}

async function refreshPending(): Promise<void> {
  if (!props.visible || !statusLoaded.value) return
  try {
    const result = await fetchConfigPending({
      currentPassword: password.value.trim() || undefined,
    })
    pendingCount.value = result.ok ? result.pending.count : 0
  } catch {
    pendingCount.value = 0
  }
}

watch(
  [activeIndex, () => completedSteps.value.length, () => skippedSteps.value.length],
  () => {
    void refreshPending()
  },
)

async function handleUnlock(): Promise<void> {
  if (gateBusy.value) return
  const candidate = password.value
  if (!candidate) {
    gateError.value = '请输入当前管理员密码。'
    return
  }

  gateBusy.value = true
  gateError.value = ''
  try {
    const result = await verifyPassword(candidate)
    if (result.valid) {
      unlocked.value = true
      gateError.value = ''
      return
    }
    if (result.code === 'auth_required') {
      password.value = ''
      gateError.value = result.message || '登录已过期，请重新登录。'
      return
    }
    if (result.code === 'rate_limited') {
      gateError.value =
        result.retry_after !== undefined
          ? `尝试次数过多，请 ${result.retry_after} 秒后再试。`
          : result.message || '尝试次数过多，请稍后再试。'
      return
    }
    gateError.value = result.message || '密码验证失败，请重试。'
  } finally {
    gateBusy.value = false
  }
}

watch(onboardingError, (error) => {
  if (!error || error.status !== 403) return
  if (error.code !== 'password_invalid' && error.code !== 'password_required') return
  if (needsSetup.value) return
  password.value = ''
  unlocked.value = false
  gateBusy.value = false
  gateError.value =
    error.code === 'password_required'
      ? '请重新输入当前管理员密码。'
      : '当前密码已失效，请重新输入。'
})

function handleClose(): void {
  clearSecrets()
  emit('close')
}

function emitCompleted(): void {
  clearSecrets()
  emit('completed')
}

async function recordProgress(
  stepId: string,
  state: 'completed' | 'skipped',
  data?: Record<string, unknown>,
): Promise<boolean> {
  progressWarning.value = ''
  const result = await recordStep(stepId, state, data)
  if (result === null) {
    progressWarning.value = `进度写入失败（不影响已完成的操作）：${
      onboardingError.value?.message ?? '未知错误'
    }`
    return false
  }
  void refreshPending()
  return true
}

/** 跨过阶段 1 边界时先展示"已可用"里程碑, 不直接进入阶段 2 */
function shouldShowMilestone(nextIndex: number): boolean {
  if (milestoneAcknowledged.value) return false
  if (!phase1Complete.value) return false
  const boundary = phase2StartIndex.value
  if (boundary < 0 || nextIndex < boundary) return false
  return activeIndex.value < boundary
}

async function navigateTo(index: number): Promise<void> {
  if (index < 0 || index >= steps.value.length) return
  if (gateOpen.value) return
  if (shouldShowMilestone(index)) {
    milestoneActive.value = true
    return
  }
  milestoneActive.value = false
  activeIndex.value = clampStepIndex(index)
}

function handleMilestoneContinue(): void {
  milestoneAcknowledged.value = true
  const boundary = phase2StartIndex.value
  if (boundary < 0) {
    emitCompleted()
    return
  }
  void navigateTo(boundary)
}

function handleMilestoneFinish(): void {
  milestoneAcknowledged.value = true
  const target = finishIndex.value
  if (target < 0) {
    emitCompleted()
    return
  }
  void navigateTo(target)
}

function goNext(): void {
  if (activeIndex.value + 1 >= steps.value.length) return
  void navigateTo(activeIndex.value + 1)
}

function goBack(): void {
  if (activeIndex.value === 0) return
  void navigateTo(activeIndex.value - 1)
}

async function handleAccountCreated(payload: {
  username?: string
  password?: string
  existing?: boolean
}): Promise<void> {
  if (payload.password) {
    password.value = payload.password
    unlocked.value = true
    gateError.value = ''
  }
  const nextIndex = Math.min(activeIndex.value + 1, steps.value.length - 1)
  const data = payload.username
    ? { username: payload.username }
    : { existing: true }
  await recordProgress('account', 'completed', data)
  await refresh()
  await navigateTo(nextIndex)
}

function handleEnterMain(): void {
  emitCompleted()
}

async function focusGateOrOverlay(): Promise<void> {
  await nextTick()
  if (gateOpen.value) {
    overlayRef.value
      ?.querySelector<HTMLInputElement>('[data-onboarding-password]')
      ?.focus()
    return
  }
  overlayRef.value?.focus()
}

watch(gateOpen, (open) => {
  if (!open || !props.visible) return
  void focusGateOrOverlay()
})

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      resetTransient()
      return
    }

    resetTransient()
    try {
      await Promise.all([refresh(), load()])
    } catch {
      // composables normalize their own errors; keep the shell usable.
    }

    activeIndex.value = resolveActiveIndex()
    statusLoaded.value = true
    void refreshPending()
    await focusGateOrOverlay()
  },
  { immediate: true },
)

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function trapFocus(event: KeyboardEvent): void {
  const root = overlayRef.value
  if (!root) return

  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (items.length === 0) return

  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement

  if (event.shiftKey) {
    if (active === first || !root.contains(active)) {
      event.preventDefault()
      last.focus()
    }
    return
  }
  if (active === last || !root.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (!props.visible) return
  if (event.key === 'Escape') {
    event.preventDefault()
    handleClose()
    return
  }
  if (event.key === 'Tab') trapFocus(event)
}

onMounted(() => {
  document.addEventListener('keydown', handleDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown)
})
</script>
