import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  CancelOptions,
  Inbox,
  InboxTarget,
  Model,
} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'

export interface SentMessage {
  readonly message: UserMessage
  readonly target: InboxTarget
  readonly wakeup: boolean
}

/** Minimal structural Agent backed by a real dsh Session. */
export class TestAgent implements Agent {
  readonly id: SessionId
  readonly session: Session
  readonly options: AgentOptions = {}
  readonly model: Model = {
    current: () => undefined,
    select: () => undefined,
  }

  readonly inbox: Inbox = {
    nextTurn: [],
    nextStep: [],
    clear: () => undefined,
    append: () => undefined,
    prepend: () => undefined,
    replace: () => false,
    remove: () => false,
    splice: () => [],
  }

  readonly ctx = new Context()
  readonly sent: SentMessage[] = []
  cancelled: AgentCancelCause | undefined
  status: 'idle' | 'running'

  constructor(id: string, preset: string | null, status: 'idle' | 'running' = 'idle') {
    this.id = SessionId(id)
    this.status = status
    this.session = Session.create(this.id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id: this.id,
      createdAt: 1,
      isSeeded: false,
      ...(preset === null ? {} : { agentPreset: preset }),
    })
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.sent.push({ message, target, wakeup })
    this.session.append('user/message', message, { surfaceOp: 'append' })
  }

  followup(message: UserMessage): void {
    this.sent.push({ message, target: 'next-turn', wakeup: true })
  }

  steer(message: UserMessage): void {
    this.sent.push({ message, target: 'next-step', wakeup: true })
  }

  inject(message: UserMessage): void {
    this.sent.push({ message, target: 'next-step', wakeup: false })
  }

  cancel(cause: AgentCancelCause, _options?: CancelOptions): void {
    this.cancelled = cause
    this.status = 'idle'
  }

  whenIdle(): Promise<void> {
    return Promise.resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }
}
