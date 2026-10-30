import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test as base, expect } from './visual-fixtures'

/**
 * 上下文面板 (inspector) QA: 用量百分比、滚动隔离、子智能体列表独立滚动、
 * 压缩确认框、发送图标与零控制台错误。
 *
 * 后端全部 mock: 上下文窗口 1,000,000, 24 个子智能体, 压缩接口只计数不落库。
 */

const SESSION_ID = 'ses_loom_demo'
const CONTEXT_WINDOW = 1_000_000
const TOTAL_TOKENS = 18_432
const DESKTOP_WIDTH = 320

const OUT_DIR = process.env.VISUAL_OUT
  ? path.join(process.env.VISUAL_OUT, 'inspector-qa')
  : path.join(process.env.ARTIFACTS_DIR ?? tmpdir(), 'kinship-ui-qa', 'inspector-qa')
mkdirSync(OUT_DIR, { recursive: true })

interface SubAgentFixture {
  id: string
  title: string
  type: string
  status: string
  createdAt: number
}

const SUBAGENTS: SubAgentFixture[] = Array.from({ length: 24 }, (_, index) => ({
  id: `ses_child_${index + 1}`,
  title: `子任务 ${index + 1}`,
  type: ['explore', 'build', 'oracle'][index % 3],
  status: index % 4 === 0 ? 'running' : 'completed',
  createdAt: 1_792_000_000_000 + index * 1000,
}))

interface Telemetry {
  consoleErrors: string[]
  failedResponses: string[]
}

interface ChatMocks {
  summarizeCalls: string[]
}

/** 注册上下文面板所需的三个 mock 路由。 */
async function mockInspectorData(page: Page): Promise<ChatMocks> {
  await page.route(
    (url) => url.pathname === '/api/screen/model/context-window',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          backend: 'loom',
          model: 'deepseek-flash',
          provider: 'xehuri-api',
          contextWindow: CONTEXT_WINDOW,
        }),
      }),
  )

  await page.route(
    (url) => url.pathname === `/api/screen/session/${SESSION_ID}/children`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ children: SUBAGENTS }),
      }),
  )

  const summarizeCalls: string[] = []
  await page.route(
    (url) => url.pathname === `/api/screen/session/${SESSION_ID}/summarize`,
    (route) => {
      summarizeCalls.push(route.request().url())
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'compacting' }),
      })
    },
  )

  return { summarizeCalls }
}

const test = base.extend<{ telemetry: Telemetry }>({
  telemetry: [
    async ({ page }, use) => {
      const consoleErrors: string[] = []
      const failedResponses: string[] = []

      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => {
        consoleErrors.push(String(error))
      })
      page.on('response', (response) => {
        if (response.status() >= 400) {
          failedResponses.push(`${response.status()} ${response.url()}`)
        }
      })
      page.on('requestfailed', (request) => {
        failedResponses.push(
          `FAILED ${request.url()} ${request.failure()?.errorText ?? ''}`,
        )
      })

      await use({ consoleErrors, failedResponses })

      expect(
        consoleErrors,
        `console errors:\n${consoleErrors.join('\n')}`,
      ).toEqual([])
      expect(
        failedResponses,
        `failed responses:\n${failedResponses.join('\n')}`,
      ).toEqual([])
    },
    { auto: true },
  ],
})

/** 把子智能体列表滚起来, 并断言外层容器不滚动。 */
async function assertListScrollsInIsolation(
  page: Page,
  scope: Locator,
): Promise<void> {
  const list = scope.getByTestId('subagent-list')
  await expect(list.getByTestId('subagent-row')).toHaveCount(SUBAGENTS.length)

  const overflow = await list.evaluate((element) => {
    const target = element as HTMLElement
    return { scrollHeight: target.scrollHeight, clientHeight: target.clientHeight }
  })
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight)

  await list.evaluate((element) => {
    ;(element as HTMLElement).scrollTop = 220
  })
  await expect
    .poll(() => list.evaluate((element) => (element as HTMLElement).scrollTop))
    .toBeGreaterThan(0)

  const scrolls = await page.evaluate(() => {
    const aside = document.querySelector('[data-testid="inspector-slot"]') as HTMLElement | null
    const body = document.querySelector('.ax-inspector__body') as HTMLElement | null
    return { aside: aside?.scrollTop ?? -1, body: body?.scrollTop ?? -1 }
  })
  expect(scrolls.aside).toBe(0)
  expect(scrolls.body).toBe(0)
}

test('desktop inspector shows 1.8% usage and keeps the subagent list scrolling alone', async ({
  page,
}) => {
  await mockInspectorData(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/mobile/#/chat')

  const slot = page.getByTestId('inspector-slot')
  await expect(slot).toBeVisible()
  const slotBox = await slot.boundingBox()
  expect(slotBox).not.toBeNull()
  expect(Math.round(slotBox!.width)).toBe(DESKTOP_WIDTH)
  await expect(page.getByTestId('inspector-trigger')).toBeHidden()

  const inspector = slot.getByTestId('context-inspector')
  await expect(inspector).toBeVisible()

  const usage = slot.getByTestId('context-usage')
  await expect(usage).toBeVisible()
  await expect(usage).toContainText('1.8%')
  await expect(usage).toContainText('18,432 / 1,000,000')

  const progressbar = slot.getByRole('progressbar')
  await expect(progressbar).toHaveAttribute('aria-valuenow', String(TOTAL_TOKENS))
  await expect(progressbar).toHaveAttribute('aria-valuemax', String(CONTEXT_WINDOW))

  const usageSection = slot.locator('.ax-inspector__section--usage')
  const usageBoxBefore = await usageSection.boundingBox()
  expect(usageBoxBefore).not.toBeNull()

  await assertListScrollsInIsolation(page, slot)

  const usageBoxAfter = await usageSection.boundingBox()
  expect(usageBoxAfter).not.toBeNull()
  expect(Math.abs(usageBoxAfter!.y - usageBoxBefore!.y)).toBeLessThanOrEqual(1)

  await page.screenshot({
    path: path.join(OUT_DIR, 'inspector-desktop-1440.png'),
    fullPage: false,
  })
})

test('tablet drawer opens, scrolls the subagent list only, and closes', async ({ page }) => {
  await mockInspectorData(page)
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/mobile/#/chat')

  const slot = page.getByTestId('inspector-slot')
  await expect(slot).toBeHidden()

  const trigger = page.getByTestId('inspector-trigger')
  await expect(trigger).toBeVisible()
  await trigger.click()

  await expect(slot).toBeVisible()
  const panel = slot.locator('.ax-inspector__panel')
  await expect(panel).toBeVisible()
  await expect(slot.getByTestId('context-usage')).toBeVisible()

  await assertListScrollsInIsolation(page, slot)

  await page.getByTestId('inspector-close').click()
  await expect(slot).toBeHidden()
})

test('mobile overlay is 85dvh tall and scrolls the subagent list', async ({ page }) => {
  await mockInspectorData(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/mobile/#/chat')

  const slot = page.getByTestId('inspector-slot')
  await expect(slot).toBeHidden()
  await expect(page.getByTestId('context-inspector')).toHaveCount(0)

  await page.getByTestId('token-trigger').click()

  const inspector = page.getByTestId('context-inspector')
  await expect(inspector).toBeVisible()

  const panel = inspector.locator('.ax-inspector__panel')
  const panelBox = await panel.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(Math.abs(panelBox!.height - 844 * 0.85)).toBeLessThanOrEqual(2)

  await assertListScrollsInIsolation(page, inspector)
  await expect(slot).toBeHidden()

  await page.screenshot({
    path: path.join(OUT_DIR, 'inspector-mobile-390.png'),
    fullPage: false,
  })
})

test('compact action asks for confirmation and only then posts summarize', async ({ page }) => {
  const { summarizeCalls } = await mockInspectorData(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/mobile/#/chat')

  const compact = page.getByTestId('compact-action')
  await expect(compact).toBeVisible()
  await expect(compact).toBeEnabled()

  const dialog = page.getByTestId('confirm-dialog')

  await compact.click()
  await expect(dialog).toBeVisible()
  expect(summarizeCalls).toHaveLength(0)

  await page.getByTestId('confirm-dialog-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(summarizeCalls).toHaveLength(0)

  await compact.click()
  await expect(dialog).toBeVisible()
  await page.getByTestId('confirm-dialog-confirm').click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => summarizeCalls.length).toBe(1)
})

test('composer send button is a single-arrow icon with an accessible label', async ({ page }) => {
  await mockInspectorData(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/mobile/#/chat')

  const send = page.getByTestId('composer-send')
  await expect(send).toHaveAttribute('aria-label', '发送消息')
  await expect(send.locator('svg')).toHaveCount(1)

  await page.locator('.ax-composer').screenshot({
    path: path.join(OUT_DIR, 'composer-send-icon.png'),
  })
})
