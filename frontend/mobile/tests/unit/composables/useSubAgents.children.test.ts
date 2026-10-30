/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'

// W49.4: 子智能体列表统一 createdAt 时间倒序（缺时间回退位次, 零回归）
// 复现现场症状: 后端 children 按插入序返回, 前端仅镜像位次时最新一条落在底部
// (如 [22:02, 08:02, 08:19] 渲染成最新在最后)。

// USE_MOCK_DATA 置 false, 走真实 API 流程 (harness 与 useSubAgents.tokens.test.ts 同构)
vi.mock('@/composables/useMockData', () => ({
  USE_MOCK_DATA: false,
}))

// mock apiGet: children 接口返回体逐用例注入
const mockClient = vi.hoisted(() => ({
  apiGet: vi.fn(),
}))
vi.mock('@/api/client', () => mockClient)

// mock useChat / useStreamingMessage 单例, 隔离会话切换副作用
const mockChat = vi.hoisted(() => ({
  currentSessionId: { value: 'parent_ses' },
  currentSessionTitle: { value: '主会话' },
  messages: { value: [] },
  clearMessages: vi.fn(),
  loadChatHistory: vi.fn(),
  switchSession: vi.fn(),
}))
vi.mock('@/composables/useChat', () => ({
  useChatSingleton: () => mockChat,
  getSessionBackend: vi.fn(() => undefined),
  setSessionBackend: vi.fn(),
}))
const streamingMock = vi.hoisted(() => ({
  finalizeStreaming: vi.fn(),
  setActiveSessionId: vi.fn(),
  updateTokens: vi.fn(),
  currentTokens: { value: null },
}))
vi.mock('@/composables/useStreamingMessage', () => ({
  useStreamingMessageSingleton: () => streamingMock,
}))

import { useSubAgents } from '@/composables/useSubAgents'
import type { ChatMessage } from '@/types'

/** 构造 task 工具调用的扫描消息 (消息扫描泳道输入) */
function taskMessage(parts: ChatMessage['parts']): ChatMessage {
  return { id: 'msg_' + Math.random().toString(36).slice(2), parts }
}

/** 构造带 <task_metadata> 输出的 task part (扫描泳道提取 childSessionId 用) */
function taskPart(callID: string, input: Record<string, unknown>, sessionId: string) {
  return {
    type: 'tool' as const,
    tool: 'task',
    callID,
    state: {
      status: 'completed',
      input,
      output: '<task_metadata>\nsession_id: ' + sessionId + '\n</task_metadata>',
    },
  }
}

describe('子智能体 children 列表时间倒序 (W49.4)', () => {
  beforeEach(() => {
    mockClient.apiGet.mockReset()
  })

  it('API children 携带乱序 createdAt 时按时间倒序渲染 (最新在最上)', async () => {
    // 插入序 = 后端建会话序: 旧(1000) -> 新(3000) -> 中(2000)
    mockClient.apiGet.mockResolvedValue({
      children: [
        { id: 'ses_old', title: '旧任务', createdAt: 1000 },
        { id: 'ses_new', title: '新任务', createdAt: 3000 },
        { id: 'ses_mid', title: '中任务', createdAt: 2000 },
      ],
    })
    const sa = useSubAgents()
    await sa.loadSubAgents('parent_ses', [])
    expect(sa.subAgents.value.map((a) => a.name)).toEqual(['新任务', '中任务', '旧任务'])
    // createdAt 透出到列表条目, 供后续展示/调试
    expect(sa.subAgents.value.map((a) => a.createdAt)).toEqual([3000, 2000, 1000])
  })

  it('createdAt 缺失/0/null 的条目不产生时间, 保持位次倒序回退', async () => {
    // W = 无字段, X = createdAt:0, Y = createdAt:null (W49.3 并行改动期的防御面)
    mockClient.apiGet.mockResolvedValue({
      children: [
        { id: 'ses_w', title: 'W' },
        { id: 'ses_x', title: 'X', createdAt: 0 },
        { id: 'ses_y', title: 'Y', createdAt: null },
      ],
    })
    const sa = useSubAgents()
    await sa.loadSubAgents('parent_ses', [])
    // 无有效时间 -> 回退 messageIndex 倒序 = 现行为 (插入序镜像)
    expect(sa.subAgents.value.map((a) => a.name)).toEqual(['Y', 'X', 'W'])
    expect(sa.subAgents.value.every((a) => a.createdAt === undefined)).toBe(true)
  })

  it('opencode 形态时间位于 time.created 时同样按时间倒序 (次级取源)', async () => {
    mockClient.apiGet.mockResolvedValue({
      children: [
        { id: 'ses_p', title: 'P', createdAt: 3000 },
        { id: 'ses_q', title: 'Q', time: { created: 2500 } },
        { id: 'ses_r', title: 'R' }, // 完全无时间
      ],
    })
    const sa = useSubAgents()
    await sa.loadSubAgents('parent_ses', [])
    // 有时间组倒序在前, 无时间组垫底
    expect(sa.subAgents.value.map((a) => a.name)).toEqual(['P', 'Q', 'R'])
  })

  it('API+扫描双泳道合并: 同 child 去重 API 胜出且跨泳道按时间排列', async () => {
    mockClient.apiGet.mockResolvedValue({
      children: [
        { id: 'ses_a', title: 'API标题A', createdAt: 5000 },
        { id: 'ses_b', title: 'API标题B', createdAt: 1000 },
      ],
    })
    const messages: ChatMessage[] = [
      taskMessage([
        // 与 API ses_a 同子会话: 去重后必须保留 API 条目 (标题为 API 侧)
        taskPart('call_a', { description: '扫描标题A', subagent_type: 'explore' }, 'ses_a'),
        // 仅扫描泳道可见的子会话: 无 createdAt, 垫底
        taskPart('call_c', { description: '扫描标题C', subagent_type: 'build' }, 'ses_c'),
      ]),
    ]
    const sa = useSubAgents()
    await sa.loadSubAgents('parent_ses', messages)
    const list = sa.subAgents.value
    expect(list.map((a) => a.childSessionId)).toEqual(['ses_a', 'ses_b', 'ses_c'])
    expect(list[0].name).toBe('API标题A') // API 泳道去重胜出
  })

  it('全部无 createdAt 时输出与旧行为逐字段一致 (opencode 时代零回归钉)', async () => {
    const children = [
      { id: 'ses_1', title: 'T1', type: 'explore', status: 'completed' },
      { id: 'ses_2', title: 'T2', type: 'build', status: 'completed' },
      { id: 'ses_3', title: 'T3', type: 'oracle', status: 'running' },
    ]
    mockClient.apiGet.mockResolvedValue({ children })
    const sa = useSubAgents()
    await sa.loadSubAgents('parent_ses', [])
    // 旧行为: messageIndex = 1000+idx 倒序 => 插入序镜像, 逐字段等值
    expect(sa.subAgents.value).toEqual([
      { id: 'ses_3', name: 'T3', type: 'oracle', childSessionId: 'ses_3', status: 'running', messageIndex: 1002 },
      { id: 'ses_2', name: 'T2', type: 'build', childSessionId: 'ses_2', status: 'completed', messageIndex: 1001 },
      { id: 'ses_1', name: 'T1', type: 'explore', childSessionId: 'ses_1', status: 'completed', messageIndex: 1000 },
    ])
  })

  it('扫描泳道 name 优先 input.title, 无 title 回退 description/agent (现状不变)', () => {
    const sa = useSubAgents()
    const messages: ChatMessage[] = [
      taskMessage([
        taskPart('call_t', { title: '精确标题', description: '旧描述', subagent_type: 'explore' }, 'ses_t'),
        taskPart('call_d', { description: '仅描述', subagent_type: 'build' }, 'ses_d'),
      ]),
    ]
    const scanned = sa.scanFromMessages(messages)
    expect(scanned.map((a) => a.name)).toEqual(['精确标题', '仅描述'])
  })
})
