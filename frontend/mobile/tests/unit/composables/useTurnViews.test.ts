import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { useTurnViews } from '@/composables/useTurnViews'

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: '2026-10-24T10:00:00.000Z' }
}

function assistantMessage(
  id: string,
  parts: ChatMessage['parts'],
  isStreaming = false,
): ChatMessage {
  return {
    id,
    role: 'assistant',
    info: { id, role: 'assistant' },
    parts,
    isStreaming,
    timestamp: '2026-10-24T10:00:01.000Z',
  }
}

describe('useTurnViews', () => {
  it('maps a live ChatMessage[] into user -> process -> reply turns', () => {
    const messages = ref<ChatMessage[]>([
      userMessage('u1', '看看今天的状态'),
      assistantMessage('a1', [
        { type: 'reasoning', text: '先核对数据' },
        {
          type: 'tool',
          callID: 'call-1',
          tool: 'read',
          state: { status: 'completed', input: { filePath: 'health.json' }, output: 'ok' },
        },
        { type: 'text', text: '今天状态不错。' },
      ]),
    ])

    const turns = useTurnViews(messages)

    expect(turns.value).toHaveLength(1)
    expect(turns.value[0]?.id).toBe('u1')
    expect(turns.value[0]?.userText).toBe('看看今天的状态')
    expect(turns.value[0]?.steps.map((step) => step.type)).toEqual(['thinking', 'tool'])
    expect(turns.value[0]?.reply).toBe('今天状态不错。')
    expect(turns.value[0]?.live).toBe(false)
  })

  it('recomputes and marks the live turn when the streaming message changes', () => {
    const messages = ref<ChatMessage[]>([
      userMessage('u1', '你好'),
      assistantMessage('a1', [{ type: 'text', text: '在' }], true),
    ])

    const turns = useTurnViews(messages)
    expect(turns.value[0]?.live).toBe(true)

    messages.value = [
      messages.value[0]!,
      assistantMessage('a1', [{ type: 'text', text: '在的，有什么可以帮你？' }], false),
    ]

    expect(turns.value[0]?.live).toBe(false)
    expect(turns.value[0]?.reply).toBe('在的，有什么可以帮你？')
  })

  it('returns no turns for an empty message list', () => {
    const turns = useTurnViews(ref<ChatMessage[]>([]))
    expect(turns.value).toEqual([])
  })
})
