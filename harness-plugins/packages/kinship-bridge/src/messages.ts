/**
 * Best-effort projection of dsh Session events into a Loom/opencode-shaped
 * message list. The durable event log remains the source of truth; this
 * module never mutates it.
 *
 * Shape (documented in the package README):
 * `{ id, role, content, text, created_at, seq, source?, tool_call_id?, is_error? }`
 *
 * @module kinship-bridge/messages
 */

import type { BridgeEvent } from './types.js'

export interface ProjectedMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly content: readonly unknown[]
  readonly text: string
  readonly created_at: number
  readonly seq: number
  readonly source?: unknown
  readonly tool_call_id?: string
  readonly is_error?: boolean
}

export interface MessagePage {
  readonly messages: readonly ProjectedMessage[]
  readonly has_more: boolean
  readonly next_before: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function contentOf(record: Record<string, unknown>): readonly unknown[] {
  const content = record['content']
  return Array.isArray(content) ? content : []
}

function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const text = block['text']
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Resolve the message payload of one surface event.
 *
 * dsh 0.2.2-rc.3 uses two shapes: `user/message` carries the `UserMessage`
 * flat, while `assistant/message`, `tool/result`, `developer/message`, and
 * `system/message` wrap it under `data.message` together with turn/step
 * metadata. Older/embedded hosts may deliver the flat shape for every type, so
 * the nested field wins only when it is a real object.
 */
function messageOf(event: BridgeEvent): Record<string, unknown> | undefined {
  if (!isRecord(event.data)) return undefined
  const nested = event.data['message']
  if (event.type !== 'user/message' && isRecord(nested)) return nested
  return event.data
}

function projectMessage(event: BridgeEvent): ProjectedMessage | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') {
    return undefined
  }
  const data = messageOf(event)
  if (data === undefined) return undefined
  const content = contentOf(data)
  const id = stringField(data, 'id') ?? `${event.type}-${String(event.seq)}`
  const created = event.time
  const source = data['source']

  if (event.type === 'tool/result') {
    const toolCallId =
      stringField(data, 'toolCallId') ??
      (isRecord(data['source']) ? stringField(data['source'], 'callId') : undefined)
    const isError = data['isError']
    return {
      id,
      role: 'tool',
      content,
      text: textOf(content),
      created_at: created,
      seq: event.seq,
      ...(source === undefined ? {} : { source }),
      ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
      ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
    }
  }

  return {
    id,
    role: event.type === 'user/message' ? 'user' : 'assistant',
    content,
    text: textOf(content),
    created_at: created,
    seq: event.seq,
    ...(source === undefined ? {} : { source }),
  }
}

/**
 * Project the durable log into one bounded page.
 *
 * @param events - committed events, oldest first.
 * @param limit - maximum messages to return; caller validates the range.
 * @param before - exclusive upper sequence bound; omitted means the current end.
 */
export function projectMessages(
  events: readonly BridgeEvent[],
  limit: number,
  before?: number,
): MessagePage {
  const all: ProjectedMessage[] = []
  for (const event of events) {
    if (before !== undefined && event.seq >= before) continue
    const project = projectMessage(event)
    if (project !== undefined) all.push(project)
  }
  const hasMore = all.length > limit
  const messages = hasMore ? all.slice(all.length - limit) : all
  const first = messages[0]
  return {
    messages,
    has_more: hasMore,
    next_before: hasMore && first !== undefined ? first.seq : null,
  }
}

/** Timestamp of the latest `turn/start` or `turn/end`, or null. */
export function lastTurnAt(events: readonly BridgeEvent[]): number | null {
  let latest: number | null = null
  for (const event of events) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    if (latest === null || event.time > latest) latest = event.time
  }
  return latest
}
