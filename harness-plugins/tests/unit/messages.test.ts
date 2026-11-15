import { describe, expect, it } from 'vitest'
import { projectMessages, lastTurnAt } from '../../packages/kinship-bridge/src/messages.js'
import type { BridgeEvent } from '../../packages/kinship-bridge/src/types.js'

function event(seq: number, type: string, data: unknown): BridgeEvent {
  return { seq, type, time: 1_000 + seq, data }
}

describe('projectMessages against dsh 0.2.2-rc.3 durable shapes', () => {
  it('projects the nested assistant/message and tool/result shapes', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', { id: 'u1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      event(2, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [],
      }),
      event(3, 'tool/result', {
        turn: 1,
        step: 2,
        message: {
          id: 't1',
          role: 'tool',
          content: [{ type: 'text', text: 'ok' }],
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          isError: false,
        },
      }),
    ]

    const page = projectMessages(events, 50)
    expect(page.messages).toMatchObject([
      { id: 'u1', role: 'user', text: 'hi', seq: 1 },
      { id: 'a1', role: 'assistant', text: 'hello', seq: 2 },
      { id: 't1', role: 'tool', text: 'ok', seq: 3, tool_call_id: 'c1', is_error: false },
    ])
    expect(page.messages[1]?.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('keeps the flat shape working for embedded hosts', () => {
    const events = [
      event(0, 'assistant/message', { id: 'a1', content: [{ type: 'text', text: 'flat' }], source: { kind: 'model' } }),
      event(1, 'tool/result', { id: 't1', content: [{ type: 'text', text: 'ok' }], toolCallId: 'c1', isError: true }),
    ]
    expect(projectMessages(events, 50).messages).toMatchObject([
      { id: 'a1', role: 'assistant', text: 'flat' },
      { id: 't1', role: 'tool', text: 'ok', tool_call_id: 'c1', is_error: true },
    ])
  })

  it('falls back to the source callId when the tool message omits toolCallId', () => {
    const events = [
      event(0, 'tool/result', {
        turn: 1,
        step: 1,
        message: { id: 't1', content: [{ type: 'text', text: 'x' }], source: { kind: 'tool', callId: 'c9' } },
      }),
    ]
    expect(projectMessages(events, 50).messages[0]).toMatchObject({ tool_call_id: 'c9' })
  })

  it('ignores non-message events and paginates by seq', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', { id: 'u1', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'user/message', { id: 'u2', content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }),
    ]
    const page = projectMessages(events, 1)
    expect(page.messages).toMatchObject([{ id: 'u2' }])
    expect(page.has_more).toBe(true)
    expect(page.next_before).toBe(3)
    expect(projectMessages(events, 50, 3).messages).toMatchObject([{ id: 'u1' }])
  })

  it('reads the latest turn boundary timestamp', () => {
    expect(lastTurnAt([])).toBeNull()
    expect(
      lastTurnAt([
        event(0, 'turn/start', { turn: 1 }),
        event(5, 'turn/end', { turn: 1, reason: { kind: 'commit' } }),
        event(9, 'turn/start', { turn: 2 }),
      ]),
    ).toBe(1_009)
  })
})
