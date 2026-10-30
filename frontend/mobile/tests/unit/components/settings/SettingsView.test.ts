/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

// ==================== Mocks ====================

const push = vi.hoisted(() => vi.fn())
const fetchPcSensorInfo = vi.hoisted(() => vi.fn())
const downloadPcSensor = vi.hoisted(() => vi.fn())
const fetchSourcesHealth = vi.hoisted(() => vi.fn())

const apiState = vi.hoisted(() => ({ isLoggedIn: null as { value: boolean } | null }))
const layoutState = vi.hoisted(() => ({ isPC: null as { value: boolean } | null }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@/components/shell/AppShell.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'AppShellStub',
      props: {
        title: { type: String, required: true },
        meta: { type: String, default: '' },
      },
      setup(props, { slots }) {
        return () =>
          h(
            'div',
            {
              class: 'appshell-stub',
              'data-title': props.title,
              'data-meta': props.meta,
            },
            slots.default ? slots.default() : [],
          )
      },
    }),
  }
})

vi.mock('@/composables/useApi', async () => {
  const { ref } = await import('vue')
  apiState.isLoggedIn = ref(true)
  return {
    useApi: () => ({
      isLoggedIn: apiState.isLoggedIn,
      logout: vi.fn(),
      changeCredentials: vi.fn(),
    }),
  }
})

vi.mock('@/composables/useLayout', async () => {
  const { ref } = await import('vue')
  layoutState.isPC = ref(false)
  return {
    useLayout: () => ({ isPC: layoutState.isPC }),
  }
})

vi.mock('@/api/downloads', () => ({
  fetchPcSensorInfo,
  downloadPcSensor,
}))

vi.mock('@/api/sources', () => ({
  fetchSourcesHealth,
}))

vi.mock('@/components/settings/MiHealthCard.vue', () => ({
  default: {
    name: 'MockMiHealthCard',
    template: '<div class="mi-health-mock" />',
  },
}))

vi.mock('@/components/settings/DebugPanel.vue', () => ({
  default: {
    name: 'MockDebugPanel',
    template: '<div class="debug-panel-mock" />',
  },
}))

const setupStatusState = vi.hoisted(() => ({
  refreshSetupStatus: vi.fn(),
}))

vi.mock('@/composables/useSetupStatus', () => ({
  useSetupStatus: () => ({
    refreshSetupStatus: setupStatusState.refreshSetupStatus,
  }),
}))

vi.mock('@/components/settings/ServicesPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'ServicesPanelStub',
      setup() {
        return () =>
          h(
            'section',
            { class: 'settings-section', 'data-services-panel-stub': '' },
            [h('h3', { class: 'settings-section__title' }, '服务状态')],
          )
      },
    }),
  }
})

vi.mock('@/components/settings/SettingsSystemConfig.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'SettingsSystemConfigStub',
      emits: ['open-onboarding'],
      setup(_, { emit }) {
        return () =>
          h(
            'section',
            { class: 'settings-section', 'data-system-config-stub': '' },
            [
              h('h3', { class: 'settings-section__title' }, '系统配置'),
              h(
                'button',
                {
                  type: 'button',
                  'data-action': 'open-onboarding',
                  onClick: () => emit('open-onboarding'),
                },
                '配置向导（测试模式）',
              ),
            ],
          )
      },
    }),
  }
})

vi.mock('@/components/onboarding/OnboardingWizard.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'OnboardingWizardStub',
      props: {
        visible: { type: Boolean, default: false },
        testMode: { type: Boolean, default: false },
      },
      emits: ['close', 'completed'],
      setup(props, { emit }) {
        return () =>
          h(
            'div',
            {
              class: 'onboarding-wizard-stub',
              'data-visible': String(props.visible),
              'data-test-mode': String(props.testMode),
            },
            [
              h('button', {
                type: 'button',
                'data-wizard-close': '',
                onClick: () => emit('close'),
              }),
              h('button', {
                type: 'button',
                'data-wizard-completed': '',
                onClick: () => emit('completed'),
              }),
            ],
          )
      },
    }),
  }
})

// ==================== Imports ====================

import SettingsView from '@/views/SettingsView.vue'
import { disposeTheme } from '@/composables/useTheme'
import { disposeTopInset } from '@/composables/useTopInset'

// ==================== Helpers ====================

const SOURCE_PAYLOAD = {
  ok: true,
  generatedAt: '2026-10-24T20:05:00+08:00',
  sources: [
    { id: 'phone_health', name: '手机健康数据', status: 'ok', last_sync: '2026-10-24T20:00:00+08:00', records: 48, detail: '' },
    { id: 'mi_cloud', name: '小米健康云', status: 'ok', last_sync: null, records: 20, detail: '' },
    { id: 'pc_sensor', name: 'PC 感知采集', status: 'stale', last_sync: null, records: 7, detail: '' },
    { id: 'realtime', name: '实时事件流', status: 'degraded', last_sync: null, records: null, detail: '' },
    { id: 'loom', name: 'Loom AI 后端', status: 'ok', last_sync: null, records: null, detail: '' },
    { id: 'files', name: '每日感知文件', status: 'offline', last_sync: null, records: null, detail: '' },
  ],
}

function mountSettingsView() {
  return mount(SettingsView, { global: { stubs: { teleport: true } } })
}

function sectionTitles(wrapper: ReturnType<typeof mountSettingsView>): string[] {
  return wrapper.findAll('.settings-section__title').map((node) => node.text())
}

function groupLabels(wrapper: ReturnType<typeof mountSettingsView>): string[] {
  return wrapper.findAll('.settings-group__label').map((node) => node.text())
}

function groupSectionTitles(wrapper: ReturnType<typeof mountSettingsView>): string[][] {
  return wrapper
    .findAll('.settings-group')
    .map((group) => group.findAll('.settings-section__title').map((node) => node.text()))
}

function row(wrapper: ReturnType<typeof mountSettingsView>, name: string) {
  return wrapper.find(`[data-setting-row="${name}"]`)
}

describe('SettingsView (v2 shell)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disposeTheme()
    disposeTopInset()
    localStorage.clear()
    for (const name of ['data-theme', 'data-accent', 'data-density', 'data-motion']) {
      document.documentElement.removeAttribute(name)
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        media: '(prefers-color-scheme: light)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    apiState.isLoggedIn!.value = true
    layoutState.isPC!.value = false
    fetchPcSensorInfo.mockResolvedValue(null)
    downloadPcSensor.mockResolvedValue(true)
    fetchSourcesHealth.mockResolvedValue(SOURCE_PAYLOAD)
    setupStatusState.refreshSetupStatus.mockReset()
    setupStatusState.refreshSetupStatus.mockResolvedValue(false)

    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    disposeTheme()
    disposeTopInset()
  })

  it('使用 AppShell 并传入标题与 meta', () => {
    const wrapper = mountSettingsView()
    const shell = wrapper.find('.appshell-stub')

    expect(shell.exists()).toBe(true)
    expect(shell.attributes('data-title')).toBe('设置')
    expect(shell.attributes('data-meta')).toBe('偏好与系统')
  })

  it('按分节渲染设置（移动端不含设备节）', () => {
    const wrapper = mountSettingsView()

    expect(sectionTitles(wrapper)).toEqual([
      '账户',
      '外观',
      '健康数据',
      '数据源',
      '调试',
      '关于',
      '系统配置',
      '服务状态',
    ])
  })

  it('PC 端共渲染 9 个设置分节', () => {
    layoutState.isPC!.value = true
    const wrapper = mountSettingsView()

    expect(sectionTitles(wrapper)).toHaveLength(9)
  })

  it('移动端渲染三个设置分组', () => {
    const wrapper = mountSettingsView()

    expect(wrapper.findAll('.settings-group')).toHaveLength(3)
  })

  it('分组标签依次为账户与偏好、数据与连接、系统与关于', () => {
    const wrapper = mountSettingsView()

    expect(groupLabels(wrapper)).toEqual(['账户与偏好', '数据与连接', '系统与关于'])
  })

  it('移动端按分组归属节次', () => {
    const wrapper = mountSettingsView()

    expect(groupSectionTitles(wrapper)).toEqual([
      ['账户', '外观'],
      ['健康数据', '数据源'],
      ['调试', '关于', '系统配置', '服务状态'],
    ])
  })

  it('PC 端设备节归入数据与连接分组', () => {
    layoutState.isPC!.value = true
    const wrapper = mountSettingsView()

    expect(groupSectionTitles(wrapper)).toEqual([
      ['账户', '外观'],
      ['健康数据', '数据源', '设备'],
      ['调试', '关于', '系统配置', '服务状态'],
    ])
  })

  it('健康数据节保留小米健康卡片且不再有报告/文件导航行', () => {
    const wrapper = mountSettingsView()

    expect(wrapper.find('.mi-health-mock').exists()).toBe(true)
    expect(row(wrapper, 'health-reports').exists()).toBe(false)
    expect(row(wrapper, 'health-files').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('报告入口')
  })

  it('数据源节渲染后端返回的六个来源', async () => {
    const wrapper = mountSettingsView()
    await flushPromises()

    expect(wrapper.findAll('.settings-source')).toHaveLength(6)
    expect(wrapper.text()).toContain('手机健康数据')
    expect(wrapper.text()).toContain('每日感知文件')
    expect(wrapper.text()).toContain('离线')
  })

  it('移动端不渲染设备节', () => {
    layoutState.isPC!.value = false
    const wrapper = mountSettingsView()

    expect(sectionTitles(wrapper)).not.toContain('设备')
    expect(row(wrapper, 'pc-sensor').exists()).toBe(false)
  })

  it('PC 端渲染设备节并显示采集端文件大小', async () => {
    layoutState.isPC!.value = true
    fetchPcSensorInfo.mockResolvedValue({
      exists: true,
      filename: 'Kinship-PCSensor.exe',
      size: 35566743,
      size_text: '33.9 MB',
      mtime: 0,
      sha256: null,
    })
    const wrapper = mountSettingsView()
    await flushPromises()

    expect(sectionTitles(wrapper)).toContain('设备')
    expect(row(wrapper, 'pc-sensor').text()).toContain('33.9 MB')
  })

  it('关于节保留 Kinship / 小贺 / 版本 / 运行环境', () => {
    const wrapper = mountSettingsView()

    expect(wrapper.text()).toContain('Kinship')
    expect(wrapper.text()).toContain('小贺')
    expect(wrapper.text()).toContain('v1.0.0')
    expect(row(wrapper, 'about-runtime').text()).toContain('运行环境')
    expect(row(wrapper, 'about-runtime').text()).toContain('移动 WebView')
  })

  it('调试节可展开调试面板覆盖层', async () => {
    const wrapper = mountSettingsView()

    expect(wrapper.find('.settings-debug-overlay').exists()).toBe(false)
    await row(wrapper, 'debug-panel').trigger('click')

    expect(wrapper.find('.settings-debug-overlay').exists()).toBe(true)
    expect(wrapper.find('.debug-panel-mock').exists()).toBe(true)
    expect(row(wrapper, 'debug-panel').attributes('aria-expanded')).toBe('true')
  })

  it('系统配置卡以测试模式打开向导, 关闭仅收起', async () => {
    const wrapper = mountSettingsView()
    const wizard = wrapper.findComponent({ name: 'OnboardingWizardStub' })

    expect(wizard.props('visible')).toBe(false)
    expect(wizard.props('testMode')).toBe(true)

    await wrapper.find('[data-action="open-onboarding"]').trigger('click')

    expect(wizard.props('visible')).toBe(true)
    expect(setupStatusState.refreshSetupStatus).not.toHaveBeenCalled()

    await wrapper.find('[data-wizard-close]').trigger('click')

    expect(wizard.props('visible')).toBe(false)
    expect(setupStatusState.refreshSetupStatus).not.toHaveBeenCalled()
  })

  it('向导完成后收起并刷新初始化状态, 不重载页面', async () => {
    const wrapper = mountSettingsView()
    const wizard = wrapper.findComponent({ name: 'OnboardingWizardStub' })

    await wrapper.find('[data-action="open-onboarding"]').trigger('click')
    await wrapper.find('[data-wizard-completed]').trigger('click')

    expect(wizard.props('visible')).toBe(false)
    expect(setupStatusState.refreshSetupStatus).toHaveBeenCalledTimes(1)
  })
})
