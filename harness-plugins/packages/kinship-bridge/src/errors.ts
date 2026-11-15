/**
 * Typed errors shared by the bridge's binding, host, and HTTP layers.
 *
 * @module kinship-bridge/errors
 */

/** An error the HTTP server can map to a status and stable machine code. */
export class BridgeError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.status = status
    this.code = code
  }
}

/** 409 when no Kinship Session is available to bind. */
export function noKinshipSession(): BridgeError {
  return new BridgeError(
    409,
    'no_kinship_session',
    'No root dsh session with agent preset "kinship" is live.',
  )
}

/** 409 when the persisted binding points at a Session the host no longer has. */
export function boundSessionMissing(sessionId: string): BridgeError {
  return new BridgeError(
    409,
    'bound_session_missing',
    `The bound kinship session "${sessionId}" is no longer live.`,
  )
}

/** 409 when the bound Session could not be resumed back into a live agent. */
export function boundSessionUnavailable(sessionId: string, reason: string): BridgeError {
  const detail = reason.trim().replace(/\.+$/, '')
  return new BridgeError(
    409,
    'bound_session_unavailable',
    `The bound kinship session "${sessionId}" could not be resumed: ${detail === '' ? 'no reason given' : detail}.`,
  )
}

/** 404 when a requested Session id is unknown. */
export function sessionNotFound(sessionId: string): BridgeError {
  return new BridgeError(404, 'session_not_found', `Unknown session "${sessionId}".`)
}

/** 409 when a Session is not a root Session. */
export function notRootSession(sessionId: string): BridgeError {
  return new BridgeError(409, 'not_root_session', `Session "${sessionId}" is not a root session.`)
}

/** 409 when a Session does not run the kinship preset. */
export function notKinshipSession(sessionId: string): BridgeError {
  return new BridgeError(
    409,
    'not_kinship_session',
    `Session "${sessionId}" does not run agent preset "kinship".`,
  )
}

/** 503 when the host has not mounted the subagent runtime. */
export function subagentsUnavailable(): BridgeError {
  return new BridgeError(503, 'subagents_unavailable', 'The dsh subagent runtime is unavailable.')
}
