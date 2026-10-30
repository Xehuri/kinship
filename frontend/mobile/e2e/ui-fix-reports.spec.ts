import { test, expect } from './visual-fixtures'

/**
 * 报告页类别分组 / 内存筛选 / 详情门禁。
 *
 * 6 条样例覆盖全部四类 (health 2 / daily 2 / weekly 1 / review 1)，
 * 路由计数用于证明切换标签不会按类别重新请求后端。
 */

const REPORTS = [
  {
    title: '健康清单 10-24',
    date: '2026-10-24',
    type: 'md',
    tags: ['健康'],
    path: 'data/daily/2026-10-24/健康清单-2026-10-24.md',
    kind: 'other',
    family: 'health',
    size_bytes: 2048,
    md: '# 健康清单 10-24\n\n今日状态平稳。',
  },
  {
    title: '健康清单 10-23',
    date: '2026-10-23',
    type: 'md',
    tags: ['健康'],
    path: 'data/daily/2026-10-23/健康清单-2026-10-23.md',
    kind: 'other',
    family: 'health',
    size_bytes: 2048,
    md: '# 健康清单 10-23\n\n睡眠略短。',
  },
  {
    title: '复盘 10-24',
    date: '2026-10-24',
    type: 'md',
    tags: ['复盘'],
    path: 'data/daily/2026-10-24/复盘-2026-10-24.md',
    kind: 'daily',
    family: 'daily',
    size_bytes: 4096,
    md: '# 复盘 10-24\n\n今天完成了主要任务。',
  },
  {
    title: '复盘 10-23',
    date: '2026-10-23',
    type: 'md',
    tags: ['复盘'],
    path: 'data/daily/2026-10-23/复盘-2026-10-23.md',
    kind: 'daily',
    family: 'daily',
    size_bytes: 4096,
    md: '# 复盘 10-23\n\n节奏正常。',
  },
  {
    title: '每周总结 2026-10-20',
    date: '2026-10-20',
    type: 'md',
    tags: ['周报'],
    path: 'data/reports/每周总结-2026-10-14~10-20.md',
    kind: 'weekly',
    family: 'weekly',
    size_bytes: 8192,
    md: '# 每周总结 2026-10-20\n\n本周整体平稳。',
  },
  {
    title: '深度回顾 2026-10-18',
    date: '2026-10-18',
    type: 'md',
    tags: ['回顾'],
    path: 'data/reports/深度回顾-2026-09-01~10-18.md',
    kind: 'audit',
    family: 'review',
    size_bytes: 16384,
    md: '# 深度回顾 2026-10-18\n\n一个半月的回顾。',
  },
]

const RESPONSE = {
  reports: REPORTS,
  total: REPORTS.length,
  counts: { health: 2, daily: 2, weekly: 1, review: 1 },
  families: [
    { id: 'health', label: '健康清单', count: 2 },
    { id: 'daily', label: '日报', count: 2 },
    { id: 'weekly', label: '周报', count: 1 },
    { id: 'review', label: '复盘', count: 1 },
  ],
}

const FAMILIES = [
  ['health', '健康清单', '2'],
  ['daily', '日报', '2'],
  ['weekly', '周报', '1'],
  ['review', '复盘', '1'],
] as const

async function stubReports(
  page: import('@playwright/test').Page,
): Promise<{ requests: () => number }> {
  let requests = 0
  await page.route(
    (url) => url.pathname === '/api/mobile/reports',
    (route) => {
      requests += 1
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(RESPONSE),
      })
    },
  )
  return { requests: () => requests }
}

async function pageOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement
    const body = document.body
    return Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth
  })
}

test('mobile reports page groups families and filters without refetching', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const counter = await stubReports(page)

  await page.goto('/mobile/#/reports')
  await expect(page.locator('.login-overlay')).toHaveCount(0)

  for (const [id, label, count] of [['all', '全部', '6'], ...FAMILIES] as const) {
    const tab = page.getByTestId(`report-tab-${id}`)
    await expect(tab).toBeVisible()
    await expect(tab).toContainText(label)
    await expect(page.getByTestId(`report-tab-count-${id}`)).toHaveText(count)
  }
  await expect(page.getByTestId('report-tab-all')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.ax-chip')).toHaveCount(0)

  for (const [family, label, count] of FAMILIES) {
    const section = page.getByTestId(`report-section-${family}`)
    await expect(section).toBeVisible()
    await expect(section.locator('h2')).toHaveText(label)
    await expect(page.getByTestId(`report-section-count-${family}`)).toHaveText(count)
  }
  await expect(page.locator('button.ax-report-row')).toHaveCount(6)

  expect(
    await page.locator('.report-tabs').evaluate((el) => getComputedStyle(el).overflowX),
  ).toBe('auto')
  expect(await pageOverflow(page), 'horizontal overflow').toBeLessThanOrEqual(1)

  await page.getByTestId('report-tab-daily').click()
  await expect(page.getByTestId('report-tab-daily')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('report-section-daily')).toBeVisible()
  await expect(page.getByTestId('report-section-health')).toHaveCount(0)
  await expect(page.locator('button.ax-report-row')).toHaveCount(2)
  await expect(page.getByTestId('report-tab-count-health')).toHaveText('2')
  expect(counter.requests()).toBe(1)

  await page.getByTestId('report-tab-all').click()
  await expect(page.getByTestId('report-section-health')).toBeVisible()
  await expect(page.locator('button.ax-report-row')).toHaveCount(6)
  expect(await pageOverflow(page), 'horizontal overflow after switching').toBeLessThanOrEqual(1)

  await page.locator('button.ax-report-row').first().click()
  await expect(page.getByTestId('report-detail')).toBeVisible()
  await expect(page.getByTestId('report-detail')).toContainText('今日状态平稳')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('report-detail')).toHaveCount(0)
})

test('section action opens the chosen family on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await stubReports(page)

  await page.goto('/mobile/#/reports')
  await expect(page.locator('.login-overlay')).toHaveCount(0)

  await expect(page.getByTestId('report-section-health').locator('button.ax-report-row')).toHaveCount(2)
  await page.getByTestId('report-section-more-health').click()

  await expect(page.getByTestId('report-tab-health')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('report-section-health')).toBeVisible()
  await expect(page.getByTestId('report-section-daily')).toHaveCount(0)
  await expect(page.locator('button.ax-report-row')).toHaveCount(2)
  expect(await pageOverflow(page), 'horizontal overflow').toBeLessThanOrEqual(1)
})
