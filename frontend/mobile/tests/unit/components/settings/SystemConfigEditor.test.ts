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

interface RevisionConflictLike {
  code: string
  message: string
  currentRevision: string | null
}

interface MockState {
  snapshot: Ref<ConfigSnapshot | null>
  schema: Ref<SchemaResponse | null>
  loading: Ref<boolean>
  saving: Ref<boolean>
  error: Ref<{ message: string } | null>
  revisionConflict: Ref<RevisionConflictLike | null>
  lastApply: Ref<SaveConfigResult | null>
  load: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  validate: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => ({}) as MockState)

enableAutoUnmount(afterEach)

vi.mock('@/composables/useSystemConfig', async () => {
  const { computed, ref } = await import('vue')
  state.snapshot = ref<ConfigSnapshot | null>(null)
  state.schema = ref<SchemaResponse | null>(null)
  state.loading = ref(false)
  state.saving = ref(false)
  state.error = ref<{ message: string } | null>(null)
  state.revisionConflict = ref<RevisionConflictLike | null>(null)
  state.lastApply = ref<SaveConfigResult | null>(null)
  state.load = vi.fn().mockResolvedValue(undefined)
  state.reload = vi.fn().mockImplementation(async () => {
    state.revisionConflict.value = null
  })
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

import SystemConfigEditor from '@/components/settings/SystemConfigEditor.vue'

const CATEGORIES: ConfigCategory[] = [
  { id: 'server', title: '服务与端口', description: '监听地址与端口', advanced: false },
  { id: 'ai', title: 'AI 后端', description: '助手通道', advanced: false },
  { id: 'kernel', title: '音频内核', description: '推理设备', advanced: false },
  { id: 'launcher', title: '启动器', description: 'launcher.py 使用的命令', advanced: true },
]

function makeField(overrides: Partial<ConfigField> & Pick<ConfigField, 'path'>): ConfigField {
  return {
    type: 'string',
    default: '',
    sensitive: false,
    apply_strategy: 'hot',
    category: 'server',
    title: overrides.path,
    help: '',
    deprecated: false,
    advanced: false,
    core: false,
    ...overrides,
  }
}

const FIELDS: ConfigField[] = [
  makeField({
    path: 'server.host',
    type: 'string',
    category: 'server',
    title: '监听地址',
    help: '服务监听地址',
    core: true,
    default: '0.0.0.0',
  }),
  makeField({
    path: 'server.https_port',
    type: 'int',
    category: 'server',
    title: 'HTTPS 端口',
    help: 'App 与 Web 入口端口',
    core: true,
    default: 8768,
    min: 1024,
    max: 65535,
  }),
  makeField({
    path: 'ai_backend',
    type: 'enum',
    category: 'ai',
    title: 'AI 后端',
    enum: ['loom'],
    core: true,
    default: 'loom',
  }),
  makeField({
    path: 'loom.token',
    type: 'secret',
    category: 'ai',
    title: 'Loom Token',
    sensitive: true,
    core: true,
    default: '',
  }),
  makeField({
    path: 'kernel.nice',
    type: 'int',
    category: 'kernel',
    title: '内核 nice',
    advanced: true,
    default: 10,
  }),
  makeField({
    path: 'launcher.conda_python',
    type: 'path',
    category: 'launcher',
    title: 'Python 路径',
    advanced: true,
    apply_strategy: 'deployment',
    default: 'python',
  }),
]

function makeSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    revision: 'r1',
    path: 'config.yaml',
    provider: {
      kind: 'yaml',
      location: '/opt/kinship/config.yaml',
      writable: true,
      detail: '文件载体',
    },
    config: {
      server: { host: '0.0.0.0', https_port: 8768 },
      ai_backend: 'loom',
      loom: { token: '***' },
      kernel: { nice: 10 },
      launcher: { conda_python: 'python' },
    },
    degraded: ['tts: 回退到默认设备'],
    apply_failures: { 'kernel.nice': '内核忙，稍后重试' },
    schema_version: '1',
    ...overrides,
  }
}

function mountEditor(open = true) {
  return mount(SystemConfigEditor, {
    props: { open },
    global: { stubs: { teleport: true } },
  })
}

async function fillPassword(wrapper: ReturnType<typeof mountEditor>, value = 'pw-123456') {
  await wrapper.get('[data-config-password]').setValue(value)
}

async function submitSave(wrapper: ReturnType<typeof mountEditor>) {
  await wrapper.get('[data-config-save-form]').trigger('submit')
  await flushPromises()
}

describe('SystemConfigEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.snapshot.value = makeSnapshot()
    state.schema.value = { schema_version: '1', categories: CATEGORIES, fields: FIELDS }
    state.loading.value = false
    state.saving.value = false
    state.error.value = null
    state.revisionConflict.value = null
    state.lastApply.value = null
    state.save.mockReset().mockResolvedValue(null)
    state.reload.mockClear()
  })

  it('renders nothing while closed', () => {
    const wrapper = mountEditor(false)
    expect(wrapper.find('.system-config-overlay').exists()).toBe(false)
  })

  it('renders provider kind, location, writable state, revision, degraded list and failures', () => {
    const wrapper = mountEditor()
    const provider = wrapper.get('[data-config-provider]')

    expect(provider.text()).toContain('yaml')
    expect(provider.text()).toContain('/opt/kinship/config.yaml')
    expect(provider.text()).toContain('可写')
    expect(provider.text()).toContain('r1')
    expect(provider.text()).toContain('tts: 回退到默认设备')
    expect(provider.text()).toContain('kernel.nice')
    expect(provider.text()).toContain('内核忙，稍后重试')
  })

  it('starts with every category folded', () => {
    const wrapper = mountEditor()
    const groups = wrapper.findAll('[data-config-group]')

    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      expect((group.element as HTMLDetailsElement).open).toBe(false)
    }
  })

  it('renders core groups first and folds advanced fields until expanded', async () => {
    const wrapper = mountEditor()

    expect(wrapper.find('[data-field-path="server.host"]').exists()).toBe(true)
    expect(wrapper.find('[data-field-path="ai_backend"]').exists()).toBe(true)
    expect(wrapper.find('[data-field-path="launcher.conda_python"]').exists()).toBe(false)

    const toggle = wrapper.get('[data-config-advanced-toggle]')
    expect(toggle.attributes('aria-expanded')).toBe('false')

    await toggle.trigger('click')

    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-advanced-body]').exists()).toBe(true)
    const advancedGroups = wrapper.findAll(
      '[data-advanced-body] [data-config-group]',
    )
    expect(advancedGroups.length).toBeGreaterThan(0)
    for (const group of advancedGroups) {
      expect((group.element as HTMLDetailsElement).open).toBe(false)
    }
    expect(wrapper.find('[data-field-path="launcher.conda_python"]').exists()).toBe(true)

    const deploymentInput = wrapper.get('[data-field-path="launcher.conda_python"] input')
    expect(deploymentInput.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-field-path="launcher.conda_python"]').text()).toContain(
      '部署接线(只读)',
    )
  })

  it('filters fields by search, including folded advanced fields', async () => {
    const wrapper = mountEditor()
    const search = wrapper.get('[data-config-search]')

    await search.setValue('端口')

    expect(wrapper.find('[data-field-path="server.https_port"]').exists()).toBe(true)
    expect(wrapper.find('[data-field-path="server.host"]').exists()).toBe(false)

    await search.setValue('Python')

    expect(wrapper.find('[data-field-path="launcher.conda_python"]').exists()).toBe(true)
    expect(wrapper.find('[data-field-path="server.https_port"]').exists()).toBe(false)
  })

  it('saves only the dirty fields with the current password', async () => {
    const wrapper = mountEditor()

    await wrapper.get('[data-field-path="server.host"] input').setValue('127.0.0.1')
    await fillPassword(wrapper)
    await submitSave(wrapper)

    expect(state.save).toHaveBeenCalledTimes(1)
    expect(state.save).toHaveBeenCalledWith({
      currentPassword: 'pw-123456',
      changes: { 'server.host': '127.0.0.1' },
      clearKeys: [],
    })
  })

  it('sends clear_keys when a masked secret is explicitly cleared', async () => {
    const wrapper = mountEditor()

    await wrapper.get('[data-field-path="loom.token"] .system-config-field__clear').trigger('click')
    await fillPassword(wrapper)
    await submitSave(wrapper)

    expect(state.save).toHaveBeenCalledWith({
      currentPassword: 'pw-123456',
      changes: {},
      clearKeys: ['loom.token'],
    })
  })

  it('requires the current password before calling the API', async () => {
    const wrapper = mountEditor()

    await wrapper.get('[data-field-path="server.host"] input').setValue('127.0.0.1')
    await submitSave(wrapper)

    expect(state.save).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请输入当前密码')
  })

  it('shows the reload action on a 409 revision conflict', async () => {
    state.save.mockImplementation(async () => {
      state.revisionConflict.value = {
        code: 'revision_conflict',
        message: '配置版本已被其他会话更新',
        currentRevision: 'r2',
      }
      return null
    })

    const wrapper = mountEditor()
    await wrapper.get('[data-field-path="server.host"] input').setValue('127.0.0.1')
    await fillPassword(wrapper)
    await submitSave(wrapper)

    expect(wrapper.text()).toContain('配置版本已被其他会话更新')

    await wrapper.get('[data-config-reload]').trigger('click')
    await flushPromises()

    expect(state.reload).toHaveBeenCalledTimes(1)
  })

  it('displays applied, failed and degraded results and keeps the editor open', async () => {
    state.save.mockResolvedValue({
      ok: true,
      revision: 'r2',
      changed: ['server.host'],
      applied: ['server.host'],
      failed: { 'kernel.nice': '内核忙' },
      degraded: ['tts'],
      dry_run: false,
    } satisfies SaveConfigResult)

    const wrapper = mountEditor()
    await wrapper.get('[data-field-path="server.host"] input').setValue('127.0.0.1')
    await fillPassword(wrapper)
    await submitSave(wrapper)

    const result = wrapper.get('[data-config-result]')
    expect(result.text()).toContain('已写入 1 个字段')
    expect(result.text()).toContain('热应用 1 个分组')
    expect(result.text()).toContain('失败 1 组')
    expect(result.text()).toContain('降级 1 项')
    expect(result.text()).toContain('内核忙')
    expect(wrapper.find('.system-config-overlay').exists()).toBe(true)
  })

  it('warns and disables saving when the provider is read-only', async () => {
    state.snapshot.value = makeSnapshot({
      provider: {
        kind: 'env',
        location: 'environment',
        writable: false,
        detail: '环境变量载体',
      },
    })

    const wrapper = mountEditor()

    expect(wrapper.text()).toContain('当前载体只读')
    expect(wrapper.get('[data-config-save]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-field-path="server.host"] input').attributes('disabled')).toBeDefined()
  })

  it('closes on Escape', async () => {
    const wrapper = mountEditor()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
