import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CoverageStrip from '@/components/plan/CoverageStrip.vue'
import { COVERAGE, PLAN } from './fixtures'

const EXPECTED_TIMES = [
  '00:00（分析昨天）',
  '06:00',
  '08:00',
  '12:00',
  '16:00',
  '20:00',
  '22:00',
]

describe('CoverageStrip', () => {
  it('renders the seven merged_7 checkpoints in order', () => {
    const wrapper = mount(CoverageStrip, {
      props: { coverage: COVERAGE, items: PLAN.items },
    })

    const rows = wrapper.findAll('[data-testid="coverage-row"]')
    expect(rows).toHaveLength(7)
    expect(rows.map((row) => row.attributes('data-checkpoint'))).toEqual(
      COVERAGE.checkpoints,
    )
    expect(rows.map((row) => row.find('.plan-coverage__time').text())).toEqual(
      EXPECTED_TIMES,
    )
  })

  it('marks a done checkpoint and a checkpoint with debt', () => {
    const wrapper = mount(CoverageStrip, {
      props: { coverage: COVERAGE, items: PLAN.items },
    })

    const rows = wrapper.findAll('[data-testid="coverage-row"]')
    expect(rows[0].attributes('data-state')).toBe('done')
    expect(rows[0].text()).toContain('已过')

    const debtRow = rows[4]
    expect(debtRow.attributes('data-checkpoint')).toBe('cov-16')
    expect(debtRow.attributes('data-debt')).toBe('true')
    expect(debtRow.text()).toContain('cov-16 未收口')
  })

  it('falls back to the seven canonical rows without coverage data', () => {
    const wrapper = mount(CoverageStrip, {
      props: { coverage: null },
    })

    const rows = wrapper.findAll('[data-testid="coverage-row"]')
    expect(rows).toHaveLength(7)
    expect(rows.every((row) => row.attributes('data-state') === 'planned')).toBe(true)
    expect(rows[0].text()).toContain('00:00（分析昨天）')
    expect(rows[0].text()).toContain('目标昨天')
  })

  it('renders six rows for the optional merged_6 profile', () => {
    const wrapper = mount(CoverageStrip, {
      props: {
        coverage: { profile: 'merged_6', checkpoints: [], debt: [] },
        items: [],
      },
    })

    const rows = wrapper.findAll('[data-testid="coverage-row"]')
    expect(rows).toHaveLength(6)
    expect(rows[0].attributes('data-checkpoint')).toBe('cov-night')
    expect(rows[0].text()).toContain('夜间合并')
  })

  it('shows unmapped debt that does not belong to a checkpoint row', () => {
    const wrapper = mount(CoverageStrip, {
      props: {
        coverage: { ...COVERAGE, debt: ['临时欠账：03:15 服务不可用'] },
        items: [],
      },
    })

    expect(wrapper.find('[data-testid="coverage-unmapped-debt"]').text()).toContain(
      '临时欠账：03:15 服务不可用',
    )
  })
})
