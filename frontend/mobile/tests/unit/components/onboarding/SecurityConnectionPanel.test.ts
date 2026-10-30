/// <reference types="vitest/globals" />

/**
 * SecurityConnectionPanel 测试
 *
 * 覆盖引导依赖步骤里的三个 HTTPS 选择：
 *   - 保持 HTTP：零写入；
 *   - 生成自签证书：复用 onboarding action，并把 ssl.* 三项写入
 *     POST /api/config/draft；
 *   - 上传证书：只把用户填写的 cert/key 路径写入草稿；
 * 并验证 pending 的 requires_restart=true 会渲染“稍后重启”，且失败时
 * 不写草稿（ssl.enabled 保持原值）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'

interface OnboardingMock {
  action: ReturnType<typeof vi.fn>
  error: Ref<{ message: string } | null>
}

const onb = vi.hoisted(() => ({}) as OnboardingMock)
const draft = vi.hoisted(() => ({
  stageConfigDraft: vi.fn(),
  fetchConfigPending: vi.fn(),
}))

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  onb.action = vi.fn()
  onb.error = ref<{ message: string } | null>(null)
  return {
    useOnboarding: () => ({
      action: onb.action,
      error: onb.error,
    }),
  }
})

vi.mock('@/api/configDraft', () => ({
  stageConfigDraft: draft.stageConfigDraft,
  fetchConfigPending: draft.fetchConfigPending,
}))

import SecurityConnectionPanel from '@/components/onboarding/SecurityConnectionPanel.vue'

enableAutoUnmount(afterEach)

const CERT = '/srv/root/backend/config/certs/cert.pem'
const KEY = '/srv/root/backend/config/certs/key.pem'
const NOTE =
  '端口仍是 8768，协议变 https；浏览器首次会警告；手机 App 需在设置里选 INSECURE。'

function pendingResult(requiresRestart = true) {
  return {
    ok: true,
    pending: {
      revision: 'mem-0',
      stagedRevision: 'draft-abc',
      count: 3,
      changes: [
        {
          path: 'ssl.enabled',
          from: false,
          to: true,
          strategy: requiresRestart ? 'deployment' : 'hot',
          requires_restart: requiresRestart,
        },
        {
          path: 'ssl.cert',
          from: '',
          to: CERT,
          strategy: requiresRestart ? 'deployment' : 'hot',
          requires_restart: requiresRestart,
        },
        {
          path: 'ssl.key',
          from: '',
          to: KEY,
          strategy: requiresRestart ? 'deployment' : 'hot',
          requires_restart: requiresRestart,
        },
      ],
    },
  }
}

function stagedResult() {
  return {
    ok: true,
    count: 3,
    changes: {
      'ssl.enabled': { from: false, to: true },
      'ssl.cert': { from: '', to: CERT },
      'ssl.key': { from: '', to: KEY },
    },
    stagedRevision: 'draft-abc',
  }
}

function mountPanel(props: { currentPassword?: string } = {}) {
  return mount(SecurityConnectionPanel, { props })
}

describe('SecurityConnectionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onb.action.mockReset()
    onb.error.value = null
    draft.stageConfigDraft.mockReset().mockResolvedValue(stagedResult())
    draft.fetchConfigPending.mockReset().mockResolvedValue(pendingResult(true))
  })

  it('is an expandable block with three choices and defaults to keep HTTP', async () => {
    const wrapper = mountPanel({ currentPassword: 'pw-123' })
    const details = wrapper.get('[data-onboarding-security]')
    expect(details.element.tagName).toBe('DETAILS')
    expect((details.element as HTMLDetailsElement).open).toBe(false)

    await wrapper.get('[data-onboarding-security-toggle]').trigger('click')

    expect(wrapper.findAll('[data-onboarding-security-choice]')).toHaveLength(3)
    expect(wrapper.get('[data-onboarding-security-note]').text()).toContain(NOTE)
    expect(
      (wrapper.get('[data-onboarding-security-choice="keep"]')
        .element as HTMLInputElement).checked,
    ).toBe(true)
    expect(wrapper.find('[data-onboarding-security-keep]').exists()).toBe(true)
    expect(onb.action).not.toHaveBeenCalled()
    expect(draft.stageConfigDraft).not.toHaveBeenCalled()
  })

  it('reuses generate_self_signed_cert and stages ssl.enabled/cert/key', async () => {
    onb.action.mockResolvedValue({
      ok: true,
      result: { cert: CERT, key: KEY },
    })
    const wrapper = mountPanel({ currentPassword: 'pw-123' })
    await wrapper.get('[data-onboarding-security-toggle]').trigger('click')
    await wrapper.get('[data-onboarding-security-choice="generate"]').setValue(true)

    await wrapper.get('[data-onboarding-security-generate-action]').trigger('click')
    await flushPromises()

    expect(onb.action).toHaveBeenCalledWith(
      'generate_self_signed_cert',
      false,
      undefined,
      'pw-123',
    )
    expect(draft.stageConfigDraft).toHaveBeenCalledWith(
      {
        'ssl.enabled': true,
        'ssl.cert': CERT,
        'ssl.key': KEY,
      },
      { currentPassword: 'pw-123' },
    )
    expect(draft.fetchConfigPending).toHaveBeenCalledWith({
      currentPassword: 'pw-123',
    })
    expect(wrapper.get('[data-onboarding-security-generated]').text()).toContain(CERT)
    expect(wrapper.get('[data-onboarding-security-pending]').text()).toContain(
      'ssl.enabled',
    )
    expect(wrapper.get('[data-onboarding-security-pending]').text()).toContain(
      'ssl.cert',
    )
    expect(wrapper.get('[data-onboarding-security-pending]').text()).toContain(
      'ssl.key',
    )
    expect(wrapper.get('[data-onboarding-security-restart]').text()).toContain(
      '稍后重启',
    )
    expect(wrapper.find('[data-onboarding-security-error]').exists()).toBe(false)
  })

  it('stages user-supplied cert/key paths without any action call', async () => {
    const wrapper = mountPanel({ currentPassword: 'pw-123' })
    await wrapper.get('[data-onboarding-security-toggle]').trigger('click')
    await wrapper.get('[data-onboarding-security-choice="upload"]').setValue(true)
    await wrapper.get('[data-onboarding-security-cert]').setValue('/etc/ssl/server.crt')
    await wrapper.get('[data-onboarding-security-key]').setValue('/etc/ssl/server.key')

    await wrapper.get('[data-onboarding-security-upload]').trigger('submit')
    await flushPromises()

    expect(onb.action).not.toHaveBeenCalled()
    expect(draft.stageConfigDraft).toHaveBeenCalledWith(
      {
        'ssl.enabled': true,
        'ssl.cert': '/etc/ssl/server.crt',
        'ssl.key': '/etc/ssl/server.key',
      },
      { currentPassword: 'pw-123' },
    )
    expect(wrapper.get('[data-onboarding-security-restart]').text()).toContain(
      '稍后重启',
    )
  })

  it('shows 稍后重启 for the ssl group even if pending reports a hot strategy', async () => {
    draft.fetchConfigPending.mockResolvedValue(pendingResult(false))
    onb.action.mockResolvedValue({ ok: true, result: { cert: CERT, key: KEY } })
    const wrapper = mountPanel({ currentPassword: 'pw-123' })
    await wrapper.get('[data-onboarding-security-toggle]').trigger('click')
    await wrapper.get('[data-onboarding-security-choice="generate"]').setValue(true)
    await wrapper.get('[data-onboarding-security-generate-action]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-onboarding-security-restart]').text()).toContain(
      '稍后重启',
    )
  })

  it('requires both upload paths and never writes a partial draft', async () => {
    const wrapper = mountPanel({ currentPassword: 'pw-123' })
    await wrapper.get('[data-onboarding-security-toggle]').trigger('click')
    await wrapper.get('[data-onboarding-security-choice="upload"]').setValue(true)
    await wrapper.get('[data-onboarding-security-cert]').setValue('/etc/ssl/server.crt')

    await wrapper.get('[data-onboarding-security-upload]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-onboarding-security-error]').text()).toContain(
      '请填写证书与私钥路径',
    )
    expect(draft.stageConfigDraft).not.toHaveBeenCalled()
  })

  it('keeps ssl.enabled unwritten when certificate generation fails', async () => {
    onb.action.mockResolvedValue(null)
    onb.error.value = { message: '无法创建证书目录: /read-only/backend/config/certs' }
    const wrapper = mountPanel({ currentPassword: 'pw-123' })
    await wrapper.get('[data-onboarding-security-toggle]').trigger('click')
    await wrapper.get('[data-onboarding-security-choice="generate"]').setValue(true)

    await wrapper.get('[data-onboarding-security-generate-action]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-onboarding-security-error]').text()).toContain(
      '无法创建证书目录',
    )
    expect(draft.stageConfigDraft).not.toHaveBeenCalled()
    expect(wrapper.find('[data-onboarding-security-pending]').exists()).toBe(false)
  })

  it('shows a readable password error before calling the action', async () => {
    const wrapper = mountPanel({ currentPassword: '' })
    await wrapper.get('[data-onboarding-security-toggle]').trigger('click')
    await wrapper.get('[data-onboarding-security-choice="generate"]').setValue(true)
    await wrapper.get('[data-onboarding-security-generate-action]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-onboarding-security-error]').text()).toContain(
      '需要当前管理员密码',
    )
    expect(onb.action).not.toHaveBeenCalled()
    expect(draft.stageConfigDraft).not.toHaveBeenCalled()
  })
})
