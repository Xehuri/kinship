/// <reference types="vitest/globals" />

import { describe, it, expect } from 'vitest'
import { h } from 'vue'
import { mount } from '@vue/test-utils'
import FormField from '@/components/settings/form/FormField.vue'
import FormToggle from '@/components/settings/form/FormToggle.vue'
import FormSelect from '@/components/settings/form/FormSelect.vue'

describe('FormField', () => {
  it('links the label and description ids to the slotted control', () => {
    const wrapper = mount(FormField, {
      props: {
        fieldId: 'api-port',
        label: '端口',
        hint: '本地监听端口',
        error: '必须为数字',
        required: true,
      },
      slots: {
        default: '<input id="api-port" />',
      },
    })

    expect(wrapper.find('label').attributes('for')).toBe('api-port')
    expect(wrapper.find('#api-port-hint').text()).toBe('本地监听端口')
    expect(wrapper.find('#api-port-error').text()).toBe('必须为数字')

    const input = wrapper.find('input')
    expect(input.attributes('aria-describedby')).toBe('api-port-hint api-port-error')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-required')).toBe('true')
  })

  it('leaves description ids off when no hint or error is set', () => {
    const wrapper = mount(FormField, {
      props: { fieldId: 'api-host', label: '地址' },
      slots: { default: '<input id="api-host" />' },
    })

    const input = wrapper.find('input')
    expect(input.attributes('aria-describedby')).toBeUndefined()
    expect(input.attributes('aria-invalid')).toBeUndefined()
    expect(input.attributes('aria-required')).toBeUndefined()
    expect(wrapper.find('.ax-form-field__required').exists()).toBe(false)
  })

  it('exposes the field state to scoped slots', () => {
    const wrapper = mount(FormField, {
      props: {
        fieldId: 'api-mode',
        label: '模式',
        hint: '帮助',
        error: '错误',
      },
      slots: {
        default: (slotProps: {
          fieldId: string
          describedBy?: string
          invalid: boolean
        }) =>
          h('input', {
            id: slotProps.fieldId,
            'aria-describedby': slotProps.describedBy,
            'data-invalid': String(slotProps.invalid),
          }),
      },
    })

    const input = wrapper.find('input')
    expect(input.attributes('aria-describedby')).toBe('api-mode-hint api-mode-error')
    expect(input.attributes('data-invalid')).toBe('true')
  })
})

describe('FormToggle', () => {
  it('renders a switch and flips aria-checked while emitting the next value', async () => {
    const wrapper = mount(FormToggle, {
      props: {
        modelValue: false,
        label: '自动重启',
        hint: '保存后重启服务',
        fieldId: 'auto-restart',
      },
    })

    const button = wrapper.find('button')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('role')).toBe('switch')
    expect(button.attributes('aria-checked')).toBe('false')
    expect(button.attributes('aria-labelledby')).toBe('auto-restart-label')
    expect(button.attributes('aria-describedby')).toBe('auto-restart-hint')
    expect(wrapper.find('#auto-restart-label').text()).toBe('自动重启')

    await button.trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true])
    expect(button.attributes('aria-checked')).toBe('true')
  })

  it('does not emit or flip when disabled', async () => {
    const wrapper = mount(FormToggle, {
      props: {
        modelValue: false,
        label: '自动重启',
        fieldId: 'auto-restart',
        disabled: true,
      },
    })

    const button = wrapper.find('button')
    expect(button.attributes('disabled')).toBeDefined()

    await button.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(button.attributes('aria-checked')).toBe('false')
  })

  it('follows external model updates', async () => {
    const wrapper = mount(FormToggle, {
      props: { modelValue: false, label: '自动重启', fieldId: 'auto-restart' },
    })

    await wrapper.setProps({ modelValue: true })

    expect(wrapper.find('button').attributes('aria-checked')).toBe('true')
    expect(wrapper.find('button').attributes('aria-describedby')).toBeUndefined()
  })
})

describe('FormSelect', () => {
  const options = [
    { value: 'off', label: '关闭' },
    { value: 'auto', label: '自动' },
  ]

  it('renders options, links the label, and emits the selected string', async () => {
    const wrapper = mount(FormSelect, {
      props: {
        modelValue: 'off',
        options,
        label: '同步模式',
        hint: '选择数据同步方式',
        fieldId: 'sync-mode',
      },
    })

    const select = wrapper.find('select')
    expect(wrapper.find('label').attributes('for')).toBe('sync-mode')
    expect(select.attributes('id')).toBe('sync-mode')
    expect(select.attributes('aria-describedby')).toBe('sync-mode-hint')
    expect(select.attributes('aria-invalid')).toBeUndefined()

    const renderedOptions = wrapper.findAll('option')
    expect(renderedOptions.map((option) => option.text())).toEqual(['关闭', '自动'])
    expect(renderedOptions.map((option) => option.attributes('value'))).toEqual(['off', 'auto'])

    await select.setValue('auto')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['auto'])
  })

  it('marks the select invalid and links the error text when invalid', () => {
    const wrapper = mount(FormSelect, {
      props: {
        modelValue: 'off',
        options,
        label: '同步模式',
        hint: '选择数据同步方式',
        error: '必须选择一种模式',
        fieldId: 'sync-mode',
      },
    })

    const select = wrapper.find('select')
    expect(select.attributes('aria-invalid')).toBe('true')
    expect(select.attributes('aria-describedby')).toBe('sync-mode-hint sync-mode-error')
    expect(wrapper.find('#sync-mode-error').text()).toBe('必须选择一种模式')
  })

  it('blocks interaction when disabled', () => {
    const wrapper = mount(FormSelect, {
      props: {
        modelValue: 'off',
        options,
        label: '同步模式',
        fieldId: 'sync-mode',
        disabled: true,
      },
    })

    expect(wrapper.find('select').attributes('disabled')).toBeDefined()
  })
})
