import { test, expect } from './visual-fixtures'

/**
 * 历史分页 + 压缩分隔线锚定 (P0)。
 *
 * 最新页 18 条消息 (9 轮) 全部晚于压缩锚点且不含分隔线; 更早一页包含:
 * 更早的提问 -> 合成压缩分隔线 (assistant + part.type=compaction) -> 用户「你好」-> 回复。
 * 验证:
 *   - 不再有手动的「加载更早 / load-more」控件;
 *   - 滚到顶部后自动请求 before=c1 并前插更早消息;
 *   - 分隔线只出现 1 条, 且 DOM 顺序为 更早提问 < 分隔线 < 你好;
 *   - 前插后消息/轮次 id 无重复。
 */

const SESSION_ID = 'ses_loom_demo'
const ANCHOR_AT = 1792000000000
const OLDER_USER_TEXT = '更早一页的提问'
const HELLO_TEXT = '你好'

interface RawMessage {
  info: {
    id: string
    role: 'user' | 'assistant'
    sessionID: string
    time: { created: number; completed?: number }
    tokens?: { total: number; input: number; output: number }
  }
  parts: Array<Record<string, unknown>>
}

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  created: number,
  text: string,
): RawMessage {
  return {
    info: { id, role, sessionID: SESSION_ID, time: { created } },
    parts: [{ type: 'text', id: `${id}_part`, text }],
  }
}

/** 最新页: 9 轮 18 条, 全部晚于压缩锚点, 不含分隔线。 */
const RECENT_MESSAGES: RawMessage[] = Array.from({ length: 9 }, (_, index) => {
  const seq = index + 1
  const created = ANCHOR_AT + 10000 + index * 2000
  return [
    textMessage(`msg_recent_user_${seq}`, 'user', created, `近期第${seq}问`),
    textMessage(
      `msg_recent_assistant_${seq}`,
      'assistant',
      created + 1000,
      `近期第${seq}答：今天的心率、步数与睡眠都记录完整，整体趋势平稳，没有需要立即处理的异常。补充一句更长的描述用于撑开页面高度，确保顶部哨兵不在初始视口内。`,
    ),
  ]
}).flat()

/** 更早页: 提问 -> 压缩分隔线 -> 你好 -> 回复。 */
const OLDER_PAGE: RawMessage[] = [
  textMessage('msg_older_user_0', 'user', ANCHOR_AT - 60000, OLDER_USER_TEXT),
  {
    info: {
      id: 'msg_compaction_ses_loom_demo_12',
      role: 'assistant',
      sessionID: SESSION_ID,
      time: { created: ANCHOR_AT },
    },
    parts: [
      {
        id: 'part_compaction_ses_loom_demo_12',
        type: 'compaction',
        text: '上下文已压缩：前 12 条消息已合并为一份摘要',
        summaryText: '更早的对话已压缩为摘要，原始历史完整保留。',
        messageID: 'msg_compaction_ses_loom_demo_12',
        sessionID: SESSION_ID,
      },
    ],
  },
  textMessage('msg_older_user_1', 'user', ANCHOR_AT + 1000, HELLO_TEXT),
  textMessage('msg_older_assistant_1', 'assistant', ANCHOR_AT + 2000, '你好，我在。'),
]

test('history auto-loads one older page and keeps the compaction divider at its anchor', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })

  const beforeRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      url.pathname === `/api/screen/session/${SESSION_ID}/messages` &&
      url.searchParams.get('before') === 'c1'
    ) {
      beforeRequests.push(request.url())
    }
  })

  await page.route(
    (url) => url.pathname === `/api/screen/session/${SESSION_ID}/messages`,
    (route) => {
      const before = new URL(route.request().url()).searchParams.get('before')
      const body =
        before === 'c1'
          ? {
              session_id: SESSION_ID,
              count: OLDER_PAGE.length,
              messages: OLDER_PAGE,
              next_cursor: null,
            }
          : {
              session_id: SESSION_ID,
              count: RECENT_MESSAGES.length,
              messages: RECENT_MESSAGES,
              next_cursor: 'c1',
            }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    },
  )

  await page.goto('/mobile/#/chat', { waitUntil: 'domcontentloaded' })

  const userMessages = page.getByTestId('user-message')
  const chatTurns = page.getByTestId('chat-turn')
  const divider = page.getByTestId('thread-divider')

  await expect(userMessages.filter({ hasText: '近期第1问' })).toBeVisible()
  await expect(chatTurns).toHaveCount(9)

  // 手动的「加载更早」入口已移除
  await expect(page.getByTestId('load-more')).toHaveCount(0)
  await expect(page.getByText('加载更早', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '加载更早' })).toHaveCount(0)

  // 初始页不含分隔线 (若哨兵已自动触发前插, 则跳过这条前置断言)
  if (beforeRequests.length === 0) {
    await expect(divider).toHaveCount(0)
    await page.locator('.ax-chat__scroll').evaluate((element) => {
      ;(element as HTMLElement).scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
  }

  await expect.poll(() => beforeRequests.length, { timeout: 15000 }).toBeGreaterThan(0)

  // 更早消息出现, 分隔线只有一条
  await expect(userMessages.filter({ hasText: OLDER_USER_TEXT })).toHaveCount(1)
  await expect(userMessages.filter({ hasText: HELLO_TEXT })).toHaveCount(1)
  await expect(divider).toHaveCount(1)
  await expect(divider).toHaveAttribute('data-kind', 'compaction')
  await expect(divider).toContainText('更早的对话已压缩为摘要')

  // DOM 顺序: 更早提问 < 分隔线 < 你好
  const order = await page.evaluate(
    ({ olderText, helloText }) => {
      const users = Array.from(document.querySelectorAll('[data-testid="user-message"]'))
      const olderUser = users.find((element) =>
        (element.textContent || '').includes(olderText),
      )
      const helloUser = users.find((element) =>
        (element.textContent || '').includes(helloText),
      )
      const dividerElement = document.querySelector('[data-testid="thread-divider"]')
      if (!olderUser || !helloUser || !dividerElement) {
        return { olderBeforeDivider: false, dividerBeforeHello: false }
      }
      return {
        olderBeforeDivider: Boolean(
          olderUser.compareDocumentPosition(dividerElement) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        dividerBeforeHello: Boolean(
          dividerElement.compareDocumentPosition(helloUser) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      }
    },
    { olderText: OLDER_USER_TEXT, helloText: HELLO_TEXT },
  )
  expect(order.olderBeforeDivider).toBe(true)
  expect(order.dividerBeforeHello).toBe(true)

  // 前插后精确计数: 9 条历史 + 更早页 2 条用户消息 = 11 轮
  await expect(chatTurns).toHaveCount(11)
  await expect(userMessages).toHaveCount(11)

  const turnIds = await chatTurns.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-turn-id') || ''),
  )
  expect(turnIds).toHaveLength(11)
  expect(new Set(turnIds).size).toBe(11)

  // 每条消息只渲染一次 (抽查首尾与更早页)
  await expect(userMessages.filter({ hasText: OLDER_USER_TEXT })).toHaveCount(1)
  await expect(userMessages.filter({ hasText: HELLO_TEXT })).toHaveCount(1)
  await expect(userMessages.filter({ hasText: '近期第1问' })).toHaveCount(1)
  await expect(userMessages.filter({ hasText: '近期第9问' })).toHaveCount(1)
  await expect(divider).toHaveCount(1)
})
