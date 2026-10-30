/**
 * 引导步骤的展示与阶段元数据 (T12 / T27)
 *
 * 只承载图标、组件名、首屏 fallback 文案与阶段分组。权威顺序/标题/required
 * 一律来自 GET /api/system/onboarding/status 的 steps, 本文件不参与运行时
 * 步骤判定, 仅按 step id 附加只读元数据。
 *
 * 阶段划分 (T27):
 *   - 阶段 1 = welcome / account / dependencies / kernel, 完成后系统即"已可用"
 *   - 阶段 2 = kernel_models / xiaomi / qq / moss / loom / clients / finish,
 *     属于可用之后的可选完善 (clients/finish 为收尾, 其余可跳过)
 *
 * 步骤 id 与顺序是后端契约 (backend/services/onboarding_service.py), 不可改动。
 */

import type { OnboardingStepInfo } from '@/api/systemTypes'

/** 引导阶段: 1 = 可用里程碑前, 2 = 可用之后的可选阶段 */
export type OnboardingPhase = 1 | 2

export interface OnboardingStepVisual {
  icon: string
  component: string
  fallbackTitle: string
  fallbackDescription: string
  /** 所处阶段 */
  phase: OnboardingPhase
  /** 是否是阶段里程碑的边界步骤 (该步骤完成后触发"已可用"页) */
  milestone: boolean
  /** 为什么要做这一步, 用业务语言解释 */
  why: string
  /** 跳过该步骤会发生什么; 不可跳过的步骤为空串 (IS-2) */
  skip_consequence: string
}

/** 阶段 1: 完成这 4 步即可用 */
export const PHASE_1_STEP_IDS = [
  'welcome',
  'account',
  'dependencies',
  'kernel',
] as const

/** 阶段 2: 可用之后的可选完善与收尾 */
export const PHASE_2_STEP_IDS = [
  'kernel_models',
  'xiaomi',
  'qq',
  'moss',
  'loom',
  'clients',
  'finish',
] as const

/** 完整的 11 步顺序 (仅用于旧后端/状态缺失时的 fallback 渲染) */
export const FALLBACK_ORDER = [
  ...PHASE_1_STEP_IDS,
  ...PHASE_2_STEP_IDS,
] as const

/**
 * 里程碑页所说的"可选"能力步骤。
 * 阶段 2 的 7 步里, kernel_models/clients/finish 属于链路与收尾,
 * 真正可选的增强能力是小米健康云/QQ/MOSS/AI 助手这 4 项。
 */
export const OPTIONAL_CAPABILITY_STEP_IDS = [
  'xiaomi',
  'qq',
  'moss',
  'loom',
] as const

const VISUALS: Record<string, OnboardingStepVisual> = {
  welcome: {
    icon: 'ChatCircleDots',
    component: 'WelcomeStep',
    fallbackTitle: '欢迎',
    fallbackDescription: '了解 Kinship 能为你做什么，准备好后开始配置',
    phase: 1,
    milestone: false,
    why: '先了解 Kinship 会怎么使用你的数据，再决定要不要继续。后面每一步都可以返回修改。',
    skip_consequence: '',
  },
  account: {
    icon: 'User',
    component: 'AccountStep',
    fallbackTitle: '管理员账号',
    fallbackDescription: '创建首个管理员账号，作为后续配置的登录凭据',
    phase: 1,
    milestone: false,
    why: '管理员账号是登录和修改配置的唯一凭据；没有它，后续配置无法写入。',
    skip_consequence: '',
  },
  dependencies: {
    icon: 'ListChecks',
    component: 'DependenciesStep',
    fallbackTitle: '依赖检查',
    fallbackDescription: '检查系统环境与 AI 工作目录，确认运行条件',
    phase: 1,
    milestone: false,
    why: '检查这台机器是否具备运行条件。缺什么会在这里直接告诉你；这里不会下载任何东西。',
    skip_consequence: '',
  },
  kernel: {
    icon: 'Plugs',
    component: 'KernelStep',
    fallbackTitle: '音频内核',
    fallbackDescription: '安装或复用音频内核程序',
    phase: 1,
    milestone: true,
    why: '把录音转成文字、识别说话人。没有它，录音只会被保存，不会被分析。',
    skip_consequence:
      '跳过内核：音频不会分析（语音识别、声纹与环境声均不可用），其他功能正常；可稍后在设置里安装。',
  },
  kernel_models: {
    icon: 'Download',
    component: 'KernelModelsStep',
    fallbackTitle: '内核模型',
    fallbackDescription: '下载或校验音频内核所需的模型文件',
    phase: 2,
    milestone: false,
    why: '模型决定识别准不准。跳过 = 降级（能用但准确度低）。',
    skip_consequence:
      '跳过模型下载：内核缺少模型，转写与声纹识别保持降级；可稍后回到设置补下，其他功能正常。',
  },
  xiaomi: {
    icon: 'Heartbeat',
    component: 'XiaomiStep',
    fallbackTitle: '小米健康云',
    fallbackDescription: '扫码连接小米健康云，同步手机健康数据，或关闭',
    phase: 2,
    milestone: false,
    why: '从小米健康云补齐心率、睡眠和步数，报告里的健康数据更完整。不需要可以关闭。',
    skip_consequence:
      '关闭小米健康云：不同步心率、睡眠与步数，报告缺少云端健康数据；可稍后在设置里开启。',
  },
  qq: {
    icon: 'ChatCircleText',
    component: 'QQStep',
    fallbackTitle: 'QQ 网关',
    fallbackDescription: '配置 QQ 机器人与 NapCat 连接，或关闭',
    phase: 2,
    milestone: false,
    why: '让 Loom 通过 NapCat 收发 QQ 消息；不需要 QQ 机器人可以关闭。',
    skip_consequence:
      '关闭 QQ 网关：QQ 机器人不会上线，手机与 QQ 之间无法收发消息；可稍后在设置里开启。',
  },
  moss: {
    icon: 'Waveform',
    component: 'MossStep',
    fallbackTitle: 'MOSS 深度音频',
    fallbackDescription: '设置外部 MOSS 服务地址与模型，或关闭',
    phase: 2,
    milestone: false,
    why: '给已落盘的录音补充环境声、静音与深度理解；不影响主链路，可关闭。',
    skip_consequence:
      '不启用 MOSS：只保留基础音频链路，没有深度音频理解与环境声/静音旁白；可稍后在设置里开启。',
  },
  loom: {
    icon: 'Brain',
    component: 'LoomStep',
    fallbackTitle: 'AI 助手',
    fallbackDescription: '设置 Loom 端口、模型提供商并启动应用',
    phase: 2,
    milestone: false,
    why: 'Loom 负责对话、报告与自动化；不启动它，系统只能采集和保存数据。',
    skip_consequence:
      '跳过 AI 助手：不会启动 Loom，对话、定时分析与报告都不可用；可稍后在设置里配置。',
  },
  clients: {
    icon: 'DeviceMobile',
    component: 'ClientsStep',
    fallbackTitle: '客户端',
    fallbackDescription: '获取 Android 与 Windows 客户端并连接',
    phase: 2,
    milestone: false,
    why: '手机和 Windows 桌面端是日常使用的入口；这里给出安装包和连接地址。',
    skip_consequence: '',
  },
  finish: {
    icon: 'CheckCircle',
    component: 'FinishStep',
    fallbackTitle: '完成',
    fallbackDescription: '校验环境、启动服务并结束引导',
    phase: 2,
    milestone: false,
    why: '一次性应用前面所有改动的草稿，并做最后校验。通常 5-20 秒。',
    skip_consequence: '',
  },
}

const FALLBACK_RULES: Record<
  string,
  Pick<OnboardingStepInfo, 'required' | 'skippable' | 'auth'>
> = {
  welcome: { required: true, skippable: false, auth: 'none' },
  account: { required: true, skippable: false, auth: 'setup_token' },
  dependencies: { required: true, skippable: false, auth: 'bearer' },
  kernel: { required: true, skippable: true, auth: 'password' },
  kernel_models: { required: true, skippable: true, auth: 'password' },
  xiaomi: { required: true, skippable: true, auth: 'password' },
  qq: { required: true, skippable: true, auth: 'password' },
  moss: { required: true, skippable: true, auth: 'password' },
  loom: { required: true, skippable: true, auth: 'password' },
  clients: { required: true, skippable: false, auth: 'bearer' },
  finish: { required: true, skippable: false, auth: 'password' },
}

const DEFAULT_VISUAL: OnboardingStepVisual = {
  icon: 'Circle',
  component: 'OnboardingStep',
  fallbackTitle: '',
  fallbackDescription: '',
  phase: 2,
  milestone: false,
  why: '',
  skip_consequence: '',
}

export function onboardingStepVisual(stepId: string): OnboardingStepVisual {
  return VISUALS[stepId] ?? DEFAULT_VISUAL
}

/** 步骤所属阶段; 未知步骤 (更新的后端) 归入可选阶段, 不阻塞"已可用"判定 */
export function onboardingStepPhase(stepId: string): OnboardingPhase {
  return VISUALS[stepId]?.phase ?? 2
}

/** 阶段里程碑的边界步骤 id (完成后展示"已可用"页); 无边界时返回 null */
export function onboardingMilestoneStepId(): string | null {
  return (
    FALLBACK_ORDER.find((id) => VISUALS[id]?.milestone === true) ?? null
  )
}

/** 跳过后果文案; 不可跳过的步骤返回空串 */
export function skipConsequenceFor(stepId: string): string {
  return VISUALS[stepId]?.skip_consequence ?? ''
}

/** 步骤必要性的业务解释; 未知步骤返回空串 */
export function whyFor(stepId: string): string {
  return VISUALS[stepId]?.why ?? ''
}

/** 是否属于阶段 1 (可用里程碑之前) */
export function isPhase1Step(stepId: string): boolean {
  return onboardingStepPhase(stepId) === 1
}

/** 两个阶段各自的步骤 id 列表 (按契约顺序) */
export function phaseStepIds(phase: OnboardingPhase): readonly string[] {
  return phase === 1 ? PHASE_1_STEP_IDS : PHASE_2_STEP_IDS
}

export interface PhaseProgress {
  /** 已完成或已跳过 */
  done: number
  total: number
}

function isHandledState(state: OnboardingStepInfo['state'] | undefined): boolean {
  return state === 'completed' || state === 'skipped'
}

/** 按后端 steps 计算某阶段的进度 (completed/skipped 均计入) */
export function phaseProgress(
  steps: ReadonlyArray<Pick<OnboardingStepInfo, 'id' | 'state'>>,
  phase: OnboardingPhase,
): PhaseProgress {
  const ids = phaseStepIds(phase)
  const byId = new Map(steps.map((step) => [step.id, step]))
  let done = 0
  for (const id of ids) {
    if (isHandledState(byId.get(id)?.state)) done += 1
  }
  return { done, total: ids.length }
}

/** 阶段 1 是否已全部完成或跳过 (后端 steps 为权威来源) */
export function isPhase1Complete(
  steps: ReadonlyArray<Pick<OnboardingStepInfo, 'id' | 'state'>>,
): boolean {
  return phaseProgress(steps, 1).done === PHASE_1_STEP_IDS.length
}

/**
 * 阶段 1 是否已完成 (仅凭 completed/skipped 两个 id 列表)。
 * 用于状态接口未携带 steps 时 (旧后端) 的降级判定。
 */
export function isPhase1CompleteFromState(
  completed: readonly string[],
  skipped: readonly string[],
): boolean {
  const handled = new Set([...completed, ...skipped])
  return PHASE_1_STEP_IDS.every((id) => handled.has(id))
}

/** 里程碑页的"可选"能力数量 (用于"还有 N 项可选") */
export function optionalCapabilityCount(): number {
  return OPTIONAL_CAPABILITY_STEP_IDS.length
}

export function fallbackOnboardingSteps(
  currentStepId?: string | null,
): OnboardingStepInfo[] {
  const current = currentStepId || FALLBACK_ORDER[0]
  return FALLBACK_ORDER.map((id) => {
    const visual = onboardingStepVisual(id)
    return {
      id,
      title: visual.fallbackTitle,
      description: visual.fallbackDescription,
      ...FALLBACK_RULES[id],
      state: id === current ? 'current' : 'pending',
    }
  })
}
