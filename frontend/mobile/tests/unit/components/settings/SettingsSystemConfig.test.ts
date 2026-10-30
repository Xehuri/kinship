/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type {
  ConfigCategory,
  ConfigField,
  ConfigSnapshot,
  SaveConfigResult,
  SchemaResponse,
} from '@/api/system'

interface MockState {
  snapshot: Ref<ConfigSnapshot | null>
  schema: Ref<SchemaResponse | null>
  loading: Ref<boolean>
  saving: Ref<boolean>
  error: Ref<{ message: string } | null>
  revisionConflict: Ref<unknown>
  lastApply: Ref<SaveConfigResult | null>
  load: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  validate: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => ({}) as MockState)
const apiState = vi.hoisted(
  () => ({ isLoggedIn: null as Ref<boolean> | null }),
)

enableAutoUnmount(afterEach)

vi.mock('@/composables/useApi', async () => {
  const { ref } = await import('vue')
  apiState.isLoggedIn = ref(true)
  return {
    useApi: () => ({ isLoggedIn: apiState.isLoggedIn }),
  }
})

vi.mock('@/composables/useSystemConfig', async () => {
  const { computed, ref } = await import('vue')
  state.snapshot = ref<ConfigSnapshot | null>(null)
  state.schema = ref<SchemaResponse | null>(null)
  state.loading = ref(false)
  state.saving = ref(false)
  state.error = ref<{ message: string } | null>(null)
  state.revisionConflict = ref<unknown>(null)
  state.lastApply = ref<SaveConfigResult | null>(null)
  state.load = vi.fn().mockResolvedValue(undefined)
  state.reload = vi.fn().mockResolvedValue(undefined)
  state.validate = vi.fn().mockResolvedValue(null)
  state.save = vi.fn().mockResolvedValue(null)
  state.restart = vi.fn().mockResolvedValue(null)

  const status = computed(() =>
    state.snapshot.value
      ? {
          revision: state.snapshot.value.revision,
          writable: state.snapshot.value.provider.writable,
          degraded: state.snapshot.value.degraded,
          apply_failures: state.snapshot.value.apply_failures,
        }
      : null,
  )

  return {
    useSystemConfig: () => ({
      snapshot: state.snapshot,
      schema: state.schema,
      status,
      loading: state.loading,
      saving: state.saving,
      error: state.error,
      revisionConflict: state.revisionConflict,
      lastApply: state.lastApply,
      load: state.load,
      reload: state.reload,
      validate: state.validate,
      save: state.save,
      restart: state.restart,
    }),
  }
})

import SettingsSystemConfig from '@/components/settings/SettingsSystemConfig.vue'

const CATEGORY: ConfigCategory = {
  id: 'server',
  title: '服务与端口',
  description: '监听地址与端口',
  advanced: false,
}

const FIELD: ConfigField = {
  path: 'server.host',
  type: 'string',
  default: '0.0.0.0',
  sensitive: false,
  apply_strategy: 'hot',
  category: 'server',
  title: '监听地址',
  help: '',
  deprecated: false,
  advanced: false,
  core: true,
}

function makeSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    revision: 'rev-7',
    path: 'config.yaml',
    provider: {
      kind: 'yaml',
      location: '/opt/kinship/config.yaml',
      writable: true,
      detail: '文件载体',
    },
    config: { server: { host: '0.0.0.0' } },
    degraded: ['tts: 回退到默认设备'],
    apply_failures: { 'kernel.nice': '内核忙' },
    schema_version: '1',
    ...overrides,
  }
}

function mountCard() {
  return mount(SettingsSystemConfig, {
    global: { stubs: { teleport: true } },
  })
}

describe('SettingsSystemConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (apiState.isLoggedIn) apiState.isLoggedIn.value = true
    state.snapshot.value = makeSnapshot()
    state.schema.value = {
      schema_version: '1',
      categories: [CATEGORY],
      fields: [FIELD],
    }
    state.loading.value = false
    state.saving.value = false
    state.error.value = null
    state.revisionConflict.value = null
    state.lastApply.value = null
    state.load.mockClear()
    state.save.mockClear()
  })

  it('loads the config on mount without blocking rendering', async () => {
    const wrapper = mountCard()

    await flushPromises()

    expect(state.load).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('系统配置')
  })

  it('renders provider, revision, degraded and apply-failure summaries', () => {
    const wrapper = mountCard()
    const provider = wrapper.get('[data-setting-row="system-config-provider"]')

    expect(provider.text()).toContain('yaml')
    expect(provider.text()).toContain('/opt/kinship/config.yaml')
    expect(wrapper.get('[data-setting-row="system-config-revision"]').text()).toContain('rev-7')
    expect(wrapper.get('[data-setting-row="system-config-degraded"]').text()).toContain('1')
    expect(wrapper.get('[data-setting-row="system-config-failures"]').text()).toContain('1')
  })

  it('truncates a long revision in the card and keeps the full value in title', () => {
    const full = '1792955514686887412-1280-abcdef123456+env-abcdef123456'
    state.snapshot.value = {
      ...state.snapshot.value,
      revision: full,
    }

    const wrapper = mountCard()
    const value = wrapper.get('[data-system-config-revision]')

    expect(value.text().length).toBeLessThan(full.length)
    expect(value.attributes('title')).toBe(full)
  })

  it('opens the full config editor from the card', async () => {
    const wrapper = mountCard()

    expect(wrapper.find('.system-config-overlay').exists()).toBe(false)

    await wrapper.get('[data-action="edit-config"]').trigger('click')

    expect(wrapper.find('.system-config-overlay').exists()).toBe(true)
    expect(wrapper.find('[data-config-password]').exists()).toBe(true)
  })

  it('emits open-onboarding from the test-mode wizard entry', async () => {
    const wrapper = mountCard()

    await wrapper.get('[data-action="open-onboarding"]').trigger('click')

    expect(wrapper.emitted('open-onboarding')).toHaveLength(1)
  })

  it('shows the read-only carrier state and disables editing', () => {
    state.snapshot.value = makeSnapshot({
      provider: {
        kind: 'env',
        location: 'environment',
        writable: false,
        detail: '环境变量载体',
      },
    })

    const wrapper = mountCard()

    expect(wrapper.text()).toContain('当前载体只读')
    expect(wrapper.get('[data-action="edit-config"]').attributes('disabled')).toBeDefined()
  })

  it('hides config data and edit actions when logged out', () => {
    if (apiState.isLoggedIn) apiState.isLoggedIn.value = false

    const wrapper = mountCard()

    expect(wrapper.find('[data-setting-row="system-config-provider"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="edit-config"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="open-onboarding"]').exists()).toBe(false)
  })

  it('keeps the card rendered when loading fails', () => {
    state.snapshot.value = null
    state.error.value = { message: '配置服务不可用' }

    const wrapper = mountCard()

    expect(wrapper.text()).toContain('配置服务不可用')
    expect(wrapper.get('[data-action="edit-config"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-action="open-onboarding"]').exists()).toBe(true)
  })
})
