/// <reference types="vitest/globals" />

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const fetchDashboard = vi.hoisted(() => vi.fn())

vi.mock('@/api/health', () => ({
  fetchDashboard,
}))

import { useHealthSummary } from '@/composables/useHealthSummary'

const FULL_DASHBOARD = {
  health: {
    heart_rate: { avg: 72 },
    steps: 8421,
    sleep: { duration_min: 452 },
    spo2: { avg: 97 },
    stress: { avg: 32 },
  },
  perception: {
    gps_records: 1071,
    battery_timeline: [
      { t: 1000, level: 90 },
      { t: 2000, level: 82 },
    ],
  },
}

function metricValue(
  metrics: ReturnType<typeof useHealthSummary>['metrics']['value'],
  key: string,
): string | undefined {
  return metrics.find((metric) => metric.key === key)?.value
}

describe('useHealthSummary', () => {
  beforeEach(() => {
    fetchDashboard.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps dashboard health and perception fields to the seven strip metrics', async () => {
    fetchDashboard.mockResolvedValue(FULL_DASHBOARD)
    const summary = useHealthSummary()

    await summary.load('2026-10-24')

    expect(fetchDashboard).toHaveBeenCalledWith('2026-10-24')
    expect(summary.date.value).toBe('2026-10-24')
    expect(summary.loading.value).toBe(false)
    expect(summary.error.value).toBe(false)

    const metrics = summary.metrics.value
    expect(metrics.map((metric) => metric.key)).toEqual([
      'heartRate',
      'steps',
      'sleep',
      'spo2',
      'stress',
      'battery',
      'gps',
    ])
    expect(metricValue(metrics, 'heartRate')).toBe('72')
    expect(metricValue(metrics, 'steps')).toBe('8,421')
    expect(metricValue(metrics, 'sleep')).toBe('7h32m')
    expect(metricValue(metrics, 'spo2')).toBe('97')
    expect(metricValue(metrics, 'stress')).toBe('32')
    expect(metricValue(metrics, 'battery')).toBe('82')
    expect(metricValue(metrics, 'gps')).toBe('1,071')
  })

  it('renders missing individual values as an em dash without inventing numbers', async () => {
    fetchDashboard.mockResolvedValue({
      health: { steps: 0 },
      perception: {},
    })
    const summary = useHealthSummary()

    await summary.load('2026-10-24')

    expect(summary.error.value).toBe(false)
    const metrics = summary.metrics.value
    expect(metricValue(metrics, 'heartRate')).toBe('—')
    expect(metricValue(metrics, 'steps')).toBe('0')
    expect(metricValue(metrics, 'sleep')).toBe('—')
    expect(metricValue(metrics, 'spo2')).toBe('—')
    expect(metricValue(metrics, 'stress')).toBe('—')
    expect(metricValue(metrics, 'battery')).toBe('—')
    expect(metricValue(metrics, 'gps')).toBe('—')
  })

  it('marks an empty response as unavailable and exposes only em dashes', async () => {
    fetchDashboard.mockResolvedValue(null)
    const summary = useHealthSummary()

    await summary.load('2026-10-24')

    expect(summary.error.value).toBe(true)
    expect(summary.metrics.value.every((metric) => metric.value === '—')).toBe(true)
  })

  it('marks a thrown request as unavailable instead of falling back to mock data', async () => {
    fetchDashboard.mockRejectedValue(new Error('network down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const summary = useHealthSummary()

    await summary.load('2026-10-24')

    expect(summary.error.value).toBe(true)
    expect(summary.loading.value).toBe(false)
    expect(summary.metrics.value.every((metric) => metric.value === '—')).toBe(true)
  })

  it('retries after a failure and replaces the unavailable state with real data', async () => {
    fetchDashboard.mockResolvedValueOnce(null).mockResolvedValueOnce(FULL_DASHBOARD)
    const summary = useHealthSummary()

    await summary.load('2026-10-24')
    expect(summary.error.value).toBe(true)

    await summary.load()

    expect(fetchDashboard).toHaveBeenNthCalledWith(1, '2026-10-24')
    expect(fetchDashboard).toHaveBeenNthCalledWith(2, '2026-10-24')
    expect(summary.error.value).toBe(false)
    expect(metricValue(summary.metrics.value, 'steps')).toBe('8,421')
  })
})
