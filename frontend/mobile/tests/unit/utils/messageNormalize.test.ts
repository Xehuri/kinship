/// <reference types="vitest/globals" />

import { describe, it, expect } from 'vitest'
import {
  normalizeHistoryMessage,
  normalizeHistoryMessages,
  type RawHistoryMessage,
} from '@/utils/messageNormalize'

describe('messageNormalize', () => {
  // ==================== normalizeHistoryMessage ====================

  describe('normalizeHistoryMessage', () => {
    it('info.time.created 毫秒时间戳映射为 ISO 字符串 timestamp', () => {
      const created = 1750663200000
      const raw: RawHistoryMessage = {
        info: { id: 'msg_1', role: 'user', time: { created } },
        parts: [{ type: 'text', text: '你好' }],
      }

      const msg = normalizeHistoryMessage(raw)

      expect(msg.id).toBe('msg_1')
      expect(msg.info?.id).toBe('msg_1')
      expect(msg.info?.role).toBe('user')
      // timestamp 与 SSE 消息保持一致 (ISO 字符串)
      expect(msg.timestamp).toBe(new Date(created).toISOString())
      expect(msg.parts).toHaveLength(1)
      expect(msg.isStreaming).toBe(false)
    })

    it('time 缺失时不设置 timestamp, 其余字段保留', () => {
      const raw: RawHistoryMessage = {
        info: { id: 'msg_2', role: 'assistant' },
        parts: [{ type: 'text', text: 'hi' }],
      }

      const msg = normalizeHistoryMessage(raw)

      expect(msg.timestamp).toBeUndefined()
      expect(msg.id).toBe('msg_2')
      expect(msg.info?.role).toBe('assistant')
      expect(msg.parts).toHaveLength(1)
    })

    it('info 缺失时不崩溃, 且兼容已归一化形态 (顶层 role/content)', () => {
      const raw: RawHistoryMessage = {
        role: 'user',
        content: '已归一化内容',
        timestamp: '2026-06-23T10:00:00.000Z',
      }

      const msg = normalizeHistoryMessage(raw)

      expect(msg.role).toBe('user')
      expect(msg.content).toBe('已归一化内容')
      expect(msg.timestamp).toBe('2026-06-23T10:00:00.000Z')
      expect(msg.isStreaming).toBe(false)
    })

    it('无参数对象不崩溃', () => {
      const msg = normalizeHistoryMessage({})

      expect(msg.id).toBeUndefined()
      expect(msg.timestamp).toBeUndefined()
      expect(msg.isStreaming).toBe(false)
    })

    it('parts 原样透传 (同引用)', () => {
      const parts = [{ type: 'text' as const, text: 'a' }]
      const msg = normalizeHistoryMessage({ info: { role: 'assistant' }, parts })

      expect(msg.parts).toBe(parts)
    })

    it('强制清除 isStreaming (历史消息非流式)', () => {
      const msg = normalizeHistoryMessage({
        role: 'assistant',
        isStreaming: true,
      })

      expect(msg.isStreaming).toBe(false)
    })
  })

  // ==================== normalizeHistoryMessages ====================

  describe('normalizeHistoryMessages', () => {
    it('批量归一化返回等长数组并逐条映射', () => {
      const list = normalizeHistoryMessages([
        { info: { id: 'a', role: 'user', time: { created: 1000 } } },
        { info: { id: 'b', role: 'assistant', time: { created: 2000 } } },
      ])

      expect(list).toHaveLength(2)
      expect(list[0].id).toBe('a')
      expect(list[0].timestamp).toBe(new Date(1000).toISOString())
      expect(list[1].id).toBe('b')
      expect(list[1].timestamp).toBe(new Date(2000).toISOString())
    })

    it('空数组返回空数组', () => {
      expect(normalizeHistoryMessages([])).toEqual([])
    })
  })
})
