/// <reference types="vitest/globals" />

/**
 * queueHandlers 单元测试
 *
 * Loom 的 session.queue 是外部发送唯一的用户消息来源: pending 快照会随
 * queued -> running -> drained 反复推送, 因此去重键必须是 (text, at) 而不是
 * 仅文本; 同时不能与本地 sendMessage 的乐观气泡重复。
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createQueueHandlers,
  QUEUE_LOCAL_DEDUPE_WINDOW_MS,
} from '@/composables/streaming/queueHandlers'
import type { ChatMessage, SSEProperties } from '@/types'

const AT = 1790000000000
const ENVELOPE = '<Axeuh-home-system>\n桥接/checkpoint 系统注入\n</Axeuh-home-system>'

function makeHandlers(msgs: ChatMessage[]) {
  return createQueueHandlers({ getMessages: () => msgs })
}

function queueEvent(pending: Array<Record<string, unknown>>): SSEProperties {
  return { sessionID: 'A', pending } as unknown as SSEProperties
}

describe('queueHandlers', () => {
  it('为 pending 项创建无 id 用户消息 (内容/时间戳/info.time.created)', () => {
    const msgs: ChatMessage[] = []
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), true)

    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('外部消息')
    expect(msgs[0].timestamp).toBe(new Date(AT).toISOString())
    expect(msgs[0].info?.time?.created).toBe(AT)
    expect(msgs[0].id).toBeUndefined()
    expect(msgs[0].info?.id).toBeUndefined()
  })

  it('非活跃会话直接忽略', () => {
    const msgs: ChatMessage[] = []
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), false)

    expect(msgs).toHaveLength(0)
  })

  it('queued -> running -> drained 重复快照不重复建条', () => {
    const msgs: ChatMessage[] = []
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), true)
    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'running' }]), true)
    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'drained' }]), true)
    h.handleSessionQueue(queueEvent([]), true)

    expect(msgs).toHaveLength(1)
  })

  it('同文本同 at 的再次快照按 info.time.created 精确去重', () => {
    const msgs: ChatMessage[] = []
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), true)
    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), true)

    expect(msgs).toHaveLength(1)
  })

  it('同文本不同 at 的外部消息各自成条', () => {
    const msgs: ChatMessage[] = []
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), true)
    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT + 1, state: 'queued' }]), true)

    expect(msgs).toHaveLength(2)
  })

  it(`本地乐观气泡 (无 id/无 info.time.created) 在 ${QUEUE_LOCAL_DEDUPE_WINDOW_MS}ms 内同文本去重`, () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: '外部消息',
        timestamp: new Date(AT - QUEUE_LOCAL_DEDUPE_WINDOW_MS + 1).toISOString(),
      },
    ]
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), true)

    expect(msgs).toHaveLength(1)
  })

  it(`本地乐观气泡超出 ${QUEUE_LOCAL_DEDUPE_WINDOW_MS}ms 窗口不算重复`, () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: '外部消息',
        timestamp: new Date(AT - QUEUE_LOCAL_DEDUPE_WINDOW_MS - 1).toISOString(),
      },
    ]
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '外部消息', at: AT, state: 'queued' }]), true)

    expect(msgs).toHaveLength(2)
  })

  it('非法 pending 项 (缺 text / 非数字 at) 被忽略', () => {
    const msgs: ChatMessage[] = []
    const h = makeHandlers(msgs)

    h.handleSessionQueue(
      queueEvent([
        { at: AT, state: 'queued' },
        { text: '无时间', state: 'queued' },
        { text: '坏时间', at: 'not-a-number', state: 'queued' },
      ]),
      true,
    )

    expect(msgs).toHaveLength(0)
  })

  // ==================== 带系统信封的外部消息 (生产重复气泡缺陷) ====================

  it('本地原文气泡与带信封的 queue 条目命中为一条, 并盖上 at 时间戳', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: '今晚吃什么',
        timestamp: new Date(AT - 2000).toISOString(),
      },
    ]
    const h = makeHandlers(msgs)

    h.handleSessionQueue(
      queueEvent([{ text: `${ENVELOPE}\n今晚吃什么`, at: AT, state: 'queued' }]),
      true,
    )

    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('今晚吃什么')
    expect(msgs[0].info?.role).toBe('user')
    expect(msgs[0].info?.time?.created).toBe(AT)
    expect(msgs[0].timestamp).toBe(new Date(AT).toISOString())
    expect(msgs[0].id).toBeUndefined()
    expect(msgs[0].info?.id).toBeUndefined()
  })

  it('盖章后同 at 快照超出 15s 窗口仍精确去重', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: '今晚吃什么',
        timestamp: new Date(AT - 2000).toISOString(),
      },
    ]
    const h = makeHandlers(msgs)

    h.handleSessionQueue(
      queueEvent([{ text: `${ENVELOPE}\n今晚吃什么`, at: AT, state: 'queued' }]),
      true,
    )
    expect(msgs).toHaveLength(1)

    vi.useFakeTimers()
    vi.setSystemTime(AT + QUEUE_LOCAL_DEDUPE_WINDOW_MS + 60000)
    try {
      h.handleSessionQueue(
        queueEvent([{ text: `${ENVELOPE}\n今晚吃什么`, at: AT, state: 'running' }]),
        true,
      )
    } finally {
      vi.useRealTimers()
    }

    expect(msgs).toHaveLength(1)
    expect(msgs[0].info?.time?.created).toBe(AT)
  })

  it('仅 queue 创建消息时保存剥离信封后的正文', () => {
    const msgs: ChatMessage[] = []
    const h = makeHandlers(msgs)

    h.handleSessionQueue(
      queueEvent([{ text: `${ENVELOPE}\n仅外部发送`, at: AT, state: 'queued' }]),
      true,
    )

    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('仅外部发送')
    expect(msgs[0].content).not.toContain('Axeuh-home-system')
  })

  it('本地气泡自带信封时同样按剥离后的文本去重', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: `${ENVELOPE}\n今晚吃什么`,
        timestamp: new Date(AT - 1000).toISOString(),
      },
    ]
    const h = makeHandlers(msgs)

    h.handleSessionQueue(queueEvent([{ text: '今晚吃什么', at: AT, state: 'queued' }]), true)

    expect(msgs).toHaveLength(1)
    expect(msgs[0].info?.time?.created).toBe(AT)
  })
})
