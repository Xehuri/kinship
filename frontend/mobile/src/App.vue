<template>
  <div class="app">
    <KeepAlive include="ChatView">
      <router-view />
    </KeepAlive>

    <!-- 启动加载覆盖层 -->
    <SplashLoading :visible="showSplash" text="正在加载 Kinship..." />

    <!-- WS 日志抽屉 (设置页调试分组打开) -->
    <WsLogDrawer />

    <!-- 通知历史抽屉 (页头铃铛与提醒页共用) -->
    <NotificationsDrawer
      :visible="notificationsVisible"
      :notifications="notificationItems"
      :total="notificationTotal"
      :state="notificationState"
      :deleting-id="deletingNotificationId"
      @close="closeNotifications"
      @delete="deleteNotificationItem"
      @retry="loadNotifications"
    />

    <!-- Token 登录覆盖层 (401 时自动弹出; 首次初始化/引导期间不显示) -->
    <LoginOverlay
      :visible="showLogin && !needsSetup && !wizardVisible"
      @close="showLogin = false"
      @login-success="handleLoginSuccess"
    />

    <!-- 首次初始化覆盖层 (仅在真实引导向导未显示时兜底展示) -->
    <SetupOverlay
      :visible="needsSetup && !wizardVisible"
      @setup-success="handleSetupSuccess"
    />

    <!-- 真实初始化向导 (首启 / 引导未完成 / 配置降级时自动打开; 设置页入口为测试模式) -->
    <OnboardingWizard
      :visible="wizardVisible"
      @close="handleWizardClose"
      @completed="handleWizardCompleted"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import LoginOverlay from '@/components/common/LoginOverlay.vue'
import SetupOverlay from '@/components/common/SetupOverlay.vue'
import OnboardingWizard from '@/components/onboarding/OnboardingWizard.vue'
import NotificationsDrawer from '@/components/notifications/NotificationsDrawer.vue'
import WsLogDrawer from '@/components/notifications/WsLogDrawer.vue'
import SplashLoading from '@/components/common/SplashLoading.vue'
import { useApi } from '@/composables/useApi'
import type { TokenRefreshPayload } from '@/composables/useApi'
import { useSetupStatus } from '@/composables/useSetupStatus'
import { useChatIntegration } from '@/composables/useChatIntegration'
import { useRealTimeSingleton } from '@/composables/useRealTime'
import { useTheme } from '@/composables/useTheme'
import { useNotificationsSingleton } from '@/composables/useNotifications'
import { useWsLog } from '@/composables/useWsLog'
import { NAV_V2_SHORTCUT_ROUTES } from '@/config/navV2'

// ==================== 状态 ====================

/** 启动加载覆盖层显示状态 */
const showSplash = ref(true)

/** 启动加载安全兜底超时 [ms]: 门控异常时也能收起覆盖层, 避免白屏卡死 */
const SPLASH_FALLBACK_MS = 3000

/** 启动加载兜底定时器 ID */
let splashFallbackTimer: ReturnType<typeof setTimeout> | null = null

/** 组件是否已卸载 (阻止门控 await 结束后再建立实时连接) */
let isUnmounted = false

/**
 * 隐藏启动加载画面 (幂等)
 * 同时清理兜底定时器, 避免门控正常完成后兜底再次触发
 */
function hideSplash(): void {
  if (splashFallbackTimer) {
    clearTimeout(splashFallbackTimer)
    splashFallbackTimer = null
  }
  showSplash.value = false
}

/** 登录覆盖层显示状态 */
const showLogin = ref(false)

// ==================== 通知 ====================

const {
  visible: notificationsVisible,
  notifications: notificationItems,
  total: notificationTotal,
  state: notificationState,
  deletingId: deletingNotificationId,
  close: closeNotifications,
  load: loadNotifications,
  deleteNotification: deleteNotificationItem,
} = useNotificationsSingleton()

// ==================== 初始化 ====================

const {
  onAuthFail,
  offAuthFail,
  onTokenRefresh,
  offTokenRefresh,
  isLoggedIn,
  logout,
} = useApi()
const rt = useRealTimeSingleton()
const { handler: wsLogHandler } = useWsLog()

// 首次初始化 / 引导状态 (模块级共享)
const {
  needsSetup,
  setupStatusError,
  onboardingComplete,
  configDegraded,
  onboardingKnown,
  onboardingPhase1Complete,
  refreshSetupStatus,
} = useSetupStatus()

// ==================== 初始化向导 ====================

/** 向导是否由用户手动关闭 (关闭后不再自动弹回, 直到触发条件全部消失) */
const wizardDismissed = ref(false)

/** 向导当前是否渲染 */
const wizardVisible = ref(false)

/**
 * 自动打开条件:
 *   - 后端尚无用户 (真实首启)
 *   - 已登录且阶段 1 未完成、引导状态已知但未完成
 *   - 已登录且阶段 1 未完成、配置处于降级态
 * 阶段 1 (welcome/account/dependencies/kernel) 完成后系统已可用,
 * 引导不再自动弹出, 需要时从设置页手动打开。
 * 旧安装 (onboardingComplete=true) 不会自动打开。
 */
function wizardShouldOpen(): boolean {
  if (needsSetup.value) return true
  if (!isLoggedIn.value) return false
  if (onboardingPhase1Complete.value) return false
  if (onboardingKnown.value && !onboardingComplete.value) return true
  return configDegraded.value
}

/**
 * 同步向导可见性
 * 触发条件全部消失后重新武装, 使后续新出现的首启/降级状态仍可自动提示。
 */
function syncWizardVisibility(): void {
  if (!wizardShouldOpen()) {
    wizardDismissed.value = false
    wizardVisible.value = false
    return
  }
  if (!wizardDismissed.value) wizardVisible.value = true
}

watch(
  [
    needsSetup,
    isLoggedIn,
    onboardingKnown,
    onboardingComplete,
    onboardingPhase1Complete,
    configDegraded,
  ],
  syncWizardVisibility,
  { immediate: true, flush: 'sync' },
)

watch(
  isLoggedIn,
  (loggedIn) => {
    if (loggedIn) showLogin.value = false
  },
  { immediate: true },
)

/** 关闭自动向导: 本次会话不再自动弹回 */
function handleWizardClose(): void {
  wizardVisible.value = false
  wizardDismissed.value = true
}

/** 向导完成: 收起并刷新初始化状态, 不重载页面 */
async function handleWizardCompleted(): Promise<void> {
  wizardVisible.value = false
  wizardDismissed.value = true
  showLogin.value = false
  await refreshSetupStatus()
  if (isLoggedIn.value) {
    rt.reconnectSSE()
    rt.reconnectWS()
  }
  if (router.currentRoute.value.path !== '/chat') {
    await router.replace('/chat')
  }
}

// Initialize theme singleton (applies data-theme and listens for system changes)
useTheme()

/**
 * Auth fail 回调
 * 当 API 请求返回 401 时, 由 client.ts 触发
 *
 * 安全整改 (FE-H1): 不再在 localStorage 缓存明文密码, 因此无法静默自动重登录。
 * 401 时调用 logout() 清除本地 token、置 isLoggedIn=false 并断开实时连接,
 * 使 UI 回到一致的未登录状态, 再弹出登录覆盖层要求用户重新输入凭据。
 * 已回到未登录且登录层已显示时直接返回, 避免并发 401 重复登出/弹窗。
 */
function handleAuthFail(): void {
  // 并发 401 去重: 已回到未登录且登录层已显示时不再重复登出/弹窗
  if (!isLoggedIn.value && showLogin.value) return
  // 清除 token + isLoggedIn=false + 断开 SSE/WS + 清空聊天/流式/TTS 状态
  logout()
  showLogin.value = true
}

/** 认证恢复后隐藏登录层并重连实时连接 (SSE + WS) */
function resumeRealtimeAfterAuth(): void {
  showLogin.value = false
  rt.reconnectSSE()
  rt.reconnectWS()
}

/**
 * 登录成功回调
 * LoginOverlay emit login-success(token) 后, 关闭覆盖层并重连实时连接
 */
async function handleLoginSuccess(_token: string): Promise<void> {
  // token 已由 LoginOverlay 内部的 useApi().login() 保存
  resumeRealtimeAfterAuth()
  // 认证后重新拉取引导状态: 未完成的向导需要登录后才能读到完整状态
  await refreshSetupStatus()
}

/**
 * 外部 token 刷新回调 (桌面壳 / Android WebView 桥)
 *
 * 刷新前已登录且登录层未显示时, 说明会话无需恢复, 不打断现有实时连接;
 * 否则 (未登录或正卡在登录层) 关闭覆盖层并重连。
 */
function handleTokenRefresh(payload: TokenRefreshPayload): void {
  if (payload.wasLoggedIn && !showLogin.value) return
  resumeRealtimeAfterAuth()
}

/**
 * 初始化认证入口
 * 先查询是否需要首次初始化:
 *   - 需要 → 展示不可跳过的 SetupOverlay (不弹出登录框)
 *   - 不需要 → 未登录时弹出登录框
 */
async function initAuthGate(): Promise<void> {
  await refreshSetupStatus()
  if (setupStatusError.value) {
    // 后端不可达: 无法确认是否需要初始化, 退回正常登录流程 (不当成已初始化)
    console.warn('[App] 首次初始化状态查询失败, 按正常登录流程处理')
  }
  if (!needsSetup.value && !isLoggedIn.value) {
    showLogin.value = true
  }
}

/**
 * 首次初始化成功回调
 * setup() 已持久化 token 与登录状态, 这里关闭覆盖层并重连实时连接
 */
async function handleSetupSuccess(_token: string): Promise<void> {
  needsSetup.value = false
  rt.reconnectSSE()
  rt.reconnectWS()
  // 初始化完成后同样刷新引导状态, 让未完成的向导在认证后打开
  await refreshSetupStatus()
}

// ==================== 键盘快捷键 ====================

const router = useRouter()

/** Ctrl+1~6: 切换桌面导航标签 (顺序由 NAV_V2_DESKTOP 决定) */
function onKeyDown(e: KeyboardEvent): void {
  // 输入框中不触发快捷键
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

  if (e.ctrlKey && !e.shiftKey && !e.metaKey) {
    const target = NAV_V2_SHORTCUT_ROUTES[e.key]
    if (target) {
      e.preventDefault()
      router.push(target)
    }
  }
}

// ==================== 生命周期 ====================

/**
 * 启动引导: 先完成认证门控, 再建立实时连接
 *
 * 关键顺序 (修复 A3 竞态):
 *   refreshSetupStatus + 登录判定 (门控) 全部完成后, 才调用 useChatIntegration()
 *   建立 SSE/WS, 确保未认证时不会提前打开实时连接。
 * 无论门控成功/失败/后端不可达, 最终都收起启动加载画面。
 */
async function bootstrapRealtime(): Promise<void> {
  try {
    await initAuthGate()
  } finally {
    if (!isUnmounted) {
      // 门控完成后才初始化聊天集成 (SSE 事件路由 + 实时连接)
      useChatIntegration()
    }
    // 门控结束 (含异常/后端不可达) 后隐藏启动画面
    hideSplash()
  }
}

onMounted(() => {
  // 1. 注册 auth fail 与 token 刷新监听
  onAuthFail(handleAuthFail)
  onTokenRefresh(handleTokenRefresh)

  // 2. 注册 WS 消息监听 (仅注册处理器, 不建立连接; 供 WS 日志抽屉使用)
  rt.onWSMessage(wsLogHandler)

  // 3. 注册键盘快捷键
  window.addEventListener('keydown', onKeyDown)

  // 4. 启动加载安全兜底: 门控异常挂起时也能在超时后收起覆盖层
  splashFallbackTimer = setTimeout(hideSplash, SPLASH_FALLBACK_MS)

  // 5. 先等待认证门控完成, 门控结束后再建立实时连接 (SSE + WS)
  void bootstrapRealtime()
})

onUnmounted(() => {
  // 标记已卸载, 阻止门控 await 结束后再建立实时连接
  isUnmounted = true
  // 清理: 兜底定时器, auth fail 监听, WS 日志监听, 实时连接, 键盘快捷键
  if (splashFallbackTimer) {
    clearTimeout(splashFallbackTimer)
    splashFallbackTimer = null
  }
  offAuthFail(handleAuthFail)
  offTokenRefresh(handleTokenRefresh)
  rt.offWSMessage(wsLogHandler)
  rt.disconnect()
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
</style>
