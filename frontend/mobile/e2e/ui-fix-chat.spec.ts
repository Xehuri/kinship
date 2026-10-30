import { test, expect } from './visual-fixtures'

/**
 * 聊天页头清理与工具行展示门禁。
 *
 * 桌面 (>=768px): 页头不再有会话入口、摘要跳转、文件入口或任何聊天动作按钮。
 * 移动 (<768px): 只保留 token / context 两个动作, 且都能打开上下文面板。
 * 工具行: 原始工具名在人话动词之前, 展开后 IN 区显示完整格式化参数。
 */

test('desktop chat header has no session trigger or chat actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/mobile/#/chat')

  await expect(page.locator('.login-overlay')).toHaveCount(0)
  await expect(page.getByTestId('chat-thread')).toBeVisible()

  await expect(page.locator('.ax-chat__action')).toHaveCount(0)
  await expect(page.getByTestId('session-trigger')).toHaveCount(0)
  await expect(page.getByTestId('compaction-jump')).toHaveCount(0)
  await expect(page.getByTestId('chat-files')).toHaveCount(0)
})

test('desktop keeps the persistent right inspector column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/mobile/#/chat')

  await expect(page.locator('.login-overlay')).toHaveCount(0)
  const inspector = page.getByTestId('inspector-slot')
  await expect(inspector).toBeVisible()

  const box = await inspector.boundingBox()
  expect(box).not.toBeNull()
  expect(Math.round(box!.width)).toBe(320)

  await expect(inspector.getByTestId('context-inspector')).toBeVisible()
  await expect(inspector.getByText('用量', { exact: true })).toBeVisible()
  await expect(page.getByTestId('inspector-trigger')).toBeHidden()
  await expect(page.locator('.ax-chat__action')).toHaveCount(0)
})

test('tablet opens the inspector drawer from the header trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/mobile/#/chat')

  await expect(page.locator('.login-overlay')).toHaveCount(0)
  const inspector = page.getByTestId('inspector-slot')
  await expect(inspector).toBeHidden()

  const trigger = page.getByTestId('inspector-trigger')
  await expect(trigger).toBeVisible()
  await trigger.click()

  await expect(inspector).toBeVisible()
  await expect(inspector.getByTestId('context-inspector')).toBeVisible()
  await expect(page.locator('.ax-chat__action')).toHaveCount(0)
})

test('tool row shows the raw tool name before the verb and full arguments', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/mobile/#/chat')

  await expect(page.locator('.login-overlay')).toHaveCount(0)
  const row = page.getByTestId('tool-row').first()
  await expect(row).toBeVisible()
  await expect(row.getByTestId('tool-name')).toHaveText('read')

  const header = row.locator('.tool-row__header')
  const nameBeforeVerb = await header.evaluate((element) => {
    const name = element.querySelector('[data-testid="tool-name"]')
    const verb = element.querySelector('.tool-row__verb')
    if (!name || !verb) throw new Error('tool row header parts missing')
    return Boolean(name.compareDocumentPosition(verb) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(nameBeforeVerb).toBe(true)

  await header.click()
  const args = row.getByTestId('tool-args')
  await expect(args).toBeVisible()
  await expect(args).toContainText('"filePath"')
  await expect(args).toContainText('ai/data/daily/2026-10-24/health.json')
})

test('mobile keeps token and context actions and opens the inspector', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/mobile/#/chat')

  await expect(page.locator('.login-overlay')).toHaveCount(0)
  await expect(page.getByTestId('chat-thread')).toBeVisible()

  const token = page.getByTestId('token-trigger')
  const context = page.getByTestId('context-trigger')
  await expect(token).toBeVisible()
  await expect(context).toBeVisible()
  await expect(page.locator('.ax-chat__action')).toHaveCount(2)
  await expect(page.getByTestId('session-trigger')).toHaveCount(0)

  await token.click()
  await expect(page.getByTestId('context-inspector')).toBeVisible()
})
