/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const apiMock = vi.hoisted(() => ({
  setup: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({
    setup: apiMock.setup,
  }),
}))

import AccountStep from '@/components/onboarding/steps/AccountStep.vue'

enableAutoUnmount(afterEach)

function mountStep(props: { needsSetup?: boolean; setupTokenRequired?: boolean } = {}) {
  return mount(AccountStep, {
    props: { needsSetup: true, setupTokenRequired: false, ...props },
  })
}

function storageDump(): string {
  const parts: string[] = []
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key) parts.push(key, storage.getItem(key) ?? '')
    }
  }
  return parts.join('|')
}

describe('AccountStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.setup.mockReset().mockResolvedValue({ success: true, token: 'jwt-token' })
    localStorage.clear()
    sessionStorage.clear()
  })

  it('renders the setup token and credential fields while setup is required', () => {
    const wrapper = mountStep({ setupTokenRequired: true })

    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('管理员账号是登录')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain('待创建')
    expect(wrapper.find('[data-onboarding-setup-token]').exists()).toBe(true)
    expect(wrapper.find('[data-onboarding-account-username]').exists()).toBe(true)
    expect(wrapper.find('[data-onboarding-account-password]').exists()).toBe(true)
    expect(wrapper.find('[data-onboarding-account-confirm]').exists()).toBe(true)
  })

  it('points at the backend auth state setup token path', () => {
    const wrapper = mountStep({ setupTokenRequired: true })

    const text = wrapper.text()
    expect(text).toContain('backend/config/.setup_token')
    expect(text).toContain('AXEUH_AUTH_STATE_DIR')
    expect(text).not.toContain('项目根的 .setup_token')
  })

  it('creates the first admin with the setup token and emits created', async () => {
    const wrapper = mountStep({ setupTokenRequired: true })

    await wrapper.get('[data-onboarding-setup-token]').setValue('tok-123')
    await wrapper.get('[data-onboarding-account-username]').setValue('admin')
    await wrapper.get('[data-onboarding-account-password]').setValue('pw123456')
    await wrapper.get('[data-onboarding-account-confirm]').setValue('pw123456')
    await wrapper.get('[data-onboarding-account-form]').trigger('submit')
    await flushPromises()

    expect(apiMock.setup).toHaveBeenCalledWith('admin', 'pw123456', 'tok-123')
    expect(wrapper.emitted('created')).toEqual([
      [{ username: 'admin', password: 'pw123456' }],
    ])
    expect(wrapper.emitted('created')).toHaveLength(1)
    expect((wrapper.get('[data-onboarding-account-username]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('[data-onboarding-account-password]').element as HTMLInputElement).value).toBe('')
  })

  it('requires the setup token when the server enforces it', async () => {
    const wrapper = mountStep({ setupTokenRequired: true })

    await wrapper.get('[data-onboarding-account-username]').setValue('admin')
    await wrapper.get('[data-onboarding-account-password]').setValue('pw123456')
    await wrapper.get('[data-onboarding-account-confirm]').setValue('pw123456')
    await wrapper.get('[data-onboarding-account-form]').trigger('submit')
    await flushPromises()

    expect(apiMock.setup).not.toHaveBeenCalled()
    expect(wrapper.get('[data-onboarding-account-error]').text()).toContain('引导令牌')
  })

  it('validates the username, password length and confirmation', async () => {
    const wrapper = mountStep()

    await wrapper.get('[data-onboarding-account-form]').trigger('submit')
    expect(wrapper.get('[data-onboarding-account-error]').text()).toContain('用户名')

    await wrapper.get('[data-onboarding-account-username]').setValue('admin')
    await wrapper.get('[data-onboarding-account-password]').setValue('123')
    await wrapper.get('[data-onboarding-account-form]').trigger('submit')
    expect(wrapper.get('[data-onboarding-account-error]').text()).toContain('6 位')

    await wrapper.get('[data-onboarding-account-password]').setValue('pw123456')
    await wrapper.get('[data-onboarding-account-confirm]').setValue('other-password')
    await wrapper.get('[data-onboarding-account-form]').trigger('submit')
    expect(wrapper.get('[data-onboarding-account-error]').text()).toContain('不一致')
    expect(apiMock.setup).not.toHaveBeenCalled()
  })

  it('surfaces the server error without emitting created', async () => {
    apiMock.setup.mockResolvedValue({ success: false, message: '引导令牌无效' })
    const wrapper = mountStep()

    await wrapper.get('[data-onboarding-account-username]').setValue('admin')
    await wrapper.get('[data-onboarding-account-password]').setValue('pw123456')
    await wrapper.get('[data-onboarding-account-confirm]').setValue('pw123456')
    await wrapper.get('[data-onboarding-account-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.emitted('created')).toBeUndefined()
    expect(wrapper.get('[data-onboarding-account-error]').text()).toContain('引导令牌无效')
  })

  it('shows the configured state and emits a recoverable created event when an admin already exists', async () => {
    const wrapper = mountStep({ needsSetup: false })

    expect(wrapper.find('[data-onboarding-setup-token]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-account-username]').exists()).toBe(false)
    expect(wrapper.get('[data-onboarding-account-exists]').text()).toContain('无需重复创建')

    await wrapper.get('[data-onboarding-account-continue]').trigger('click')
    expect(wrapper.emitted('created')).toEqual([[{ existing: true }]])
    expect(wrapper.emitted('next')).toBeUndefined()
  })

  it('never writes credentials or the setup token to browser storage', async () => {
    const wrapper = mountStep({ setupTokenRequired: true })

    await wrapper.get('[data-onboarding-setup-token]').setValue('tok-123')
    await wrapper.get('[data-onboarding-account-username]').setValue('admin')
    await wrapper.get('[data-onboarding-account-password]').setValue('pw-123456')
    await wrapper.get('[data-onboarding-account-confirm]').setValue('pw-123456')
    await wrapper.get('[data-onboarding-account-form]').trigger('submit')
    await flushPromises()

    const dump = storageDump()
    expect(dump).not.toContain('pw-123456')
    expect(dump).not.toContain('tok-123')
  })
})
