import type { BrowserWindow, Session } from 'electron'
import { logger } from '../lib/logger'
import { installCertificateVerifyProc, type TrustPolicy } from '../lib/tls'
import { applyDownloadPolicy } from './downloads'
import { applySessionPermissions } from './permissions'

export interface MainSessionPolicyOptions {
  readonly session: Session
  readonly getTrustPolicy: () => TrustPolicy
  readonly getAllowedOrigin: () => string | null
  readonly getParentWindow: () => BrowserWindow | null
}

export function installMainSessionPolicies(options: MainSessionPolicyOptions): void {
  installCertificateVerifyProc(
    options.session,
    options.getTrustPolicy,
    (line) => logger.info(line),
  )
  applySessionPermissions(
    options.session,
    options.getAllowedOrigin,
    (message) => logger.debug(message),
  )
  applyDownloadPolicy(options.session, {
    getAllowedOrigin: options.getAllowedOrigin,
    getParentWindow: options.getParentWindow,
    log: (message, fields) => logger.info(message, fields),
  })
}
