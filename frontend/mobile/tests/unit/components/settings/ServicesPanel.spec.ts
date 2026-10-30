/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ServicesPanel from '@/components/settings/ServicesPanel.vue'

const apiGetVerbose = vi.hoisted(() => vi.fn())
const apiPostVerbose = vi.hoisted(() => vi.fn())
const routerPush = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGetVerbose,
  apiPostVerbose,
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}))

interface RawService {
  id: string
  state: string
  reason_code: string
  detail: string
  pid: number | null
  started_at: string | null
  retry_count: number
  next_retry_at: string | null
  requires: string[]
  critical: boolean
}

function service(overrides: Partial<RawService> & Pick<RawService, 'id' | 'state'>): RawService {
  return {
    reason_code: '',
    detail: '',
    pid: null,
    started_at: '2026-10-29T12:00:00+08:00',
    retry_count: 0,
    next_retry_at: null,
    requires: [],
    critical: false,
    ...overrides,
  }
}

function success(services: RawService[], orchestrator = 'on') {
  return {
    status: 200,
    ok: true,
    data: { orchestrator, services },
  }
}

function mountPanel(options: { mode?: 'full' | 'compact' } = {}): VueWrapper {
  return mount(ServicesPanel, {
    props: { mode: options.mode ?? 'full' },
  })
}

describe('ServicesPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T12:00:00+08:00'))
    apiGetVerbose.mockReset()
    apiPostVerbose.mockReset()
    routerPush.mockReset()
    routerPush.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('首次加载显示骨架并带 aria-busy', () => {
    apiGetVerbose.mockReturnValue(new Promise(() => {}))
    const wrapper = mountPanel()

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('服务状态')
    expect(wrapper.text()).toContain('读取中')
  })

  it('按后端 state 渲染运行中、待配置与异常三种状态', async () => {
    apiGetVerbose.mockResolvedValue(
      success([
        service({ id: 'kernel', state: 'ready', pid: 4242, critical: true }),
        service({ id: 'moss_watcher', state: 'blocked', reason_code: 'disabled' }),
        service({
          id: 'loom',
          state: 'failed',
          reason_code: 'spawn_failed',
          detail: 'AI 助手启动失败，端口被占用',
        }),
      ]),
    )
    const wrapper = mountPanel()
    await flushPromises()

    const rows = wrapper.findAll('[data-service-id]')
    expect(rows).toHaveLength(3)

    expect(rows[0].attributes('data-service-state')).toBe('ready')
    expect(rows[0].text()).toContain('运行中')
    expect(rows[0].text()).toContain('PID 4242')

    expect(rows[1].attributes('data-service-state')).toBe('blocked')
    expect(rows[1].text()).toContain('待配置')
    expect(rows[1].text()).toContain('未启用')
    expect(rows[1].find('[data-service-action="configure"]').exists()).toBe(true)
    expect(rows[1].find('[data-service-action="retry"]').exists()).toBe(false)

    expect(rows[2].attributes('data-service-state')).toBe('failed')
    expect(rows[2].text()).toContain('异常')
    expect(rows[2].text()).toContain('AI 助手启动失败，端口被占用')
    expect(rows[2].find('[data-service-action="retry"]').exists()).toBe(true)

    // 原始 reason_code 与人话并存会让面板泄漏技术词，断言只出现翻译后的文本。
    expect(wrapper.text()).not.toContain('disabled')
    expect(wrapper.text()).not.toContain('spawn_failed')
  })

  it('绝不展示堆栈原文，失败详情回退为 reason 的人话', async () => {
    apiGetVerbose.mockResolvedValue(
      success([
        service({
          id: 'kernel',
          state: 'failed',
          reason_code: 'spawn_failed',
          detail: 'Traceback (most recent call last):\n  File "boot.py", line 3',
        }),
        service({
          id: 'loom',
          state: 'failed',
          reason_code: 'spawn_failed',
          detail: 'start action raised: 内核握手缺少 port/pid: {}',
        }),
        service({
          id: 'moss_watcher',
          state: 'failed',
          reason_code: 'crashed',
          detail: 'kernel exited with code 1',
        }),
      ]),
    )
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.text()).not.toContain('Traceback')
    expect(wrapper.text()).not.toContain('boot.py')
    expect(wrapper.text()).not.toContain('start action raised')
    expect(wrapper.text()).not.toContain('port/pid')
    expect(wrapper.text()).not.toContain('kernel exited with code 1')
    expect(wrapper.text()).toContain('进程启动失败')
    expect(wrapper.text()).toContain('运行中异常退出')
  })

  it('stopped 状态只显示人话，不展示后端 detail 原文', async () => {
    apiGetVerbose.mockResolvedValue(
      success([service({ id: 'loom', state: 'stopped', reason_code: 'stopped', detail: 'stopped' })]),
    )
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('已停止')
    expect(wrapper.text()).not.toContain('stopped')
  })

  it('点击重试调用 POST /api/config/apply/retry 并刷新服务状态', async () => {
    apiGetVerbose.mockResolvedValueOnce(
      success([
        service({ id: 'kernel', state: 'failed', reason_code: 'crashed', detail: '内核已退出' }),
      ]),
    )
    apiGetVerbose.mockResolvedValueOnce(
      success([service({ id: 'kernel', state: 'ready', pid: 9001 })]),
    )
    apiPostVerbose.mockResolvedValue({
      status: 200,
      ok: true,
      data: { ok: true, partial: false, failed: [] },
    })

    const wrapper = mountPanel()
    await flushPromises()
    expect(apiGetVerbose).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-service-action="retry"]').trigger('click')
    await flushPromises()

    expect(apiPostVerbose).toHaveBeenCalledTimes(1)
    expect(apiPostVerbose).toHaveBeenCalledWith('/api/config/apply/retry', {})
    expect(apiGetVerbose).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('重试已提交')
    expect(wrapper.find('[data-service-id="kernel"]').attributes('data-service-state')).toBe(
      'ready',
    )
    expect(wrapper.text()).toContain('PID 9001')
  })

  it('重试被拒绝时显示人话错误且不抛出', async () => {
    apiGetVerbose.mockResolvedValue(
      success([service({ id: 'kernel', state: 'failed', reason_code: 'crashed' })]),
    )
    apiPostVerbose.mockResolvedValue({
      status: 403,
      ok: false,
      data: { code: 'password_required', message: '修改配置需要验证密码' },
    })

    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-service-action="retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-services-action-error]').text()).toContain('密码校验')
  })

  it('每 5 秒轮询一次，且更新时间随之推进', async () => {
    apiGetVerbose.mockResolvedValue(success([service({ id: 'kernel', state: 'ready', pid: 1 })]))

    const wrapper = mountPanel()
    await flushPromises()
    expect(apiGetVerbose).toHaveBeenCalledTimes(1)

    const firstUpdatedAt = Number(
      wrapper.find('[data-services-updated-at]').attributes('data-updated-ms'),
    )

    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(apiGetVerbose).toHaveBeenCalledTimes(2)

    const secondUpdatedAt = Number(
      wrapper.find('[data-services-updated-at]').attributes('data-updated-ms'),
    )
    expect(secondUpdatedAt).toBe(firstUpdatedAt + 5000)

    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(apiGetVerbose).toHaveBeenCalledTimes(3)
  })

  it('去配置按 service_id 映射跳转设置页系统分组', async () => {
    apiGetVerbose.mockResolvedValue(
      success([service({ id: 'moss_watcher', state: 'blocked', reason_code: 'missing_config' })]),
    )
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-service-action="configure"]').trigger('click')
    await flushPromises()

    expect(routerPush).toHaveBeenCalledWith('/settings#settings-group-system')
  })

  it('compact 模式只渲染 critical 服务且不显示操作按钮', async () => {
    apiGetVerbose.mockResolvedValue(
      success([
        service({ id: 'kernel', state: 'ready', pid: 12, critical: true }),
        service({ id: 'koom', state: 'blocked', reason_code: 'disabled', critical: false }),
      ]),
    )
    const wrapper = mountPanel({ mode: 'compact' })
    await flushPromises()

    expect(wrapper.findAll('[data-service-id]')).toHaveLength(1)
    expect(wrapper.text()).toContain('音频内核')
    expect(wrapper.text()).not.toContain('koom')
    expect(wrapper.find('[data-service-action]').exists()).toBe(false)
  })
})
