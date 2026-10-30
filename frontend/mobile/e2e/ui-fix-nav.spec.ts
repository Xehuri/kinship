import { test, expect } from './visual-fixtures'

/**
 * 侧栏激活项左侧内缩的几何门禁。
 *
 * - >=1180px: 完整标签侧栏 (216px), 列表内边距 12px
 * - 768-1179px: 图标轨道 (72px), 列表内边距 8px
 *
 * 断言激活胶囊左缘到侧栏左缘的距离, 而不是只检查 CSS 变量,
 * 避免样式被级联覆盖后测试仍然通过。
 */

const CASES = [
  { name: 'wide sidebar', width: 1440, height: 900, sidebarWidth: 216, inset: 12 },
  { name: 'icon rail', width: 1024, height: 900, sidebarWidth: 72, inset: 8 },
]

for (const item of CASES) {
  test(`active pill keeps ${item.inset}px inset at ${item.width}x${item.height}`, async ({ page }) => {
    await page.setViewportSize({ width: item.width, height: item.height })
    await page.goto('/mobile/#/chat')

    await expect(page.locator('.login-overlay')).toHaveCount(0)
    const nav = page.locator('.ax-shell__nav')
    const active = page.locator('.ax-nav__item--active')
    await expect(nav).toBeVisible()
    await expect(active).toBeVisible()

    const geometry = await page.evaluate(() => {
      const navEl = document.querySelector('.ax-shell__nav')
      const activeEl = document.querySelector('.ax-nav__item--active')
      if (!navEl || !activeEl) throw new Error('shell navigation not rendered')
      const navRect = navEl.getBoundingClientRect()
      const activeRect = activeEl.getBoundingClientRect()
      return {
        navLeft: navRect.left,
        navWidth: navRect.width,
        activeLeft: activeRect.left,
        activeWidth: activeRect.width,
      }
    })

    expect(Math.round(geometry.navWidth)).toBe(item.sidebarWidth)
    expect(geometry.activeLeft - geometry.navLeft).toBeCloseTo(item.inset, 1)
    expect(geometry.activeWidth).toBeGreaterThan(0)
    expect(geometry.activeWidth).toBeLessThanOrEqual(geometry.navWidth - item.inset * 2 + 1)

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement
      const body = document.body
      return Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth
    })
    expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(1)
  })
}
