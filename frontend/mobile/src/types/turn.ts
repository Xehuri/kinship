/**
 * TurnView —— 聊天消息的"用户 -> 过程 -> 回复"轮次视图模型
 *
 * 只描述渲染所需数据, 不携带 QQ 通道/表面等来源字段。
 * 由 utils/turnAdapter.ts 的 toTurnViews() 从 ChatMessage[] 派生。
 */

/** 工具调用状态 (OpenCode / Loom 状态字符串的归一态) */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'abandoned'

/** 用户消息附件 (当前无结构化附件数据源, 适配器保持为空) */
export interface TurnAttachment {
  id: string
  name: string
  kind?: string
}

/** 思考步骤 (reasoning / thought part) */
export interface ThinkingStep {
  type: 'thinking'
  text: string
  durationMs?: number
  live?: boolean
}

/** 工具结果正文 */
export interface ToolResultView {
  text: string
  isError?: boolean
  truncated?: boolean
  totalChars?: number
}

/** 工具调用步骤 */
export interface ToolStep {
  type: 'tool'
  id: string
  name: string
  status: ToolStatus
  arguments?: unknown
  result?: ToolResultView
  durationMs?: number
  /** 找不到对应 tool call 的孤立结果 (Loom 孤儿 toolResult 壳等) */
  orphan?: boolean
}

/** 上下文压缩步骤 (压缩分隔线 / 压缩摘要消息) */
export interface CompactionStep {
  type: 'compaction'
  text: string
}

/** 轮次内的过程步骤; 回复正文统一放在 TurnView.reply */
export type TurnStep = ThinkingStep | ToolStep | CompactionStep

/** 轮次终态 (ChatMessage 暂无结构化终态信号, 适配器不臆造) */
export type TurnTerminalReason = 'done' | 'aborted' | 'error'

export interface TurnTerminal {
  reason: TurnTerminalReason
  at?: number
}

/** 一轮对话: 用户输入 -> 过程步骤 -> 回复正文 */
export interface TurnView {
  id: string
  userText: string
  attachments: TurnAttachment[]
  steps: TurnStep[]
  reply: string
  live: boolean
  startedAt?: number
  terminal?: TurnTerminal
}
