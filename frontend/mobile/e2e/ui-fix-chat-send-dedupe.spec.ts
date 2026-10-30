import { test, expect } from '@playwright/test'

/**
 * 本地发送对账 Loom session.queue 信封 (P0)。
 *
 * Loom 只推 session.queue, 且 text 带 <Axeuh-home-system> 信封。本用例验证:
 *   - 本地乐观气泡先出现且只有一条;
 *   - 同一 at 的 queue 快照 (queued/running) 反复到达不会新增气泡;
 *   - 纯外部 queue 消息创建一条去信封的用户气泡;
 *   - 全程不把信封原文渲染到页面。
 * 不依赖真实后端: 路由全 mock, EventSource 由可控实现注入。
 */

const SESSION_ID = 'ses_qa_dedupe'
const BASE_AT = 1792000000000

const PRIOR_USER = '前一轮的提问'
const PRIOR_REPLY = '前一轮的回答'
const LOCAL_TEXT = '去重用例：今晚一起读半小时书？'
const EXTERNAL_TEXT = '外部同步：明早的闹钟调早十分钟'

function envelope(text: string): string {
  return (
    '<Axeuh-home-system>\n' +
    '{"current_datetime":"2026-10-25T01:30:00+08:00"}\n' +
    '</Axeuh-home-system>\n\n' +
    text
  )
}

test('local send is deduped against repeated enveloped session.queue snapshots', async ({
  page,
}) => {
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

  // 兜底: 其余 API 一律 200 {}, 页面不会挂起
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
              title: '去重会话',
              date: '2026-10-25T01:00:00+08:00',
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
                id: 'msg_prior_user',
                role: 'user',
                sessionID: SESSION_ID,
                time: { created: BASE_AT - 60000 },
              },
              parts: [{ type: 'text', id: 'prt_prior_user', text: PRIOR_USER }],
            },
            {
              info: {
                id: 'msg_prior_assistant',
                role: 'assistant',
                sessionID: SESSION_ID,
                time: { created: BASE_AT - 50000, completed: BASE_AT - 45000 },
              },
              parts: [{ type: 'text', id: 'prt_prior_assistant', text: PRIOR_REPLY }],
            },
          ],
          next_cursor: null,
        }),
      }),
  )

  let sendCalls = 0
  await page.route(
    (url) => url.pathname === '/api/screen/session/message',
    (route) => {
      sendCalls += 1
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    },
  )

  await page.goto('/mobile/#/chat', { waitUntil: 'domcontentloaded' })

  const userMessages = page.getByTestId('user-message')
  const chatTurns = page.getByTestId('chat-turn')

  await expect(userMessages.filter({ hasText: PRIOR_USER })).toBeVisible()
  await expect(page.getByTestId('assistant-message').filter({ hasText: PRIOR_REPLY })).toBeVisible()

  // 发送前: 只有历史里的 1 条用户气泡
  await expect(userMessages).toHaveCount(1)

  await page.getByTestId('composer-input').fill(LOCAL_TEXT)
  await page.getByTestId('composer-send').click()

  // 本地乐观气泡先到, 且只有一条
  await expect(userMessages.filter({ hasText: LOCAL_TEXT })).toHaveCount(1)
  await expect(userMessages).toHaveCount(2)
  await expect.poll(() => sendCalls).toBe(1)

  // 取发送之后的当前时间, 保证落在 15s 本地去重窗口内
  const at = Date.now()

  const emitQueue = (pending: Array<{ text: string; at: number; state: string }>) =>
    page.evaluate(
      ({ sessionID, items }) => {
        const emit = (window as unknown as { __emitSSE?: (data: unknown) => void }).__emitSSE
        emit?.({
          payload: {
            type: 'session.queue',
            properties: { sessionID, pending: items },
          },
        })
      },
      { sessionID: SESSION_ID, items: pending },
    )

  // 第一次 queue 快照 (queued): 命中本地气泡并盖时间戳, 不新增
  await emitQueue([{ text: envelope(LOCAL_TEXT), at, state: 'queued' }])
  await expect(userMessages.filter({ hasText: LOCAL_TEXT })).toHaveCount(1)
  await expect(userMessages).toHaveCount(2)
  await expect(page.locator('body')).not.toContainText('Axeuh-home-system')

  // 同一 (text, at) 的快照再次到达 (running): 仍不新增
  await emitQueue([{ text: envelope(LOCAL_TEXT), at, state: 'running' }])
  await expect(userMessages.filter({ hasText: LOCAL_TEXT })).toHaveCount(1)
  await expect(userMessages).toHaveCount(2)
  await expect(chatTurns).toHaveCount(2)

  // 纯外部 queue 消息 (无本地气泡): 新建一条去信封的用户气泡
  await emitQueue([
    { text: envelope(LOCAL_TEXT), at, state: 'running' },
    { text: envelope(EXTERNAL_TEXT), at: at + 1000, state: 'queued' },
  ])

  const externalBubble = userMessages.filter({ hasText: EXTERNAL_TEXT })
  await expect(externalBubble).toHaveCount(1)
  await expect(externalBubble).not.toContainText('Axeuh-home-system')
  await expect(page.locator('body')).not.toContainText('Axeuh-home-system')

  // 精确计数: 历史 1 + 本地发送 1 + 外部 1, 没有重复
  await expect(userMessages).toHaveCount(3)
  await expect(userMessages.filter({ hasText: PRIOR_USER })).toHaveCount(1)
  await expect(userMessages.filter({ hasText: LOCAL_TEXT })).toHaveCount(1)
  await expect(externalBubble).toHaveCount(1)
  await expect(chatTurns).toHaveCount(3)

  // 上一轮回复没有被新消息污染
  const priorReply = await page
    .getByTestId('assistant-message')
    .filter({ hasText: PRIOR_REPLY })
    .innerText()
  expect(priorReply).not.toContain(LOCAL_TEXT)
  expect(priorReply).not.toContain(EXTERNAL_TEXT)
})
