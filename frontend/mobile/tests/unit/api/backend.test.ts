/// <reference types="vitest/globals" />

/**
 * api/backend 测试 (W31 Web 后端热切换)
 *
 * 验证:
 *   1. fetchWebBackend 正常解析 GET 响应 (backend/options) 与容错回退;
 *   2. fetchWebBackend 请求异常/响应非法时返回 null (不抛);
 *   3. switchWebBackend POST body 形状为 { backend } , 2xx 解析为 { ok: true, backend };
 *   4. switchWebBackend 对 400 {ok:false,error} 走 ok:false 路径, 网络异常吞为 null。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApiGet = vi.hoisted(() => vi.fn())
const mockApiPostVerbose = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiPostVerbose: mockApiPostVerbose,
}))

import { fetchWebBackend, switchWebBackend } from '@/api/backend'

describe('fetchWebBackend', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('解析 GET 响应的 backend 与 options', async () => {
    mockApiGet.mockResolvedValue({
      ok: true,
      backend: 'loom',
      options: ['opencode', 'loom'],
    })
    await expect(fetchWebBackend()).resolves.toEqual({
      backend: 'loom',
      options: ['opencode', 'loom'],
    })
    expect(mockApiGet).toHaveBeenCalledWith('/api/screen/backend')
  })

  it('options 缺失时回退全量合法清单', async () => {
    mockApiGet.mockResolvedValue({ ok: true, backend: 'opencode' })
    await expect(fetchWebBackend()).resolves.toEqual({
      backend: 'opencode',
      options: ['opencode', 'loom'],
    })
  })

  it('backend 为未知取值时判为非法响应返回 null', async () => {
    mockApiGet.mockResolvedValue({ ok: true, backend: 'gpt', options: ['gpt'] })
    await expect(fetchWebBackend()).resolves.toBeNull()
  })

  it('请求失败 (apiGet 吞为 null) 时返回 null', async () => {
    mockApiGet.mockResolvedValue(null)
    await expect(fetchWebBackend()).resolves.toBeNull()
  })

  it('请求异常时返回 null 而不抛出', async () => {
    mockApiGet.mockRejectedValue(new Error('boom'))
    await expect(fetchWebBackend()).resolves.toBeNull()
  })
})

describe('switchWebBackend', () => {
  beforeEach(() => {
    mockApiPostVerbose.mockReset()
  })

  it('POST body 形状为 { backend } 且成功解析新当前值', async () => {
    mockApiPostVerbose.mockResolvedValue({
      status: 200,
      ok: true,
      data: { ok: true, backend: 'loom', options: ['opencode', 'loom'] },
    })
    await expect(switchWebBackend('loom')).resolves.toEqual({
      ok: true,
      backend: 'loom',
    })
    expect(mockApiPostVerbose).toHaveBeenCalledWith('/api/screen/backend', {
      backend: 'loom',
    })
  })

  it('400 非法取值走 ok:false 路径 (无 backend 字段归一为空串)', async () => {
    mockApiPostVerbose.mockResolvedValue({
      status: 400,
      ok: false,
      data: { ok: false, error: '无效的 backend 取值' },
    })
    await expect(switchWebBackend('loom')).resolves.toEqual({
      ok: false,
      backend: '',
    })
  })

  it('2xx 但响应体无法归一化时视为未生效 (ok:false)', async () => {
    mockApiPostVerbose.mockResolvedValue({ status: 200, ok: true, data: null })
    await expect(switchWebBackend('opencode')).resolves.toEqual({
      ok: false,
      backend: '',
    })
  })

  it('网络异常 (status=0 哨兵) 返回 null 而不抛出', async () => {
    mockApiPostVerbose.mockResolvedValue({ status: 0, ok: false, data: null })
    await expect(switchWebBackend('loom')).resolves.toBeNull()
  })

  it('封装函数抛出时吞为 null', async () => {
    mockApiPostVerbose.mockRejectedValue(new Error('boom'))
    await expect(switchWebBackend('loom')).resolves.toBeNull()
  })
})
