/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'

// 隔离 API 客户端: 只关心 session.ts 的归一化逻辑
const mockClient = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

vi.mock('@/api/client', () => mockClient)

import {
  listSessions,
  getSessionMessages,
  sendMessage,
  createSession,
  switchSession,
  renameSession,
  normalizeSession,
} from '@/api/session'

describe('api/session 容错 (FE-M9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listSessions 支持裸数组响应', async () => {
    mockClient.apiGet.mockResolvedValue([{ session_id: 's1', name: '会话1' }])

    const sessions = await listSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions![0].id).toBe('s1')
    expect(sessions![0].title).toBe('会话1')
  })

  it('listSessions 支持 local_sessions 包装响应', async () => {
    mockClient.apiGet.mockResolvedValue({ local_sessions: [{ id: 's2', title: 'T' }] })

    const sessions = await listSessions()

    expect(sessions![0].id).toBe('s2')
    expect(sessions![0].title).toBe('T')
  })

  it('listSessions 支持 sessions 包装响应', async () => {
    mockClient.apiGet.mockResolvedValue({ sessions: [{ session_id: 's3' }] })

    const sessions = await listSessions()

    expect(sessions![0].id).toBe('s3')
  })

  it('listSessions 对请求失败返回 null', async () => {
    mockClient.apiGet.mockResolvedValue(null)
    expect(await listSessions()).toBeNull()
  })

  it('getSessionMessages 支持裸数组响应', async () => {
    mockClient.apiGet.mockResolvedValue([{ role: 'user', content: 'hi' }])

    const msgs = await getSessionMessages('s1')

    expect(msgs).toHaveLength(1)
    expect(msgs![0].content).toBe('hi')
  })

  it('getSessionMessages 支持 {data} 包装响应', async () => {
    mockClient.apiGet.mockResolvedValue({ data: [{ role: 'assistant' }] })

    const msgs = await getSessionMessages('s1')

    expect(msgs).toHaveLength(1)
  })

  it('getSessionMessages 结构异常返回 null', async () => {
    mockClient.apiGet.mockResolvedValue({ foo: 'bar' })
    expect(await getSessionMessages('s1')).toBeNull()
  })

  it('createSession 容忍 id 字段', async () => {
    mockClient.apiPost.mockResolvedValue({ id: 'new-id' })
    expect(await createSession('t')).toBe('new-id')
  })

  it('createSession 容忍 sessionId 字段', async () => {
    mockClient.apiPost.mockResolvedValue({ sessionId: 'camel-id' })
    expect(await createSession('t')).toBe('camel-id')
  })

  it('switchSession 容忍 status=ok', async () => {
    mockClient.apiPost.mockResolvedValue({ status: 'ok' })
    expect(await switchSession('s1')).toBe(true)
  })

  it('switchSession 容忍 success=true', async () => {
    mockClient.apiPost.mockResolvedValue({ success: true })
    expect(await switchSession('s1')).toBe(true)
  })

  it('renameSession 容忍 status=updated', async () => {
    mockClient.apiPost.mockResolvedValue({ status: 'updated' })
    expect(await renameSession('s1', 't')).toBe(true)
  })
})

// ==================== W45: 双通道 backend 标签与会话级路由 ====================

describe('api/session 双通道分账 (W45)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('normalizeSession backend 透传', () => {
    it("backend='loom' 原样透传", () => {
      expect(normalizeSession({ id: 's1', backend: 'loom' }).backend).toBe('loom')
    })

    it("backend='opencode' 原样透传", () => {
      expect(normalizeSession({ id: 's1', backend: 'opencode' }).backend).toBe('opencode')
    })

    it('缺失 backend 时为 undefined (老后端条目不标注)', () => {
      expect(normalizeSession({ id: 's1' }).backend).toBeUndefined()
    })

    it('未知/非法取值归一化为 undefined (精确匹配协议冻结取值)', () => {
      expect(normalizeSession({ id: 's1', backend: 'Loom' }).backend).toBeUndefined()
      expect(normalizeSession({ id: 's1', backend: 'weird' }).backend).toBeUndefined()
      expect(normalizeSession({ id: 's1', backend: 1 }).backend).toBeUndefined()
    })
  })

  describe('listSessions 键优先级', () => {
    it('优先 sessions 键 (新契约合并列表, 每条自带 backend)', async () => {
      mockClient.apiGet.mockResolvedValue({
        sessions: [
          { id: 'a', backend: 'loom' },
          { id: 'b', backend: 'opencode' },
        ],
        local_sessions: [{ id: 'stale' }],
      })

      const sessions = await listSessions()

      expect(sessions!.map((s) => s.id)).toEqual(['a', 'b'])
      expect(sessions![0].backend).toBe('loom')
    })

    it('无 sessions 键时回退 local_sessions (老后端兼容)', async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [{ id: 'old', backend: 'loom' }],
      })

      const sessions = await listSessions()

      expect(sessions!.map((s) => s.id)).toEqual(['old'])
    })
  })

  describe('getSessionMessages 可选 backend', () => {
    it('有 backend 时拼 ?backend=', async () => {
      mockClient.apiGet.mockResolvedValue([])

      await getSessionMessages('s1', 'loom')

      expect(mockClient.apiGet).toHaveBeenCalledWith('/api/screen/session/s1/messages?backend=loom')
    })

    it('无 backend 时路径不带查询串 (老行为不变)', async () => {
      mockClient.apiGet.mockResolvedValue([])

      await getSessionMessages('s1')

      expect(mockClient.apiGet).toHaveBeenCalledWith('/api/screen/session/s1/messages')
    })
  })

  describe('sendMessage 可选 backend', () => {
    it('有 backend 时 body 携带 backend 字段', async () => {
      mockClient.apiPost.mockResolvedValue({ status: 'ok' })

      await sendMessage({ session_id: 's1', content: 'hi', backend: 'opencode' })

      expect(mockClient.apiPost).toHaveBeenCalledWith('/api/screen/session/message', {
        message: 'hi',
        session_id: 's1',
        backend: 'opencode',
      })
    })

    it('无 backend 时 body 完全不出现 backend 键', async () => {
      mockClient.apiPost.mockResolvedValue({ status: 'ok' })

      await sendMessage({ session_id: 's1', content: 'hi' })

      const body = mockClient.apiPost.mock.calls[0][1] as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'backend')).toBe(false)
    })
  })

  // ==================== W46: switch 可选 backend (S3 盲区修补) ====================

  describe('switchSession 可选 backend (W46)', () => {
    it('有 backend 时 body 携带 backend 字段', async () => {
      mockClient.apiPost.mockResolvedValue({ status: 'ok' })

      expect(await switchSession('s1', 'loom')).toBe(true)

      expect(mockClient.apiPost).toHaveBeenCalledWith('/api/screen/session/switch', {
        session_id: 's1',
        backend: 'loom',
      })
    })

    it('无 backend 时 body 完全不出现 backend 键 (防 undefined 序列化, 照 sendMessage 惯例)', async () => {
      mockClient.apiPost.mockResolvedValue({ status: 'ok' })

      expect(await switchSession('s1')).toBe(true)

      const body = mockClient.apiPost.mock.calls[0][1] as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'backend')).toBe(false)
      expect(body).toEqual({ session_id: 's1' })
    })
  })
})
