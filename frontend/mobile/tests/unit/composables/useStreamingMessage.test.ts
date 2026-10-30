/// <reference types="vitest/globals" />

import { ref, type Ref } from 'vue'
import { vi } from 'vitest'
import { useStreamingMessage, setSSEDebug, type UseStreamingMessageReturn } from '@/composables/useStreamingMessage'
import type { ChatMessage } from '@/types/chat'

/**
 * useStreamingMessage 测试 — 按真实架构验证
 *
 * 真实架构: useChat.initStreaming() 调 sm.configure({ messages, activeSessionId })
 * 注入中央 Store 的 messages ref, SSE 事件通过 handleSSEEvent 直接修改 messages.value。
 * 测试必须 configure 后才能验证 SSE 事件驱动渲染路径。
 */

describe('useStreamingMessage', () => {
  let sm: UseStreamingMessageReturn
  let messages: Ref<ChatMessage[]>
  let activeSessionId: Ref<string>

  beforeEach(() => {
    messages = ref<ChatMessage[]>([])
    activeSessionId = ref('ses_main')
    sm = useStreamingMessage()
    sm.configure({ messages, activeSessionId })
  })

  function partUpdated(part: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    sm.handleSSEEvent({
      type: 'message.part.updated',
      payload: {
        type: 'message.part.updated',
        properties: {
          part,
          sessionID: activeSessionId.value,
          ...extra,
        },
      },
    })
  }

  function partDelta(partID: string, delta: string): void {
    sm.handleSSEEvent({
      type: 'message.part.delta',
      payload: {
        type: 'message.part.delta',
        properties: {
          partID,
          field: 'text',
          delta,
          sessionID: activeSessionId.value,
        } as Record<string, unknown>,
      },
    })
  }

  // ==================== 核心: 事件驱动自动建占位符 ====================

  describe('事件驱动自动建占位符 (无 sendMessage 触发)', () => {
    it('part.updated 到达时自动创建 isStreaming 占位符并写入 part', () => {
      partUpdated({ id: 'p1', type: 'text', text: 'hello' })

      expect(messages.value.length).toBe(1)
      expect(messages.value[0].role).toBe('assistant')
      expect(messages.value[0].isStreaming).toBe(true)
      const p = messages.value[0].parts![0]
      expect(p.type).toBe('text')
      expect(p.text).toBe('hello')
    })

    it('part.delta 到达时自动创建占位符并追加文本', () => {
      partDelta('p2', '世界')

      expect(messages.value.length).toBe(1)
      expect(messages.value[0].isStreaming).toBe(true)
      expect(messages.value[0].parts![0].text).toBe('世界')
    })

    it('多个事件复用同一个占位符 (不重复创建)', () => {
      partUpdated({ id: 'p1', type: 'text', text: '你' })
      partDelta('p1', '好')
      partUpdated({ id: 'p2', type: 'reasoning', text: '思考' })

      expect(messages.value.length).toBe(1)
      const parts = messages.value[0].parts!
      expect(parts.length).toBe(2)
      expect(parts.find(p => p._partId === 'p1')?.text).toBe('你好')
      expect(parts.find(p => p._partId === 'p2')?.text).toBe('思考')
    })

    it('session.idle 后占位符被 finalize (isStreaming=false)', () => {
      partUpdated({ id: 'p1', type: 'text', text: '完成' })

      sm.handleSSEEvent({
        type: 'session.idle',
        payload: {
          type: 'session.idle',
          properties: { sessionID: activeSessionId.value },
        },
      })

      expect(messages.value[0].isStreaming).toBe(false)
    })
  })

  // ==================== 会话过滤 ====================

  describe('会话过滤', () => {
    it('其他会话的 part 事件不污染当前会话消息列表', () => {
      partUpdated(
        { id: 'p_other', type: 'text', text: '其他会话内容' },
        { sessionID: 'ses_other' }
      )

      // 非活跃会话事件被丢弃, 不创建消息
      expect(messages.value.length).toBe(0)
    })
  })

  // ==================== 既有行为 ====================

  describe('handleSSEEvent 兼容行为', () => {
    it('忽略 step-start / step-finish 事件 (不写入 parts)', () => {
      partUpdated({ id: 'p1', type: 'step-start', text: 'start' })
      partUpdated({ id: 'p1', type: 'step-finish', text: 'finish' })

      // step 事件被忽略: 不产生 parts
      if (messages.value.length > 0) {
        expect(messages.value[0].parts!.length).toBe(0)
      }
    })

    it('忽略 proxy.connected / server.connected 事件', () => {
      sm.handleSSEEvent({
        type: 'proxy.connected',
        payload: { type: 'proxy.connected', properties: {} },
      })
      sm.handleSSEEvent({
        type: 'server.connected',
        payload: { type: 'server.connected', properties: {} },
      })

      expect(messages.value.length).toBe(0)
    })

    it('处理 null/undefined 输入不报错', () => {
      expect(() => sm.handleSSEEvent(null)).not.toThrow()
      expect(() => sm.handleSSEEvent(undefined as unknown as Record<string, unknown>)).not.toThrow()
    })

    it('处理不含 payload 的事件不报错', () => {
      expect(() => sm.handleSSEEvent({ type: 'unknown' })).not.toThrow()
    })

    it('处理不含 properties 的事件不报错', () => {
      expect(() =>
        sm.handleSSEEvent({
          type: 'message.part.updated',
          payload: { type: 'message.part.updated' },
        })
      ).not.toThrow()
    })
  })

  describe('message.updated', () => {
    it('message.updated 更新 tokens, session.idle 触发 finalize 使 promise resolve', async () => {
      // 先创建流式占位符 (session.idle 需要 isStreaming=true 才 finalize)
      partUpdated({ id: 'p1', type: 'text', text: '回复中' })
      const promise = sm.createPendingPromise()

      sm.handleSSEEvent({
        type: 'message.updated',
        payload: {
          type: 'message.updated',
          properties: {
            info: { role: 'assistant', tokens: { total: 100, input: 60, output: 40 } },
            sessionID: activeSessionId.value,
          } as Record<string, unknown>,
        },
      })

      // message.updated 更新 token 用量
      expect(sm.currentTokens.value?.total).toBe(100)

      // finalize 由 session.idle 触发
      sm.handleSSEEvent({
        type: 'session.idle',
        payload: {
          type: 'session.idle',
          properties: { sessionID: activeSessionId.value },
        },
      })

      await expect(promise).resolves.toBeUndefined()
      // 占位符被 finalize
      expect(messages.value[0].isStreaming).toBe(false)
    })

    it('收到 message.updated(user) 不触发 finalize, promise 不 resolve', async () => {
      let resolved = false
      const promise = sm.createPendingPromise()
      promise.then(() => { resolved = true })

      sm.handleSSEEvent({
        type: 'message.updated',
        payload: {
          type: 'message.updated',
          properties: {
            info: { role: 'user' },
          } as Record<string, unknown>,
        },
      })

      await new Promise((r) => setTimeout(r, 10))
      expect(resolved).toBe(false)
    })
  })

  describe('token 归一化 (C7)', () => {
    /** 触发 message.updated 事件并携带指定 tokens */
    function messageUpdatedTokens(tokens: Record<string, unknown>): void {
      sm.handleSSEEvent({
        type: 'message.updated',
        payload: {
          type: 'message.updated',
          properties: {
            info: { role: 'assistant', tokens },
            sessionID: activeSessionId.value,
          } as Record<string, unknown>,
        },
      })
    }

    it('仅有 total 时保留 total (input/output 补 0)', () => {
      messageUpdatedTokens({ total: 250 })
      expect(sm.currentTokens.value?.total).toBe(250)
      expect(sm.currentTokens.value?.input).toBe(0)
      expect(sm.currentTokens.value?.output).toBe(0)
    })

    it('仅有 input/output 时推导 total = input + output', () => {
      messageUpdatedTokens({ input: 60, output: 40 })
      expect(sm.currentTokens.value).toEqual({ total: 100, input: 60, output: 40 })
    })

    it('保留 reasoning / cache 明细', () => {
      messageUpdatedTokens({ total: 100, reasoning: 30, cache: { read: 5, write: 6 } })
      expect(sm.currentTokens.value?.reasoning).toBe(30)
      expect(sm.currentTokens.value?.cache).toEqual({ read: 5, write: 6 })
    })

    it('全 0 tokens 不更新显示 (保持 null)', () => {
      messageUpdatedTokens({ total: 0, input: 0, output: 0 })
      expect(sm.currentTokens.value).toBeNull()
    })
  })

  describe('createPendingPromise + finalizeStreaming', () => {
    it('promise 在 finalizeStreaming 时 resolve', async () => {
      const promise = sm.createPendingPromise()

      setTimeout(() => sm.finalizeStreaming(), 5)

      await expect(promise).resolves.toBeUndefined()
    })
  })

  describe('createPendingPromise 竞态 (FE-H5)', () => {
    it('连发两条请求都能 resolve (旧请求被新请求取代时立即 resolve)', async () => {
      const p1 = sm.createPendingPromise()
      const p2 = sm.createPendingPromise()

      // 第二个请求创建时, 第一个 pending 应被 resolve, 避免悬挂
      await expect(p1).resolves.toBeUndefined()

      // 流式完成后, 第二个也 resolve
      sm.finalizeStreaming()
      await expect(p2).resolves.toBeUndefined()
    })

    it('finalizeStreaming 会 resolve 当前 pending', async () => {
      const p = sm.createPendingPromise()
      sm.finalizeStreaming()
      await expect(p).resolves.toBeUndefined()
    })
  })

  describe('活跃会话来源 (FE-M2)', () => {
    it('SSE 事件不会篡改活跃会话 ID', () => {
      // 激活会话重置为空 (不按会话过滤)
      activeSessionId.value = ''
      sm.configure({ messages, activeSessionId })

      // 收到 ses_x 的事件
      partUpdated({ id: 'p1', type: 'text', text: 'a' }, { sessionID: 'ses_x' })
      // 再收到 ses_y 的事件: 若活跃会话被劫持为 ses_x, 此事件会被丢弃
      partUpdated({ id: 'p2', type: 'text', text: 'b' }, { sessionID: 'ses_y' })

      const ids = messages.value[0]?.parts?.map((p) => (p as { _partId?: string })._partId)
      expect(ids).toContain('p2')
    })
  })

  describe('isStreaming', () => {
    it('初始为 false', () => {
      expect(sm.isStreaming.value).toBe(false)
    })

    it('事件驱动创建占位符后为 true', () => {
      partUpdated({ id: 'p1', type: 'text', text: 'hi' })
      expect(sm.isStreaming.value).toBe(true)
    })

    it('finalize 后恢复为 false', () => {
      partUpdated({ id: 'p1', type: 'text', text: 'hi' })
      expect(sm.isStreaming.value).toBe(true)

      sm.finalizeStreaming()
      expect(sm.isStreaming.value).toBe(false)
    })
  })

  describe('sessionStatus', () => {
    it('session.idle 更新会话状态映射', () => {
      sm.handleSSEEvent({
        type: 'session.idle',
        payload: {
          type: 'session.idle',
          properties: { sessionID: 'ses_x' },
        },
      })

      expect(sm.sessionStatus.value['ses_x']).toBe('idle')
    })

    it('session.updated 更新会话状态映射', () => {
      sm.handleSSEEvent({
        type: 'session.updated',
        payload: {
          type: 'session.updated',
          properties: { sessionID: 'ses_y', status: 'busy' },
        },
      })

      expect(sm.sessionStatus.value['ses_y']).toBe('busy')
    })
  })

  // ==================== T-C5 SSE 健壮性 ====================

  describe('session.status 状态对象解析 (T-C5)', () => {
    it('status 为对象时读取 type 字段', () => {
      sm.handleSSEEvent({
        type: 'session.status',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_obj',
            status: { type: 'busy' },
          } as Record<string, unknown>,
        },
      })

      expect(sm.sessionStatus.value['ses_obj']).toBe('busy')
    })

    it('status 为字符串时兼容解析', () => {
      sm.handleSSEEvent({
        type: 'session.status',
        payload: {
          type: 'session.status',
          properties: { sessionID: 'ses_str', status: 'idle' },
        },
      })

      expect(sm.sessionStatus.value['ses_str']).toBe('idle')
    })

    it('无法识别的状态安全回退 idle', () => {
      sm.handleSSEEvent({
        type: 'session.status',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_unknown',
            status: { type: 'weird' },
          } as Record<string, unknown>,
        },
      })

      expect(sm.sessionStatus.value['ses_unknown']).toBe('idle')
    })
  })

  describe('session.status idle 结束流式 (OpenCode 1.18.30+)', () => {
    it('收到 session.status{status:{type:idle}} 时 finalize (isStreaming 变 false)', () => {
      partUpdated({ id: 'p1', type: 'text', text: '流式中' })
      expect(sm.isStreaming.value).toBe(true)

      sm.handleSSEEvent({
        type: 'session.status',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: activeSessionId.value,
            status: { type: 'idle' },
          } as Record<string, unknown>,
        },
      })

      expect(sm.isStreaming.value).toBe(false)
      expect(messages.value[0].isStreaming).toBe(false)
      expect(sm.sessionStatus.value[activeSessionId.value]).toBe('idle')
    })

    it('finalizeStreaming 清除所有 isStreaming 消息', () => {
      partUpdated({ id: 'p1', type: 'text', text: '第一条' })
      // 手工追加第二条流式消息 (模拟异常/并发产生的多条占位符)
      messages.value.push({ role: 'assistant', parts: [], isStreaming: true })
      expect(messages.value.filter((m) => m.isStreaming === true).length).toBe(2)

      sm.finalizeStreaming()

      expect(messages.value.some((m) => m.isStreaming === true)).toBe(false)
    })
  })

  describe('会话错误处理 (T-C5)', () => {
    it('session.error 展示错误并 finalize, 使 pending resolve', async () => {
      partUpdated({ id: 'p1', type: 'text', text: '进行中' })
      const promise = sm.createPendingPromise()

      sm.handleSSEEvent({
        type: 'session.error',
        payload: {
          type: 'session.error',
          properties: {
            sessionID: activeSessionId.value,
            error: { name: 'AIError', message: '模型超时' },
          } as Record<string, unknown>,
        },
      })

      await expect(promise).resolves.toBeUndefined()
      expect(messages.value[0].isStreaming).toBe(false)
      const text = messages.value[0].parts!.map((p) => p.text).join('')
      expect(text).toContain('[错误]')
      expect(text).toContain('模型超时')
      expect(sm.sessionStatus.value[activeSessionId.value]).toBe('error')
    })

    it('error part 展示错误并 finalize', async () => {
      const promise = sm.createPendingPromise()

      partUpdated({ id: 'e1', type: 'error', text: 'part 级错误' })

      await expect(promise).resolves.toBeUndefined()
      expect(sm.isStreaming.value).toBe(false)
      const text = messages.value[0].parts!.map((p) => p.text).join('')
      expect(text).toContain('[错误]')
      expect(text).toContain('part 级错误')
    })
  })

  describe('占位符校验顺序 (T-C5)', () => {
    it('未知 part 类型不创建幽灵占位符', () => {
      partUpdated({ id: 'x1', type: 'no_such_type', text: '???' })

      expect(messages.value.length).toBe(0)
      expect(sm.isStreaming.value).toBe(false)
    })

    it('非 text 字段的 delta 不创建幽灵占位符', () => {
      sm.handleSSEEvent({
        type: 'message.part.delta',
        payload: {
          type: 'message.part.delta',
          properties: {
            partID: 'p9',
            field: 'input',
            delta: 'x',
            sessionID: activeSessionId.value,
          } as Record<string, unknown>,
        },
      })

      expect(messages.value.length).toBe(0)
    })
  })

  describe('SSE-DEBUG 调试日志开关 (T-C5)', () => {
    it('默认关闭: 常规事件不产生 [SSE-DEBUG] 日志', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setSSEDebug(false)

      partUpdated({ id: 'p1', type: 'text', text: 'hi' })

      const debugCalls = spy.mock.calls.filter(
        (c) => String(c[0]).includes('SSE-DEBUG') || String(c[0]).includes('SSE-DBG'),
      )
      expect(debugCalls.length).toBe(0)
      spy.mockRestore()
    })
  })

  // ==================== C8: sessionID / session_id 双命名兼容 ====================

  describe('会话 ID 双命名兼容 (C8)', () => {
    it('session.status 使用 session_id 时同样更新状态映射', () => {
      sm.handleSSEEvent({
        type: 'session.status',
        payload: {
          type: 'session.status',
          properties: { session_id: 'ses_snake', status: 'busy' } as Record<string, unknown>,
        },
      })

      expect(sm.sessionStatus.value['ses_snake']).toBe('busy')
    })

    it('session.updated 使用 session_id 时同样更新状态映射', () => {
      sm.handleSSEEvent({
        type: 'session.updated',
        payload: {
          type: 'session.updated',
          properties: { session_id: 'ses_snake2', status: 'idle' } as Record<string, unknown>,
        },
      })

      expect(sm.sessionStatus.value['ses_snake2']).toBe('idle')
    })

    it('part 事件按 session_id 正确过滤非活跃会话', () => {
      sm.handleSSEEvent({
        type: 'message.part.updated',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { id: 'p_other', type: 'text', text: '其他会话内容' },
            session_id: 'ses_other',
          } as Record<string, unknown>,
        },
      })

      expect(messages.value.length).toBe(0)
    })
  })

  // ==================== 消息边界: 用户消息与多步助手消息 ====================

  /** 触发 message.updated 记录消息角色 */
  function messageUpdated(id: string, role: string): void {
    sm.handleSSEEvent({
      type: 'message.updated',
      payload: {
        type: 'message.updated',
        properties: {
          info: { id, role },
          sessionID: activeSessionId.value,
        } as Record<string, unknown>,
      },
    })
  }

  describe('用户消息不渲染为 AI 气泡 (BUG: 用户消息双显)', () => {
    it('已知为用户消息的 part 只填充用户气泡, 不创建 assistant 占位符', () => {
      messageUpdated('msg_u1', 'user')
      partUpdated({ id: 'p_u1', type: 'text', text: '用户说的话' }, { messageID: 'msg_u1' })

      expect(messages.value.length).toBe(1)
      expect(messages.value[0].role).toBe('user')
      expect(messages.value[0].content).toBe('用户说的话')
      expect(messages.value.some((m) => (m.role || m.info?.role) === 'assistant')).toBe(false)
    })

    it('用户 part 先到 (角色未知) 时, message.updated(user) 到达后移除误建占位符并建用户气泡', () => {
      // part 先到: 角色未知, 会先进入 assistant 占位符
      partUpdated({ id: 'p_u1', type: 'text', text: '用户说的话' }, { messageID: 'msg_u1' })
      expect(messages.value.length).toBe(1)
      expect(messages.value[0].role).toBe('assistant')

      // user 的 message.updated 到达 → 移除误建占位符, 建立用户气泡
      messageUpdated('msg_u1', 'user')
      expect(messages.value.length).toBe(1)
      expect(messages.value[0].role).toBe('user')
      expect(messages.value[0].id).toBe('msg_u1')

      // 重复到达的用户 part 填充用户气泡正文
      partUpdated({ id: 'p_u1', type: 'text', text: '用户说的话' }, { messageID: 'msg_u1' })
      expect(messages.value[0].content).toBe('用户说的话')
      expect(messages.value.some((m) => (m.role || m.info?.role) === 'assistant')).toBe(false)
    })

    it('message.updated(user) 给未绑定 id 的乐观用户消息绑定后端 id', () => {
      messages.value.push({ role: 'user', content: '你好', timestamp: new Date().toISOString() })

      messageUpdated('msg_u1', 'user')

      const userMsg = messages.value.find((m) => (m.role || m.info?.role) === 'user')
      expect(userMsg?.id).toBe('msg_u1')
    })

    it('用户消息的 delta 填充用户气泡而非 AI 占位符', () => {
      messageUpdated('msg_u2', 'user')
      sm.handleSSEEvent({
        type: 'message.part.delta',
        payload: {
          type: 'message.part.delta',
          properties: {
            partID: 'p_u2',
            field: 'text',
            delta: '用户',
            messageID: 'msg_u2',
            sessionID: activeSessionId.value,
          } as Record<string, unknown>,
        },
      })

      expect(messages.value.length).toBe(1)
      expect(messages.value[0].role).toBe('user')
      expect(messages.value[0].content).toBe('用户')
      expect(messages.value.some((m) => (m.role || m.info?.role) === 'assistant')).toBe(false)
    })
  })

  describe('多步助手消息按 messageID 独立渲染 (BUG: 步骤被合并)', () => {
    it('不同的 assistant messageID 各自独立成条, 不合并', () => {
      partUpdated({ id: 'p1', type: 'text', text: '第一步' }, { messageID: 'msg_1' })
      partUpdated({ id: 'p2', type: 'text', text: '第二步' }, { messageID: 'msg_2' })

      expect(messages.value.length).toBe(2)
      expect(messages.value[0].parts![0].text).toBe('第一步')
      expect(messages.value[1].parts![0].text).toBe('第二步')
    })

    it('同一 messageID 的后续 part 复用同一条消息', () => {
      partUpdated({ id: 'p1', type: 'text', text: '第一段' }, { messageID: 'msg_1' })
      partUpdated({ id: 'p2', type: 'reasoning', text: '思考' }, { messageID: 'msg_1' })

      expect(messages.value.length).toBe(1)
      expect(messages.value[0].parts!.length).toBe(2)
    })

    it('多步消息 finalize 后各自 isStreaming=false', () => {
      partUpdated({ id: 'p1', type: 'text', text: '步骤1' }, { messageID: 'msg_1' })
      partUpdated({ id: 'p2', type: 'text', text: '步骤2' }, { messageID: 'msg_2' })

      sm.finalizeStreaming()

      expect(messages.value.every((m) => m.isStreaming === false)).toBe(true)
    })
  })
})
