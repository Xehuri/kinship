import { test, expect } from './fixtures'

test('T1: built preview serves the /mobile/ hash route behind the auth gate', async ({ page }) => {
  await page.goto('/mobile/#/chat')

  await expect(page.locator('#app')).toBeVisible()
  await expect(page).toHaveURL(/\/mobile\/#\/chat/)
  await expect(page.locator('.login-overlay')).toBeVisible()
})
