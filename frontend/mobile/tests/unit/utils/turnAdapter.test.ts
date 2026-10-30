/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types'
import type { ToolStep } from '@/types/turn'
import { toTurnViews } from '@/utils/turnAdapter'

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): ChatMessage {
  return { id, info: { role }, parts: [{ type: 'text', text }] }
}

/** 构造运行时才存在的 role (如 toolResult) 或额外字段形状 */
function shell(partial: Record<string, unknown>): ChatMessage {
  return partial as unknown as ChatMessage
}

function toolStepOf(
  turns: ReturnType<typeof toTurnViews>,
  turnIndex: number,
  stepIndex: number,
): ToolStep {
  const step = turns[turnIndex]?.steps[stepIndex]
  if (step === undefined || step.type !== 'tool') {
    throw new Error(`expected tool step at turn ${turnIndex} step ${stepIndex}`)
  }
  return step
}

describe('turnAdapter', () => {
  it('多轮: 每条 user 消息开启一轮, 后续回复归入该轮', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '第一问'),
      textMessage('a1', 'assistant', '第一答'),
      textMessage('u2', 'user', '第二问'),
      textMessage('a2', 'assistant', '第二答'),
    ])

    expect(turns).toHaveLength(2)
    expect(
      turns.map((turn) => ({ id: turn.id, userText: turn.userText, reply: turn.reply })),
    ).toEqual([
      { id: 'u1', userText: '第一问', reply: '第一答' },
      { id: 'u2', userText: '第二问', reply: '第二答' },
    ])
    for (const turn of turns) {
      expect(turn.attachments).toEqual([])
      expect(turn.live).toBe(false)
    }
  })

  it('text + reasoning + tool: 过程步骤保序, 文本进入 reply', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '读一下'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: '开头' },
          { type: 'reasoning', text: '先想想' },
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'completed', input: { path: '/x' }, output: '文件内容' },
            time: { start: 1000, end: 1250 },
          },
          { type: 'text', text: '读完了' },
        ],
      },
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.reply).toBe('开头\n\n读完了')
    expect(turns[0]?.steps).toHaveLength(2)
    expect(turns[0]?.steps[0]).toMatchObject({ type: 'thinking', text: '先想想' })
    expect(toolStepOf(turns, 0, 1)).toMatchObject({
      id: 'call_1',
      name: 'read',
      status: 'completed',
      arguments: { path: '/x' },
      result: { text: '文件内容', isError: false, totalChars: 4 },
      durationMs: 250,
    })
  })

  it('工具 part 的 state.input 为 null 时仍建立 ToolStep', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '读文件'),
      shell({
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: null, output: '' },
          },
        ],
      }),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.steps).toHaveLength(1)
    const step = toolStepOf(turns, 0, 0)
    expect(step).toMatchObject({ id: 'call_1', name: 'read', status: 'running' })
    expect(step.arguments).toBeUndefined()
  })

  it('重复工具 part 的 state.input 为 null 时不抛错且保留原参数', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '读文件'),
      shell({
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: { path: '/x' }, output: '' },
          },
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: null, output: '' },
          },
        ],
      }),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.steps).toHaveLength(1)
    expect(toolStepOf(turns, 0, 0).arguments).toEqual({ path: '/x' })
  })

  it('toolResult 壳 part 无 tool 时回退到 message.toolName', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '问'),
      shell({
        id: 'tr1',
        info: { role: 'toolResult' },
        toolName: 'read',
        parts: [
          {
            type: 'tool',
            id: 'p-tr1',
            callID: 'call_orphan',
            state: { status: 'completed', input: null, output: '结果' },
          },
        ],
      }),
    ])

    expect(toolStepOf(turns, 0, 0).name).toBe('read')
  })

  it('工具结果无 callID 时按位置配对到最近未完成的调用', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '读文件'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: { path: '/x' }, output: '' },
          },
        ],
      },
      {
        id: 'a2',
        info: { role: 'assistant' },
        parts: [{ type: 'tool_result', text: '结果正文' }],
      },
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.steps).toHaveLength(1)
    const step = toolStepOf(turns, 0, 0)
    expect(step.status).toBe('completed')
    expect(step.result).toMatchObject({ text: '结果正文', isError: false })
  })

  it('工具结果按 callID 配对且不重复已并入工具 part 的结果', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '读文件'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'completed', input: {}, output: '已有结果' },
          },
          { type: 'tool_result', callID: 'call_1', text: '重复结果' },
        ],
      },
    ])

    expect(turns[0]?.steps).toHaveLength(1)
    expect(toolStepOf(turns, 0, 0).result?.text).toBe('已有结果')
  })

  it('callID 命中的结果并入原调用, 不新成孤儿轮', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '问'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: {}, output: '' },
          },
        ],
      },
      textMessage('a2', 'assistant', '中间回复'),
      {
        id: 'a3',
        info: { role: 'assistant' },
        parts: [{ type: 'tool_result', callID: 'call_1', text: '结果' }],
      },
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.steps).toHaveLength(1)
    expect(toolStepOf(turns, 0, 0).result?.text).toBe('结果')
    expect(turns[0]?.reply).toBe('中间回复')
  })

  it('toolResult 壳的 content 形态也能按 toolCallId 配对', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '问'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: {}, output: '' },
          },
        ],
      },
      shell({
        id: 'tr1',
        info: { role: 'toolResult' },
        toolCallId: 'call_1',
        toolName: 'read',
        content: '结果',
      }),
    ])

    expect(turns).toHaveLength(1)
    expect(toolStepOf(turns, 0, 0).result?.text).toBe('结果')
    expect(toolStepOf(turns, 0, 0).orphan).toBeUndefined()
  })

  it('孤儿 toolResult 壳在原相对位置成轮, 不并入上一条回复', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '第一问'),
      textMessage('a1', 'assistant', '第一答'),
      shell({
        id: 'tr1',
        info: { role: 'toolResult' },
        parts: [
          {
            type: 'tool',
            id: 'p-tr1',
            callID: 'call_orphan',
            tool: 'read',
            state: { status: 'completed', input: {}, output: '迟到的结果' },
          },
        ],
      }),
      textMessage('a2', 'assistant', '后续文字'),
    ])

    expect(turns).toHaveLength(3)
    expect(turns[0]?.reply).toBe('第一答')
    expect(turns[1]).toMatchObject({ id: 'tr1', userText: '', reply: '' })
    expect(turns[1]?.steps).toHaveLength(1)
    expect(toolStepOf(turns, 1, 0)).toMatchObject({
      id: 'call_orphan',
      name: 'read',
      orphan: true,
      result: { text: '迟到的结果' },
    })
    expect(turns[2]?.userText).toBe('')
    expect(turns[2]?.reply).toBe('后续文字')
  })

  it('孤儿 tool_result part 在回复后原位成轮', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '问'),
      textMessage('a1', 'assistant', '答'),
      {
        id: 'a2',
        info: { role: 'assistant' },
        parts: [{ type: 'tool_result', text: '孤立结果' }],
      },
    ])

    expect(turns).toHaveLength(2)
    expect(turns[1]).toMatchObject({ id: 'a2', userText: '', reply: '' })
    expect(toolStepOf(turns, 1, 0)).toMatchObject({
      orphan: true,
      result: { text: '孤立结果' },
    })
  })

  it('连续多个无 callID 的孤儿结果各自成步', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '问'),
      textMessage('a1', 'assistant', '答'),
      {
        id: 'a2',
        info: { role: 'assistant' },
        parts: [
          { type: 'tool_result', text: '结果一' },
          { type: 'tool_result', text: '结果二' },
        ],
      },
    ])

    expect(turns).toHaveLength(2)
    expect(turns[1]?.steps).toHaveLength(2)
    expect(toolStepOf(turns, 1, 0).result?.text).toBe('结果一')
    expect(toolStepOf(turns, 1, 1).result?.text).toBe('结果二')
  })

  it('压缩摘要与压缩分隔线成为 CompactionStep, 不作为 user 气泡或 reply', () => {
    const turns = toTurnViews([
      shell({
        id: 'c1',
        info: { role: 'user', summary: true, mode: 'compaction' },
        parts: [{ type: 'text', text: '历史摘要正文' }],
      }),
      textMessage('u1', 'user', '摘要后的问题'),
      textMessage('a1', 'assistant', '回答'),
      {
        id: 'c2',
        info: { role: 'assistant' },
        parts: [{ type: 'compaction', text: '上下文已压缩', summaryText: '第二段摘要' }],
      },
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ userText: '', reply: '' })
    expect(turns[0]?.steps).toEqual([{ type: 'compaction', text: '历史摘要正文' }])
    expect(turns[1]).toMatchObject({ userText: '摘要后的问题', reply: '回答' })
    expect(turns[1]?.steps).toEqual([{ type: 'compaction', text: '第二段摘要' }])
  })

  it('streaming: isStreaming 与 streamingId 都能标记 live', () => {
    const byFlag = toTurnViews([
      textMessage('u1', 'user', '问题'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: '生成中' }],
        isStreaming: true,
      },
    ])
    expect(byFlag[0]?.live).toBe(true)

    const byId = toTurnViews(
      [
        textMessage('u1', 'user', '问题'),
        {
          id: 'a1',
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: '生成中' }],
        },
      ],
      { streamingId: 'a1' },
    )
    expect(byId[0]?.live).toBe(true)
  })

  it('streaming 占位符无文本时也标记 live 且 reply 为空', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '问题'),
      { id: 'a1', info: { role: 'assistant' }, parts: [], isStreaming: true },
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.live).toBe(true)
    expect(turns[0]?.reply).toBe('')
  })

  it('tool-only 轮 reply 为空, 空白 text part 不进入 reply', () => {
    const turns = toTurnViews([
      textMessage('u1', 'user', '跑一下'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          { type: 'text', text: '   ' },
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: '' },
          },
        ],
      },
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.reply).toBe('')
    expect(turns[0]?.steps).toHaveLength(1)
    expect(toolStepOf(turns, 0, 0).status).toBe('completed')
  })

  it('id 全部由消息/part id 派生, 多次调用结果一致', () => {
    const build = (): ChatMessage[] => [
      textMessage('u1', 'user', '问题'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          { type: 'thought', text: '想' },
          {
            type: 'tool',
            id: 'part_1',
            tool: 'glob',
            state: { status: 'running', input: { pattern: '*' } },
          },
          { type: 'text', text: '答' },
        ],
      },
    ]

    const first = toTurnViews(build())
    const second = toTurnViews(build())

    expect(second).toEqual(first)
    expect(first[0]?.id).toBe('u1')
    expect(toolStepOf(first, 0, 1).id).toBe('part_1')
  })

  it('无消息 id 时退化为确定性索引 id', () => {
    const turns = toTurnViews([
      { info: { role: 'user' }, content: '无 id' },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: '答' }] },
    ])

    expect(turns[0]?.id).toBe('turn:0')
    expect(turns[0]?.reply).toBe('答')
  })

  it('不修改输入消息', () => {
    const messages: ChatMessage[] = [
      textMessage('u1', 'user', '问题'),
      {
        id: 'a1',
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'running', input: { path: '/x' }, output: '' },
          },
          { type: 'tool_result', text: '结果' },
          { type: 'text', text: '答' },
        ],
      },
    ]

    const before = JSON.stringify(messages)
    const first = toTurnViews(messages)
    const second = toTurnViews(messages)

    expect(JSON.stringify(messages)).toBe(before)
    expect(second).toEqual(first)
  })
})
