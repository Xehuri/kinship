/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// ==================== Mock Composables ====================

const mockSetup = vi.hoisted(() => vi.fn())

const mockApi = vi.hoisted(() => ({
  setup: mockSetup,
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => mockApi,
}))

// ==================== Helpers ====================

/** 等待微任务队列清空 */
function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 1))
}

function createWrapper(props: { visible: boolean } = { visible: true }) {
  return mount(SetupOverlay, {
    props,
    global: {
      stubs: { teleport: true },
    },
  })
}

import SetupOverlay from '@/components/common/SetupOverlay.vue'

describe('SetupOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetup.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ==================== 可见性 ====================

  describe('visibility', () => {
    it('visible=true 时渲染', () => {
      const wrapper = createWrapper({ visible: true })
      expect(wrapper.find('.setup-overlay').exists()).toBe(true)
    })

    it('visible=false 时不渲染', () => {
      const wrapper = createWrapper({ visible: false })
      expect(wrapper.find('.setup-overlay').exists()).toBe(false)
    })
  })

  // ==================== 表单渲染 ====================

  describe('form rendering', () => {
    it('渲染用户名/密码/确认密码三个输入框', () => {
      const wrapper = createWrapper()
      expect(wrapper.find('#setup-username').exists()).toBe(true)
      expect(wrapper.find('#setup-password').exists()).toBe(true)
      expect(wrapper.find('#setup-confirm').exists()).toBe(true)
    })

    it('渲染创建管理员账号按钮', () => {
      const wrapper = createWrapper()
      const btn = wrapper.find('.setup-btn')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toBe('创建管理员账号')
    })

    it('不可跳过: 无关闭按钮且无跳过链接', () => {
      const wrapper = createWrapper()
      expect(wrapper.find('.setup-close').exists()).toBe(false)
      expect(wrapper.find('.setup-skip').exists()).toBe(false)
      // 覆盖层不含"忽略"文案
      expect(wrapper.text()).not.toContain('忽略')
      expect(wrapper.text()).not.toContain('跳过')
    })
  })

  // ==================== 提交按钮状态 ====================

  describe('submit button state', () => {
    it('三个输入框都为空时按钮禁用', () => {
      const wrapper = createWrapper()
      expect((wrapper.find('.setup-btn').element as HTMLButtonElement).disabled).toBe(true)
    })

    it('确认密码为空时按钮禁用', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      expect((wrapper.find('.setup-btn').element as HTMLButtonElement).disabled).toBe(true)
    })

    it('三个输入框都有内容时按钮可用', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      expect((wrapper.find('.setup-btn').element as HTMLButtonElement).disabled).toBe(false)
    })
  })

  // ==================== 客户端校验 ====================

  describe('validation', () => {
    it('空用户名不调用 setup', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockSetup).not.toHaveBeenCalled()
      expect(wrapper.find('.setup-error').text()).toContain('请输入用户名')
    })

    it('密码不足 6 位时报错且不调用 setup', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123')
      await wrapper.find('#setup-confirm').setValue('123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockSetup).not.toHaveBeenCalled()
      expect(wrapper.find('.setup-error').text()).toContain('密码至少 6 位')
    })

    it('两次密码不一致时报错且不调用 setup', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('654321')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockSetup).not.toHaveBeenCalled()
      expect(wrapper.find('.setup-error').text()).toContain('两次输入的密码不一致')
    })
  })

  // ==================== 初始化成功 ====================

  describe('setup success', () => {
    it('成功后 emit setup-success 并重置表单', async () => {
      mockSetup.mockResolvedValue({ success: true, token: 'setup-token' })
      const wrapper = createWrapper()

      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockSetup).toHaveBeenCalledWith('admin', '123456')
      expect(wrapper.emitted('setup-success')).toBeTruthy()
      expect(wrapper.emitted('setup-success')![0][0]).toBe('setup-token')
      expect((wrapper.find('#setup-username').element as HTMLInputElement).value).toBe('')
      expect((wrapper.find('#setup-password').element as HTMLInputElement).value).toBe('')
      expect((wrapper.find('#setup-confirm').element as HTMLInputElement).value).toBe('')
    })

    it('用户名前后空格被去除', async () => {
      mockSetup.mockResolvedValue({ success: true, token: 't' })
      const wrapper = createWrapper()

      await wrapper.find('#setup-username').setValue('  admin  ')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockSetup).toHaveBeenCalledWith('admin', '123456')
    })
  })

  // ==================== 初始化失败 ====================

  describe('setup failure', () => {
    it('后端返回失败时显示对应 message', async () => {
      mockSetup.mockResolvedValue({ success: false, token: '', message: '系统已初始化' })
      const wrapper = createWrapper()

      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('.setup-error').text()).toContain('系统已初始化')
      expect(wrapper.emitted('setup-success')).toBeFalsy()
    })

    it('API 返回 null 时显示网络错误', async () => {
      mockSetup.mockResolvedValue(null)
      const wrapper = createWrapper()

      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('.setup-error').text()).toContain('网络错误')
    })

    it('setup 抛出异常时显示请求失败', async () => {
      mockSetup.mockRejectedValue(new Error('Network failure'))
      const wrapper = createWrapper()

      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('.setup-error').text()).toContain('初始化请求失败')
    })
  })

  // ==================== 加载状态 ====================

  describe('loading state', () => {
    it('加载时输入框禁用且按钮显示初始化中', async () => {
      let resolveSetup: (value: unknown) => void
      mockSetup.mockImplementation(
        () => new Promise((resolve) => { resolveSetup = resolve }),
      )
      const wrapper = createWrapper()

      await wrapper.find('#setup-username').setValue('admin')
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await nextTick()

      expect((wrapper.find('#setup-username').element as HTMLInputElement).disabled).toBe(true)
      expect((wrapper.find('#setup-password').element as HTMLInputElement).disabled).toBe(true)
      expect((wrapper.find('#setup-confirm').element as HTMLInputElement).disabled).toBe(true)
      const btn = wrapper.find('.setup-btn')
      expect(btn.text()).toBe('初始化中...')
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)

      resolveSetup!({ success: true, token: 't' })
      await flushPromises()
    })
  })

  // ==================== 错误信息自动清除 ====================

  describe('error clearing', () => {
    it('修改用户名时清除错误信息', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#setup-password').setValue('123456')
      await wrapper.find('#setup-confirm').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()
      expect(wrapper.find('.setup-error').exists()).toBe(true)

      await wrapper.find('#setup-username').setValue('admin')
      await nextTick()
      expect(wrapper.find('.setup-error').exists()).toBe(false)
    })
  })
})
