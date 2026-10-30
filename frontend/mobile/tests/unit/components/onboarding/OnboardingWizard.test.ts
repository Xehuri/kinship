/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type {
  ConfigSnapshot,
  FinishClosing,
  FinishGroups,
  FinishStatus,
  LoomSetupResult,
  MossConfig,
  OnboardingState,
  OnboardingStatus,
  OnboardingStepInfo,
  OnboardingStepState,
  QqStatus,
  XiaomiStatus,
} from '@/api/system'

interface ApiErrorLike {
  status: number
  code: string
  message: string
  data?: Record<string, unknown>
}

interface OnboardingMock {
  status: Ref<OnboardingStatus | null>
  error: Ref<ApiErrorLike | null>
  steps: ComputedRef<OnboardingStepInfo[]>
  needsSetup: ComputedRef<boolean>
  completedSteps: ComputedRef<string[]>
  skippedSteps: ComputedRef<string[]>
  refresh: ReturnType<typeof vi.fn>
  recordStep: ReturnType<typeof vi.fn>
  xiaomi: Ref<XiaomiStatus | null>
  qq: Ref<QqStatus | null>
  mossConfig: Ref<MossConfig | null>
  loomSetupResult: Ref<LoomSetupResult | null>
  finish: Ref<FinishStatus | null>
  finishGroups: Ref<FinishGroups | null>
  finishClosing: Ref<FinishClosing | null>
  finishError: Ref<ApiErrorLike | null>
  loadXiaomi: ReturnType<typeof vi.fn>
  configureXiaomi: ReturnType<typeof vi.fn>
  requestXiaomiQr: ReturnType<typeof vi.fn>
  pollXiaomiQr: ReturnType<typeof vi.fn>
  loadQq: ReturnType<typeof vi.fn>
  validateQq: ReturnType<typeof vi.fn>
  configureQq: ReturnType<typeof vi.fn>
  loadMossConfig: ReturnType<typeof vi.fn>
  configureMoss: ReturnType<typeof vi.fn>
  setupLoom: ReturnType<typeof vi.fn>
  loadFinish: ReturnType<typeof vi.fn>
  runFinish: ReturnType<typeof vi.fn>
}

interface ConfigMock {
  snapshot: Ref<ConfigSnapshot | null>
  load: ReturnType<typeof vi.fn>
}

const onb = vi.hoisted(() => ({}) as OnboardingMock)
const cfg = vi.hoisted(() => ({}) as ConfigMock)
const verifyPassword = vi.hoisted(() => vi.fn())
const configDraft = vi.hoisted(() => ({ fetchConfigPending: vi.fn() }))

vi.mock('@/api/configDraft', () => ({
  fetchConfigPending: configDraft.fetchConfigPending,
}))

vi.mock('@/composables/useOnboarding', async () => {
  const { computed, ref } = await import('vue')
  onb.status = ref<OnboardingStatus | null>(null)
  onb.error = ref<ApiErrorLike | null>(null)
  onb.refresh = vi.fn().mockResolvedValue(undefined)
  onb.recordStep = vi.fn().mockResolvedValue({})
  onb.xiaomi = ref<XiaomiStatus | null>(null)
  onb.qq = ref<QqStatus | null>(null)
  onb.mossConfig = ref<MossConfig | null>(null)
  onb.loomSetupResult = ref<LoomSetupResult | null>(null)
  onb.finish = ref<FinishStatus | null>(null)
  onb.finishGroups = ref<FinishGroups | null>(null)
  onb.finishClosing = ref<FinishClosing | null>(null)
  onb.finishError = ref<ApiErrorLike | null>(null)
  onb.loadXiaomi = vi.fn().mockResolvedValue(null)
  onb.configureXiaomi = vi.fn().mockResolvedValue(null)
  onb.requestXiaomiQr = vi.fn().mockResolvedValue(null)
  onb.pollXiaomiQr = vi.fn().mockResolvedValue(null)
  onb.loadQq = vi.fn().mockResolvedValue(null)
  onb.validateQq = vi.fn().mockResolvedValue(null)
  onb.configureQq = vi.fn().mockResolvedValue(null)
  onb.loadMossConfig = vi.fn().mockResolvedValue(null)
  onb.configureMoss = vi.fn().mockResolvedValue(null)
  onb.setupLoom = vi.fn().mockResolvedValue(null)
  onb.loadFinish = vi.fn().mockResolvedValue(null)
  onb.runFinish = vi.fn().mockResolvedValue(null)
  onb.steps = computed(() => onb.status.value?.steps ?? [])
  onb.needsSetup = computed(() => onb.status.value?.needs_setup ?? false)
  onb.completedSteps = computed(
    () => onb.status.value?.state.completed_steps ?? [],
  )
  onb.skippedSteps = computed(() => onb.status.value?.state.skipped_steps ?? [])
  return {
    useOnboarding: () => ({
      status: onb.status,
      error: onb.error,
      steps: onb.steps,
      needsSetup: onb.needsSetup,
      completedSteps: onb.completedSteps,
      skippedSteps: onb.skippedSteps,
      refresh: onb.refresh,
      recordStep: onb.recordStep,
      xiaomi: onb.xiaomi,
      qq: onb.qq,
      mossConfig: onb.mossConfig,
      loomSetupResult: onb.loomSetupResult,
      finish: onb.finish,
      finishGroups: onb.finishGroups,
      finishClosing: onb.finishClosing,
      finishError: onb.finishError,
      loadXiaomi: onb.loadXiaomi,
      configureXiaomi: onb.configureXiaomi,
      requestXiaomiQr: onb.requestXiaomiQr,
      pollXiaomiQr: onb.pollXiaomiQr,
      loadQq: onb.loadQq,
      validateQq: onb.validateQq,
      configureQq: onb.configureQq,
      loadMossConfig: onb.loadMossConfig,
      configureMoss: onb.configureMoss,
      setupLoom: onb.setupLoom,
      loadFinish: onb.loadFinish,
      runFinish: onb.runFinish,
    }),
  }
})

vi.mock('@/composables/useSystemConfig', async () => {
  const { ref } = await import('vue')
  cfg.snapshot = ref<ConfigSnapshot | null>(null)
  cfg.load = vi.fn().mockResolvedValue(undefined)
  return {
    useSystemConfig: () => ({ snapshot: cfg.snapshot, load: cfg.load }),
  }
})

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({
    verifyPassword,
    setup: vi.fn(),
    token: 'test-token',
  }),
}))

import OnboardingWizard from '@/components/onboarding/OnboardingWizard.vue'
import XiaomiStep from '@/components/onboarding/steps/XiaomiStep.vue'

enableAutoUnmount(afterEach)

const STEP_IDS = [
  'welcome',
  'account',
  'dependencies',
  'kernel',
  'kernel_models',
  'xiaomi',
  'qq',
  'moss',
  'loom',
  'clients',
  'finish',
] as const

const STEP_TITLES: Record<string, string> = {
  welcome: '欢迎',
  account: '管理员账号',
  dependencies: '依赖检查',
  kernel: '音频内核',
  kernel_models: '内核模型',
  xiaomi: '小米健康云',
  qq: 'QQ 网关',
  moss: 'MOSS 深度音频',
  loom: 'AI 助手',
  clients: '客户端',
  finish: '完成',
}

const SKIPPABLE = new Set(['kernel', 'kernel_models', 'xiaomi', 'qq', 'moss', 'loom'])

function makeSteps(
  completed: string[] = [],
  skipped: string[] = [],
  current = 'welcome',
): OnboardingStepInfo[] {
  return STEP_IDS.map((id) => {
    let state: OnboardingStepState = 'pending'
    if (completed.includes(id)) state = 'completed'
    else if (skipped.includes(id)) state = 'skipped'
    else if (id === current) state = 'current'
    return {
      id,
      title: STEP_TITLES[id],
      description: '',
      required: true,
      skippable: SKIPPABLE.has(id),
      state,
      auth: 'none',
    }
  })
}

function makeStatus(
  overrides: {
    needs_setup?: boolean
    state?: Partial<OnboardingState>
    steps?: OnboardingStepInfo[]
  } = {},
): OnboardingStatus {
  const completed = overrides.state?.completed_steps ?? []
  const skipped = overrides.state?.skipped_steps ?? []
  const current = overrides.state?.current_step ?? 'welcome'
  return {
    state: {
      version: 4,
      completed_steps: completed,
      skipped_steps: skipped,
      current_step: current,
      completed: false,
      started_at: null,
      updated_at: null,
    },
    needs_setup: overrides.needs_setup ?? true,
    degraded: false,
    onboarding_complete: false,
    config_revision: 'rev-1',
    steps: overrides.steps ?? makeSteps(completed, skipped, current),
    bootstrap: true,
    state_version: 4,
    legacy_upgraded: false,
    degraded_reasons: [],
  }
}

function mountWizard(status: OnboardingStatus) {
  onb.status.value = status
  return mount(OnboardingWizard, {
    props: { visible: true },
    global: { stubs: { teleport: true } },
  })
}

function mountWizardStubbed(status: OnboardingStatus) {
  onb.status.value = status
  return mount(OnboardingWizard, {
    props: { visible: true },
    global: {
      stubs: {
        teleport: true,
        WelcomeStep: true,
        AccountStep: true,
        DependenciesStep: true,
        KernelStep: true,
        KernelModelsStep: true,
        XiaomiStep: true,
        QQStep: true,
        MossStep: true,
        LoomStep: true,
        ClientsStep: true,
        FinishStep: true,
        ServicesPanel: true,
      },
    },
  })
}

async function unlock(wrapper: ReturnType<typeof mountWizard>, password = 'pw') {
  await wrapper.get('[data-onboarding-password]').setValue(password)
  await wrapper.get('[data-onboarding-unlock-submit]').trigger('submit')
  await flushPromises()
}

describe('OnboardingWizard v4', () => {
  beforeEach(() => {
    onb.error.value = null
    onb.finishClosing.value = null
    onb.finishGroups.value = null
    onb.finishError.value = null
    cfg.snapshot.value = null
    verifyPassword.mockReset()
    verifyPassword.mockResolvedValue({ valid: true })
    configDraft.fetchConfigPending.mockReset().mockResolvedValue({
      ok: true,
      pending: {
        revision: 'rev-1',
        stagedRevision: null,
        changes: [],
        count: 0,
      },
    })
  })

  it('renders the v4 11-step rail and no old validation steps', async () => {
    const wrapper = mountWizard(makeStatus())
    await flushPromises()
    const ids = wrapper
      .findAll('[data-onboarding-step]')
      .map((node) => node.attributes('data-step-id'))
    expect(ids).toEqual([...STEP_IDS])
    expect(ids).not.toContain('preflight')
    expect(ids).not.toContain('startup')
    expect(wrapper.text()).toContain('小米健康云')
    expect(wrapper.text()).toContain('QQ 网关')
  })

  it('uses the server step order as authoritative', async () => {
    const reordered = makeSteps().slice().reverse()
    const wrapper = mountWizard(makeStatus({ steps: reordered }))
    await flushPromises()
    const ids = wrapper
      .findAll('[data-onboarding-step]')
      .map((node) => node.attributes('data-step-id'))
    const phase1 = reordered
      .filter((step) => ['welcome', 'account', 'dependencies', 'kernel'].includes(step.id))
      .map((step) => step.id)
    const phase2 = reordered
      .filter((step) => !['welcome', 'account', 'dependencies', 'kernel'].includes(step.id))
      .map((step) => step.id)
    expect(ids).toEqual([...phase1, ...phase2])
  })

  it('blocks an existing install behind the gate before panel or footer', async () => {
    const wrapper = mountWizard(makeStatus({ needs_setup: false }))
    await flushPromises()
    expect(wrapper.find('[data-onboarding-gate]').exists()).toBe(true)
    expect(wrapper.find('[data-onboarding-panel]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-next]').exists()).toBe(false)
  })

  it('unlocks and injects the password into XiaomiStep', async () => {
    const completed = STEP_IDS.slice(0, 5)
    const wrapper = mountWizard(
      makeStatus({
        needs_setup: false,
        state: { completed_steps: [...completed], current_step: 'xiaomi' },
      }),
    )
    await flushPromises()
    await unlock(wrapper)
    const panel = wrapper.findComponent(XiaomiStep)
    expect(panel.exists()).toBe(true)
    expect(panel.props('currentPassword')).toBe('pw')
    expect(wrapper.find('[data-onboarding-password]').exists()).toBe(false)
  })

  it('shows a wrong-password error and stays behind the gate', async () => {
    verifyPassword.mockResolvedValue({
      valid: false,
      code: 'password_invalid',
      message: '密码错误',
    })
    const wrapper = mountWizard(makeStatus({ needs_setup: false }))
    await flushPromises()
    await unlock(wrapper, 'bad')
    expect(wrapper.find('[data-onboarding-gate]').exists()).toBe(true)
    expect(wrapper.find('[data-onboarding-gate-error]').text()).toContain('密码错误')
  })

  it('reopens the gate when a step reports password_invalid', async () => {
    const completed = STEP_IDS.slice(0, 5)
    const wrapper = mountWizard(
      makeStatus({
        needs_setup: false,
        state: { completed_steps: [...completed], current_step: 'xiaomi' },
      }),
    )
    await flushPromises()
    await unlock(wrapper)
    onb.error.value = {
      status: 403,
      code: 'password_invalid',
      message: '当前密码已失效',
    }
    await flushPromises()
    expect(wrapper.find('[data-onboarding-gate]').exists()).toBe(true)
  })

  it('clamps navigation to account while setup is incomplete', async () => {
    const wrapper = mountWizard(
      makeStatus({ state: { current_step: 'dependencies' } }),
    )
    await flushPromises()
    const account = wrapper.get('[data-step-id="account"]')
    expect(account.attributes('aria-current')).toBe('step')
  })

  it('emits completed when FinishStep enters the main UI', async () => {
    const prior = STEP_IDS.slice(0, 10)
    onb.finishClosing.value = {
      title: '初始化完成',
      message: '系统已完成初始化，你可以开始使用了。',
      enabled: [{ id: 'loom', label: 'AI 助手' }],
      skipped: [],
      degraded: [],
      enter_label: '进入主界面',
    }
    const wrapper = mountWizard(
      makeStatus({
        needs_setup: true,
        state: { completed_steps: [...prior], current_step: 'finish' },
      }),
    )
    await flushPromises()
    await wrapper.get('[data-onboarding-finish-enter]').trigger('click')
    expect(wrapper.emitted('completed')).toHaveLength(1)
  })

  it('emits close from the close button and Escape', async () => {
    const wrapper = mountWizard(makeStatus())
    await flushPromises()
    await wrapper.get('[data-onboarding-close]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('close')!.length).toBeGreaterThanOrEqual(2)
  })

  it('shows the pending-changes badge and refreshes it on step change', async () => {
    configDraft.fetchConfigPending.mockResolvedValue({
      ok: true,
      pending: {
        revision: 'rev-1',
        stagedRevision: 'staged-1',
        changes: [
          { path: 'ssl.enabled', from: false, to: true, strategy: 'merge', requires_restart: true },
          { path: 'server.port', from: 8768, to: 8768, strategy: 'merge', requires_restart: true },
          { path: 'loom.url', from: '', to: 'http://127.0.0.1:5100', strategy: 'merge', requires_restart: false },
        ],
        count: 3,
      },
    })
    const wrapper = mountWizard(
      makeStatus({
        state: { completed_steps: ['welcome'], current_step: 'account' },
      }),
    )
    await flushPromises()

    const badge = wrapper.get('[data-onboarding-pending-badge]')
    expect(badge.text()).toContain('3 项变更将在完成时统一应用')

    const calls = configDraft.fetchConfigPending.mock.calls.length
    await wrapper.get('[data-step-id="welcome"]').trigger('click')
    await flushPromises()

    expect(configDraft.fetchConfigPending.mock.calls.length).toBeGreaterThan(calls)
  })

  it('hides the pending-changes badge when nothing is staged', async () => {
    const wrapper = mountWizard(makeStatus())
    await flushPromises()

    expect(wrapper.find('[data-onboarding-pending-badge]').exists()).toBe(false)
  })
})

describe('OnboardingWizard 已可用里程碑 (T27)', () => {
  beforeEach(() => {
    onb.error.value = null
    onb.finishClosing.value = null
    onb.finishGroups.value = null
    onb.finishError.value = null
    cfg.snapshot.value = null
    verifyPassword.mockReset()
    verifyPassword.mockResolvedValue({ valid: true })
    configDraft.fetchConfigPending.mockReset().mockResolvedValue({
      ok: true,
      pending: {
        revision: 'rev-1',
        stagedRevision: null,
        changes: [],
        count: 0,
      },
    })
  })

  const PHASE_1_DONE = ['welcome', 'account', 'dependencies']

  function atKernelSkipped() {
    return makeStatus({
      needs_setup: true,
      state: {
        completed_steps: [...PHASE_1_DONE],
        skipped_steps: ['kernel'],
        current_step: 'kernel',
      },
    })
  }

  it('阶段 1 完成后进入阶段 2 前先展示"已可用"页', async () => {
    const wrapper = mountWizardStubbed(atKernelSkipped())
    await flushPromises()
    expect(wrapper.find('[data-onboarding-milestone]').exists()).toBe(false)

    await wrapper.get('[data-onboarding-next]').trigger('click')
    await flushPromises()

    const milestone = wrapper.get('[data-onboarding-milestone]')
    expect(milestone.text()).toContain('已可用')
    expect(milestone.text()).toContain('还有 4 项可选')
    expect(
      wrapper.get('[data-onboarding-milestone-url]').text(),
    ).toBe(`${window.location.origin}/mobile/`)
    expect(wrapper.get('[data-onboarding-progress]').text()).toBe('阶段 1 完成')
    expect(wrapper.find('[data-onboarding-next]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-milestone-continue]').exists()).toBe(true)
    expect(wrapper.find('[data-onboarding-milestone-finish]').exists()).toBe(true)
    expect(wrapper.find('[data-onboarding-milestone-services]').exists()).toBe(true)
    expect(wrapper.find('services-panel-stub').exists()).toBe(true)
  })

  it('继续配置后进入阶段 2 第一步, 里程碑不再出现', async () => {
    const wrapper = mountWizardStubbed(atKernelSkipped())
    await flushPromises()
    await wrapper.get('[data-onboarding-next]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-onboarding-milestone-continue]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-onboarding-milestone]').exists()).toBe(false)
    expect(wrapper.get('[data-step-id="kernel_models"]').attributes('aria-current')).toBe(
      'step',
    )
  })

  it('直接完成初始化会跳到 finish 步骤', async () => {
    const wrapper = mountWizardStubbed(atKernelSkipped())
    await flushPromises()
    await wrapper.get('[data-onboarding-next]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-onboarding-milestone-finish]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-onboarding-milestone]').exists()).toBe(false)
    expect(wrapper.get('[data-step-id="finish"]').attributes('aria-current')).toBe('step')
    expect(wrapper.get('[data-onboarding-progress]').text()).toBe('第 11 / 11 步')
  })

  it('阶段 1 未完成时不会出现里程碑', async () => {
    const wrapper = mountWizardStubbed(
      makeStatus({
        needs_setup: true,
        state: {
          completed_steps: ['welcome', 'account'],
          current_step: 'dependencies',
        },
      }),
    )
    await flushPromises()
    await wrapper.get('[data-step-id="kernel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-onboarding-milestone]').exists()).toBe(false)
  })

  it('阶段 1 完成但从阶段 2 中途恢复时不强制回到里程碑', async () => {
    const wrapper = mountWizardStubbed(
      makeStatus({
        needs_setup: true,
        state: {
          completed_steps: [...PHASE_1_DONE, 'kernel_models'],
          skipped_steps: ['kernel'],
          current_step: 'xiaomi',
        },
      }),
    )
    await flushPromises()
    expect(wrapper.find('[data-onboarding-milestone]').exists()).toBe(false)
    expect(wrapper.get('[data-step-id="xiaomi"]').attributes('aria-current')).toBe('step')
  })
})
