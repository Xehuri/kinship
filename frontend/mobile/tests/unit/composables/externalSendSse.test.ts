/// <reference types="vitest/globals" />

/**
 * 外部发送渲染 (P0)
 *
 * 覆盖两条没有本地乐观气泡（或本地气泡与本条外部消息无关）的入站路径:
 *   - Loom: 只发 session.queue { pending:[{text,at,state}] }, 不发用户消息事件
 *   - OpenCode: 外部 message.updated(role=user) + 用户 part
 *
 * 不变量:
 *   1. 外部用户消息必须成为轮次边界, 下一条 assistant 回复开新轮, 不并入旧回复;
 *   2. 重复的 queue 快照 / 本地乐观气泡不产生重复用户消息;
 *   3. 用户 part 只填充用户气泡, 绝不创建 AI 占位符。
 */

import { ref, type Ref } from 'vue'
import { vi } from 'vitest'
import { useStreamingMessage, type UseStreamingMessageReturn } from '@/composables/useStreamingMessage'
import { mergeChatMessages } from '@/composables/chat/historyMerge'
import { toTurnViews } from '@/utils/turnAdapter'
import type { ChatMessage } from '@/types/chat'

const MAIN_SESSION = 'ses_main'
const EXTERNAL_AT = 1790000000000
const ENVELOPE = '<Axeuh-home-system>\n桥接/checkpoint 系统注入\n</Axeuh-home-system>'

describe('外部发送 SSE 渲染 (Loom session.queue / OpenCode user message)', () => {
  let sm: UseStreamingMessageReturn
  let messages: Ref<ChatMessage[]>
  let activeSessionId: Ref<string>

  beforeEach(() => {
    messages = ref<ChatMessage[]>([])
    activeSessionId = ref(MAIN_SESSION)
    sm = useStreamingMessage()
    sm.configure({ messages, activeSessionId })
  })

  function queue(
    pending: Array<Record<string, unknown>>,
    sessionID: string = MAIN_SESSION,
  ): void {
    sm.handleSSEEvent({
      type: 'session.queue',
      payload: {
        type: 'session.queue',
        properties: { sessionID, pending } as Record<string, unknown>,
      },
    })
  }

  function messageUpdated(
    info: Record<string, unknown>,
    sessionID: string = MAIN_SESSION,
  ): void {
    sm.handleSSEEvent({
      type: 'message.updated',
      payload: {
        type: 'message.updated',
        properties: { info, sessionID } as Record<string, unknown>,
      },
    })
  }

  function partUpdated(
    part: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void {
    sm.handleSSEEvent({
      type: 'message.part.updated',
      payload: {
        type: 'message.part.updated',
        properties: {
          part,
          sessionID: MAIN_SESSION,
          ...extra,
        } as Record<string, unknown>,
      },
    })
  }

  function partDelta(partID: string, delta: string, messageID: string): void {
    sm.handleSSEEvent({
      type: 'message.part.delta',
      payload: {
        type: 'message.part.delta',
        properties: {
          partID,
          field: 'text',
          delta,
          messageID,
          sessionID: MAIN_SESSION,
        } as Record<string, unknown>,
      },
    })
  }

  function userMessages(): ChatMessage[] {
    return messages.value.filter((m) => (m.role || m.info?.role) === 'user')
  }

  // ==================== a. queue 建用户消息 ====================

  it('a. session.queue 为活跃会话创建带内容与 at 时间戳的用户消息 (无稳定 id)', () => {
    queue([{ text: '外部消息', at: EXTERNAL_AT, state: 'queued' }])

    expect(messages.value).toHaveLength(1)
    const msg = messages.value[0]
    expect(msg.role).toBe('user')
    expect(msg.info?.role).toBe('user')
    expect(msg.content).toBe('外部消息')
    expect(msg.timestamp).toBe(new Date(EXTERNAL_AT).toISOString())
    expect(msg.info?.time?.created).toBe(EXTERNAL_AT)
    // 队列临时消息不能有稳定 id, 否则历史合并无法用历史版本替换它
    expect(msg.id).toBeUndefined()
    expect(msg.info?.id).toBeUndefined()
  })

  it('a2. 非活跃会话的 session.queue 被忽略', () => {
    queue([{ text: '别的会话', at: EXTERNAL_AT, state: 'queued' }], 'ses_other')

    expect(messages.value).toHaveLength(0)
  })

  // ==================== b. 重复快照去重 ====================

  it('b. queued -> running -> drained -> 空列表 不重复创建用户消息', () => {
    const item = { text: '外部消息', at: EXTERNAL_AT }
    queue([{ ...item, state: 'queued' }])
    queue([{ ...item, state: 'running' }])
    queue([{ ...item, state: 'drained' }])
    queue([])

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].content).toBe('外部消息')
  })

  // ==================== c. 本地乐观气泡去重 ====================

  it('c. 同文本且 15s 内的本地乐观用户消息不会被 queue 重复添加', () => {
    messages.value.push({
      role: 'user',
      content: '外部消息',
      timestamp: new Date(EXTERNAL_AT - 5000).toISOString(),
    })

    queue([{ text: '外部消息', at: EXTERNAL_AT, state: 'queued' }])

    expect(userMessages()).toHaveLength(1)
    expect(messages.value).toHaveLength(1)
  })

  it('c2. 同文本但 at 不同的两条外部排队消息必须各自成条', () => {
    queue([{ text: '外部消息', at: EXTERNAL_AT, state: 'queued' }])
    queue([{ text: '外部消息', at: EXTERNAL_AT + 60000, state: 'queued' }])

    expect(userMessages()).toHaveLength(2)
    expect(userMessages().map((m) => m.info?.time?.created)).toEqual([
      EXTERNAL_AT,
      EXTERNAL_AT + 60000,
    ])
  })

  it('c3. 本地原文气泡 + 带信封的 queue 条目只渲染一条用户消息 (生产重复气泡回归)', () => {
    messages.value.push({
      role: 'user',
      content: '今晚吃什么',
      timestamp: new Date(EXTERNAL_AT - 5000).toISOString(),
    })

    queue([{ text: `${ENVELOPE}\n今晚吃什么`, at: EXTERNAL_AT, state: 'queued' }])

    expect(messages.value).toHaveLength(1)
    expect(userMessages()).toHaveLength(1)
    expect(userMessages()[0].content).toBe('今晚吃什么')
    expect(userMessages()[0].info?.time?.created).toBe(EXTERNAL_AT)
    expect(userMessages()[0].timestamp).toBe(new Date(EXTERNAL_AT).toISOString())
    expect(userMessages()[0].id).toBeUndefined()
  })

  it('c4. 盖章后超过 15s 的同 at 快照仍只保留一条', () => {
    messages.value.push({
      role: 'user',
      content: '今晚吃什么',
      timestamp: new Date(EXTERNAL_AT - 5000).toISOString(),
    })
    queue([{ text: `${ENVELOPE}\n今晚吃什么`, at: EXTERNAL_AT, state: 'queued' }])
    expect(userMessages()).toHaveLength(1)

    vi.useFakeTimers()
    vi.setSystemTime(EXTERNAL_AT + 15000 + 60000)
    try {
      queue([{ text: `${ENVELOPE}\n今晚吃什么`, at: EXTERNAL_AT, state: 'running' }])
    } finally {
      vi.useRealTimers()
    }

    expect(messages.value).toHaveLength(1)
    expect(userMessages()[0].info?.time?.created).toBe(EXTERNAL_AT)
  })

  it('c5. 仅 queue 来源的带信封消息渲染剥离后的正文', () => {
    queue([{ text: `${ENVELOPE}\n仅外部发送`, at: EXTERNAL_AT, state: 'queued' }])

    expect(userMessages()).toHaveLength(1)
    expect(userMessages()[0].content).toBe('仅外部发送')
    expect(userMessages()[0].content).not.toContain('Axeuh-home-system')

    const turns = toTurnViews(messages.value)
    expect(turns).toHaveLength(1)
    expect(turns[0].userText).toBe('仅外部发送')
  })

  // ==================== d. 轮次边界 ====================

  it('d. [user U1, assistant A1, queue U2, assistant A2] 渲染两轮, A2 不并入 A1', () => {
    messages.value.push(
      {
        id: 'u1',
        role: 'user',
        content: '第一问',
        timestamp: new Date(EXTERNAL_AT - 60000).toISOString(),
      },
      {
        id: 'a1',
        role: 'assistant',
        timestamp: new Date(EXTERNAL_AT - 55000).toISOString(),
        parts: [{ type: 'text', text: '第一答' }],
      },
    )

    queue([{ text: '第二问', at: EXTERNAL_AT, state: 'queued' }])
    partUpdated({ id: 'p_a2', type: 'text', text: '第二答' }, { messageID: 'msg_a2' })

    const turns = toTurnViews(messages.value)

    expect(turns).toHaveLength(2)
    expect(turns[0].userText).toBe('第一问')
    expect(turns[0].reply).toBe('第一答')
    expect(turns[1].userText).toBe('第二问')
    expect(turns[1].reply).toBe('第二答')
    expect(turns[0].reply).not.toContain('第二答')
  })

  // ==================== e. OpenCode 外部用户消息 ====================

  it('e. 外部 message.updated(user) 建用户消息, 后续用户 text part 只填充内容', () => {
    messageUpdated({ id: 'msg_ext_u', role: 'user', time: { created: EXTERNAL_AT } })

    expect(messages.value).toHaveLength(1)
    const created = messages.value[0]
    expect(created.id).toBe('msg_ext_u')
    expect(created.role).toBe('user')
    expect(created.content).toBe('')
    expect(created.timestamp).toBe(new Date(EXTERNAL_AT).toISOString())

    partUpdated(
      { id: 'p_ext_u', type: 'text', text: '外部提问' },
      { messageID: 'msg_ext_u' },
    )

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].role).toBe('user')
    expect(messages.value[0].content).toBe('外部提问')
    expect(messages.value.some((m) => (m.role || m.info?.role) === 'assistant')).toBe(false)
  })

  it('e2. 用户 part.delta 同样填充外部用户气泡, 不建 AI 占位符', () => {
    messageUpdated({ id: 'msg_ext_u2', role: 'user', time: { created: EXTERNAL_AT + 1000 } })

    partDelta('p_ext_u2', '外部', 'msg_ext_u2')

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].role).toBe('user')
    expect(messages.value[0].content).toBe('外部')
    expect(messages.value.some((m) => (m.role || m.info?.role) === 'assistant')).toBe(false)
  })

  it('e3. 同一外部 message.updated(user) 重复到达不重复建条', () => {
    const info = { id: 'msg_ext_u3', role: 'user', time: { created: EXTERNAL_AT + 2000 } }
    messageUpdated(info)
    messageUpdated(info)

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].id).toBe('msg_ext_u3')
    expect(messages.value[0].role).toBe('user')
  })

  it('e4. queue 消息绑定 id 后重复 message.updated(user) 不重复', () => {
    queue([{ text: '外部消息', at: EXTERNAL_AT, state: 'queued' }])
    messageUpdated({ id: 'msg_ext_u4', role: 'user', time: { created: EXTERNAL_AT } })
    expect(userMessages()).toHaveLength(1)
    expect(userMessages()[0].id).toBe('msg_ext_u4')

    messageUpdated({ id: 'msg_ext_u4', role: 'user', time: { created: EXTERNAL_AT } })

    expect(userMessages()).toHaveLength(1)
    expect(userMessages()[0].content).toBe('外部消息')
  })

  it('e5. 历史中已有同 id 用户消息时, message.updated(user) 不重复', () => {
    messages.value.push({
      id: 'hist_u1',
      role: 'user',
      content: '历史提问',
      info: { role: 'user', time: { created: EXTERNAL_AT } },
    })

    messageUpdated({ id: 'hist_u1', role: 'user', time: { created: EXTERNAL_AT } })

    expect(userMessages()).toHaveLength(1)
    expect(userMessages()[0].content).toBe('历史提问')
  })

  it('e6. 用户 part 带信封时只把剥离后的正文写入外部用户气泡', () => {
    messageUpdated({ id: 'msg_ext_u6', role: 'user', time: { created: EXTERNAL_AT + 500 } })
    partUpdated(
      { id: 'p_ext_u6', type: 'text', text: `${ENVELOPE}\n外部提问` },
      { messageID: 'msg_ext_u6' },
    )

    expect(userMessages()).toHaveLength(1)
    expect(userMessages()[0].content).toBe('外部提问')
    expect(userMessages()[0].content).not.toContain('Axeuh-home-system')
  })

  // ==================== f. 不抢占本地乐观气泡 ====================

  it('f. 本地发送在途时, 外部 message.updated(user) 不抢占/重绑本地气泡', () => {
    // sendMessage 的乐观状态: 无 id 用户气泡 + 无 id 流式占位符
    messages.value.push(
      {
        role: 'user',
        content: '本地发送',
        timestamp: new Date(EXTERNAL_AT - 3000).toISOString(),
      },
      {
        id: 'local-1',
        role: 'assistant',
        parts: [],
        isStreaming: true,
        timestamp: new Date(EXTERNAL_AT - 2000).toISOString(),
      },
    )

    queue([{ text: '外部提问', at: EXTERNAL_AT, state: 'queued' }])
    messageUpdated({ id: 'msg_ext_u', role: 'user', time: { created: EXTERNAL_AT } })

    const local = userMessages()[0]
    expect(local.content).toBe('本地发送')
    expect(local.id).toBeUndefined()

    const external = userMessages().find((m) => m.id === 'msg_ext_u')
    expect(external?.content).toBe('外部提问')
    expect(userMessages()).toHaveLength(2)
  })

  // ==================== g. 历史合并替换临时 queue 消息 ====================

  it('g. 历史合并用历史版本替换临时 queue 用户消息 (不重复)', () => {
    queue([{ text: '外部消息', at: EXTERNAL_AT, state: 'queued' }])
    expect(messages.value).toHaveLength(1)

    const history: ChatMessage[] = [
      {
        id: 'hist_u1',
        role: 'user',
        content: '外部消息',
        timestamp: new Date(EXTERNAL_AT).toISOString(),
        info: { role: 'user', time: { created: EXTERNAL_AT } },
      },
    ]

    const merged = mergeChatMessages(history, messages.value)

    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('hist_u1')
    expect(merged.filter((m) => (m.role || m.info?.role) === 'user')).toHaveLength(1)
  })
})
