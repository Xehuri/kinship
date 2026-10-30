import { test, expect } from './visual-fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * 设置页布局几何契约（预期红灯）。
 *
 * 三组信息架构已落地，卡片 CSS 尚未写入。当前页面仍是单列列表：
 * - .settings-group__grid 只有 1 条轨道；
 * - .settings-controls 只是普通块级容器；
 * - .settings-source-list 仍是 flex 单列；
 * - .settings-section 没有背景、边框与圆角。
 *
 * 本规格只读取 computed style 与 boundingBox，不点退出登录、下载、设置
 * 开关或任何交互按钮。几何断言使用 expect.soft，让一次运行暴露全部缺口；
 * 登录覆盖层、页面脚本错误等健康断言保持硬失败。
 */

test.use({ visualTheme: 'light' })

const LIGHT_VIEWPORTS = [
  { id: '1440x900', width: 1440, height: 900, screenshot: null },
  { id: '1024x900', width: 1024, height: 900, screenshot: 'settings-1024-light.png' },
  { id: '390x844', width: 390, height: 844, screenshot: null },
  { id: '320x640', width: 320, height: 640, screenshot: 'settings-320-light.png' },
]

const GROUP_LABELS = ['账户与偏好', '数据与连接', '系统与关于']

interface GridInfo {
  display: string
  tracks: number
  template: string
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** 从 computed gridTemplateColumns 按空白切分统计轨道数。 */
async function readGrid(locator: Locator): Promise<GridInfo> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const template = style.gridTemplateColumns.trim()
    const tracks = template === '' || template === 'none' ? 0 : template.split(/\s+/).length
    return { display: style.display, tracks, template: style.gridTemplateColumns }
  })
}

/** 先断言 display: grid，再断言轨道数。 */
async function expectGrid(locator: Locator, tracks: number, label: string): Promise<void> {
  const info = await readGrid(locator)
  expect.soft(info.display, `${label}: display should be grid`).toBe('grid')
  expect
    .soft(
      info.tracks,
      `${label}: grid-template-columns should contain ${tracks} track(s), got "${info.template}"`,
    )
    .toBe(tracks)
}

async function readBox(locator: Locator, label: string): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`missing layout box for ${label}`)
  return box
}

/** 打开设置页并等待稳定数据源列表；返回收集到的页面脚本错误。 */
async function openSettings(
  page: Page,
  width: number,
  height: number,
  theme: 'light' | 'dark',
): Promise<Error[]> {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))

  await page.setViewportSize({ width, height })
  await page.goto('/mobile/#/settings')

  await expect(page.locator('.login-overlay')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('.settings-section').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.settings-source-list .settings-source')).toHaveCount(6, {
    timeout: 15000,
  })
  await page.evaluate(async () => {
    await document.fonts.ready
  })

  return pageErrors
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement
    const body = document.body
    return Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth
  })
}

for (const viewport of LIGHT_VIEWPORTS) {
  test(`settings layout contract ${viewport.id}`, async ({ page }, testInfo) => {
    const pageErrors = await openSettings(page, viewport.width, viewport.height, 'light')
    const desktop = viewport.width >= 768

    // ---- 1. 三组与固定标签 ----
    await expect(page.locator('.settings-group')).toHaveCount(3)
    const labels = page.locator('.settings-group__label')
    await expect(labels).toHaveCount(3)
    expect((await labels.allTextContents()).map((text) => text.trim())).toEqual(GROUP_LABELS)

    // ---- 2. 分组网格与外观控件网格 ----
    const groupGrids = page.locator('.settings-group__grid')
    await expect(groupGrids).toHaveCount(3)
    for (let index = 0; index < 3; index += 1) {
      await expectGrid(
        groupGrids.nth(index),
        desktop ? 2 : 1,
        `.settings-group__grid[${index}] at ${viewport.id}`,
      )
    }

    const controls = page.locator('.settings-controls')
    await expect(controls).toHaveCount(1)
    await expectGrid(controls.first(), desktop ? 2 : 1, `.settings-controls at ${viewport.id}`)

    // ---- 3. 账户 / 外观卡片位置 ----
    const accountCards = page.locator('.settings-group--account .settings-section')
    await expect(accountCards).toHaveCount(2)
    await expect(accountCards.nth(0).locator('.settings-section__title')).toHaveText('账户')
    await expect(accountCards.nth(1).locator('.settings-section__title')).toHaveText('外观')

    const accountBox = await readBox(accountCards.nth(0), 'account card')
    const appearanceBox = await readBox(accountCards.nth(1), 'appearance card')

    if (desktop) {
      expect
        .soft(
          Math.abs(accountBox.y - appearanceBox.y),
          `account/appearance top edges should match at ${viewport.id}`,
        )
        .toBeLessThanOrEqual(1)
      expect
        .soft(
          accountBox.x,
          `account card should sit left of appearance card at ${viewport.id}`,
        )
        .toBeLessThan(appearanceBox.x)
    } else {
      expect
        .soft(
          appearanceBox.y,
          `appearance card should sit below account card at ${viewport.id}`,
        )
        .toBeGreaterThanOrEqual(accountBox.y + accountBox.height - 1)
      expect
        .soft(
          Math.abs(appearanceBox.x - accountBox.x),
          `account/appearance should share one column at ${viewport.id}`,
        )
        .toBeLessThanOrEqual(1)
    }

    // ---- 4. 账户卡片表面样式（仅桌面） ----
    if (desktop) {
      const cardStyle = await accountCards.nth(0).evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          borderWidths: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ],
          borderRadiuses: [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ],
        }
      })

      expect
        .soft(
          cardStyle.backgroundColor,
          `account card background should not be transparent at ${viewport.id}`,
        )
        .not.toBe('rgba(0, 0, 0, 0)')
      expect
        .soft(
          cardStyle.backgroundColor,
          `account card background should not be transparent at ${viewport.id}`,
        )
        .not.toBe('transparent')

      for (const [side, width] of cardStyle.borderWidths.entries()) {
        expect
          .soft(width, `account card border width [${side}] should be 1px at ${viewport.id}`)
          .toBe('1px')
      }
      for (const [corner, radius] of cardStyle.borderRadiuses.entries()) {
        expect
          .soft(radius, `account card border radius [${corner}] should be 8px at ${viewport.id}`)
          .toBe('8px')
      }
    }

    // ---- 5. 设备卡片（PC >= 768 存在，手机端不渲染） ----
    const dataSections = page.locator('.settings-group--data .settings-section')
    if (desktop) {
      await expect(dataSections).toHaveCount(3)
      await expect(dataSections.nth(0).locator('.settings-section__title')).toHaveText('健康数据')
      await expect(dataSections.nth(1).locator('.settings-section__title')).toHaveText('数据源')
      await expect(dataSections.nth(2).locator('.settings-section__title')).toHaveText('设备')

      const healthBox = await readBox(dataSections.nth(0), 'health card')
      const sourcesBox = await readBox(dataSections.nth(1), 'sources card')
      const deviceBox = await readBox(dataSections.nth(2), 'device card')

      expect
        .soft(
          Math.abs(deviceBox.x - healthBox.x),
          `device card x should equal health card x at ${viewport.id}`,
        )
        .toBeLessThanOrEqual(1)
      expect
        .soft(
          deviceBox.y,
          `device card y should be at or below sources card bottom at ${viewport.id}`,
        )
        .toBeGreaterThanOrEqual(sourcesBox.y + sourcesBox.height - 1)
    } else {
      await expect(dataSections).toHaveCount(2)
      await expect(
        page.locator('.settings-group--data .settings-section__title', { hasText: /^设备$/ }),
      ).toHaveCount(0)
    }

    // ---- 6. 320 宽度下主题分段控件不得超出字段控制区 ----
    if (viewport.width === 320) {
      const themeField = page.locator('.settings-field[data-setting-row="theme"]')
      const segmentedBox = await readBox(
        themeField.locator('.settings-segmented'),
        'theme segmented control',
      )
      const controlBox = await readBox(
        themeField.locator('.settings-field__control'),
        'theme field control',
      )
      expect
        .soft(
          segmentedBox.width,
          'theme segmented control width should not exceed its field control width at 320',
        )
        .toBeLessThanOrEqual(controlBox.width + 0.5)
    }

    // ---- 7. 数据源列表轨道 ----
    const sourceList = page.locator('.settings-source-list')
    await expect(sourceList).toHaveCount(1)
    await expectGrid(
      sourceList,
      viewport.width === 1440 ? 2 : 1,
      `.settings-source-list at ${viewport.id}`,
    )

    // ---- 8. 截图（1024 / 320 亮色） ----
    if (viewport.screenshot) {
      const target = testInfo.outputPath(viewport.screenshot)
      await page.screenshot({ path: target, fullPage: true, animations: 'disabled' })
      console.log(`[settings-layout] captured ${target}`)
    }

    // ---- 9. 页面健康 ----
    const overflow = await horizontalOverflow(page)
    expect
      .soft(overflow, `horizontal overflow at ${viewport.id} should be <= 1px`)
      .toBeLessThanOrEqual(1)
    expect(
      pageErrors.map((error) => error.message),
      `unexpected page errors at ${viewport.id}`,
    ).toEqual([])
  })
}

test.describe('settings layout dark', () => {
  test.use({ visualTheme: 'dark' })

  test('settings layout contract 1024x900 dark', async ({ page }, testInfo) => {
    const pageErrors = await openSettings(page, 1024, 900, 'dark')
    const overflow = await horizontalOverflow(page)

    const target = testInfo.outputPath('settings-1024-dark.png')
    await page.screenshot({ path: target, fullPage: true, animations: 'disabled' })
    console.log(`[settings-layout] captured ${target}`)

    expect.soft(overflow, 'horizontal overflow at 1024 dark should be <= 1px').toBeLessThanOrEqual(1)
    expect(
      pageErrors.map((error) => error.message),
      'unexpected page errors at 1024 dark',
    ).toEqual([])
  })
})
