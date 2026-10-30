/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const push = vi.hoisted(() => vi.fn())
const changeCredentials = vi.hoisted(() => vi.fn())
const logout = vi.hoisted(() => vi.fn())
const apiState = vi.hoisted(() => ({ isLoggedIn: null as { value: boolean } | null }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@/composables/useApi', async () => {
  const { ref } = await import('vue')
  apiState.isLoggedIn = ref(true)
  return {
    useApi: () => ({
      isLoggedIn: apiState.isLoggedIn,
      logout,
      changeCredentials,
    }),
  }
})

import SettingsAccount from '@/components/settings/SettingsAccount.vue'

function mountAccount() {
  return mount(SettingsAccount)
}

function row(wrapper: ReturnType<typeof mountAccount>, name: string) {
  return wrapper.find(`[data-setting-row="${name}"]`)
}

async function openCredentialForm(wrapper: ReturnType<typeof mountAccount>) {
  await row(wrapper, 'credentials').trigger('click')
  return wrapper.find('[data-setting-form="credentials"]')
}

describe('SettingsAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiState.isLoggedIn!.value = true
    changeCredentials.mockResolvedValue({ success: true, message: '已更新' })
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未登录时显示登录入口且隐藏退出/改密', () => {
    apiState.isLoggedIn!.value = false
    const wrapper = mountAccount()

    expect(row(wrapper, 'login').text()).toContain('未登录')
    expect(row(wrapper, 'logout').exists()).toBe(false)
    expect(row(wrapper, 'credentials').exists()).toBe(false)
  })

  it('点击登录跳转 /chat 以触发登录覆盖层', async () => {
    apiState.isLoggedIn!.value = false
    const wrapper = mountAccount()

    await row(wrapper, 'login').trigger('click')
    expect(push).toHaveBeenCalledWith('/chat')
  })

  it('已登录时显示状态、退出与修改凭据入口', () => {
    const wrapper = mountAccount()

    expect(row(wrapper, 'account-status').text()).toContain('已登录')
    expect(row(wrapper, 'logout').exists()).toBe(true)
    expect(row(wrapper, 'credentials').exists()).toBe(true)
  })

  it('确认退出时调用 logout 并跳转 /chat', async () => {
    const wrapper = mountAccount()

    await row(wrapper, 'logout').trigger('click')

    expect(logout).toHaveBeenCalledOnce()
    expect(push).toHaveBeenCalledWith('/chat')
  })

  it('取消退出时不调用 logout', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const wrapper = mountAccount()

    await row(wrapper, 'logout').trigger('click')

    expect(logout).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('展开修改凭据表单', async () => {
    const wrapper = mountAccount()

    expect(wrapper.find('[data-setting-form="credentials"]').exists()).toBe(false)
    await openCredentialForm(wrapper)
    expect(wrapper.find('[data-setting-form="credentials"]').exists()).toBe(true)
    expect(row(wrapper, 'credentials').attributes('aria-expanded')).toBe('true')
  })

  it('成功修改后调用 changeCredentials 并清空表单', async () => {
    const wrapper = mountAccount()
    await openCredentialForm(wrapper)

    await wrapper.find('.cred-old-password').setValue('oldpass')
    await wrapper.find('.cred-new-username').setValue('newuser')
    await wrapper.find('.cred-new-password').setValue('newpass1')
    await wrapper.find('.cred-confirm-password').setValue('newpass1')
    await wrapper.find('[data-setting-form="credentials"]').trigger('submit')
    await flushPromises()

    expect(changeCredentials).toHaveBeenCalledWith('oldpass', 'newuser', 'newpass1')
    expect(wrapper.find('.settings-message--success').text()).toContain('已更新')
    expect((wrapper.find('.cred-old-password').element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('.cred-new-password').element as HTMLInputElement).value).toBe('')
  })

  it('仅改用户名时新密码参数为 undefined', async () => {
    const wrapper = mountAccount()
    await openCredentialForm(wrapper)

    await wrapper.find('.cred-old-password').setValue('oldpass')
    await wrapper.find('.cred-new-username').setValue('renamed')
    await wrapper.find('[data-setting-form="credentials"]').trigger('submit')
    await flushPromises()

    expect(changeCredentials).toHaveBeenCalledWith('oldpass', 'renamed', undefined)
  })

  it('原密码为空时报错且不调用 API', async () => {
    const wrapper = mountAccount()
    await openCredentialForm(wrapper)

    await wrapper.find('.cred-new-username').setValue('newuser')
    await wrapper.find('[data-setting-form="credentials"]').trigger('submit')
    await flushPromises()

    expect(changeCredentials).not.toHaveBeenCalled()
    expect(wrapper.find('.settings-message--error').text()).toContain('请输入原密码')
  })

  it('未填写任何新值时报错', async () => {
    const wrapper = mountAccount()
    await openCredentialForm(wrapper)

    await wrapper.find('.cred-old-password').setValue('oldpass')
    await wrapper.find('[data-setting-form="credentials"]').trigger('submit')
    await flushPromises()

    expect(changeCredentials).not.toHaveBeenCalled()
    expect(wrapper.find('.settings-message--error').text()).toContain('至少填写')
  })

  it('新密码不足 6 位时报错', async () => {
    const wrapper = mountAccount()
    await openCredentialForm(wrapper)

    await wrapper.find('.cred-old-password').setValue('oldpass')
    await wrapper.find('.cred-new-password').setValue('123')
    await wrapper.find('.cred-confirm-password').setValue('123')
    await wrapper.find('[data-setting-form="credentials"]').trigger('submit')
    await flushPromises()

    expect(changeCredentials).not.toHaveBeenCalled()
    expect(wrapper.find('.settings-message--error').text()).toContain('新密码至少 6 位')
  })

  it('两次新密码不一致时报错', async () => {
    const wrapper = mountAccount()
    await openCredentialForm(wrapper)

    await wrapper.find('.cred-old-password').setValue('oldpass')
    await wrapper.find('.cred-new-password').setValue('newpass1')
    await wrapper.find('.cred-confirm-password').setValue('newpass2')
    await wrapper.find('[data-setting-form="credentials"]').trigger('submit')
    await flushPromises()

    expect(changeCredentials).not.toHaveBeenCalled()
    expect(wrapper.find('.settings-message--error').text()).toContain('两次输入的新密码不一致')
  })

  it('API 明确失败时显示后端 message', async () => {
    changeCredentials.mockResolvedValue({ success: false, message: '旧密码错误' })
    const wrapper = mountAccount()
    await openCredentialForm(wrapper)

    await wrapper.find('.cred-old-password').setValue('wrong')
    await wrapper.find('.cred-new-username').setValue('newuser')
    await wrapper.find('[data-setting-form="credentials"]').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.settings-message--error').text()).toContain('旧密码错误')
  })
})
