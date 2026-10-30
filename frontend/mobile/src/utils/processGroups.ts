/**
 * TurnView.steps -> 过程组 / 过程头。
 *
 * 组只包含连续的 thinking / tool 步骤；compaction 会断开分组，由
 * ChatThread 单独渲染分隔线。组标签只用于 aria-label，不显示在界面上。
 */

import type { ThinkingStep, ToolStep, TurnStep, TurnView } from '@/types/turn'
import { formatDurationMs } from '@/utils/toolDisplay'
import { toolDescriptor } from '@/utils/toolRegistry'

export type ProcessRowStep = ThinkingStep | ToolStep

export interface ProcessGroupView {
  key: string
  label: string
  steps: ProcessRowStep[]
}

export type ProcessState =
  | 'running'
  | 'done-thinking'
  | 'done-tools'
  | 'done'
  | 'stopped'
  | 'error'

export interface ProcessHeaderInfo {
  state: ProcessState
  label: string
}

const THINKING_ACTIVITY = '思考'
const FALLBACK_ACTIVITY = '处理'

export function isProcessStep(step: TurnStep): step is ProcessRowStep {
  return step.type === 'thinking' || step.type === 'tool'
}

function stepActivities(step: ProcessRowStep): string[] {
  if (step.type === 'thinking') {
    return [THINKING_ACTIVITY]
  }
  return [toolDescriptor(step.name).activity]
}

export function summarizeActivities(steps: readonly ProcessRowStep[]): string {
  const seen = new Set<string>()
  const activities: string[] = []
  let hasThinking = false

  for (const step of steps) {
    for (const activity of stepActivities(step)) {
      if (activity === THINKING_ACTIVITY) {
        hasThinking = true
        continue
      }
      if (seen.has(activity)) {
        continue
      }
      seen.add(activity)
      activities.push(activity)
    }
  }

  if (activities.length > 0) {
    return activities.join('、')
  }
  return hasThinking ? THINKING_ACTIVITY : FALLBACK_ACTIVITY
}

export function buildProcessGroups(turn: TurnView): ProcessGroupView[] {
  const groups: ProcessGroupView[] = []
  let current: ProcessRowStep[] = []

  function flush(): void {
    if (current.length === 0) {
      return
    }
    groups.push({
      key: `${turn.id}-group-${groups.length}`,
      label: summarizeActivities(current),
      steps: current,
    })
    current = []
  }

  for (const step of turn.steps) {
    if (!isProcessStep(step)) {
      flush()
      continue
    }
    current.push(step)
  }

  flush()
  return groups
}

function hasThinking(turn: TurnView): boolean {
  return turn.steps.some((step) => step.type === 'thinking')
}

function hasToolWork(turn: TurnView): boolean {
  return turn.steps.some(
    (step) => step.type === 'tool' && step.orphan !== true,
  )
}

export function processState(turn: TurnView): ProcessState {
  if (turn.live) {
    return 'running'
  }

  const reason = turn.terminal?.reason
  if (reason === 'aborted') {
    return 'stopped'
  }
  if (reason === 'error') {
    return 'error'
  }
  if (hasToolWork(turn)) {
    return 'done-tools'
  }
  if (hasThinking(turn)) {
    return 'done-thinking'
  }
  return 'done'
}

function validMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

export function processDurationMs(
  turn: TurnView,
  now = Date.now(),
): number | null {
  const startedAt = validMs(turn.startedAt)
  if (startedAt === undefined) {
    return null
  }

  if (turn.live) {
    const elapsed = now - startedAt
    return elapsed >= 0 ? elapsed : null
  }

  const endedAt = validMs(turn.terminal?.at)
  if (endedAt === undefined || endedAt < startedAt) {
    return null
  }
  return endedAt - startedAt
}

const STATE_WORD: Record<ProcessState, string> = {
  running: '正在处理',
  'done-thinking': '已思考',
  'done-tools': '已完成',
  done: '已完成',
  stopped: '已停止',
  error: '执行失败',
}

function usesElapsedWord(state: ProcessState): boolean {
  return (
    state === 'done-tools' ||
    state === 'done' ||
    state === 'stopped' ||
    state === 'error'
  )
}

export function processHeader(
  turn: TurnView,
  now = Date.now(),
): ProcessHeaderInfo {
  const state = processState(turn)
  const word = STATE_WORD[state]
  const duration = processDurationMs(turn, now)
  const durationText = duration === null ? '' : formatDurationMs(duration)

  if (durationText.length === 0) {
    return { state, label: word }
  }

  const prefix = usesElapsedWord(state) ? `${word} · 用时` : `${word} ·`
  return { state, label: `${prefix} ${durationText}` }
}
