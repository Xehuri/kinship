import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ReportRow from '@/components/reports/ReportRow.vue'
import type { ReportItem, ReportKind } from '@/types'

function makeReport(overrides: Partial<ReportItem> = {}): ReportItem {
  return {
    title: '每日理解记录',
    date: '2026-10-24',
    type: 'md',
    path: 'data/daily/2026-10-24/复盘-2026-10-24.md',
    ...overrides,
  }
}

describe('ReportRow', () => {
  it('renders title, family label, date and formatted size', () => {
    const wrapper = mount(ReportRow, {
      props: {
        report: makeReport({ family: 'weekly', size_bytes: 2048 }),
      },
    })

    expect(wrapper.find('.ax-row__title').text()).toBe('每日理解记录')
    expect(wrapper.find('.ax-report-row__kind').text()).toBe('周报')
    expect(wrapper.findAll('.ax-row__mono')[0].text()).toBe('2026-10-24')
    expect(wrapper.findAll('.ax-row__mono')[1].text()).toBe('2.0 KB')
  })

  it('prefers the family label over the legacy kind label', () => {
    const wrapper = mount(ReportRow, {
      props: {
        report: makeReport({ family: 'health', kind: 'audit' }),
      },
    })

    expect(wrapper.find('.ax-report-row__kind').text()).toBe('健康清单')
  })

  it('falls back to the kind label when family is absent', () => {
    const cases = [
      ['daily', '日报'],
      ['weekly', '周报'],
      ['monthly', '月报'],
      ['audit', '审计'],
      ['other', '其他'],
    ] as const

    for (const [kind, label] of cases) {
      const wrapper = mount(ReportRow, {
        props: { report: makeReport({ family: undefined, kind }) },
      })
      expect(wrapper.find('.ax-report-row__kind').text()).toBe(label)
    }
  })

  it('falls back to a dash for unknown or missing kinds', () => {
    const unknown = mount(ReportRow, {
      props: { report: makeReport({ family: undefined, kind: 'mystery' as ReportKind }) },
    })
    expect(unknown.find('.ax-report-row__kind').text()).toBe('—')

    const missing = mount(ReportRow, {
      props: { report: makeReport({ family: undefined, kind: undefined }) },
    })
    expect(missing.find('.ax-report-row__kind').text()).toBe('—')
  })

  it('omits size when the backend does not send it', () => {
    const wrapper = mount(ReportRow, {
      props: { report: makeReport({ family: 'review', size_bytes: undefined }) },
    })

    expect(wrapper.findAll('.ax-row__mono')[0].text()).toBe('2026-10-24')
    expect(wrapper.find('.ax-report-row__empty').text()).toBe('—')
    expect(wrapper.text()).not.toContain('KB')
  })

  it('emits open with the report on click', async () => {
    const report = makeReport({ family: 'daily' })
    const wrapper = mount(ReportRow, { props: { report } })

    await wrapper.find('button.ax-report-row').trigger('click')

    expect(wrapper.emitted('open')?.[0]).toEqual([report])
  })
})
