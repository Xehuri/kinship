/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ==================== Mock API 模块 ====================

const mockFetchFileContent = vi.hoisted(() => vi.fn())

vi.mock('@/api/files', () => ({
  fetchFileContent: mockFetchFileContent,
}))

// ==================== 测试 ====================

import { useGps } from '@/composables/useGps'
import type { UseGpsReturn } from '@/composables/useGps'
import type { PerceptionObject, GpsRawPoint } from '@/types'

describe('useGps', () => {
  let gps: UseGpsReturn

  beforeEach(() => {
    vi.clearAllMocks()
    gps = useGps()
  })

  // ==================== parseGpsFromPerception ====================

  describe('parseGpsFromPerception', () => {
    it('解析字符串格式 GPS "lat,lng"', () => {
      const objects: PerceptionObject[] = [
        { t: '10:00', gps: '39.9042,116.4074', place: '北京' },
      ]
      const result = gps.parseGpsFromPerception(objects)
      expect(result).toHaveLength(1)
      expect(result[0].lat).toBe(39.9042)
      expect(result[0].lng).toBe(116.4074)
      expect(result[0].place).toBe('北京')
      expect(result[0].t).toBe('10:00')
    })

    it('解析数组格式 GPS [{lat, lng}]', () => {
      const objects: PerceptionObject[] = [
        { t: '11:00', gps: [{ lat: 31.2304, lng: 121.4737 }] as unknown as string, place: '上海' },
      ]
      const result = gps.parseGpsFromPerception(objects)
      expect(result).toHaveLength(1)
      expect(result[0].lat).toBe(31.2304)
      expect(result[0].lng).toBe(121.4737)
    })

    it('跳过无 GPS 的对象', () => {
      const objects: PerceptionObject[] = [
        { t: '10:00', gps: '39.9042,116.4074', place: '北京' },
        { t: '11:00', place: '无GPS' },
        { t: '12:00', gps: '31.2304,121.4737', place: '上海' },
      ]
      const result = gps.parseGpsFromPerception(objects)
      expect(result).toHaveLength(2)
    })

    it('空数组返回空列表', () => {
      expect(gps.parseGpsFromPerception([])).toEqual([])
    })

    it('不完整 GPS 字符串被忽略', () => {
      const objects: PerceptionObject[] = [
        { gps: 'invalid' } as PerceptionObject,
      ]
      expect(gps.parseGpsFromPerception(objects)).toEqual([])
    })

    it('无 place 时使用默认名称', () => {
      const objects: PerceptionObject[] = [
        { t: '10:00', gps: '39.9042,116.4074' },
      ]
      const result = gps.parseGpsFromPerception(objects)
      expect(result[0].place).toBe('未知位置')
    })

    it('无 t 时使用默认时间 "12:00"', () => {
      const objects: PerceptionObject[] = [
        { gps: '39.9042,116.4074' },
      ]
      const result = gps.parseGpsFromPerception(objects)
      expect(result[0].t).toBe('12:00')
    })

    it('数组格式中跳过缺字段的对象', () => {
      const objects: PerceptionObject[] = [
        { gps: [{ lat: 31.2304 }] as unknown as string },
      ]
      const result = gps.parseGpsFromPerception(objects)
      expect(result).toHaveLength(0)
    })
  })

  // ==================== mergeGpsPoints ====================

  describe('mergeGpsPoints', () => {
    it('合并连续相同位置的点', () => {
      const points: GpsRawPoint[] = [
        { t: '10:00', lat: 39.9, lng: 116.4, place: '北京' },
        { t: '10:05', lat: 39.9, lng: 116.4, place: '北京' },
        { t: '10:10', lat: 39.9, lng: 116.4, place: '北京' },
      ]
      const result = gps.mergeGpsPoints(points)
      expect(result).toHaveLength(1)
      expect(result[0].timeStart).toBe('10:00')
      expect(result[0].timeEnd).toBe('10:10')
      expect(result[0].count).toBe(3)
    })

    it('不同位置保持独立不合并', () => {
      const points: GpsRawPoint[] = [
        { t: '10:00', lat: 39.9, lng: 116.4, place: '北京' },
        { t: '11:00', lat: 31.2, lng: 121.4, place: '上海' },
      ]
      const result = gps.mergeGpsPoints(points)
      expect(result).toHaveLength(2)
      expect(result[0].count).toBe(1)
      expect(result[1].count).toBe(1)
    })

    it('相同位置不连续时不合并', () => {
      const points: GpsRawPoint[] = [
        { t: '10:00', lat: 39.9, lng: 116.4, place: '北京' },
        { t: '11:00', lat: 31.2, lng: 121.4, place: '上海' },
        { t: '12:00', lat: 39.9, lng: 116.4, place: '北京' },
      ]
      const result = gps.mergeGpsPoints(points)
      expect(result).toHaveLength(3)
    })

    it('空数组返回空列表', () => {
      expect(gps.mergeGpsPoints([])).toEqual([])
    })

    it('单个点保持原样', () => {
      const points: GpsRawPoint[] = [
        { t: '10:00', lat: 39.9, lng: 116.4, place: '北京' },
      ]
      const result = gps.mergeGpsPoints(points)
      expect(result).toHaveLength(1)
      expect(result[0].count).toBe(1)
      expect(result[0].timeStart).toBe('10:00')
      expect(result[0].timeEnd).toBe('10:00')
    })
  })

  // ==================== loadGpsData ====================

  describe('loadGpsData', () => {
    it('加载并解析 GPS 数据', async () => {
      mockFetchFileContent.mockResolvedValue({
        objects: [
          { t: '10:00', gps: '39.9,116.4', place: '北京' },
          { t: '11:00', gps: '31.2,121.4', place: '上海' },
        ],
      })

      await gps.loadGpsData('2026-06-22')

      expect(mockFetchFileContent).toHaveBeenCalledWith('data/daily/2026-06-22/perception.jsonl')
      expect(gps.gpsRawPoints.value).toHaveLength(2)
      expect(gps.hasData.value).toBe(true)
      expect(gps.loading.value).toBe(false)
    })

    it('API 返回 null 时保持空数据', async () => {
      mockFetchFileContent.mockResolvedValue(null)

      await gps.loadGpsData('2026-06-22')

      expect(gps.gpsRawPoints.value).toEqual([])
      expect(gps.hasData.value).toBe(false)
    })

    it('API 异常时清空数据并设置 loading=false', async () => {
      mockFetchFileContent.mockRejectedValue(new Error('Network error'))

      await gps.loadGpsData('2026-06-22')

      expect(gps.gpsRawPoints.value).toEqual([])
      expect(gps.hasData.value).toBe(false)
      expect(gps.loading.value).toBe(false)
    })

    it('无 GPS 对象的文件不产生数据', async () => {
      mockFetchFileContent.mockResolvedValue({
        objects: [{ t: '10:00' }],
      })

      await gps.loadGpsData('2026-06-22')

      expect(gps.gpsRawPoints.value).toEqual([])
      expect(gps.hasData.value).toBe(false)
    })

    it('空 objects 数组不产生数据', async () => {
      mockFetchFileContent.mockResolvedValue({
        objects: [],
      })

      await gps.loadGpsData('2026-06-22')

      expect(gps.gpsRawPoints.value).toEqual([])
    })

    it('无 objects 字段的响应不产生数据', async () => {
      mockFetchFileContent.mockResolvedValue({})

      await gps.loadGpsData('2026-06-22')

      expect(gps.gpsRawPoints.value).toEqual([])
    })
  })

  // ==================== gpsPointData (computed) ====================

  describe('gpsPointData', () => {
    it('自动合并原始数据', () => {
      gps.gpsRawPoints.value = [
        { t: '10:00', lat: 39.9, lng: 116.4, place: '北京' },
        { t: '10:05', lat: 39.9, lng: 116.4, place: '北京' },
      ]
      expect(gps.gpsPointData.value).toHaveLength(1)
      expect(gps.gpsPointData.value[0].count).toBe(2)
    })

    it('空数据时返回空列表', () => {
      expect(gps.gpsPointData.value).toEqual([])
    })
  })

  // ==================== hasData (computed) ====================

  describe('hasData', () => {
    it('有点数据时返回 true', () => {
      gps.gpsRawPoints.value = [
        { t: '10:00', lat: 39.9, lng: 116.4, place: '北京' },
      ]
      expect(gps.hasData.value).toBe(true)
    })

    it('无点数据时返回 false', () => {
      expect(gps.hasData.value).toBe(false)
    })
  })

  // ==================== clearGpsData ====================

  describe('clearGpsData', () => {
    it('清空所有 GPS 数据并重置索引', () => {
      gps.gpsRawPoints.value = [
        { t: '10:00', lat: 39.9, lng: 116.4, place: '北京' },
      ]
      gps.gpsSelectedIdx.value = 3
      gps.clearGpsData()
      expect(gps.gpsRawPoints.value).toEqual([])
      expect(gps.gpsSelectedIdx.value).toBe(0)
    })
  })
})
