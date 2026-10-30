import { test, expect } from '@playwright/test'

/**
 * 外部发送 SSE 回归 (P0)。
 *
 * 不依赖真实后端：用可控 EventSource 注入 Loom 帧，验证浏览器里
 * session.queue 会建立用户轮次边界，下一条 assistant 回复不会追加到
 * 上一条回复的气泡里。帧形状与 Loom 契约一致。
 */

const SESSION_ID = 'ses_qa'
const BASE_AT = 1790000000000

test('external session.queue creates a new turn instead of appending to the previous reply', async ({ page }) => {
  await page.addInitScript(() => {
    class MockEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      static instances: MockEventSource[] = []
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readonly url: string
      readyState = MockEventSource.OPEN
      withCredentials = false
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor(url: string | URL) {
        this.url = String(url)
        MockEventSource.instances.push(this)
        setTimeout(() => this.onopen?.(new Event('open')), 0)
      }
      close(): void {
        this.readyState = MockEventSource.CLOSED
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean {
        return true
      }
    }
    const w = window as unknown as {
      EventSource: typeof EventSource
      __emitSSE?: (data: unknown) => void
    }
    w.EventSource = MockEventSource as unknown as typeof EventSource
    w.__emitSSE = (data: unknown) => {
      const es = MockEventSource.instances[MockEventSource.instances.length - 1]
      es?.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
    }
    localStorage.setItem('mobile_token', 'qa-token')
  })

  await page.route('**/auth/setup-status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ needs_setup: false, require_token: false }),
    }),
  )
  await page.route('**/auth/ws-ticket', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'qa-ticket', expires_in: 30 }),
    }),
  )
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      }),
  )

  await page.route(
    (url) => url.pathname === '/api/screen/session/list',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            {
              session_id: SESSION_ID,
              title: 'QA 会话',
              date: '2026-10-24T22:00:00+08:00',
              active: true,
              backend: 'loom',
            },
          ],
          local_sessions: [],
          current_session: SESSION_ID,
        }),
      }),
  )
  await page.route(
    (url) => url.pathname === `/api/screen/session/${SESSION_ID}/messages`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            {
              info: {
                id: 'msg_u1',
                role: 'user',
                sessionID: SESSION_ID,
                time: { created: BASE_AT - 60000 },
              },
              parts: [{ type: 'text', text: '第一问' }],
            },
            {
              info: {
                id: 'msg_a1',
                role: 'assistant',
                sessionID: SESSION_ID,
                time: { created: BASE_AT - 50000 },
              },
              parts: [{ type: 'text', text: '第一答' }],
            },
          ],
          next_cursor: null,
        }),
      }),
  )

  await page.goto('/mobile/#/chat', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('user-message').filter({ hasText: '第一问' })).toBeVisible()
  await expect(page.getByTestId('assistant-message').filter({ hasText: '第一答' })).toBeVisible()

  await page.evaluate(
    ({ sessionID, at }) => {
      const emit = (window as unknown as { __emitSSE?: (data: unknown) => void }).__emitSSE
      emit?.({
        payload: {
          type: 'session.queue',
          properties: {
            sessionID,
            pending: [{ text: '外部提问', at, state: 'queued' }],
          },
        },
      })
      emit?.({
        payload: {
          type: 'message.part.updated',
          properties: {
            sessionID,
            messageID: 'msg_a2',
            part: { id: 'part_a2', type: 'text', text: '外部回答' },
          },
        },
      })
      emit?.({
        payload: {
          type: 'session.idle',
          properties: { sessionID, id: sessionID },
        },
      })
    },
    { sessionID: SESSION_ID, at: BASE_AT },
  )

  await expect(page.getByTestId('user-message').filter({ hasText: '外部提问' })).toBeVisible()
  await expect(page.getByTestId('assistant-message').filter({ hasText: '外部回答' })).toBeVisible()
  await expect(page.getByTestId('chat-turn')).toHaveCount(2)
  await expect(page.getByTestId('user-message')).toHaveCount(2)

  const firstReply = await page
    .getByTestId('assistant-message')
    .filter({ hasText: '第一答' })
    .innerText()
  expect(firstReply).not.toContain('外部回答')
})
