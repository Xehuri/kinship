import { test, expect } from './visual-fixtures'

/**
 * 设置页按钮/控件级联缺陷门禁 (预期红灯)。
 *
 * shell.css 的 `.ax-shell button` 复位规则特异度为 (0,1,1),
 * 高于 settings.css 中以类名书写的按钮样式 (0,1,0):
 *   - `.settings-row`      -> padding / border-block-end / font 被清零;
 *   - `.settings-segmented__option` -> padding / border / 12.5px 字号 / 弱色被覆盖;
 *   - `.settings-button--primary`   -> 主按钮背景透明。
 * 因此 <button> 行的 computed style 应与同级 <div> 行一致, 分段控件与主按钮
 * 也应保留 settings.css 的设计值。本规格只读取 computed style, 不改设置、
 * 不点退出登录、不触发下载。样式断言用 expect.soft, 让一次运行暴露完整
 * 级联损伤面; 页面健康断言保持硬失败。
 */

test.use({ visualTheme: 'light' })

const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 },
]

for (const viewport of VIEWPORTS) {
  test.describe(`settings cascade ${viewport.id} ${viewport.width}x${viewport.height}`, () => {
    test(`button rows and controls keep settings.css styles at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      const pageErrors: Error[] = []
      page.on('pageerror', (error) => pageErrors.push(error))

      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/mobile/#/settings')

      await expect(page.locator('.login-overlay')).toHaveCount(0)
      await expect(page.locator('.settings-section').first()).toBeVisible({ timeout: 15000 })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

      // ---- 1. 按钮行与 div 行必须共用同一套行样式 ----
      const rowStyles = await page.evaluate(() => {
        const read = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) throw new Error(`missing selector: ${selector}`)
          const style = getComputedStyle(element)
          return {
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            borderBottomWidth: style.borderBottomWidth,
            fontSize: style.fontSize,
          }
        }
        return {
          button: read('[data-setting-row="logout"]'),
          div: read('[data-setting-row="about-version"]'),
        }
      })

      expect.soft(
        rowStyles.button.paddingTop,
        'button row padding-top should match div row padding-top',
      ).toBe(rowStyles.div.paddingTop)
      expect.soft(
        rowStyles.button.paddingBottom,
        'button row padding-bottom should match div row padding-bottom',
      ).toBe(rowStyles.div.paddingBottom)
      expect.soft(
        rowStyles.button.borderBottomWidth,
        'button row border-bottom-width should match div row border-bottom-width',
      ).toBe(rowStyles.div.borderBottomWidth)
      expect.soft(
        rowStyles.div.borderBottomWidth,
        'div row border-bottom-width should be the settings.css hairline (1px)',
      ).toBe('1px')
      expect.soft(
        rowStyles.button.fontSize,
        'button row font-size should match div row font-size',
      ).toBe(rowStyles.div.fontSize)

      // ---- 2. 未选中的分段控件必须保留 settings.css 的盒模型与弱色 ----
      const segmented = await page.evaluate(() => {
        const option = document.querySelector<HTMLElement>(
          '.settings-segmented__option[aria-pressed="false"]',
        )
        const title = document.querySelector<HTMLElement>('.settings-row__title')
        if (!option) throw new Error('missing unselected .settings-segmented__option')
        if (!title) throw new Error('missing .settings-row__title')
        const optionStyle = getComputedStyle(option)
        return {
          paddingInlineStart: optionStyle.paddingLeft,
          paddingInlineEnd: optionStyle.paddingRight,
          borderTopWidth: optionStyle.borderTopWidth,
          fontSize: optionStyle.fontSize,
          color: optionStyle.color,
          titleColor: getComputedStyle(title).color,
        }
      })

      expect.soft(
        parseFloat(segmented.paddingInlineStart),
        'unselected segmented option padding-inline-start should be >= 6px',
      ).toBeGreaterThanOrEqual(6)
      expect.soft(
        parseFloat(segmented.paddingInlineEnd),
        'unselected segmented option padding-inline-end should be >= 6px',
      ).toBeGreaterThanOrEqual(6)
      expect.soft(
        segmented.borderTopWidth,
        'unselected segmented option border-top-width should be 1px',
      ).toBe('1px')
      expect.soft(
        parseFloat(segmented.fontSize),
        'unselected segmented option font-size should be 12.5px',
      ).toBeCloseTo(12.5, 2)
      expect.soft(
        segmented.color,
        'unselected segmented option color should differ from .settings-row__title color',
      ).not.toBe(segmented.titleColor)

      // ---- 3. 凭据主按钮必须是实心强调色, 不能回退到 background: none ----
      await page.locator('[data-setting-row="credentials"]').click()
      const submitButton = page.locator('.cred-submit-btn')
      await expect(submitButton).toBeVisible({ timeout: 5000 })
      const submitBackground = await submitButton.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      )
      expect.soft(
        submitBackground,
        '.cred-submit-btn background-color should not be transparent',
      ).not.toBe('rgba(0, 0, 0, 0)')
      expect.soft(
        submitBackground,
        '.cred-submit-btn background-color should not be transparent',
      ).not.toBe('transparent')

      // ---- 4. 页面健康: 无脚本错误、无横向溢出 ----
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement
        const body = document.body
        return Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth
      })
      expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(1)

      expect(
        pageErrors.map((error) => error.message),
        'unexpected page errors on the settings page',
      ).toEqual([])
    })
  })
}
