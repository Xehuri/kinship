/// <reference types="vitest/globals" />

/**
 * App.vue 启动引导测试 (修复 A3 认证门控竞态)
 *
 * 验证:
 *   1. 认证门控 (refreshSetupStatus + 登录判定) 完成前不调用 useChatIntegration(),
 *      即不会提前建立 SSE/WS;
 *   2. 门控完成后隐藏启动加载覆盖层;
 *   3. 门控挂起时由安全兜底超时隐藏覆盖层;
 *   4. 401 (handleAuthFail) 时清除 token、置 isLoggedIn=false 并弹出登录覆盖层;
 *   5. v2-only 壳层: 只渲染 router-view 与全局抽屉, 无旧导航/浮动按钮;
 *   6. Ctrl+1~6 按桌面导航顺序跳转。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Ref } from 'vue'

// ==================== Hoisted Mocks ====================

const mocks = vi.hoisted(() => {
  return {
    onAuthFail: vi.fn(),
    offAuthFail: vi.fn(),
    onTokenRefresh: vi.fn(),
    offTokenRefresh: vi.fn(),
    logout: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    // 真 ref 在 vi.mock 工厂里创建 (watch 需要真实响应式)
    currentRoute: null as unknown as Ref<{ path: string }>,
    isLoggedIn: null as unknown as Ref<boolean>,
    needsSetup: null as unknown as Ref<boolean>,
    setupStatusError: null as unknown as Ref<boolean>,
    onboardingComplete: null as unknown as Ref<boolean>,
    configDegraded: null as unknown as Ref<boolean>,
    onboardingKnown: null as unknown as Ref<boolean>,
    onboardingPhase1Complete: null as unknown as Ref<boolean>,
    refreshSetupStatus: vi.fn(),
    useChatIntegration: vi.fn(),
    rt: {
      onWSMessage: vi.fn(),
      offWSMessage: vi.fn(),
      disconnect: vi.fn(),
      reconnectSSE: vi.fn(),
      reconnectWS: vi.fn(),
    },
  }
})

vi.mock('@/composables/useApi', async () => {
  const { ref } = await import('vue')
  mocks.isLoggedIn = ref(false)
  return {
    useApi: () => ({
      isLoggedIn: mocks.isLoggedIn,
      onAuthFail: mocks.onAuthFail,
      offAuthFail: mocks.offAuthFail,
      onTokenRefresh: mocks.onTokenRefresh,
      offTokenRefresh: mocks.offTokenRefresh,
      logout: mocks.logout,
      login: vi.fn(),
    }),
  }
})

vi.mock('@/composables/useSetupStatus', async () => {
  const { ref } = await import('vue')
  mocks.needsSetup = ref(false)
  mocks.setupStatusError = ref(false)
  mocks.onboardingComplete = ref(true)
  mocks.configDegraded = ref(false)
  mocks.onboardingKnown = ref(false)
  mocks.onboardingPhase1Complete = ref(false)
  return {
    useSetupStatus: () => ({
      needsSetup: mocks.needsSetup,
      setupStatusError: mocks.setupStatusError,
      onboardingComplete: mocks.onboardingComplete,
      configDegraded: mocks.configDegraded,
      onboardingKnown: mocks.onboardingKnown,
      onboardingPhase1Complete: mocks.onboardingPhase1Complete,
      refreshSetupStatus: mocks.refreshSetupStatus,
    }),
  }
})

vi.mock('@/composables/useChatIntegration', () => ({
  useChatIntegration: mocks.useChatIntegration,
}))

vi.mock('@/composables/useRealTime', () => ({
  useRealTimeSingleton: () => mocks.rt,
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiGet: vi.fn().mockResolvedValue(null),
  apiPost: vi.fn().mockResolvedValue(null),
  apiDelete: vi.fn().mockResolvedValue(null),
}))

vi.mock('vue-router', async () => {
  const { ref } = await import('vue')
  mocks.currentRoute = ref({ path: '/chat' })
  return {
    useRouter: () => ({
      push: mocks.push,
      replace: mocks.replace,
      currentRoute: mocks.currentRoute,
    }),
  }
})

// 轻量子组件替身, 避免引入重型依赖 (markdown/katex/mermaid 等)
vi.mock('@/components/common/SplashLoading.vue', () => ({
  default: { name: 'SplashLoading', props: ['visible', 'text'], template: '<div class="splash" />' },
}))
vi.mock('@/components/common/LoginOverlay.vue', () => ({
  default: { name: 'LoginOverlay', props: ['visible'], template: '<div class="login" />' },
}))
vi.mock('@/components/common/SetupOverlay.vue', () => ({
  default: { name: 'SetupOverlay', props: ['visible'], template: '<div class="setup" />' },
}))
vi.mock('@/components/onboarding/OnboardingWizard.vue', () => ({
  default: {
    name: 'OnboardingWizard',
    props: {
      visible: { type: Boolean, default: false },
      testMode: { type: Boolean, default: false },
    },
    emits: ['close', 'completed'],
    template: '<div class="onboarding-wizard" />',
  },
}))
vi.mock('@/components/notifications/NotificationsDrawer.vue', () => ({
  default: {
    name: 'NotificationsDrawer',
    props: ['visible', 'notifications', 'total', 'state', 'deletingId'],
    template: '<div class="notif-drawer" />',
  },
}))
vi.mock('@/components/notifications/WsLogDrawer.vue', () => ({
  default: { name: 'WsLogDrawer', template: '<div class="ws-log-drawer-stub" />' },
}))

import App from '@/App.vue'
import { useNotificationsSingleton } from '@/composables/useNotifications'
import { resetWsLog, useWsLog } from '@/composables/useWsLog'

// ==================== 辅助 ====================

/** 挂载 App, 屏蔽 router-view (未安装 vue-router 插件) */
function mountApp() {
  return mount(App, {
    global: {
      stubs: { RouterView: true },
    },
  })
}

describe('App.vue 启动引导 (认证门控竞态)', () => {
  beforeEach(() => {
    mocks.isLoggedIn.value = false
    mocks.needsSetup.value = false
    mocks.setupStatusError.value = false
    mocks.onboardingComplete.value = true
    mocks.configDegraded.value = false
    mocks.onboardingKnown.value = false
    mocks.onboardingPhase1Complete.value = false
    useNotificationsSingleton().close()
    resetWsLog()
    vi.clearAllMocks()
    mocks.currentRoute.value = { path: '/chat' }
    mocks.refreshSetupStatus.mockReset()
    mocks.refreshSetupStatus.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('门控完成前不建立 SSE/WS, 门控完成后才调用 useChatIntegration', async () => {
    let resolveGate: (v: boolean) => void = () => {}
    mocks.refreshSetupStatus.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveGate = resolve }),
    )

    const wrapper = mountApp()
    await flushPromises()

    // 门控仍挂起: 绝不能建立实时连接
    expect(mocks.refreshSetupStatus).toHaveBeenCalledTimes(1)
    expect(mocks.useChatIntegration).not.toHaveBeenCalled()

    // 门控完成
    resolveGate(false)
    await flushPromises()

    expect(mocks.useChatIntegration).toHaveBeenCalledTimes(1)

    // 门控完成前 splash 可见, 完成后隐藏
    const splash = wrapper.findComponent({ name: 'SplashLoading' })
    expect(splash.props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('门控挂起时安全兜底超时也会隐藏 splash (且不建立连接)', async () => {
    vi.useFakeTimers()
    mocks.refreshSetupStatus.mockImplementation(() => new Promise<boolean>(() => {}))

    const wrapper = mountApp()

    const splash = wrapper.findComponent({ name: 'SplashLoading' })
    expect(splash.props('visible')).toBe(true)

    // 推进兜底超时
    vi.advanceTimersByTime(3000)
    await nextTick()
    await nextTick()

    expect(splash.props('visible')).toBe(false)
    // 兜底只是隐藏 splash, 不应越过门控建立连接
    expect(mocks.useChatIntegration).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('401 触发 handleAuthFail 时清除 token (logout) 并弹出登录覆盖层', async () => {
    // 已登录: 门控不会主动弹登录框, 便于隔离 handleAuthFail 行为
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    // 取出 onMounted 注册的 auth fail 回调并触发
    const handler = mocks.onAuthFail.mock.calls[0]?.[0] as (() => void) | undefined
    expect(handler).toBeTypeOf('function')
    handler?.()

    await flushPromises()

    expect(mocks.logout).toHaveBeenCalledTimes(1)
    const login = wrapper.findComponent({ name: 'LoginOverlay' })
    expect(login.props('visible')).toBe(true)

    wrapper.unmount()
  })

  it('后端不可达 (setupStatusError) 时不当成已初始化, 仍走登录流程', async () => {
    mocks.refreshSetupStatus.mockImplementation(async () => {
      mocks.setupStatusError.value = true
      mocks.needsSetup.value = false
      return false
    })

    const wrapper = mountApp()
    await flushPromises()

    const login = wrapper.findComponent({ name: 'LoginOverlay' })
    const setup = wrapper.findComponent({ name: 'SetupOverlay' })
    expect(login.props('visible')).toBe(true)
    expect(setup.props('visible')).toBe(false)
    expect(mocks.useChatIntegration).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('v2-only: 只渲染 router-view 与全局抽屉, 无旧壳层或浮动按钮', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'RouterView' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'NotificationsDrawer' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'WsLogDrawer' }).exists()).toBe(true)
    expect(wrapper.find('[data-testid="notifications-trigger"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="WS 日志"]').exists()).toBe(false)
    expect(wrapper.find('.pc-container').exists()).toBe(false)
    expect(wrapper.find('.app-content').exists()).toBe(false)

    wrapper.unmount()
  })

  it('注册 WS 日志处理器并在卸载时注销', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    const handler = mocks.rt.onWSMessage.mock.calls[0]?.[0] as (data: unknown) => void
    expect(handler).toBeTypeOf('function')
    expect(handler).toBe(useWsLog().handler)

    wrapper.unmount()
    expect(mocks.rt.offWSMessage).toHaveBeenCalledWith(handler)
  })

  it('Ctrl+1~6 按桌面导航顺序跳转', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    const cases: Array<[string, string]> = [
      ['1', '/chat'],
      ['2', '/plan'],
      ['3', '/reminders'],
      ['4', '/reports'],
      ['5', '/files'],
      ['6', '/settings'],
    ]
    for (const [key, route] of cases) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true }))
      expect(mocks.push).toHaveBeenLastCalledWith(route)
    }

    wrapper.unmount()
  })

  it('保留登录/初始化覆盖层, 并渲染全局通知抽屉', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'NotificationsDrawer' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)
    expect(wrapper.findComponent({ name: 'SetupOverlay' }).props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('需要首次初始化时打开真实向导并隐藏 SetupOverlay/LoginOverlay', async () => {
    mocks.needsSetup.value = true
    mocks.isLoggedIn.value = false
    mocks.refreshSetupStatus.mockImplementation(async () => {
      mocks.needsSetup.value = true
      return true
    })

    const wrapper = mountApp()
    await flushPromises()

    const wizard = wrapper.findComponent({ name: 'OnboardingWizard' })
    expect(wizard.props('visible')).toBe(true)
    expect(wizard.props('testMode')).toBe(false)
    expect(wrapper.findComponent({ name: 'SetupOverlay' }).props('visible')).toBe(false)
    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('已登录且引导未完成时自动打开向导', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockImplementation(async () => {
      mocks.onboardingKnown.value = true
      mocks.onboardingComplete.value = false
      return false
    })

    const wrapper = mountApp()
    await flushPromises()

    const wizard = wrapper.findComponent({ name: 'OnboardingWizard' })
    expect(wizard.props('visible')).toBe(true)
    expect(wizard.props('testMode')).toBe(false)
    expect(wrapper.findComponent({ name: 'SetupOverlay' }).props('visible')).toBe(false)
    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('阶段 1 完成后即使引导未完成也不再自动打开向导', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockImplementation(async () => {
      mocks.onboardingKnown.value = true
      mocks.onboardingComplete.value = false
      mocks.onboardingPhase1Complete.value = true
      return false
    })

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'OnboardingWizard' }).props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('旧安装 (引导已完成) 不自动打开向导', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockImplementation(async () => {
      mocks.onboardingKnown.value = true
      mocks.onboardingComplete.value = true
      return false
    })

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'OnboardingWizard' }).props('visible')).toBe(false)
    expect(wrapper.findComponent({ name: 'SetupOverlay' }).props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('已配置安装正常登录时不打开任何引导层', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'OnboardingWizard' }).props('visible')).toBe(false)
    expect(wrapper.findComponent({ name: 'SetupOverlay' }).props('visible')).toBe(false)
    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('配置降级且已登录时自动打开向导', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockImplementation(async () => {
      mocks.onboardingKnown.value = true
      mocks.onboardingComplete.value = false
      mocks.configDegraded.value = true
      return false
    })

    const wrapper = mountApp()
    await flushPromises()

    expect(wrapper.findComponent({ name: 'OnboardingWizard' }).props('visible')).toBe(true)

    wrapper.unmount()
  })

  it('向导完成后收起、刷新初始化状态并跳转到对话页', async () => {
    mocks.needsSetup.value = true
    mocks.refreshSetupStatus.mockResolvedValue(true)
    mocks.currentRoute.value = { path: '/settings' }

    const wrapper = mountApp()
    await flushPromises()

    const wizard = wrapper.findComponent({ name: 'OnboardingWizard' })
    expect(wizard.props('visible')).toBe(true)

    mocks.refreshSetupStatus.mockClear()
    await wizard.vm.$emit('completed')
    await flushPromises()

    expect(wizard.props('visible')).toBe(false)
    expect(mocks.refreshSetupStatus).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith('/chat')

    wrapper.unmount()
  })

  it('完成向导后清除初始门控遗留的登录层', async () => {
    mocks.needsSetup.value = true
    mocks.isLoggedIn.value = false
    mocks.refreshSetupStatus.mockResolvedValue(true)

    const wrapper = mountApp()
    await flushPromises()
    const wizard = wrapper.findComponent({ name: 'OnboardingWizard' })
    expect(wizard.props('visible')).toBe(true)

    mocks.isLoggedIn.value = true
    mocks.needsSetup.value = false
    await flushPromises()
    await wizard.vm.$emit('completed')
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)

    wrapper.unmount()
  })

  it('已在对话页时完成向导不重复 replace', async () => {
    mocks.needsSetup.value = true
    mocks.refreshSetupStatus.mockResolvedValue(true)
    mocks.currentRoute.value = { path: '/chat' }

    const wrapper = mountApp()
    await flushPromises()

    await wrapper.findComponent({ name: 'OnboardingWizard' }).vm.$emit('completed')
    await flushPromises()

    expect(mocks.replace).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('401 后 overlay 可见, wasLoggedIn=false 刷新时关闭 overlay 并重连', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    const authFail = mocks.onAuthFail.mock.calls[0]?.[0] as (() => void) | undefined
    authFail?.()
    await flushPromises()
    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(true)

    const refresh = mocks.onTokenRefresh.mock.calls[0]?.[0] as
      | ((payload: { token: string; wasLoggedIn: boolean }) => void)
      | undefined
    expect(refresh).toBeTypeOf('function')
    refresh?.({ token: 'new-token', wasLoggedIn: false })
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)
    expect(mocks.rt.reconnectSSE).toHaveBeenCalledTimes(1)
    expect(mocks.rt.reconnectWS).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('已登录且无 overlay 时 wasLoggedIn=true 刷新不重连', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    const refresh = mocks.onTokenRefresh.mock.calls[0]?.[0] as
      | ((payload: { token: string; wasLoggedIn: boolean }) => void)
      | undefined
    refresh?.({ token: 'new-token', wasLoggedIn: true })
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)
    expect(mocks.rt.reconnectSSE).not.toHaveBeenCalled()
    expect(mocks.rt.reconnectWS).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('overlay 可见时 wasLoggedIn=true 刷新关闭 overlay 并重连', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    const authFail = mocks.onAuthFail.mock.calls[0]?.[0] as (() => void) | undefined
    authFail?.()
    await flushPromises()
    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(true)

    const refresh = mocks.onTokenRefresh.mock.calls[0]?.[0] as
      | ((payload: { token: string; wasLoggedIn: boolean }) => void)
      | undefined
    refresh?.({ token: 'new-token', wasLoggedIn: true })
    await flushPromises()

    expect(wrapper.findComponent({ name: 'LoginOverlay' }).props('visible')).toBe(false)
    expect(mocks.rt.reconnectSSE).toHaveBeenCalledTimes(1)
    expect(mocks.rt.reconnectWS).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('卸载时注销 token 刷新监听', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()

    const registered = mocks.onTokenRefresh.mock.calls[0]?.[0]
    expect(registered).toBeTypeOf('function')

    wrapper.unmount()
    expect(mocks.offTokenRefresh).toHaveBeenCalledWith(registered)
  })

  it('登录成功后刷新引导状态, 认证后可见未完成向导', async () => {
    mocks.isLoggedIn.value = true
    mocks.refreshSetupStatus.mockResolvedValue(false)

    const wrapper = mountApp()
    await flushPromises()
    expect(mocks.refreshSetupStatus).toHaveBeenCalledTimes(1)

    await wrapper
      .findComponent({ name: 'LoginOverlay' })
      .vm.$emit('login-success', 'new-token')
    await flushPromises()

    expect(mocks.refreshSetupStatus).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })

  it('首次初始化成功后刷新引导状态', async () => {
    mocks.needsSetup.value = true
    mocks.isLoggedIn.value = false
    mocks.refreshSetupStatus.mockResolvedValue(true)

    const wrapper = mountApp()
    await flushPromises()

    await wrapper
      .findComponent({ name: 'SetupOverlay' })
      .vm.$emit('setup-success', 'new-token')
    await flushPromises()

    expect(mocks.refreshSetupStatus).toHaveBeenCalledTimes(2)
    expect(mocks.needsSetup.value).toBe(false)

    wrapper.unmount()
  })
})
