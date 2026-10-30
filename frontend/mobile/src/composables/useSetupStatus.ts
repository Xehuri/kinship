/**
 * 首次初始化状态 Composable
 *
 * 并行查询后端是否尚无用户 (需要首次初始化) 以及引导初始化状态。
 * 使用模块级单例 ref, 多个组件共享同一状态。
 *
 * 使用方式:
 *   const { needsSetup, onboardingComplete, refreshSetupStatus } = useSetupStatus()
 *   await refreshSetupStatus()
 *   if (needsSetup.value) { ...展示初始化覆盖层 }
 */

import { ref } from 'vue'
import type { Ref } from 'vue'
import { getSetupStatus } from '@/composables/useApi'
import { getOnboardingStatus } from '@/api/system'
import {
  isPhase1Complete,
  isPhase1CompleteFromState,
} from '@/config/onboardingSteps'

/**
 * 首次初始化状态三态 (模块级共享)
 *   true  -> 需要初始化
 *   false -> 已初始化
 *   null  -> 查询失败 / 未知 (后端不可达或响应异常)
 */
const setupStatus = ref<boolean | null>(null)

/** 是否需要首次初始化 (模块级共享状态) */
const needsSetup = ref(false)

/** 首次初始化状态查询是否失败 (后端不可达 / 响应异常) */
const setupStatusError = ref(false)

/**
 * 引导初始化是否已完成 (模块级共享)
 * 默认 true: 尚未查询或旧后端无引导接口时按"已完成"处理, 避免升级安装被反复打扰。
 */
const onboardingComplete = ref(true)

/** 配置是否处于降级态 (模块级共享) */
const configDegraded = ref(false)

/** 引导状态是否来自后端 (旧后端 404 / 网络失败时为 false) */
const onboardingKnown = ref(false)

/**
 * 引导阶段 1 (welcome/account/dependencies/kernel) 是否已完成。
 * 完成即代表系统已可用: 自动弹出向导的"引导未完成"条件随之中止 (T27)。
 */
const onboardingPhase1Complete = ref(false)

/**
 * 查询并刷新初始化状态
 *
 * 两个接口并行查询:
 *   - GET /auth/setup-status        -> needsSetup / setupStatus / setupStatusError
 *   - GET /api/system/onboarding/status -> onboardingComplete / configDegraded / onboardingKnown
 *
 * 明确区分三态:
 *   - true  -> needsSetup=true, 进入首次初始化流程
 *   - false -> needsSetup=false, 已初始化, 走正常登录流程
 *   - null  -> setupStatusError=true, needsSetup 保持 false (保证登录流程可用),
 *             但 UI 可通过 setupStatusError 识别"未知", 不把后端不可达误判为已初始化
 *
 * 引导接口失败 (旧后端 / 404) 时回退为 onboardingComplete=true 且 onboardingKnown=false,
 * 实现"旧安装不再打扰"; 该回退不修改 needsSetup, 不把真实的 needs_setup=true 抹掉。
 * @returns 是否需要初始化
 */
export async function refreshSetupStatus(): Promise<boolean> {
  const [setupResult, onboardingResult] = await Promise.allSettled([
    getSetupStatus(),
    getOnboardingStatus(),
  ])

  const status = setupResult.status === 'fulfilled' ? setupResult.value : null
  setupStatus.value = status
  setupStatusError.value = status === null
  // 仅明确 needs_setup=true 才需要初始化; null (不可达) 按 false 处理
  needsSetup.value = status === true

  if (onboardingResult.status === 'fulfilled' && onboardingResult.value) {
    const onboarding = onboardingResult.value
    onboardingComplete.value = onboarding.onboarding_complete
    configDegraded.value = onboarding.degraded
    onboardingKnown.value = true
    const steps = Array.isArray(onboarding.steps) ? onboarding.steps : []
    onboardingPhase1Complete.value =
      steps.length > 0
        ? isPhase1Complete(steps)
        : isPhase1CompleteFromState(
            onboarding.state?.completed_steps ?? [],
            onboarding.state?.skipped_steps ?? [],
          )
  } else {
    onboardingComplete.value = true
    configDegraded.value = false
    onboardingKnown.value = false
    onboardingPhase1Complete.value = false
  }

  return needsSetup.value
}

/** useSetupStatus 返回值 */
export interface UseSetupStatusReturn {
  /** 是否需要首次初始化 */
  needsSetup: Ref<boolean>
  /** 首次初始化状态三态: true=需要 / false=已初始化 / null=未知 (查询失败) */
  setupStatus: Ref<boolean | null>
  /** 首次初始化状态查询是否失败 (后端不可达 / 响应异常) */
  setupStatusError: Ref<boolean>
  /** 引导初始化是否已完成 (旧后端无引导接口时回退为 true) */
  onboardingComplete: Ref<boolean>
  /** 配置是否处于降级态 */
  configDegraded: Ref<boolean>
  /** 引导状态是否成功从后端获取 */
  onboardingKnown: Ref<boolean>
  /** 阶段 1 是否已完成 (系统已可用) */
  onboardingPhase1Complete: Ref<boolean>
  /** 刷新初始化状态 */
  refreshSetupStatus: () => Promise<boolean>
}

/** 首次初始化状态 Composable */
export function useSetupStatus(): UseSetupStatusReturn {
  return {
    needsSetup,
    setupStatus,
    setupStatusError,
    onboardingComplete,
    configDegraded,
    onboardingKnown,
    onboardingPhase1Complete,
    refreshSetupStatus,
  }
}
