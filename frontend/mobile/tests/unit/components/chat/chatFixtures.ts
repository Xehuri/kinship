import type {
  CompactionStep,
  ThinkingStep,
  ToolResultView,
  ToolStep,
  TurnView,
} from '@/types/turn'

export function makeTurn(overrides: Partial<TurnView> = {}): TurnView {
  return {
    id: 'turn-1',
    userText: '看看今天的状态',
    attachments: [],
    steps: [],
    reply: '今天整体状态平稳。',
    live: false,
    ...overrides,
  }
}

export function thinking(
  text = '先核对今天的健康数据',
  overrides: Partial<ThinkingStep> = {},
): ThinkingStep {
  return { type: 'thinking', text, ...overrides }
}

export function makeTool(
  name = 'read',
  overrides: Partial<ToolStep> = {},
): ToolStep {
  return {
    type: 'tool',
    id: `call-${name}`,
    name,
    status: 'completed',
    ...overrides,
  }
}

export function makeResult(
  text = 'ok',
  overrides: Partial<ToolResultView> = {},
): ToolResultView {
  return {
    text,
    totalChars: text.length,
    ...overrides,
  }
}

export function compaction(text = '上下文已压缩摘要'): CompactionStep {
  return { type: 'compaction', text }
}
