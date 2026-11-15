/**
 * Structural adapter from the scheduler to the sibling `kinship-bridge` plugin.
 *
 * The scheduler only needs three facts from the bridge: which Session is bound,
 * whether that binding is live, and a way to inject one plain-text wake into
 * it. Mirroring the bridge's public shape here (instead of importing its
 * package) keeps the two plugins independently installable and lets a
 * deployment run the scheduler with no bridge at all: `deliver` then throws and
 * the wake queue records the failure like any other delivery error.
 *
 * @module kinship-plan-scheduler/delivery
 */

import type { Context } from '@deepseek-ai/cordis'

/** One delivery target the scheduler and wake queue need. */
export interface PlanDelivery {
  /** Bound Session id, or null when the bridge has no session. */
  sessionId(): string | null
  /** True when the bridge reports a live `bound` session. */
  live(): boolean
  /** Inject one user message into the bound Session. */
  deliver(text: string): Promise<{ readonly sessionId: string; readonly messageId: string }>
}

/** Structural mirror of `BindingSnapshot` from kinship-bridge. */
interface BridgeBindingSnapshot {
  readonly status: 'unbound' | 'bound' | 'bound_session_missing'
  readonly sessionId: string | null
}

/** Structural mirror of `KinshipBridgeService` from kinship-bridge. */
interface BridgeService {
  status(): BridgeBindingSnapshot
  deliver?(text: string): Promise<{ readonly sessionId: string; readonly messageId: string }>
}

/** The message every failed lookup reports; the queue treats a throw as a failed delivery. */
const UNAVAILABLE = 'kinship bridge is unavailable'

function bridgeOf(ctx: Context): BridgeService | undefined {
  try {
    const service = ctx.get('kinshipBridge') as BridgeService | undefined
    return service === undefined || service === null ? undefined : service
  } catch {
    return undefined
  }
}

/**
 * Read the bridge's current binding snapshot, or null when the service is
 * absent or fails; callers treat null as "no session".
 */
function snapshotOf(ctx: Context): BridgeBindingSnapshot | null {
  const bridge = bridgeOf(ctx)
  if (bridge === undefined) return null
  try {
    return bridge.status()
  } catch {
    return null
  }
}

/**
 * Build the bridge-backed delivery adapter.
 *
 * @param ctx - host context; the bridge service is resolved lazily on every
 * call so a plugin reload that replaces the service needs no re-wiring here.
 * @returns the delivery port used by the wake queue.
 */
export function createBridgeDelivery(ctx: Context): PlanDelivery {
  return {
    sessionId() {
      const snapshot = snapshotOf(ctx)
      const sessionId = snapshot?.sessionId
      return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
    },
    live() {
      return snapshotOf(ctx)?.status === 'bound'
    },
    async deliver(text) {
      const bridge = bridgeOf(ctx)
      if (bridge === undefined || typeof bridge.deliver !== 'function') {
        throw new Error(UNAVAILABLE)
      }
      const result = await bridge.deliver(text)
      if (typeof result?.sessionId !== 'string' || typeof result.messageId !== 'string') {
        throw new Error(`${UNAVAILABLE}: the bridge returned no message id`)
      }
      return { sessionId: result.sessionId, messageId: result.messageId }
    },
  }
}
