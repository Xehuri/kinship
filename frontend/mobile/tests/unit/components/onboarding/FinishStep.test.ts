/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import FinishStep from '@/components/onboarding/steps/FinishStep.vue'
import type { FinishClosing, FinishGroups } from '@/api/system'

interface OnboardingMock {
  finishGroups: Ref<FinishGroups | null>
  finishClosing: Ref<FinishClosing | null>
  finishError: Ref<{ message: string; code?: string } | null>
  loadFinish: ReturnType<typeof vi.fn>
  runFinish: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

const onb = vi.hoisted(() => ({}) as OnboardingMock)

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  onb.finishGroups = ref<FinishGroups | null>(null)
  onb.finishClosing = ref<FinishClosing | null>(null)
  onb.finishError = ref<{ message: string; code?: string } | null>(null)
  onb.loadFinish = vi.fn().mockResolvedValue(null)
  onb.runFinish = vi.fn().mockResolvedValue(null)
  onb.refresh = vi.fn().mockResolvedValue(undefined)
  return {
    useOnboarding: () => ({
      finishGroups: onb.finishGroups,
      finishClosing: onb.finishClosing,
      finishError: onb.finishError,
      loadFinish: onb.loadFinish,
      runFinish: onb.runFinish,
      refresh: onb.refresh,
    }),
  }
})

enableAutoUnmount(afterEach)

const EMPTY: FinishGroups = { blocking: [], soft: [] }

const CLOSING: FinishClosing = {
  title: '初始化完成',
  message: '系统已完成初始化，你可以开始使用了。',
  enabled: [{ id: 'loom', label: 'AI 助手' }],
  skipped: [{ id: 'moss', label: 'MOSS 深度音频' }],
  degraded: [{ id: 'moss', message: 'MOSS 未连接' }],
  enter_label: '进入主界面',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function mountStep(currentPassword = 'pw') {
  return mount(FinishStep, {
    props: { currentPassword },
    global: { stubs: { teleport: true } },
  })
}

describe('FinishStep v4', () => {
  beforeEach(() => {
    onb.finishGroups.value = EMPTY
    onb.finishClosing.value = null
    onb.finishError.value = null
    onb.loadFinish.mockClear()
    onb.runFinish.mockClear()
  })

  it('loads finish status on mount', async () => {
    const wrapper = mountStep()
    await flushPromises()
    expect(onb.loadFinish).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('环境预检')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain(
      '一次性应用前面所有改动的草稿',
    )
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('通常 5-20 秒')
  })

  it('renders blocking groups and disables submit', async () => {
    onb.finishGroups.value = {
      blocking: [
        {
          layer: 'preflight',
          id: 'ssl',
          title: 'HTTPS 证书',
          message: '证书文件不存在',
          fix: '检查 ssl.cert 与 ssl.key',
        },
      ],
      soft: [],
    }
    const wrapper = mountStep()
    await flushPromises()
    const button = wrapper.get('[data-onboarding-finish]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('证书文件不存在')
    expect(wrapper.text()).toContain('检查 ssl.cert 与 ssl.key')
  })

  it('requires acknowledgement for soft groups', async () => {
    onb.finishGroups.value = {
      blocking: [],
      soft: [
        {
          layer: 'moss',
          id: 'moss',
          title: 'MOSS 深度音频',
          message: 'MOSS 服务不可达',
        },
      ],
    }
    onb.runFinish.mockImplementation(async () => {
      onb.finishClosing.value = CLOSING
      return { ok: true }
    })
    const wrapper = mountStep()
    await flushPromises()
    expect(wrapper.get('[data-onboarding-finish]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-onboarding-finish-ack]').setValue(true)
    await wrapper.get('[data-onboarding-finish]').trigger('click')
    await flushPromises()
    expect(onb.runFinish).toHaveBeenCalledWith(true, 'pw')
  })

  it('shows closing and enters main UI on success', async () => {
    onb.runFinish.mockImplementation(async () => {
      onb.finishClosing.value = CLOSING
      return { ok: true }
    })
    const wrapper = mountStep()
    await flushPromises()
    await wrapper.get('[data-onboarding-finish]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-onboarding-finish-closing]').exists()).toBe(true)
    expect(wrapper.text()).toContain('初始化完成')
    expect(wrapper.text()).toContain('进入主界面')
    await wrapper.get('[data-onboarding-finish-enter]').trigger('click')
    expect(wrapper.emitted('completed')).toHaveLength(1)
  })

  it('shows failure and does not emit completed', async () => {
    onb.runFinish.mockImplementation(async () => {
      onb.finishError.value = { code: 'finish_startup_failed', message: '启动校验未通过' }
      return null
    })
    const wrapper = mountStep()
    await flushPromises()
    await wrapper.get('[data-onboarding-finish]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('启动校验未通过')
    expect(wrapper.emitted('completed')).toBeUndefined()
  })

  it('emits close from the close button', async () => {
    const wrapper = mountStep()
    await flushPromises()
    await wrapper.get('[data-onboarding-finish-close]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('shows busy feedback and staged progress while finishing', async () => {
    const pending = deferred<Record<string, unknown>>()
    onb.runFinish.mockReturnValue(pending.promise)
    const wrapper = mountStep()
    await flushPromises()

    const button = wrapper.get('[data-onboarding-finish]')
    await button.trigger('click')

    expect(button.text()).toContain('正在校验并完成…')
    expect(button.attributes('data-busy')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.find('.onboarding-spinner').exists()).toBe(true)
    expect(wrapper.get('[data-onboarding-finish-close]').attributes('disabled')).toBeDefined()

    const progress = wrapper.get('[data-onboarding-long-task]')
    expect(progress.text()).toContain('通常 5-20 秒，请勿关闭')
    expect(progress.get('[data-onboarding-long-task-elapsed]').text()).toContain(
      '已用时 0 秒',
    )

    pending.resolve({ ok: true })
    await flushPromises()

    expect(wrapper.find('[data-onboarding-long-task]').exists()).toBe(false)
  })
})
