/// <reference types="vitest/globals" />

/**
 * api/downloads 测试
 *
 * 验证:
 *   1. fetchPcSensorInfo 正常返回后端数据 / 请求异常时返回 null (不抛);
 *   2. downloadPcSensor 取票失败返回 false, 且不创建下载链接;
 *   3. downloadPcSensor 成功取票时用一次性 ticket 构造下载链接并触发点击, 随后清理节点。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockApiGet = vi.hoisted(() => vi.fn())
const mockFetchWsTicket = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
}))

vi.mock('@/api/ticket', () => ({
  fetchWsTicket: mockFetchWsTicket,
}))

import { fetchPcSensorInfo, downloadPcSensor } from '@/api/downloads'

describe('fetchPcSensorInfo', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('返回后端数据', async () => {
    const info = {
      exists: true,
      filename: 'Kinship-PCSensor.exe',
      size: 35566743,
      size_text: '33.9 MB',
      mtime: 0,
      sha256: null,
    }
    mockApiGet.mockResolvedValue(info)
    await expect(fetchPcSensorInfo()).resolves.toEqual(info)
    expect(mockApiGet).toHaveBeenCalledWith('/api/pc-sensor/info')
  })

  it('请求异常时返回 null 而不抛出', async () => {
    mockApiGet.mockRejectedValue(new Error('boom'))
    await expect(fetchPcSensorInfo()).resolves.toBeNull()
  })
})

describe('downloadPcSensor', () => {
  let clickSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetchWsTicket.mockReset()
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('取票失败返回 false 且不触发下载', async () => {
    mockFetchWsTicket.mockResolvedValue(null)
    await expect(downloadPcSensor()).resolves.toBe(false)
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('取票成功后触发下载并清理链接节点', async () => {
    mockFetchWsTicket.mockResolvedValue('tk-123')
    await expect(downloadPcSensor()).resolves.toBe(true)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(document.querySelector('a[download="Kinship-PCSensor.exe"]')).toBeNull()
  })

  it('ticket 被 URL 编码后拼进下载地址', async () => {
    let href = ''
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      href = this.getAttribute('href') ?? ''
    })
    mockFetchWsTicket.mockResolvedValue('a b/c')
    await downloadPcSensor()
    expect(href).toBe('/api/pc-sensor/download?ticket=a%20b%2Fc')
  })
})
