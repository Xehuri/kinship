import type { Page } from '@playwright/test'
import { test, expect } from './visual-fixtures'

/**
 * 文件页导航稳定性与全路径选择门禁。
 *
 * - 进入 data 目录后树保持挂载 (不被骨架替换), 根级 opencode.json 仍以
 *   完整路径 `opencode.json` 请求内容, 而不是拼成 `data/opencode.json`。
 * - 目录加载失败时保留旧行与旧路径, 内联错误可重试/关闭。
 */

const MTIME = '2026-10-24T18:00:00'

const ROOT = {
  entries: [
    { name: 'data', type: 'dir', size: 0, mtime: MTIME },
    { name: 'opencode.json', type: 'json', size: 128, mtime: MTIME },
    { name: 'broken', type: 'dir', size: 0, mtime: MTIME },
  ],
}

const DATA = {
  entries: [
    { name: 'daily', type: 'dir', size: 0, mtime: MTIME },
    { name: 'note.md', type: 'md', size: 64, mtime: MTIME },
  ],
}

interface FileStubs {
  contentPaths: string[]
  directoryPaths: string[]
}

async function stubFiles(page: Page): Promise<FileStubs> {
  const contentPaths: string[] = []
  const directoryPaths: string[] = []

  await page.route(
    (url) => url.pathname === '/api/mobile/files',
    (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? ''
      directoryPaths.push(path)
      if (path === '') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(ROOT),
        })
      }
      if (path === 'data') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(DATA),
        })
      }
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'boom' }),
      })
    },
  )

  await page.route(
    (url) => url.pathname === '/api/mobile/files/content',
    (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? ''
      contentPaths.push(path)
      if (path === 'data/opencode.json') {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'not found' }),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: '{"name":"kinship","version":1}' }),
      })
    },
  )

  return { contentPaths, directoryPaths }
}

function rowByName(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('[data-testid="file-tree-row"]').filter({
    has: page.locator('.ax-file-row__name', {
      hasText: new RegExp(`^${escaped}$`),
    }),
  })
}

test('data folder keeps the tree and previews root opencode.json by full path', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const stubs = await stubFiles(page)

  await page.goto('/mobile/#/files')
  await expect(page.locator('.login-overlay')).toHaveCount(0)

  const tree = page.getByTestId('file-tree')
  await expect(tree).toBeVisible()
  await expect(tree.getByTestId('file-tree-row')).toHaveCount(3)
  await tree.evaluate((element) => {
    element.dataset.preserved = 'yes'
  })

  await rowByName(page, 'data').locator('.ax-file-row__main').click()

  await expect(page.locator('.ax-files__crumb--current')).toHaveText('data')
  await expect(tree).toBeVisible()
  await expect(tree.locator('.ax-file-tree__loading')).toHaveCount(0)
  expect(await tree.evaluate((element) => element.dataset.preserved)).toBe('yes')

  for (const name of ['data', 'opencode.json']) {
    await expect(rowByName(page, name)).toBeVisible()
  }
  expect(stubs.directoryPaths).toContain('data')

  await rowByName(page, 'opencode.json').locator('.ax-file-row__main').click()

  const preview = page.getByTestId('file-preview')
  await expect(preview).toBeVisible()
  const surface = preview.getByTestId('code-surface')
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute('data-language', 'json')
  await expect(surface).toContainText('"name": "kinship"')

  expect(stubs.contentPaths).toEqual(['opencode.json'])
  expect(stubs.contentPaths).not.toContain('data/opencode.json')
})

test('failed folder navigation keeps rows and offers an inline retry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const stubs = await stubFiles(page)

  await page.goto('/mobile/#/files')
  await expect(page.locator('.login-overlay')).toHaveCount(0)

  const tree = page.getByTestId('file-tree')
  await expect(tree.getByTestId('file-tree-row')).toHaveCount(3)
  await tree.evaluate((element) => {
    element.dataset.preserved = 'yes'
  })
  const rowNames = () =>
    tree
      .locator('.ax-file-row__name')
      .evaluateAll((names) => names.map((name) => name.textContent))
  const before = await rowNames()

  await rowByName(page, 'broken').locator('.ax-file-row__main').click()

  const banner = page.getByTestId('files-navigation-error')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('加载目录失败')
  await expect(page.locator('.ax-files__crumb--current')).toHaveText('ai')
  await expect(tree).toBeVisible()
  await expect(tree.locator('.ax-file-tree__loading')).toHaveCount(0)
  expect(await tree.evaluate((element) => element.dataset.preserved)).toBe('yes')
  expect(await rowNames()).toEqual(before)

  const failedRequests = stubs.directoryPaths.filter((path) => path === 'broken').length
  await banner.getByRole('button', { name: '重试' }).click()
  await expect
    .poll(() => stubs.directoryPaths.filter((path) => path === 'broken').length)
    .toBe(failedRequests + 1)
  await expect(banner).toBeVisible()
  await expect(tree.getByTestId('file-tree-row')).toHaveCount(3)

  await banner.getByRole('button', { name: '关闭' }).click()
  await expect(banner).toHaveCount(0)
  await expect(tree.getByTestId('file-tree-row')).toHaveCount(3)
})
