/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ==================== Mock API 模块 ====================

const mockApiGet = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
}))

// ==================== 测试 ====================

import { useReports } from '@/composables/useReports'
import type { UseReportsReturn } from '@/composables/useReports'
import type { ReportItem } from '@/types'

function makeReport(overrides: Partial<ReportItem> = {}): ReportItem {
  return {
    title: '报告标题',
    date: '2026-06-22',
    type: 'md',
    path: '/reports/2026-06-22.md',
    family: 'daily',
    ...overrides,
  }
}

describe('useReports', () => {
  let rp: UseReportsReturn

  beforeEach(() => {
    vi.clearAllMocks()
    rp = useReports()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ==================== loadReportList ====================

  describe('loadReportList', () => {
    it('只请求一次完整的报告列表, 不带标签查询', async () => {
      const reports = [makeReport()]
      mockApiGet.mockResolvedValue({ reports })

      await rp.loadReportList()

      expect(mockApiGet).toHaveBeenCalledTimes(1)
      expect(mockApiGet).toHaveBeenCalledWith('/api/mobile/reports')
      expect(rp.reports.value).toEqual(reports)
      expect(rp.loading.value).toBe(false)
    })

    it('API 返回空数组时清空列表', async () => {
      mockApiGet.mockResolvedValue({ reports: [] })

      await rp.loadReportList()

      expect(rp.reports.value).toEqual([])
      expect(rp.counts.value).toEqual({ health: 0, daily: 0, weekly: 0, review: 0 })
    })

    it('API 返回 null 时清空列表', async () => {
      mockApiGet.mockResolvedValue(null)

      await rp.loadReportList()

      expect(rp.reports.value).toEqual([])
    })

    it('API 异常时不注入模拟数据并标记错误', async () => {
      mockApiGet.mockRejectedValue(new Error('Network error'))

      await rp.loadReportList()

      expect(rp.reports.value).toEqual([])
      expect(rp.error.value).toBe(true)
      expect(rp.loading.value).toBe(false)
    })

    it('API 异常时保留已有报告并标记错误', async () => {
      const existing = [makeReport({ title: '已有报告' })]
      rp.reports.value = existing
      mockApiGet.mockRejectedValue(new Error('Network error'))

      await rp.loadReportList()

      expect(rp.reports.value).toEqual(existing)
      expect(rp.error.value).toBe(true)
    })

    it('加载成功时清除 error 标记', async () => {
      mockApiGet.mockRejectedValueOnce(new Error('Network error'))
      await rp.loadReportList()
      expect(rp.error.value).toBe(true)

      mockApiGet.mockResolvedValue({ reports: [makeReport()] })
      await rp.loadReportList()
      expect(rp.error.value).toBe(false)
    })

    it('加载期间 loading 为 true', async () => {
      let resolvePromise: (value: unknown) => void
      mockApiGet.mockImplementation(() => {
        return new Promise((resolve) => {
          resolvePromise = resolve
        })
      })

      const promise = rp.loadReportList()

      expect(rp.loading.value).toBe(true)

      resolvePromise!({ reports: [] })
      await promise

      expect(rp.loading.value).toBe(false)
    })

    it('每次加载后分页复位到 50 条', async () => {
      rp.reports.value = Array.from({ length: 120 }, (_, index) =>
        makeReport({ title: `D${index}`, family: 'daily' }),
      )
      rp.familyFilter.value = 'daily'
      rp.loadMore()
      expect(rp.visibleReports.value).toHaveLength(100)

      mockApiGet.mockResolvedValue({
        reports: Array.from({ length: 120 }, (_, index) =>
          makeReport({ title: `Refreshed${index}`, family: 'daily' }),
        ),
      })
      await rp.loadReportList()

      expect(rp.familyFilter.value).toBe('daily')
      expect(rp.visibleReports.value).toHaveLength(50)
    })
  })

  // ==================== counts ====================

  describe('counts', () => {
    it('基于完整列表统计四类数量 (含 0)', () => {
      rp.reports.value = [
        makeReport({ family: 'health' }),
        makeReport({ family: 'health' }),
        makeReport({ family: 'daily' }),
        makeReport({ family: 'weekly' }),
        makeReport({ family: 'review' }),
      ]

      expect(rp.counts.value).toEqual({ health: 2, daily: 1, weekly: 1, review: 1 })
    })

    it('行数据缺少 family 时按 kind 回退归类', () => {
      rp.reports.value = [
        makeReport({ family: undefined, kind: 'daily' }),
        makeReport({ family: undefined, kind: 'weekly' }),
        makeReport({ family: undefined, kind: 'audit' }),
        makeReport({ family: undefined, kind: 'other' }),
      ]

      expect(rp.counts.value).toEqual({ health: 0, daily: 1, weekly: 1, review: 1 })
    })

    it('无法从行数据分类时退回 API counts', async () => {
      mockApiGet.mockResolvedValue({
        reports: [makeReport({ family: undefined, kind: undefined })],
        counts: { health: 3, daily: 2, weekly: 1, review: 4 },
      })

      await rp.loadReportList()

      expect(rp.counts.value).toEqual({ health: 3, daily: 2, weekly: 1, review: 4 })
    })

    it('可分类时优先使用行数据, 不被 API counts 覆盖', async () => {
      mockApiGet.mockResolvedValue({
        reports: [makeReport({ family: 'weekly' })],
        counts: { health: 9, daily: 9, weekly: 9, review: 9 },
      })

      await rp.loadReportList()

      expect(rp.counts.value).toEqual({ health: 0, daily: 0, weekly: 1, review: 0 })
    })

    it('切换筛选时四类计数不缩减', () => {
      rp.reports.value = [
        makeReport({ family: 'health' }),
        makeReport({ family: 'daily' }),
        makeReport({ family: 'weekly' }),
        makeReport({ family: 'review' }),
      ]

      rp.familyFilter.value = 'daily'

      expect(rp.counts.value).toEqual({ health: 1, daily: 1, weekly: 1, review: 1 })
      expect(rp.reportCount.value).toBe(1)
    })
  })

  // ==================== filteredReports ====================

  describe('filteredReports', () => {
    it('默认筛选为 all, 返回所有报告', () => {
      rp.reports.value = [
        makeReport({ title: 'A', date: '2026-06-22' }),
        makeReport({ title: 'B', date: '2026-06-21' }),
      ]

      expect(rp.familyFilter.value).toBe('all')
      expect(rp.filteredReports.value).toHaveLength(2)
    })

    it('按报告类别筛选', () => {
      rp.reports.value = [
        makeReport({ title: 'H', family: 'health' }),
        makeReport({ title: 'D', family: 'daily' }),
        makeReport({ title: 'D2', family: 'daily' }),
        makeReport({ title: 'W', family: 'weekly' }),
        makeReport({ title: 'R', family: 'review' }),
      ]

      rp.familyFilter.value = 'daily'

      expect(rp.filteredReports.value.map((report) => report.title)).toEqual(['D', 'D2'])
    })

    it('kind 回退行也能参与类别筛选', () => {
      rp.reports.value = [
        makeReport({ title: 'D', family: undefined, kind: 'daily' }),
        makeReport({ title: 'R', family: undefined, kind: 'audit' }),
        makeReport({ title: 'X', family: undefined, kind: 'other' }),
      ]

      rp.familyFilter.value = 'review'
      expect(rp.filteredReports.value.map((report) => report.title)).toEqual(['R'])

      rp.familyFilter.value = 'health'
      expect(rp.filteredReports.value).toEqual([])
    })

    it('按日期降序排序', () => {
      rp.reports.value = [
        makeReport({ title: 'C', date: '2026-06-20' }),
        makeReport({ title: 'A', date: '2026-06-22' }),
        makeReport({ title: 'B', date: '2026-06-21' }),
      ]

      expect(rp.filteredReports.value.map((report) => report.title)).toEqual(['A', 'B', 'C'])
    })

    it('返回新数组不修改原数组', () => {
      const original = [
        makeReport({ title: 'B', date: '2026-06-21' }),
        makeReport({ title: 'A', date: '2026-06-22' }),
      ]
      rp.reports.value = original

      const filtered = rp.filteredReports.value
      expect(filtered).not.toBe(original)
      expect(original[0].title).toBe('B')
    })
  })

  // ==================== reportCount ====================

  describe('reportCount', () => {
    it('返回筛选后的报告数量', () => {
      rp.reports.value = [
        makeReport({ family: 'daily' }),
        makeReport({ family: 'daily' }),
        makeReport({ family: 'health' }),
      ]
      rp.familyFilter.value = 'daily'

      expect(rp.reportCount.value).toBe(2)
    })

    it('空列表返回 0', () => {
      rp.reports.value = []

      expect(rp.reportCount.value).toBe(0)
    })
  })

  // ==================== 分页 ====================

  describe('pagination', () => {
    it('类别视图首屏 50 条, loadMore 每次 +50', () => {
      rp.reports.value = Array.from({ length: 120 }, (_, index) =>
        makeReport({ title: `D${index}`, family: 'daily' }),
      )
      rp.familyFilter.value = 'daily'

      expect(rp.visibleReports.value).toHaveLength(50)
      expect(rp.hasMore.value).toBe(true)

      rp.loadMore()
      expect(rp.visibleReports.value).toHaveLength(100)
      expect(rp.hasMore.value).toBe(true)

      rp.loadMore()
      expect(rp.visibleReports.value).toHaveLength(120)
      expect(rp.hasMore.value).toBe(false)

      rp.loadMore()
      expect(rp.visibleReports.value).toHaveLength(120)
    })

    it('全部视图返回完整列表且没有下一页', () => {
      rp.reports.value = Array.from({ length: 60 }, (_, index) =>
        makeReport({ title: `R${index}`, family: 'review' }),
      )

      expect(rp.visibleReports.value).toHaveLength(60)
      expect(rp.hasMore.value).toBe(false)
    })

    it('切换类别后分页复位到 50 条', () => {
      rp.reports.value = [
        ...Array.from({ length: 120 }, (_, index) =>
          makeReport({ title: `D${index}`, family: 'daily' }),
        ),
        ...Array.from({ length: 60 }, (_, index) =>
          makeReport({ title: `W${index}`, family: 'weekly' }),
        ),
      ]

      rp.familyFilter.value = 'daily'
      rp.loadMore()
      rp.loadMore()
      expect(rp.visibleReports.value).toHaveLength(120)

      rp.familyFilter.value = 'weekly'
      expect(rp.visibleReports.value).toHaveLength(50)
      expect(rp.hasMore.value).toBe(true)
    })
  })
})
