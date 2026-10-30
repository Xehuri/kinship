import { test, expect } from './visual-fixtures'

/**
 * 通知历史的桌面居中模态 / 移动底部抽屉几何门禁。
 *
 * 桌面 (>=768px): 水平垂直居中, 宽度 <= 560px, 高度受 70dvh 限制,
 * 四周留出视口边距, 圆角面板。
 * 移动 (<=767.98px): 底部对齐整宽, 高度 <= 85dvh, 仅顶部圆角。
 */

const ITEMS = Array.from({ length: 12 }, (_, index) => ({
  id: 500 - index,
  title: `通知 ${index + 1}`,
  content: '这是一条用于几何校验的通知内容，长度足够撑开列表。',
  created_at: 1761300000 - index * 600,
}))

async function stubNotifications(page: import('@playwright/test').Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/notification/history',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ notifications: ITEMS, total: ITEMS.length }),
      }),
  )
}

async function openDrawer(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/mobile/#/chat')
  await expect(page.locator('.login-overlay')).toHaveCount(0)
  await page.getByTestId('notifications-trigger').click()
  await expect(page.getByTestId('notifications-drawer')).toBeVisible()
  await expect(page.getByTestId('notification-item').first()).toBeVisible()
}

/** 等面板入场过渡结束, 避免 transform 干扰几何读数。 */
async function settlePanel(page: import('@playwright/test').Page): Promise<void> {
  const panel = page.locator('.notifications-drawer__panel')
  await expect
    .poll(() => panel.evaluate((el) => getComputedStyle(el).transform), { timeout: 5000 })
    .toBe('none')
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

test('desktop notification panel is a centered modal at 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await stubNotifications(page)
  await openDrawer(page)
  await settlePanel(page)

  const panel = page.locator('.notifications-drawer__panel')
  const rect = await panel.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      borderRadius: style.borderTopLeftRadius,
      maxBlockSize: style.maxBlockSize,
      overflowY: getComputedStyle(el.querySelector('.notifications-drawer__body') as Element).overflowY,
    }
  })

  expect(rect.width).toBeLessThanOrEqual(560)
  expect(rect.width).toBeGreaterThan(320)
  expect(rect.left).toBeGreaterThan(0)
  expect(rect.top).toBeGreaterThan(0)
  expect(rect.right).toBeLessThan(1440)
  expect(rect.bottom).toBeLessThan(900)
  expect(rect.height).toBeLessThanOrEqual(900 * 0.7 + 1)
  expect(rect.height).toBeLessThan(900)
  expect(rect.borderRadius).not.toBe('0px')
  expect(Number.parseFloat(rect.maxBlockSize)).toBeLessThanOrEqual(631)
  expect(rect.overflowY).toBe('auto')

  expect(Math.abs(rect.left + rect.width / 2 - 720)).toBeLessThanOrEqual(1)
  expect(Math.abs(rect.top + rect.height / 2 - 450)).toBeLessThanOrEqual(1)

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    const body = document.body
    return Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth
  })
  expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(1)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('notifications-drawer')).toHaveCount(0)
})

test('mobile notification panel stays a bottom sheet at 390x844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await stubNotifications(page)
  await openDrawer(page)
  await settlePanel(page)

  const panel = page.locator('.notifications-drawer__panel')
  const rect = await panel.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      radiusTopLeft: style.borderTopLeftRadius,
      radiusBottomLeft: style.borderBottomLeftRadius,
    }
  })

  expect(rect.left).toBeCloseTo(0, 0)
  expect(rect.right).toBeCloseTo(390, 0)
  expect(rect.width).toBeGreaterThanOrEqual(389)
  expect(rect.bottom).toBeCloseTo(844, 0)
  expect(rect.height).toBeLessThanOrEqual(844 * 0.85 + 1)
  expect(rect.top).toBeGreaterThan(0)
  expect(rect.radiusTopLeft).not.toBe('0px')
  expect(rect.radiusBottomLeft).toBe('0px')

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    const body = document.body
    return Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth
  })
  expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(1)
})
