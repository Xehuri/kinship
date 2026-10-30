/// <reference types="vitest/globals" />

/**
 * partHandlers 守卫收紧测试 (W45 双通道分账)
 *
 * 新规则: activeSessionId 在场时, message.part.updated / message.part.delta
 * 事件的 sessionID 必须与之相等, 否则一律丢弃 —— 包括不带 sessionID 的帧
 * (通道归属不明, 双 hub 混合流下正是串会话的根因, 绝不建占位符)。
 * activeSessionId 缺席 (尚未归属) 时维持旧行为: 帧直通并自动建占位符。
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createPartHandlers,
  type PartHandlerDeps,
} from '@/composables/streaming/partHandlers'
import type { ChatMessage, SSEProperties } from '@/types'
import type { SessionStatus } from '@/composables/streaming/sseParsing'

/** 构造最小依赖面: 固定 messages 数组 + 活跃会话 ID */
function makeDeps(activeSessionId: string, msgs: ChatMessage[]) {
  const setSessionStatus = vi.fn<(id: string, s: SessionStatus) => void>()
  const finalizeStreaming = vi.fn()
  const deps: PartHandlerDeps = {
    getMessages: () => msgs,
    getActiveSessionId: () => activeSessionId,
    setSessionStatus,
    finalizeStreaming,
  }
  return { deps, setSessionStatus, finalizeStreaming }
}

describe('partHandlers 守卫收紧 (W45)', () => {
  // ==================== message.part.updated ====================

  describe('handlePartUpdated', () => {
    it('活跃会话在场时, 缺 sessionID 的帧被丢弃且不新建占位符', () => {
      const msgs: ChatMessage[] = []
      const { deps } = makeDeps('A', msgs)
      const h = createPartHandlers(deps)

      h.handlePartUpdated({ part: { id: 'p1', type: 'text', text: '串泡内容' } } as SSEProperties, undefined)

      // 关键回归断言: msgs 完全不变 (旧规则会直通并自动创建占位符)
      expect(msgs).toHaveLength(0)
    })

    it('活跃会话在场时, sessionID 相等的帧生效并写入占位符', () => {
      const msgs: ChatMessage[] = []
      const { deps } = makeDeps('A', msgs)
      const h = createPartHandlers(deps)

      h.handlePartUpdated({ part: { id: 'p1', type: 'text', text: '正常内容' } } as SSEProperties, 'A')

      expect(msgs).toHaveLength(1)
      expect(msgs[0].parts![0].text).toBe('正常内容')
    })

    it('活跃会话在场时, 异属会话的帧被丢弃 (回归: 旧守卫已覆盖, 收紧后仍丢弃)', () => {
      const msgs: ChatMessage[] = []
      const { deps } = makeDeps('A', msgs)
      const h = createPartHandlers(deps)

      h.handlePartUpdated({ part: { id: 'p1', type: 'text', text: '别的会话' } } as SSEProperties, 'B')

      expect(msgs).toHaveLength(0)
    })

    it('活跃会话在场时, 缺 sessionID 的 error part 也被丢弃 (不 finalize/不建占位符)', () => {
      const msgs: ChatMessage[] = []
      const { deps, setSessionStatus, finalizeStreaming } = makeDeps('A', msgs)
      const h = createPartHandlers(deps)

      h.handlePartUpdated({ part: { id: 'e1', type: 'error', text: 'boom' } } as SSEProperties, undefined)

      expect(msgs).toHaveLength(0)
      expect(setSessionStatus).not.toHaveBeenCalled()
      expect(finalizeStreaming).not.toHaveBeenCalled()
    })

    it('活跃会话缺席时, 缺 sessionID 的帧仍可建占位符 (归属未初始化前的兼容路径)', () => {
      const msgs: ChatMessage[] = []
      const { deps } = makeDeps('', msgs)
      const h = createPartHandlers(deps)

      h.handlePartUpdated({ part: { id: 'p1', type: 'text', text: '早期事件' } } as SSEProperties, undefined)

      expect(msgs).toHaveLength(1)
      expect(msgs[0].isStreaming).toBe(true)
    })
  })

  // ==================== message.part.delta ====================

  describe('handlePartDelta', () => {
    it('活跃会话在场时, 缺 sessionID 的 delta 被丢弃且不新建占位符', () => {
      const msgs: ChatMessage[] = []
      const { deps } = makeDeps('A', msgs)
      const h = createPartHandlers(deps)

      h.handlePartDelta({ partID: 'p1', field: 'text', delta: '串泡' } as SSEProperties, undefined)

      expect(msgs).toHaveLength(0)
    })

    it('活跃会话在场时, sessionID 相等的 delta 生效 (自动建 part 并累积)', () => {
      const msgs: ChatMessage[] = []
      const { deps } = makeDeps('A', msgs)
      const h = createPartHandlers(deps)

      h.handlePartDelta({ partID: 'p1', field: 'text', delta: '正常' } as SSEProperties, 'A')

      expect(msgs).toHaveLength(1)
      expect(msgs[0].parts![0].text).toBe('正常')
    })

    it('活跃会话在场时, 异属会话的 delta 被丢弃 (回归)', () => {
      const msgs: ChatMessage[] = []
      const { deps } = makeDeps('A', msgs)
      const h = createPartHandlers(deps)

      h.handlePartDelta({ partID: 'p1', field: 'text', delta: '别的' } as SSEProperties, 'B')

      expect(msgs).toHaveLength(0)
    })
  })

  // ==================== 用户 part 的系统信封剥离 ====================

  describe('用户 part 信封剥离', () => {
    const ENVELOPE = '<Axeuh-home-system>\n系统注入\n</Axeuh-home-system>'

    function makeUserDeps(msgs: ChatMessage[], msgId: string) {
      const { deps } = makeDeps('A', msgs)
      deps.getMessageRole = (id: string) => (id === msgId ? 'user' : undefined)
      return deps
    }

    it('handlePartUpdated 填充外部用户气泡时剥离信封', () => {
      const msgs: ChatMessage[] = [
        { id: 'msg_u', role: 'user', content: '', info: { role: 'user' } },
      ]
      const h = createPartHandlers(makeUserDeps(msgs, 'msg_u'))

      h.handlePartUpdated(
        {
          part: { id: 'p1', type: 'text', text: `${ENVELOPE}\n外部提问` },
          messageID: 'msg_u',
        } as SSEProperties,
        'A',
      )

      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe('外部提问')
      expect(msgs[0].content).not.toContain('Axeuh-home-system')
    })

    it('handlePartDelta 填充外部用户气泡时剥离信封', () => {
      const msgs: ChatMessage[] = [
        { id: 'msg_u2', role: 'user', content: '', info: { role: 'user' } },
      ]
      const h = createPartHandlers(makeUserDeps(msgs, 'msg_u2'))

      h.handlePartDelta(
        {
          partID: 'p2',
          field: 'text',
          delta: `${ENVELOPE}\n增量提问`,
          messageID: 'msg_u2',
        } as SSEProperties,
        'A',
      )

      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe('增量提问')
      expect(msgs[0].content).not.toContain('Axeuh-home-system')
    })

    it('无信封的用户 part 内容逐字保留', () => {
      const msgs: ChatMessage[] = [
        { id: 'msg_u3', role: 'user', content: '', info: { role: 'user' } },
      ]
      const h = createPartHandlers(makeUserDeps(msgs, 'msg_u3'))

      h.handlePartUpdated(
        {
          part: { id: 'p3', type: 'text', text: '  原样文本  ' },
          messageID: 'msg_u3',
        } as SSEProperties,
        'A',
      )

      expect(msgs[0].content).toBe('  原样文本  ')
    })
  })
})
