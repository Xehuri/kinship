/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsSources from '@/components/settings/SettingsSources.vue'

const apiGetVerbose = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGetVerbose,
}))

interface RawSource {
  id: string
  name: string
  status: string
  last_sync: string | null
  records: number | null
  detail: string
}

function source(overrides: Partial<RawSource> & Pick<RawSource, 'id' | 'name'>): RawSource {
  return {
    status: 'ok',
    last_sync: '2026-10-24T20:00:00+08:00',
    records: 12,
    detail: '正常写入',
    ...overrides,
  }
}

const SIX_SOURCES: RawSource[] = [
  source({ id: 'phone_health', name: '手机健康数据', records: 48 }),
  source({ id: 'mi_cloud', name: '小米健康云', records: 20 }),
  source({ id: 'pc_sensor', name: 'PC 感知采集', records: 7 }),
  source({ id: 'realtime', name: '实时事件流', status: 'degraded', records: null, detail: '仅 SSE 在线' }),
  source({ id: 'loom', name: 'Loom AI 后端', status: 'stale', records: null }),
  source({ id: 'files', name: '每日感知文件', status: 'offline', records: null }),
]

function success(sources: RawSource[]) {
  return {
    status: 200,
    ok: true,
    data: { generated_at: '2026-10-24T20:05:00+08:00', sources },
  }
}

function mountSources() {
  return mount(SettingsSources)
}

describe('SettingsSources', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiGetVerbose.mockResolvedValue(success(SIX_SOURCES))
  })

  it('加载中显示骨架并带 aria-busy', () => {
    apiGetVerbose.mockReturnValue(new Promise(() => {}))
    const wrapper = mountSources()

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('读取中')
  })

  it('渲染后端返回的六个数据源、状态、记录数与说明', async () => {
    const wrapper = mountSources()
    await flushPromises()

    const rows = wrapper.findAll('.settings-source')
    expect(rows).toHaveLength(6)
    expect(rows.map((row) => row.attributes('data-source-id'))).toEqual([
      'phone_health',
      'mi_cloud',
      'pc_sensor',
      'realtime',
      'loom',
      'files',
    ])
    expect(wrapper.text()).toContain('手机健康数据')
    expect(wrapper.text()).toContain('48 条')
    expect(wrapper.text()).toContain('正常')
    expect(wrapper.text()).toContain('降级')
    expect(wrapper.text()).toContain('过期')
    expect(wrapper.text()).toContain('离线')
    expect(wrapper.text()).toContain('记录 未知')
    expect(wrapper.text()).toContain('仅 SSE 在线')
    expect(wrapper.text()).toContain('生成于')
  })

  it('后端返回未知状态值时按未知展示', async () => {
    apiGetVerbose.mockResolvedValue(
      success([source({ id: 'future', name: '未来数据源', status: 'mystery' })]),
    )
    const wrapper = mountSources()
    await flushPromises()

    expect(wrapper.text()).toContain('未来数据源')
    expect(wrapper.text()).toContain('未知')
  })

  it('401 显示不可用而非崩溃并保留重试入口', async () => {
    apiGetVerbose.mockResolvedValue({
      status: 401,
      ok: false,
      data: { detail: '未授权访问，请先登录' },
    })
    const wrapper = mountSources()
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('数据源状态不可用')
    expect(wrapper.text()).toContain('重新登录')
    expect(wrapper.find('.sources-refresh-btn').exists()).toBe(true)
  })

  it('404 显示当前后端不支持接口', async () => {
    apiGetVerbose.mockResolvedValue({ status: 404, ok: false, data: { detail: 'Not Found' } })
    const wrapper = mountSources()
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toContain('不支持数据源健康接口')
  })

  it('不补造后端未返回的数据源', async () => {
    apiGetVerbose.mockResolvedValue(
      success([
        source({ id: 'phone_health', name: '手机健康数据' }),
        source({ id: 'files', name: '每日感知文件' }),
      ]),
    )
    const wrapper = mountSources()
    await flushPromises()

    expect(wrapper.findAll('.settings-source')).toHaveLength(2)
    expect(wrapper.text()).not.toContain('小米健康云')
    expect(wrapper.text()).not.toContain('Loom AI 后端')
  })

  it('点击刷新重新请求并更新数据', async () => {
    const wrapper = mountSources()
    await flushPromises()
    expect(apiGetVerbose).toHaveBeenCalledTimes(1)

    apiGetVerbose.mockResolvedValue(
      success([source({ id: 'phone_health', name: '手机健康数据', records: 99 })]),
    )
    await wrapper.find('.sources-refresh-btn').trigger('click')
    await flushPromises()

    expect(apiGetVerbose).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('99 条')
    expect(wrapper.findAll('.settings-source')).toHaveLength(1)
  })
})
