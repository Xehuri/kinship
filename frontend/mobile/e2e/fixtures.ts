import { test as base, expect } from '@playwright/test'

/**
 * 无后端 E2E 夹具:
 * - setup-status 明确返回 needs_setup=false (走正常登录门控)
 * - /api/** 统一返回 200 {} (数据请求不挂起)
 * - EventSource / WebSocket 替换为空实现 (实时通道不阻塞页面)
 * 不注入 token, 登录覆盖层应保持可见。
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/auth/setup-status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needs_setup: false, require_token: false }),
      }),
    )

    // 仅匹配真正的 /api/ 端点; `**/api/**` 会误伤 Vite 源码模块路径
    // (例如 /mobile/src/api/client.ts), 在 dev server 下返回 JSON 导致模块加载失败。
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{}',
        }),
    )

    await page.addInitScript(() => {
      class StubEventSource {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSED = 2
        readonly CONNECTING = 0
        readonly OPEN = 1
        readonly CLOSED = 2
        readonly url: string
        readyState = StubEventSource.OPEN
        withCredentials = false
        onopen: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent) => void) | null = null
        onerror: ((event: Event) => void) | null = null

        constructor(url: string | URL) {
          this.url = String(url)
        }

        close(): void {
          this.readyState = StubEventSource.CLOSED
        }

        addEventListener(): void {}
        removeEventListener(): void {}
        dispatchEvent(): boolean {
          return true
        }
      }

      class StubWebSocket {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSING = 2
        static readonly CLOSED = 3
        readonly CONNECTING = 0
        readonly OPEN = 1
        readonly CLOSING = 2
        readonly CLOSED = 3
        readonly url: string
        readyState = StubWebSocket.OPEN
        bufferedAmount = 0
        extensions = ''
        protocol = ''
        binaryType = 'blob'
        onopen: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        onclose: ((event: CloseEvent) => void) | null = null

        constructor(url: string | URL) {
          this.url = String(url)
        }

        close(): void {
          this.readyState = StubWebSocket.CLOSED
        }

        send(): void {}
        addEventListener(): void {}
        removeEventListener(): void {}
        dispatchEvent(): boolean {
          return true
        }
      }

      Object.defineProperty(window, 'EventSource', {
        configurable: true,
        writable: true,
        value: StubEventSource,
      })
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: StubWebSocket,
      })
    })

    await use(page)
  },
})

export { expect }
