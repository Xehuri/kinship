/**
 * ChatMessage[] -> TurnView[] 纯适配器
 *
 * 把生产消息 (OpenCode / Loom) 映射为"用户 -> 过程 -> 回复"轮次模型:
 *   - 一条 user 消息开启一轮, 后续 assistant / tool 消息挂到该轮;
 *   - 无 user 消息时创建 synthetic 轮 (userText 为空);
 *   - assistant 非空 text part 按序收集为 reply (\n\n 连接);
 *   - reasoning / thought -> ThinkingStep, tool / tool_call -> ToolStep;
 *   - compaction part / info.summary / info.mode='compaction' -> CompactionStep;
 *   - 工具调用与结果按 callID 配对, 未命中的结果在原相对位置成为 orphan 步骤。
 *
 * 纯函数: 不修改入参, 不产生随机 id, 相同输入必得相同输出。
 */

import type { ChatMessage, MessagePart } from '@/types'
import type {
  CompactionStep,
  ThinkingStep,
  ToolResultView,
  ToolStatus,
  ToolStep,
  TurnStep,
  TurnView,
} from '@/types/turn'

export interface TurnAdapterOptions {
  /** 流式消息 id (与 ChatMessage.id / info.id 比对) */
  streamingId?: string
  /** 预留: 会话 id, 供调用方标注来源与后续扩展 */
  sessionId?: string
}

interface DraftTurn {
  id: string
  synthetic: boolean
  orphanOnly: boolean
  userText: string
  steps: TurnStep[]
  replyParts: string[]
  live: boolean
  processOpen: boolean
  startedAt?: number
}

interface OwnedTool {
  step: ToolStep
  turn: DraftTurn
}

const TOOL_STATUS_MAP: Record<string, ToolStatus> = {
  pending: 'pending',
  running: 'running',
  working: 'running',
  streaming: 'running',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  success: 'completed',
  error: 'error',
  failed: 'error',
  failure: 'error',
  abandoned: 'abandoned',
  aborted: 'abandoned',
  cancelled: 'abandoned',
  canceled: 'abandoned',
}

function stableMessageId(message: ChatMessage): string {
  if (typeof message.id === 'string' && message.id) return message.id
  const infoId = message.info?.id
  return typeof infoId === 'string' && infoId ? infoId : ''
}

function messageKey(message: ChatMessage, index: number): string {
  return stableMessageId(message) || `#${index}`
}

function messageRole(message: ChatMessage): string {
  const infoRole: string | undefined = message.info?.role
  const topRole: string | undefined = message.role
  return infoRole ?? topRole ?? ''
}

function messageTimeMs(message: ChatMessage): number | undefined {
  const created = message.info?.time?.created
  if (typeof created === 'number' && Number.isFinite(created)) return created
  for (const raw of [message.timestamp, message.created_at]) {
    if (typeof raw === 'string' && raw) {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return undefined
}

function isLiveMessage(message: ChatMessage, streamingId: string | undefined): boolean {
  if (message.isStreaming === true) return true
  if (streamingId === undefined || streamingId === '') return false
  return stableMessageId(message) === streamingId
}

function isCompactionMessage(message: ChatMessage): boolean {
  if (message.info?.summary === true || message.info?.mode === 'compaction') return true
  return (message.parts ?? []).some((part) => part.type === 'compaction')
}

function textOf(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function textPartsText(parts: readonly MessagePart[]): string {
  const texts: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') continue
    const text = textOf(part.text)
    if (text) texts.push(text)
  }
  return texts.join('\n\n')
}

function userTextOf(message: ChatMessage): string {
  return textPartsText(message.parts ?? []) || textOf(message.content) || textOf(message.text)
}

function compactionTextOf(message: ChatMessage): string {
  const parts = message.parts ?? []
  for (const part of parts) {
    if (part.type !== 'compaction') continue
    const summary = textOf(part.summaryText)
    if (summary) return summary
    const label = textOf(part.text)
    if (label) return label
  }
  return textPartsText(parts) || textOf(message.content) || textOf(message.text)
}

function partDuration(part: MessagePart): number | undefined {
  const start = part.time?.start
  const end = part.time?.end
  if (typeof start !== 'number' || typeof end !== 'number') return undefined
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

function toolNameOf(part: MessagePart): string {
  return typeof part.tool === 'string' ? part.tool.trim() : ''
}

function outputText(part: MessagePart): string {
  const output = part.state?.output
  if (typeof output === 'string' && output.length > 0) return output
  return typeof part.text === 'string' ? part.text : ''
}

function hasInputKeys(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.keys(value).length > 0
}

function normalizeToolStatus(raw: string | undefined, hasResult: boolean): ToolStatus {
  return TOOL_STATUS_MAP[(raw ?? '').toLowerCase()] ?? (hasResult ? 'completed' : 'running')
}

function mergeToolStatus(current: ToolStatus, incoming: ToolStatus): ToolStatus {
  if (current === 'error' || current === 'abandoned') return current
  if (incoming === 'error') return 'error'
  if (current === 'completed' || incoming === 'completed') return 'completed'
  if (current === 'running' || incoming === 'running') return 'running'
  return incoming
}

function makeResult(text: string, isError: boolean): ToolResultView {
  return { text, isError, totalChars: text.length }
}

function shellCallId(message: ChatMessage): string | undefined {
  if (!('toolCallId' in message)) return undefined
  return typeof message.toolCallId === 'string' && message.toolCallId
    ? message.toolCallId
    : undefined
}

function shellName(message: ChatMessage): string | undefined {
  if (!('toolName' in message)) return undefined
  return typeof message.toolName === 'string' && message.toolName ? message.toolName : undefined
}

function shellIsError(message: ChatMessage): boolean {
  return 'isError' in message && message.isError === true
}

function findFirstUnresultedTool(turn: DraftTurn): ToolStep | undefined {
  for (const step of turn.steps) {
    if (step.type === 'tool' && step.result === undefined && step.orphan !== true) {
      return step
    }
  }
  return undefined
}

function hasResolvedToolCall(turn: DraftTurn): boolean {
  return turn.steps.some((step) => step.type === 'tool' && step.orphan !== true)
}

/**
 * 把 ChatMessage 列表转换为 TurnView 列表。
 *
 * @param messages 当前会话消息 (已按时间升序)
 * @param opts.streamingId 正在流式的消息 id
 * @param opts.sessionId 预留会话 id
 */
export function toTurnViews(
  messages: ChatMessage[],
  opts: TurnAdapterOptions = {},
): TurnView[] {
  const streamingId = opts.streamingId
  const drafts: DraftTurn[] = []
  const toolIndex = new Map<string, OwnedTool>()
  const usedTurnIds = new Set<string>()
  let open: DraftTurn | null = null

  function uniqueTurnId(base: string): string {
    let id = base
    let suffix = 2
    while (usedTurnIds.has(id)) {
      id = `${base}:${suffix}`
      suffix += 1
    }
    usedTurnIds.add(id)
    return id
  }

  function makeTurn(
    message: ChatMessage,
    index: number,
    synthetic: boolean,
    orphanOnly: boolean,
  ): DraftTurn {
    const base = stableMessageId(message) || `turn:${index}`
    const turn: DraftTurn = {
      id: uniqueTurnId(base),
      synthetic,
      orphanOnly,
      userText: '',
      steps: [],
      replyParts: [],
      live: false,
      processOpen: false,
    }
    const startedAt = messageTimeMs(message)
    if (startedAt !== undefined) turn.startedAt = startedAt
    drafts.push(turn)
    return turn
  }

  function applyMessageMeta(turn: DraftTurn, message: ChatMessage): void {
    if (turn.startedAt === undefined) {
      const at = messageTimeMs(message)
      if (at !== undefined) turn.startedAt = at
    }
    if (isLiveMessage(message, streamingId)) turn.live = true
  }

  function startUserTurn(message: ChatMessage, index: number): void {
    open = null
    const turn = makeTurn(message, index, false, false)
    turn.userText = userTextOf(message)
    open = turn
    applyMessageMeta(turn, message)
  }

  function ensureContentTurn(message: ChatMessage, index: number): DraftTurn {
    if (open !== null && !open.orphanOnly) {
      applyMessageMeta(open, message)
      return open
    }
    open = null
    const turn = makeTurn(message, index, true, false)
    open = turn
    applyMessageMeta(turn, message)
    return turn
  }

  function ensureDividerTurn(message: ChatMessage, index: number): DraftTurn {
    if (open !== null) {
      applyMessageMeta(open, message)
      return open
    }
    const turn = makeTurn(message, index, true, false)
    open = turn
    applyMessageMeta(turn, message)
    return turn
  }

  function ensureOrphanTurn(message: ChatMessage, index: number): DraftTurn {
    if (open !== null) {
      const replyClosed = open.replyParts.length > 0 && !open.processOpen
      if (!replyClosed) {
        if (open.synthetic && open.steps.length === 0 && open.replyParts.length === 0) {
          open.orphanOnly = true
        }
        applyMessageMeta(open, message)
        return open
      }
    }
    const turn = makeTurn(message, index, true, true)
    open = turn
    applyMessageMeta(turn, message)
    return turn
  }

  function appendReply(turn: DraftTurn, text: string): void {
    turn.replyParts.push(text)
    turn.processOpen = false
  }

  function addThinkingStep(
    part: MessagePart,
    message: ChatMessage,
    index: number,
  ): void {
    const text = textOf(part.text)
    if (!text) return
    const turn = ensureContentTurn(message, index)
    const step: ThinkingStep = { type: 'thinking', text }
    const duration = partDuration(part)
    if (duration !== undefined) step.durationMs = duration
    if (isLiveMessage(message, streamingId)) step.live = true
    turn.steps.push(step)
    turn.processOpen = true
  }

  function registerTool(step: ToolStep, turn: DraftTurn, part?: MessagePart): void {
    const owned: OwnedTool = { step, turn }
    if (part?.callID) toolIndex.set(part.callID, owned)
    if (part?.id) toolIndex.set(part.id, owned)
    if (step.id) toolIndex.set(step.id, owned)
  }

  function addToolCall(
    part: MessagePart,
    message: ChatMessage,
    index: number,
    partIndex: number,
  ): void {
    const key = part.callID || part.id || ''
    const existing = key ? toolIndex.get(key) : undefined
    const output = outputText(part)
    const status = normalizeToolStatus(part.state?.status, output.length > 0)

    if (existing !== undefined) {
      const step = existing.step
      const name = toolNameOf(part)
      if (name && (step.name === 'tool' || step.name === '')) step.name = name
      const input = part.state?.input
      if (
        input !== undefined &&
        input !== null &&
        (step.arguments === undefined || hasInputKeys(input))
      ) {
        step.arguments = input
      }
      if (output.length > 0 && step.result === undefined) {
        step.result = makeResult(output, status === 'error')
        step.status = status === 'error' ? 'error' : 'completed'
      } else {
        step.status = mergeToolStatus(step.status, status)
      }
      const duration = partDuration(part)
      if (duration !== undefined && step.durationMs === undefined) step.durationMs = duration
      if (step.orphan === true) delete step.orphan
      applyMessageMeta(existing.turn, message)
      return
    }

    const turn = ensureContentTurn(message, index)
    const step: ToolStep = {
      type: 'tool',
      id: key || `${messageKey(message, index)}:tool:${partIndex}`,
      name: toolNameOf(part) || 'tool',
      status,
    }
    const input = part.state?.input
    if (input !== undefined && input !== null) step.arguments = input
    if (output.length > 0) step.result = makeResult(output, status === 'error')
    const duration = partDuration(part)
    if (duration !== undefined) step.durationMs = duration
    turn.steps.push(step)
    turn.processOpen = true
    registerTool(step, turn, part)
  }

  function mergeResultIntoStep(step: ToolStep, text: string, isError: boolean): void {
    if (step.result === undefined || (step.result.text === '' && text !== '')) {
      step.result = makeResult(text, isError)
    }
    if (isError) {
      step.status = 'error'
    } else if (step.status !== 'error') {
      step.status = 'completed'
    }
  }

  function addOrphanStep(
    step: ToolStep,
    message: ChatMessage,
    index: number,
  ): DraftTurn {
    const turn = ensureOrphanTurn(message, index)
    turn.steps.push(step)
    turn.processOpen = true
    return turn
  }

  function addToolResultPart(
    part: MessagePart,
    message: ChatMessage,
    index: number,
    partIndex: number,
  ): void {
    const text = outputText(part)
    const isError = part.state?.status === 'error'
    const callKey = part.callID || ''

    if (callKey) {
      const owned = toolIndex.get(callKey)
      if (owned !== undefined) {
        mergeResultIntoStep(owned.step, text, isError)
        applyMessageMeta(owned.turn, message)
        return
      }
    } else if (open !== null) {
      const target = findFirstUnresultedTool(open)
      if (target !== undefined) {
        mergeResultIntoStep(target, text, isError || target.status === 'error')
        applyMessageMeta(open, message)
        return
      }
      if (hasResolvedToolCall(open)) {
        applyMessageMeta(open, message)
        return
      }
    }

    const status = normalizeToolStatus(part.state?.status, true)
    const step: ToolStep = {
      type: 'tool',
      id: callKey || part.id || `${messageKey(message, index)}:result:${partIndex}`,
      name: toolNameOf(part) || 'tool',
      status,
      orphan: true,
    }
    if (text.length > 0 || status === 'error') {
      step.result = makeResult(text, status === 'error')
    }
    const turn = addOrphanStep(step, message, index)
    registerTool(step, turn, part)
  }

  function addShellResult(
    part: MessagePart,
    message: ChatMessage,
    index: number,
    partIndex: number,
  ): void {
    const callKey = part.callID || ''
    const output = outputText(part)
    const status = normalizeToolStatus(part.state?.status, output.length > 0)

    if (callKey) {
      const owned = toolIndex.get(callKey)
      if (owned !== undefined) {
        mergeResultIntoStep(owned.step, output, status === 'error')
        applyMessageMeta(owned.turn, message)
        return
      }
    }

    const step: ToolStep = {
      type: 'tool',
      id: callKey || part.id || `${messageKey(message, index)}:result:${partIndex}`,
      name: toolNameOf(part) || shellName(message) || 'tool',
      status,
      orphan: true,
    }
    const input = part.state?.input
    if (input !== undefined && input !== null && hasInputKeys(input)) {
      step.arguments = input
    }
    if (output.length > 0 || status === 'error') {
      step.result = makeResult(output, status === 'error')
    }
    const duration = partDuration(part)
    if (duration !== undefined) step.durationMs = duration
    const turn = addOrphanStep(step, message, index)
    registerTool(step, turn, part)
  }

  function processCompaction(message: ChatMessage, index: number): void {
    const turn = ensureDividerTurn(message, index)
    const step: CompactionStep = { type: 'compaction', text: compactionTextOf(message) }
    turn.steps.push(step)
  }

  function processUserMessage(message: ChatMessage, index: number): void {
    startUserTurn(message, index)
    const parts = message.parts ?? []
    parts.forEach((part, partIndex) => {
      if (part.type === 'reasoning' || part.type === 'thought') {
        addThinkingStep(part, message, index)
        return
      }
      if (part.type === 'tool' || part.type === 'tool_call') {
        addToolCall(part, message, index, partIndex)
        return
      }
      if (part.type === 'tool_result') {
        addToolResultPart(part, message, index, partIndex)
      }
      // text 已并入 userText; compaction 在消息级处理
    })
  }

  function processAssistantMessage(message: ChatMessage, index: number): void {
    const parts = message.parts ?? []
    if (parts.length === 0) {
      const fallback = textOf(message.content) || textOf(message.text)
      if (fallback) {
        const turn = ensureContentTurn(message, index)
        appendReply(turn, fallback)
        applyMessageMeta(turn, message)
      } else if (isLiveMessage(message, streamingId)) {
        ensureContentTurn(message, index)
      }
      return
    }

    let touched = false
    parts.forEach((part, partIndex) => {
      if (part.type === 'text') {
        const text = textOf(part.text)
        if (!text) return
        const turn = ensureContentTurn(message, index)
        appendReply(turn, text)
        applyMessageMeta(turn, message)
        touched = true
        return
      }
      if (part.type === 'reasoning' || part.type === 'thought') {
        if (textOf(part.text)) touched = true
        addThinkingStep(part, message, index)
        return
      }
      if (part.type === 'tool' || part.type === 'tool_call') {
        addToolCall(part, message, index, partIndex)
        touched = true
        return
      }
      if (part.type === 'tool_result') {
        addToolResultPart(part, message, index, partIndex)
        touched = true
      }
    })

    if (!touched && isLiveMessage(message, streamingId)) {
      ensureContentTurn(message, index)
    }
  }

  function processToolResultMessage(message: ChatMessage, index: number): void {
    const parts = message.parts ?? []
    let handled = false
    parts.forEach((part, partIndex) => {
      if (part.type !== 'tool' && part.type !== 'tool_call' && part.type !== 'tool_result') {
        return
      }
      handled = true
      addShellResult(part, message, index, partIndex)
    })
    if (handled) return

    const text = textOf(message.content) || textOf(message.text) || textPartsText(parts)
    const isError = shellIsError(message)
    if (!text && !isError) {
      if (isLiveMessage(message, streamingId) && open !== null) {
        applyMessageMeta(open, message)
      }
      return
    }

    const callId = shellCallId(message)
    if (callId) {
      const owned = toolIndex.get(callId)
      if (owned !== undefined) {
        mergeResultIntoStep(owned.step, text, isError)
        applyMessageMeta(owned.turn, message)
        return
      }
    }

    const status: ToolStatus = isError ? 'error' : 'completed'
    const step: ToolStep = {
      type: 'tool',
      id: callId || stableMessageId(message) || `turn:${index}:result`,
      name: shellName(message) ?? 'tool',
      status,
      orphan: true,
      result: makeResult(text, isError),
    }
    const turn = addOrphanStep(step, message, index)
    registerTool(step, turn)
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (isCompactionMessage(message)) {
      processCompaction(message, index)
      continue
    }
    const role = messageRole(message)
    if (role === 'user') {
      processUserMessage(message, index)
      continue
    }
    if (role === 'toolResult') {
      processToolResultMessage(message, index)
      continue
    }
    processAssistantMessage(message, index)
  }

  return drafts.map((turn) => {
    const view: TurnView = {
      id: turn.id,
      userText: turn.userText,
      attachments: [],
      steps: turn.steps,
      reply: turn.replyParts.join('\n\n'),
      live: turn.live,
    }
    if (turn.startedAt !== undefined) view.startedAt = turn.startedAt
    return view
  })
}
