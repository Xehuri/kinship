/**
 * Resolve the persisted bound Session, resuming it when it is not live.
 *
 * dsh keeps the agent registry empty after a harness restart: the Session log
 * is still on disk, but no agent is running until something resumes it. The
 * Web UI resumes a Session when someone opens it; the bridge performs the same
 * resume lazily so the Kinship backend never depends on that manual step.
 *
 * @module kinship-bridge/rehydrate
 */

import {
  boundSessionMissing,
  boundSessionUnavailable,
  noKinshipSession,
} from './errors.js'
import type {
  BindingController,
  BridgeHost,
  BridgeSession,
} from './types.js'

/** One bound Session resolved for a caller. */
export interface BoundSession {
  readonly id: string
  readonly session: BridgeSession
}

/**
 * Concurrent HTTP requests for the same dead binding share one resume.
 *
 * Keyed by Session id and cleared when the attempt settles, so a request that
 * arrives after a failure starts a fresh attempt instead of reusing a rejected
 * promise.
 */
const inFlight = new Map<string, Promise<BoundSession>>()

/**
 * Resolve the bound Session, resuming it through the host when it is not live.
 *
 * The persisted binding survives restarts but the live agent does not, so a
 * missing `host.getSession` result means "not live yet", not "gone". When the
 * host exposes the optional resume capability the bridge rebuilds the agent
 * through it, then re-reconciles the binding so `bound_session_missing` clears
 * for every later request.
 *
 * @param binding - durable binding controller holding the selected Session id.
 * @param host - adapter that may resume a persisted Session back into an agent.
 * @returns the live Session and its id.
 * @throws {BridgeError} `409 no_kinship_session`, `409 bound_session_missing`,
 * or `409 bound_session_unavailable`.
 */
export async function ensureBoundSession(
  binding: BindingController,
  host: BridgeHost,
): Promise<BoundSession> {
  const snapshot = binding.snapshot()
  if (snapshot.sessionId === null) throw noKinshipSession()
  const sessionId = snapshot.sessionId

  const live = host.getSession(sessionId)
  if (live !== undefined) {
    if (snapshot.status === 'bound_session_missing') binding.reconcile(host)
    // The binding may still refuse the Session (its live definition no longer
    // matches the bound policy); keep the established 409 contract then.
    if (binding.snapshot().status !== 'bound') throw boundSessionMissing(sessionId)
    return { id: sessionId, session: live }
  }

  if (host.resume === undefined) throw boundSessionMissing(sessionId)

  const pending = inFlight.get(sessionId)
  if (pending !== undefined) return pending
  const attempt = rehydrate(binding, host, sessionId)
  const tracked = attempt.finally(() => {
    if (inFlight.get(sessionId) === tracked) inFlight.delete(sessionId)
  })
  inFlight.set(sessionId, tracked)
  return tracked
}

/** One resume attempt; `ensureBoundSession` allows one at a time per Session. */
async function rehydrate(
  binding: BindingController,
  host: BridgeHost,
  sessionId: string,
): Promise<BoundSession> {
  const resume = host.resume
  if (resume === undefined) throw boundSessionMissing(sessionId)
  const result = await resume.call(host, sessionId)

  if (result.status === 'resumed') {
    binding.reconcile(host)
    const snapshot = binding.snapshot()
    if (snapshot.status !== 'bound' || snapshot.sessionId !== sessionId) {
      // The host published an agent, but the binding no longer owns it (for
      // instance because the live Session fails the root/kinship policy).
      throw boundSessionMissing(sessionId)
    }
    return { id: sessionId, session: result.session }
  }

  if (result.status === 'missing') {
    // Under `first` + `rebindOnMissing` reconcile may switch the binding to
    // another live kinship Session; hand that Session out when it exists so
    // the caller receives whatever the binding now points at.
    binding.reconcile(host)
    const snapshot = binding.snapshot()
    if (snapshot.status === 'bound' && snapshot.sessionId !== null) {
      const rebound = host.getSession(snapshot.sessionId)
      if (rebound !== undefined) return { id: snapshot.sessionId, session: rebound }
    }
    throw boundSessionMissing(sessionId)
  }

  throw boundSessionUnavailable(sessionId, result.reason)
}
