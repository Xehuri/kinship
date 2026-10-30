/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SystemConfigField from '@/components/settings/SystemConfigField.vue'
import type { ConfigField } from '@/api/system'

function makeField(overrides: Partial<ConfigField> = {}): ConfigField {
  return {
    path: 'server.host',
    type: 'string',
    default: '0.0.0.0',
    sensitive: false,
    apply_strategy: 'hot',
    category: 'server',
    title: '监听地址',
    help: '服务监听地址；0.0.0.0 表示全部网卡。',
    deprecated: false,
    advanced: false,
    core: true,
    ...overrides,
  }
}

function mountField(
  field: ConfigField,
  modelValue: unknown,
  extra: { disabled?: boolean; error?: string } = {},
) {
  return mount(SystemConfigField, {
    props: { field, modelValue, ...extra },
  })
}

describe('SystemConfigField', () => {
  it('renders a boolean as a switch and emits the next value', async () => {
    const wrapper = mountField(
      makeField({
        path: 'ssl.enabled',
        type: 'bool',
        title: '启用 HTTPS',
        default: true,
      }),
      false,
    )

    const toggle = wrapper.get('[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(toggle.text()).toContain('启用 HTTPS')

    await toggle.trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true])
  })

  it('renders an enum as a select with schema options and emits the choice', async () => {
    const wrapper = mountField(
      makeField({
        path: 'ai_backend',
        type: 'enum',
        title: 'AI 后端',
        enum: ['opencode', 'loom'],
      }),
      'opencode',
    )

    const select = wrapper.get('select')
    expect(wrapper.findAll('option').map((option) => option.attributes('value'))).toEqual([
      'opencode',
      'loom',
    ])

    await select.setValue('loom')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['loom'])
  })

  it('renders int fields as number inputs with min/max and emits a number', async () => {
    const wrapper = mountField(
      makeField({
        path: 'server.https_port',
        type: 'int',
        title: 'HTTPS 端口',
        min: 1024,
        max: 65535,
      }),
      8768,
    )

    const input = wrapper.get('input[type="number"]')
    expect(input.attributes('min')).toBe('1024')
    expect(input.attributes('max')).toBe('65535')

    await input.setValue('9000')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([9000])
  })

  it('never renders a secret plaintext, shows the masked placeholder and emits clear', async () => {
    const plaintext = 'super-secret-token-value'
    const leaked = mountField(
      makeField({
        path: 'loom.token',
        type: 'secret',
        title: 'Loom Token',
        sensitive: true,
      }),
      plaintext,
    )

    expect(leaked.html()).not.toContain(plaintext)
    expect(leaked.get('input').attributes('type')).toBe('password')
    leaked.unmount()

    const masked = mountField(
      makeField({
        path: 'loom.token',
        type: 'secret',
        title: 'Loom Token',
        sensitive: true,
      }),
      '***',
    )

    const input = masked.get('input')
    expect(input.attributes('type')).toBe('password')
    expect(input.attributes('placeholder')).toBe('***')
    expect(masked.html()).not.toContain(plaintext)

    const clear = masked.get('.system-config-field__clear')
    expect(clear.text()).toBe('清除')
    await clear.trigger('click')

    expect(masked.emitted('clear')).toHaveLength(1)
  })

  it('renders list fields as JSON and only emits parsed valid values', async () => {
    const wrapper = mountField(
      makeField({
        path: 'audio.devices',
        type: 'list',
        title: '设备列表',
        default: [],
      }),
      ['cpu'],
    )

    const textarea = wrapper.get('textarea')
    expect(JSON.parse(textarea.element.value)).toEqual(['cpu'])

    await textarea.setValue('["cpu", "cuda"]')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['cpu', 'cuda']])

    const emitsBefore = wrapper.emitted('update:modelValue')?.length ?? 0
    await textarea.setValue('["cpu",')
    expect(wrapper.emitted('update:modelValue')?.length ?? 0).toBe(emitsBefore)
    expect(wrapper.text()).toContain('JSON')
  })

  it('renders string and path fields as text inputs', async () => {
    const wrapper = mountField(makeField(), '0.0.0.0')
    const input = wrapper.get('input[type="text"]')
    expect(input.element.value).toBe('0.0.0.0')

    await input.setValue('127.0.0.1')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['127.0.0.1'])
    wrapper.unmount()

    const pathWrapper = mountField(
      makeField({ path: 'data.dir', type: 'path', title: '数据目录' }),
      'ai/data',
    )
    expect(pathWrapper.get('input').classes()).toContain('system-config-field__input--path')
    expect(pathWrapper.text()).toContain('相对路径')
  })

  it('shows strategy, sensitivity and core/advanced badges and locks deployment fields', () => {
    const wrapper = mountField(
      makeField({
        path: 'launcher.opencode_cmd',
        type: 'path',
        title: 'OpenCode 命令',
        advanced: true,
        core: false,
        sensitive: true,
        apply_strategy: 'deployment',
      }),
      'opencode',
    )

    const text = wrapper.text()
    expect(text).toContain('高级')
    expect(text).toContain('敏感')
    expect(text).toContain('部署接线(只读)')
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  })
})
