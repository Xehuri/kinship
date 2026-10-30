export const MAX_RESTART_ATTEMPTS = 5

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 16000

export function backoffDelayMs(attempt: number): number {
  const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  return Math.min(BASE_DELAY_MS * 2 ** (normalized - 1), MAX_DELAY_MS)
}

export function shouldRestart(attempt: number, isQuitting: boolean): boolean {
  return !isQuitting && attempt >= 1 && attempt <= MAX_RESTART_ATTEMPTS
}
