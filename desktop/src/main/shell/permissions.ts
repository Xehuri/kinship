import type { Session } from 'electron'

export type PermissionLog = (message: string) => void

const ALLOWED_PERMISSION = 'clipboard-sanitized-write'

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

export function decidePermission(
  permission: string,
  requestingOrigin: string,
  allowedOrigin: string | null,
): boolean {
  if (allowedOrigin === null || allowedOrigin.length === 0) return false
  if (permission !== ALLOWED_PERMISSION) return false
  return normalizeOrigin(requestingOrigin) === normalizeOrigin(allowedOrigin)
}

function contentsOrigin(contents: Electron.WebContents | null): string {
  if (contents === null) return ''
  try {
    return contents.getURL()
  } catch {
    return ''
  }
}

export function applySessionPermissions(
  session: Session,
  getAllowedOrigin: () => string | null,
  log: PermissionLog = () => undefined,
): void {
  session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = decidePermission(
      permission,
      contentsOrigin(webContents),
      getAllowedOrigin(),
    )
    if (!allowed) log(`权限请求被拒绝：${permission}`)
    callback(allowed)
  })

  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const allowed = decidePermission(permission, requestingOrigin, getAllowedOrigin())
    if (!allowed) log(`权限检查被拒绝：${permission}`)
    return allowed
  })

  session.setDevicePermissionHandler((details) => {
    log(`设备权限被拒绝：${details.deviceType}`)
    return false
  })
}
