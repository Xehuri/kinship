/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// ==================== Mock Composables ====================

const mockLogin = vi.hoisted(() => vi.fn())

const mockApi = vi.hoisted(() => ({
  login: mockLogin,
  isLoggedIn: { value: false },
  token: '',
  logout: vi.fn(),
  onAuthFail: vi.fn(),
  offAuthFail: vi.fn(),
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
  return mount(LoginOverlay, {
    props,
    global: {
      stubs: { teleport: true },
    },
  })
}

import LoginOverlay from '@/components/common/LoginOverlay.vue'

describe('LoginOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLogin.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ==================== 可见性 ====================

  describe('visibility', () => {
    it('visible=true 时渲染', () => {
      const wrapper = createWrapper({ visible: true })
      expect(wrapper.find('.login-overlay').exists()).toBe(true)
    })

    it('visible=false 时不渲染', () => {
      const wrapper = createWrapper({ visible: false })
      expect(wrapper.find('.login-overlay').exists()).toBe(false)
    })
  })

  // ==================== 表单渲染 ====================

  describe('form rendering', () => {
    it('渲染用户名和密码输入框', () => {
      const wrapper = createWrapper()
      expect(wrapper.find('#login-username').exists()).toBe(true)
      expect(wrapper.find('#login-password').exists()).toBe(true)
    })

    it('渲染登录按钮', () => {
      const wrapper = createWrapper()
      const btn = wrapper.find('.login-btn')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toBe('登录')
    })

    it('渲染密码可见切换按钮', () => {
      const wrapper = createWrapper()
      expect(wrapper.find('.login-eye').exists()).toBe(true)
    })
  })

  // ==================== 输入绑定 ====================

  describe('input binding', () => {
    it('用户名输入更新 v-model', async () => {
      const wrapper = createWrapper()
      const input = wrapper.find('#login-username')
      await input.setValue('testuser')
      expect((input.element as HTMLInputElement).value).toBe('testuser')
    })

    it('密码输入更新 v-model', async () => {
      const wrapper = createWrapper()
      const input = wrapper.find('#login-password')
      await input.setValue('mypassword')
      expect((input.element as HTMLInputElement).value).toBe('mypassword')
    })
  })

  // ==================== 密码可见性 ====================

  describe('password visibility', () => {
    it('默认密码隐藏 (type=password)', () => {
      const wrapper = createWrapper()
      const input = wrapper.find('#login-password')
      expect((input.element as HTMLInputElement).type).toBe('password')
    })

    it('点击眼睛按钮切换密码可见性', async () => {
      const wrapper = createWrapper()
      const input = wrapper.find('#login-password')
      const eyeBtn = wrapper.find('.login-eye')

      // 点击显示密码
      await eyeBtn.trigger('click')
      expect((input.element as HTMLInputElement).type).toBe('text')

      // 再次点击隐藏密码
      await eyeBtn.trigger('click')
      expect((input.element as HTMLInputElement).type).toBe('password')
    })
  })

  // ==================== 提交按钮状态 ====================

  describe('submit button state', () => {
    it('两个输入框都为空时按钮禁用', () => {
      const wrapper = createWrapper()
      const btn = wrapper.find('.login-btn')
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    })

    it('用户名为空时按钮禁用', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#login-password').setValue('pass123')
      const btn = wrapper.find('.login-btn')
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    })

    it('密码为空时按钮禁用', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#login-username').setValue('user')
      const btn = wrapper.find('.login-btn')
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    })

    it('两个输入框都有内容时按钮可用', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#login-username').setValue('user')
      await wrapper.find('#login-password').setValue('pass')
      const btn = wrapper.find('.login-btn')
      expect((btn.element as HTMLButtonElement).disabled).toBe(false)
    })
  })

  // ==================== 登录成功 ====================

  describe('login success', () => {
    it('登录成功后 emit login-success', async () => {
      mockLogin.mockResolvedValue({ success: true, token: 'test-token' })
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockLogin).toHaveBeenCalledWith('admin', '123456')
      expect(wrapper.emitted('login-success')).toBeTruthy()
      expect(wrapper.emitted('login-success')![0][0]).toBe('test-token')
    })

    it('登录成功时表单重置', async () => {
      mockLogin.mockResolvedValue({ success: true, token: 'test-token' })
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123456')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const usernameInput = wrapper.find('#login-username')
      const passwordInput = wrapper.find('#login-password')
      expect((usernameInput.element as HTMLInputElement).value).toBe('')
      expect((passwordInput.element as HTMLInputElement).value).toBe('')
    })
  })

  // ==================== 登录失败 ====================

  describe('login failure', () => {
    it('API 返回失败时显示错误信息', async () => {
      mockLogin.mockResolvedValue({
        success: false,
        token: '',
        message: '用户名或密码错误',
      })
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('wrong')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('.login-error').exists()).toBe(true)
      expect(wrapper.find('.login-error').text()).toContain('用户名或密码错误')
    })

    it('API 返回 null 时显示网络错误', async () => {
      mockLogin.mockResolvedValue(null)
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('.login-error').exists()).toBe(true)
      expect(wrapper.find('.login-error').text()).toContain('网络错误')
    })

    it('login 抛出异常时显示请求失败', async () => {
      mockLogin.mockRejectedValue(new Error('Network failure'))
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('.login-error').exists()).toBe(true)
      expect(wrapper.find('.login-error').text()).toContain('登录请求失败')
    })

    it('服务器返回错误时显示对应错误信息', async () => {
      mockLogin.mockResolvedValue({
        success: false,
        token: '',
        message: '账号已被锁定',
      })
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('user')
      await wrapper.find('#login-password').setValue('pass')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('.login-error').text()).toContain('账号已被锁定')
    })

    it('API 返回成功但没有 token 时不 emit', async () => {
      mockLogin.mockResolvedValue({ success: true, token: '' })
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(mockLogin).toHaveBeenCalled()
      expect(wrapper.emitted('login-success')).toBeFalsy()
    })
  })

  // ==================== 加载状态 ====================

  describe('loading state', () => {
    it('登录加载时输入框禁用', async () => {
      let resolveLogin: (value: unknown) => void
      mockLogin.mockImplementation(
        () => new Promise((resolve) => { resolveLogin = resolve }),
      )
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await nextTick()

      expect(
        (wrapper.find('#login-username').element as HTMLInputElement).disabled,
      ).toBe(true)
      expect(
        (wrapper.find('#login-password').element as HTMLInputElement).disabled,
      ).toBe(true)

      // 清理：让 promise 完成
      resolveLogin!({ success: true, token: 't' })
      await flushPromises()
    })

    it('登录加载时按钮显示"登录中..."并禁用', async () => {
      let resolveLogin: (value: unknown) => void
      mockLogin.mockImplementation(
        () => new Promise((resolve) => { resolveLogin = resolve }),
      )
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await nextTick()

      const btn = wrapper.find('.login-btn')
      expect(btn.text()).toBe('登录中...')
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)

      // 清理
      resolveLogin!({ success: true, token: 't' })
      await flushPromises()
    })

    it('加载中时关闭按钮隐藏', async () => {
      let resolveLogin: (value: unknown) => void
      mockLogin.mockImplementation(
        () => new Promise((resolve) => { resolveLogin = resolve }),
      )
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await nextTick()

      // 关闭按钮使用 v-if="!loading"
      expect(wrapper.find('.login-close').exists()).toBe(false)

      // 清理
      resolveLogin!({ success: true, token: 't' })
      await flushPromises()
    })
  })

  // ==================== 关闭行为 ====================

  describe('close behavior', () => {
    it('ESC 键触发 close', async () => {
      const wrapper = createWrapper()
      await wrapper.find('.login-overlay').trigger('keydown.escape')
      expect(wrapper.emitted('close')).toBeTruthy()
    })

    it('点击关闭按钮触发 close', async () => {
      const wrapper = createWrapper()
      await wrapper.find('.login-close').trigger('click')
      expect(wrapper.emitted('close')).toBeTruthy()
    })

    it('加载中时 ESC 不触发 close', async () => {
      let resolveLogin: (value: unknown) => void
      mockLogin.mockImplementation(
        () => new Promise((resolve) => { resolveLogin = resolve }),
      )
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await nextTick()

      await wrapper.find('.login-overlay').trigger('keydown.escape')
      expect(wrapper.emitted('close')).toBeFalsy()

      // 清理
      resolveLogin!({ success: true, token: 't' })
      await flushPromises()
    })

    it('加载中时关闭按钮不触发 close', async () => {
      let resolveLogin: (value: unknown) => void
      mockLogin.mockImplementation(
        () => new Promise((resolve) => { resolveLogin = resolve }),
      )
      const wrapper = createWrapper()

      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('123')
      await wrapper.find('form').trigger('submit')
      await nextTick()

      // 关闭按钮在 loading 时隐藏，无法点击
      expect(wrapper.find('.login-close').exists()).toBe(false)
      expect(wrapper.emitted('close')).toBeFalsy()

      // 清理
      resolveLogin!({ success: true, token: 't' })
      await flushPromises()
    })
  })

  // ==================== 错误信息自动清除 ====================

  describe('error clearing', () => {
    it('输入用户名时清除错误信息', async () => {
      mockLogin.mockResolvedValue({
        success: false,
        token: '',
        message: '用户名或密码错误',
      })
      const wrapper = createWrapper()

      // 触发错误
      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('wrong')
      await wrapper.find('form').trigger('submit')
      await flushPromises()
      expect(wrapper.find('.login-error').exists()).toBe(true)

      // 修改用户名 -> 错误消除
      await wrapper.find('#login-username').setValue('newadmin')
      await nextTick()
      expect(wrapper.find('.login-error').exists()).toBe(false)
    })

    it('输入密码时清除错误信息', async () => {
      mockLogin.mockResolvedValue({
        success: false,
        token: '',
        message: '用户名或密码错误',
      })
      const wrapper = createWrapper()

      // 触发错误
      await wrapper.find('#login-username').setValue('admin')
      await wrapper.find('#login-password').setValue('wrong')
      await wrapper.find('form').trigger('submit')
      await flushPromises()
      expect(wrapper.find('.login-error').exists()).toBe(true)

      // 修改密码 -> 错误消除
      await wrapper.find('#login-password').setValue('newpass')
      await nextTick()
      expect(wrapper.find('.login-error').exists()).toBe(false)
    })
  })

  // ==================== 表单验证 ====================

  describe('validation', () => {
    it('空用户名不调用 login', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#login-password').setValue('pass')
      await wrapper.find('.login-btn').trigger('click')
      await flushPromises()

      expect(mockLogin).not.toHaveBeenCalled()
    })

    it('空密码不调用 login', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#login-username').setValue('user')
      await wrapper.find('.login-btn').trigger('click')
      await flushPromises()

      expect(mockLogin).not.toHaveBeenCalled()
    })

    it('纯空格用户名视为空', async () => {
      const wrapper = createWrapper()
      await wrapper.find('#login-username').setValue('   ')
      await wrapper.find('#login-password').setValue('pass')
      await wrapper.find('.login-btn').trigger('click')
      await flushPromises()

      expect(mockLogin).not.toHaveBeenCalled()
    })
  })
})
