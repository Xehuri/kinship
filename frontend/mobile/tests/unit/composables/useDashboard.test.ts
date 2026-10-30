/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ==================== Mock API 模块 ====================

const mockFetchDashboard = vi.hoisted(() => vi.fn())
const mockFetchHealthQuery = vi.hoisted(() => vi.fn())

vi.mock('@/api/health', () => ({
  fetchDashboard: mockFetchDashboard,
  fetchHealthQuery: mockFetchHealthQuery,
}))

// ==================== 测试 ====================

import { useDashboard } from '@/composables/useDashboard'
import type { UseDashboardReturn } from '@/composables/useDashboard'

describe('useDashboard', () => {
  let dash: UseDashboardReturn

  beforeEach(() => {
    vi.clearAllMocks()
    dash = useDashboard()
  })

  // ==================== navigateDate ====================

  describe('navigateDate', () => {
    it('向后导航一天 (dir=-1)', () => {
      mockFetchDashboard.mockResolvedValue({ health: { heart_rate: { avg: 72 } }, perception: {} })
      mockFetchHealthQuery.mockResolvedValue({ status: 'ok', samples: [] })
      dash.dashDate.value = '2026-06-23'
      dash.navigateDate(-1)
      expect(dash.dashDate.value).toBe('2026-06-22')
    })

    it('向前导航一天 (dir=1)', () => {
      mockFetchDashboard.mockResolvedValue({ health: { heart_rate: { avg: 72 } }, perception: {} })
      mockFetchHealthQuery.mockResolvedValue({ status: 'ok', samples: [] })
      dash.dashDate.value = '2026-06-22'
      dash.navigateDate(1)
      expect(dash.dashDate.value).toBe('2026-06-23')
    })

    it('跨月导航正确', () => {
      mockFetchDashboard.mockResolvedValue({ health: { heart_rate: { avg: 72 } }, perception: {} })
      mockFetchHealthQuery.mockResolvedValue({ status: 'ok', samples: [] })
      dash.dashDate.value = '2026-03-01'
      dash.navigateDate(-1)
      expect(dash.dashDate.value).toBe('2026-02-28')
    })

    it('跨年导航正确', () => {
      mockFetchDashboard.mockResolvedValue({ health: { heart_rate: { avg: 72 } }, perception: {} })
      mockFetchHealthQuery.mockResolvedValue({ status: 'ok', samples: [] })
      dash.dashDate.value = '2026-01-01'
      dash.navigateDate(-1)
      expect(dash.dashDate.value).toBe('2025-12-31')
    })
  })

  // ==================== loadDashboardData (双源加载) ====================

  describe('loadDashboardData', () => {
    it('Dashboard API 成功时使用聚合数据', async () => {
      const dashData = { health: { heart_rate: { avg: 72 } }, perception: {} }
      mockFetchDashboard.mockResolvedValue(dashData)
      mockFetchHealthQuery.mockResolvedValue({ status: 'ok', samples: [{ t: 1000, hr: 72 }] })

      await dash.loadDashboardData('2026-06-22')

      expect(mockFetchDashboard).toHaveBeenCalledWith('2026-06-22')
      expect(dash.cachedDashData.value).toEqual(dashData)
      expect(dash.loading.value).toBe(false)
      expect(dash.loadError.value).toBe('')
    })

    it('Dashboard API 失败时降级到 Health API', async () => {
      mockFetchDashboard.mockResolvedValue(null)
      const healthData = { status: 'ok', samples: [{ t: 1000, hr: 72 }] }
      mockFetchHealthQuery.mockResolvedValue(healthData)

      await dash.loadDashboardData('2026-06-22')

      expect(mockFetchDashboard).toHaveBeenCalledWith('2026-06-22')
      expect(mockFetchHealthQuery).toHaveBeenCalled()
      expect(dash.cachedHealthData.value).toEqual(healthData)
      expect(dash.cachedDashData.value).toBeNull()
    })

    it('两个 API 都失败时设置错误信息', async () => {
      mockFetchDashboard.mockResolvedValue(null)
      mockFetchHealthQuery.mockResolvedValue(null)

      await dash.loadDashboardData('2026-06-22')

      expect(dash.loadError.value).toBe('2026-06-22 无可用数据')
      expect(dash.cachedDashData.value).toBeNull()
      expect(dash.cachedHealthData.value).toBeNull()
    })

    it('Dashboard API 返回空数据时降级', async () => {
      mockFetchDashboard.mockResolvedValue({})
      const healthData = { status: 'ok', samples: [{ t: 1000, hr: 72 }] }
      mockFetchHealthQuery.mockResolvedValue(healthData)

      await dash.loadDashboardData('2026-06-22')

      expect(mockFetchHealthQuery).toHaveBeenCalled()
      expect(dash.cachedHealthData.value).toEqual(healthData)
    })

    it('网络异常时设置错误信息', async () => {
      mockFetchDashboard.mockRejectedValue(new Error('Network error'))

      await dash.loadDashboardData('2026-06-22')

      expect(dash.loadError.value).toContain('网络请求失败')
      expect(dash.loading.value).toBe(false)
    })

    it('始终从 Health API 补充图表数据', async () => {
      const dashData = { health: { heart_rate: { avg: 72 } }, perception: {} }
      mockFetchDashboard.mockResolvedValue(dashData)
      mockFetchHealthQuery.mockResolvedValue({ status: 'ok', samples: [{ t: 1000, hr: 72 }] })

      await dash.loadDashboardData('2026-06-22')

      expect(mockFetchHealthQuery).toHaveBeenCalled()
      expect(dash.cachedHealthData.value).toBeDefined()
    })
  })

  // ==================== toggleSensor ====================

  describe('toggleSensor', () => {
    it('切换传感器可见性', () => {
      expect(dash.sensorStates['audio']).toBe(true)
      dash.toggleSensor('audio')
      expect(dash.sensorStates['audio']).toBe(false)
      dash.toggleSensor('audio')
      expect(dash.sensorStates['audio']).toBe(true)
    })

    it('未知传感器不报错', () => {
      expect(() => dash.toggleSensor('unknown')).not.toThrow()
    })

    it('所有传感器默认可见', () => {
      expect(dash.sensorStates).toEqual({
        audio: true, app: true, notify: true,
        health: true, usage: true, gps: true, battery: true,
      })
    })
  })

  // ==================== latestSample ====================

  describe('latestSample', () => {
    it('返回时间戳最大的样本', () => {
      const result = dash.latestSample([
        { t: 100, hr: 70 } as any,
        { t: 200, hr: 80 } as any,
        { t: 150, hr: 75 } as any,
      ])
      expect((result as any).hr).toBe(80)
    })

    it('空数组返回空对象', () => {
      expect(dash.latestSample([])).toEqual({})
    })

    it('null 返回空对象', () => {
      expect(dash.latestSample(null)).toEqual({})
    })

    it('undefined 返回空对象', () => {
      expect(dash.latestSample(undefined)).toEqual({})
    })
  })

  // ==================== fmtDuration ====================

  describe('fmtDuration', () => {
    it('458 分钟格式化为 "7h38m"', () => {
      expect(dash.fmtDuration(458)).toBe('7h38m')
    })

    it('45 分钟格式化为 "45m"', () => {
      expect(dash.fmtDuration(45)).toBe('45m')
    })

    it('null 返回空字符串', () => {
      expect(dash.fmtDuration(null)).toBe('')
    })

    it('undefined 返回空字符串', () => {
      expect(dash.fmtDuration(undefined)).toBe('')
    })

    it('NaN 返回空字符串', () => {
      expect(dash.fmtDuration(NaN)).toBe('')
    })

    it('0 分钟格式化为 "0m"', () => {
      expect(dash.fmtDuration(0)).toBe('0m')
    })

    it('60 分钟格式化为 "1h0m"', () => {
      expect(dash.fmtDuration(60)).toBe('1h0m')
    })
  })
})
