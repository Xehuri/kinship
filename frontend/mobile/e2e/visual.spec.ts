import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './visual-fixtures'
import {
  SURFACES,
  THEMES,
  VIEWPORTS,
  defaultOutDir,
  resolveSurfaces,
  shotFileName,
} from '../scripts/shot-matrix.mjs'

/**
 * 视觉截图门禁。
 *
 * 矩阵来自 scripts/shot-matrix.mjs: 6 个 surface x 2 主题 x 2 视口 (共 24 张)。
 * 仅 ready=true 的 surface 会真正截图; 其余显式 skip, 不产出文件。
 *
 * 环境变量:
 *   VISUAL_ONLY  逗号分隔的 surface id 过滤 (如 reports,reminders)
 *   VISUAL_OUT   截图输出目录 (默认由 playwright.config.ts 注入时间戳目录)
 *
 * 每张截图前断言:
 * - 无登录覆盖层, data-theme 与矩阵一致;
 * - 页面无 pageerror;
 * - 无横向溢出 (scrollWidth <= 视口宽度 + 1px)。
 */

const OUT_DIR: string = process.env.VISUAL_OUT || defaultOutDir()
const ONLY = process.env.VISUAL_ONLY
const SELECTED = new Set(resolveSurfaces(ONLY).map((surface: { id: string }) => surface.id))

test.beforeAll(() => {
  mkdirSync(OUT_DIR, { recursive: true })
})

for (const theme of THEMES) {
  test.describe(`theme:${theme}`, () => {
    test.use({ visualTheme: theme })

    for (const surface of SURFACES) {
      for (const viewport of VIEWPORTS) {
        test(`${surface.id} ${viewport.id}`, async ({ page }) => {
          test.skip(!SELECTED.has(surface.id), `surface ${surface.id} excluded by VISUAL_ONLY`)
          test.skip(!surface.ready, `surface ${surface.id} pending (ready=false)`)

          const errors: Error[] = []
          page.on('pageerror', (error) => errors.push(error))

          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await page.goto(`/mobile/#${surface.route}`)

          await expect(page).toHaveURL(new RegExp(`#${surface.route.replace('/', '\\/')}$`))
          await expect(page.locator('.login-overlay')).toHaveCount(0)
          await expect(page.locator('.splash-overlay')).toHaveCount(0)
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

          try {
            await page
              .locator(surface.readySelector)
              .first()
              .waitFor({ state: 'visible', timeout: 15000 })
          } catch {
            const pageErrors = errors.map((item) => item.message).join(' | ')
            throw new Error(
              `surface ${surface.id} (${viewport.id}, ${theme}) did not become ready: ${pageErrors || 'no page errors'}`,
            )
          }
          await page.evaluate(async () => {
            await document.fonts.ready
          })

          const overflow = await page.evaluate(() => {
            const doc = document.documentElement
            const body = document.body
            const contentWidth = Math.max(doc.scrollWidth, body.scrollWidth)
            return contentWidth - window.innerWidth
          })
          expect(overflow, `horizontal overflow at ${viewport.id}`).toBeLessThanOrEqual(1)

          expect(
            errors.map((error) => error.message),
            'page errors during capture',
          ).toEqual([])

          const file = shotFileName(surface.id, theme, viewport.id)
          const target = join(OUT_DIR, file)
          await page.screenshot({ path: target, animations: 'disabled' })
          console.log(`[visual] captured ${target}`)
        })
      }
    }
  })
}
