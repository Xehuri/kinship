import { logger } from '../lib/logger'

export type ShutdownHook = () => Promise<void> | void

const DEFAULT_TIMEOUT_MS = 8_000

export class ShutdownHooks {
  private readonly hooks: ShutdownHook[] = []
  private running: Promise<void> | null = null

  register(hook: ShutdownHook): void {
    this.hooks.push(hook)
  }

  run(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (this.running !== null) return this.running
    this.running = this.execute(timeoutMs)
    return this.running
  }

  private async execute(timeoutMs: number): Promise<void> {
    const hooks = this.hooks.splice(0, this.hooks.length)
    let timer: NodeJS.Timeout | undefined

    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const running = (async (): Promise<'done'> => {
      for (const hook of hooks) {
        try {
          await hook()
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown error'
          logger.error('关闭钩子执行失败', { error: reason })
        }
      }
      return 'done'
    })()

    const result = await Promise.race([running, timeout])
    if (timer !== undefined) clearTimeout(timer)
    if (result === 'timeout') {
      logger.warn('关闭钩子执行超时', { timeoutMs })
    }
  }
}
