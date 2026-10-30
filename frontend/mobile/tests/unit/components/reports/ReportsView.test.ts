import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { ReportFamily, ReportItem } from '@/types'

const apiGet = vi.hoisted(() => vi.fn())
const fetchDashboard = vi.hoisted(() => vi.fn())
const fetchReportContent = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGet,
}))

vi.mock('@/api/health', () => ({
  fetchDashboard,
}))

vi.mock('@/api/reports', () => ({
  fetchReportContent,
}))

import ReportsView from '@/views/ReportsView.vue'
import { useReportsSingleton } from '@/composables/useReports'

function makeReport(overrides: Partial<ReportItem> = {}): ReportItem {
  return {
    title: '每日复盘',
    date: '2026-10-24',
    type: 'md',
    path: 'data/daily/2026-10-24/复盘-2026-10-24.md',
    kind: 'daily',
    family: 'daily',
    size_bytes: 1024,
    md: '# 报告正文',
    ...overrides,
  }
}

function familyReports(family: ReportFamily, count: number): ReportItem[] {
  return Array.from({ length: count }, (_, index) =>
    makeReport({
      title: `${family}-${index}`,
      date: `2026-10-${String(28 - (index % 28)).padStart(2, '0')}`,
      path: `data/${family}/${index}.md`,
      family,
      kind: family === 'review' ? 'audit' : family === 'health' ? 'other' : family,
    }),
  )
}

const FULL_REPORTS = [
  ...familyReports('health', 2),
  ...familyReports('daily', 2),
  ...familyReports('weekly', 1),
  ...familyReports('review', 1),
]

const HEALTH_DASHBOARD = {
  health: {
    heart_rate: { avg: 72 },
    steps: 8421,
    sleep: { duration_min: 452 },
    spo2: { avg: 97 },
    stress: { avg: 32 },
  },
  perception: {
    gps_records: 1071,
    battery_timeline: [{ t: 1000, level: 90 }, { t: 2000, level: 82 }],
  },
}

const stubs = {
  AppShell: { template: '<div class="ax-shell"><slot /></div>' },
  DetailOverlay: {
    props: ['visible', 'title'],
    template: '<div v-if="visible" class="detail-stub"><slot /></div>',
  },
  MarkdownContent: {
    props: ['content'],
    template: '<div class="markdown-stub">{{ content }}</div>',
  },
  GpsMapOverlay: {
    props: ['visible'],
    template: '<div v-if="visible" data-testid="gps-overlay-stub" />',
  },
  VoiceprintSheet: {
    props: ['visible'],
    template: '<div v-if="visible" data-testid="voiceprint-sheet-stub"><slot /></div>',
  },
  VoiceprintTab: true,
}

describe('ReportsView', () => {
  const reportsApi = useReportsSingleton()

  beforeEach(() => {
    apiGet.mockReset()
    fetchDashboard.mockReset()
    fetchReportContent.mockReset()
    fetchDashboard.mockResolvedValue(HEALTH_DASHBOARD)
    reportsApi.familyFilter.value = 'all'
    reportsApi.reports.value = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders five family tabs with counts and four grouped sections', async () => {
    apiGet.mockResolvedValue({ reports: FULL_REPORTS })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    const tabs = [
      ['all', '全部', '6'],
      ['health', '健康清单', '2'],
      ['daily', '日报', '2'],
      ['weekly', '周报', '1'],
      ['review', '复盘', '1'],
    ] as const

    for (const [id, label, count] of tabs) {
      const tab = wrapper.get(`[data-testid="report-tab-${id}"]`)
      expect(tab.text()).toContain(label)
      expect(tab.get(`[data-testid="report-tab-count-${id}"]`).text()).toBe(count)
      expect(tab.attributes('aria-pressed')).toBe(id === 'all' ? 'true' : 'false')
    }

    const sections = [
      ['health', '健康清单', '2'],
      ['daily', '日报', '2'],
      ['weekly', '周报', '1'],
      ['review', '复盘', '1'],
    ] as const

    for (const [family, label, count] of sections) {
      const section = wrapper.get(`[data-testid="report-section-${family}"]`)
      expect(section.get('h2').text()).toBe(label)
      expect(section.get(`[data-testid="report-section-count-${family}"]`).text()).toBe(count)
    }

    expect(wrapper.findAll('button.ax-report-row')).toHaveLength(6)
    expect(wrapper.findAll('.ax-chip')).toHaveLength(0)
  })

  it('filters by family in memory without refetching and keeps all tab counts', async () => {
    apiGet.mockResolvedValue({ reports: FULL_REPORTS })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    await wrapper.get('[data-testid="report-tab-daily"]').trigger('click')
    await flushPromises()

    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="report-tab-daily"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="report-section-health"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="report-section-daily"]')).toBeTruthy()
    expect(wrapper.findAll('button.ax-report-row')).toHaveLength(2)
    expect(wrapper.get('[data-testid="report-tab-count-health"]').text()).toBe('2')
    expect(wrapper.get('[data-testid="report-tab-count-review"]').text()).toBe('1')

    await wrapper.get('[data-testid="report-tab-all"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="report-section-health"]').exists()).toBe(true)
  })

  it('shows the latest 8 rows per family and opens the full family from the section action', async () => {
    const reports = familyReports('health', 10)
    apiGet.mockResolvedValue({ reports })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    const section = wrapper.get('[data-testid="report-section-health"]')
    expect(section.findAll('button.ax-report-row')).toHaveLength(8)

    const more = section.get('[data-testid="report-section-more-health"]')
    expect(more.text()).toContain('查看全部 10 份')
    await more.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="report-section-health"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="report-section-daily"]')).toHaveLength(0)
    expect(wrapper.findAll('button.ax-report-row')).toHaveLength(10)
    expect(wrapper.get('[data-testid="report-tab-health"]').attributes('aria-pressed')).toBe('true')
  })

  it('pages a family view at 50 rows and increments by 50', async () => {
    apiGet.mockResolvedValue({ reports: familyReports('daily', 55) })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    await wrapper.get('[data-testid="report-tab-daily"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('button.ax-report-row')).toHaveLength(50)
    const more = wrapper.get('[data-testid="reports-load-more"]')
    expect(more.text()).toBe('加载更多')

    await more.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('button.ax-report-row')).toHaveLength(55)
    expect(wrapper.find('[data-testid="reports-load-more"]').exists()).toBe(false)
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('renders the total empty state when there are no reports', async () => {
    apiGet.mockResolvedValue({ reports: [] })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    const empty = wrapper.get('[data-testid="reports-empty"]')
    expect(empty.text()).toContain('暂无报告')
    expect(empty.text()).toContain('仅显示健康清单、日报、周报与复盘；未生成时会出现在这里。')
    expect(wrapper.findAll('[data-testid^="report-section-"]')).toHaveLength(0)
  })

  it('renders a family empty state with a path back to all reports', async () => {
    apiGet.mockResolvedValue({ reports: familyReports('daily', 2) })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    await wrapper.get('[data-testid="report-tab-health"]').trigger('click')
    await flushPromises()

    const empty = wrapper.get('[data-testid="reports-family-empty"]')
    expect(empty.text()).toContain('暂无健康清单')
    expect(empty.text()).toContain('这一类还没有报告。')

    await empty.get('.ax-state__action').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="reports-family-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="report-section-daily"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="report-tab-all"]').attributes('aria-pressed')).toBe('true')
  })

  it('renders an error state and retries through the reports composable', async () => {
    apiGet.mockRejectedValue(new Error('network down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('.ax-state[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('加载失败')

    await wrapper.find('.ax-state__action').trigger('click')
    await flushPromises()
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('renders the health strip above the toolbar and keeps the report list below', async () => {
    apiGet.mockResolvedValue({ reports: FULL_REPORTS })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    const page = wrapper.find('.ax-page')
    expect(page.element.firstElementChild?.getAttribute('data-testid')).toBe('health-summary')

    const metrics = wrapper.findAll('[data-testid="health-metric"]')
    expect(metrics).toHaveLength(7)
    const text = metrics.map((metric) => metric.text()).join(' ')
    expect(text).toContain('72')
    expect(text).toContain('8,421')
    expect(text).toContain('7h32m')
    expect(text).toContain('97')
    expect(text).toContain('32')
    expect(text).toContain('82')
    expect(text).toContain('1,071')

    expect(wrapper.findAll('button.ax-report-row')).toHaveLength(6)
    expect(fetchDashboard).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('opens the GPS overlay and the voiceprint sheet from the strip actions', async () => {
    apiGet.mockResolvedValue({ reports: FULL_REPORTS })

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('[data-testid="gps-overlay-stub"]').exists()).toBe(false)

    await wrapper.find('[data-testid="health-gps-action"]').trigger('click')
    expect(wrapper.find('[data-testid="gps-overlay-stub"]').exists()).toBe(true)

    expect(wrapper.find('[data-testid="voiceprint-sheet-stub"]').exists()).toBe(false)
    await wrapper.find('[data-testid="health-voiceprint-action"]').trigger('click')
    expect(wrapper.find('[data-testid="voiceprint-sheet-stub"]').exists()).toBe(true)
  })

  it('opens inline detail and loads missing markdown through fetchReportContent', async () => {
    apiGet.mockResolvedValue({
      reports: [
        makeReport({ title: '内联报告', md: '# 内联正文' }),
        makeReport({ title: '远程报告', path: 'data/daily/2026-10-24/remote.md', md: undefined }),
      ],
    })
    fetchReportContent.mockResolvedValue('# 远程正文')

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    await wrapper.findAll('button.ax-report-row')[0].trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="report-detail"]').text()).toContain('# 内联正文')
    expect(fetchReportContent).not.toHaveBeenCalled()

    await wrapper.findAll('button.ax-report-row')[1].trigger('click')
    await flushPromises()
    expect(fetchReportContent).toHaveBeenCalledWith('data/daily/2026-10-24/remote.md')
    expect(wrapper.get('[data-testid="report-detail"]').text()).toContain('# 远程正文')
  })

  it('shows a compact unavailable state with retry and never fabricates health numbers', async () => {
    apiGet.mockResolvedValue({ reports: FULL_REPORTS })
    fetchDashboard.mockReset()
    fetchDashboard.mockResolvedValueOnce(null).mockResolvedValueOnce(HEALTH_DASHBOARD)

    const wrapper = mount(ReportsView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('[data-testid="health-summary"]').text()).toContain('健康数据暂不可用')
    expect(wrapper.findAll('[data-testid="health-metric"]')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('8,421')
    expect(wrapper.findAll('button.ax-report-row')).toHaveLength(6)

    await wrapper.find('[data-testid="health-retry"]').trigger('click')
    await flushPromises()

    expect(fetchDashboard).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-testid="health-metric"]')).toHaveLength(7)
    expect(wrapper.find('[data-testid="health-summary"]').text()).toContain('8,421')
  })
})
