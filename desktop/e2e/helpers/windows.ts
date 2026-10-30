import type { ElectronApplication, Page } from 'playwright'

const POLL_INTERVAL_MS = 100

export async function waitForWindow(
  app: ElectronApplication,
  matcher: (url: string) => boolean,
  timeoutMs = 20_000,
): Promise<Page> {
  const existing = app.windows().find((page) => matcher(page.url()))
  if (existing !== undefined) return existing

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = app.windows().find((page) => matcher(page.url()))
    if (match !== undefined) return match
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS)
    })
  }

  const urls = app.windows().map((page) => page.url())
  throw new Error(`timed out waiting for window; open windows: ${urls.join(' | ')}`)
}

export function waitForHashWindow(
  app: ElectronApplication,
  fragment: string,
  timeoutMs = 20_000,
): Promise<Page> {
  return waitForWindow(app, (url) => url.includes(`#/${fragment}`), timeoutMs)
}
