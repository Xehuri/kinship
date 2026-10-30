import { basename, join } from 'node:path'
import type { BrowserWindow, Session } from 'electron'

export type DownloadLog = (
  message: string,
  fields?: Readonly<Record<string, string | number | boolean>>,
) => void

export interface DownloadPolicyOptions {
  readonly getAllowedOrigin: () => string | null
  readonly getParentWindow: () => BrowserWindow | null
  readonly log?: DownloadLog
}

const ILLEGAL_FILENAME_CHARACTERS = /[<>:"/\\|?*\x00-\x1f]/g
const MAX_FILENAME_LENGTH = 180
const FALLBACK_FILENAME = 'download.bin'

export function sanitizeDownloadFilename(name: string): string {
  return (
    basename(name)
      .replace(ILLEGAL_FILENAME_CHARACTERS, '_')
      .slice(0, MAX_FILENAME_LENGTH) || FALLBACK_FILENAME
  )
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function isAllowedDownload(url: string, allowedOrigin: string | null): boolean {
  if (allowedOrigin === null || allowedOrigin.length === 0) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const expected = normalizeOrigin(allowedOrigin)
  return expected !== null && parsed.origin === expected
}

function resolveDefaultPath(
  appModule: Pick<typeof import('electron').app, 'getPath'>,
  filename: string,
): string {
  try {
    return join(appModule.getPath('downloads'), filename)
  } catch {
    return filename
  }
}

export function applyDownloadPolicy(session: Session, options: DownloadPolicyOptions): void {
  const log = options.log ?? (() => undefined)

  session.on('will-download', (_event, item) => {
    const url = item.getURL()
    if (!isAllowedDownload(url, options.getAllowedOrigin())) {
      log('下载来源不在允许范围，已取消', { url })
      item.cancel()
      return
    }

    item.pause()

    const { app, dialog } = require('electron') as typeof import('electron')
    const parent = options.getParentWindow()
    const dialogOptions = {
      title: '保存文件',
      defaultPath: resolveDefaultPath(app, sanitizeDownloadFilename(item.getFilename())),
    }
    const pending =
      parent !== null && !parent.isDestroyed()
        ? dialog.showSaveDialog(parent, dialogOptions)
        : dialog.showSaveDialog(dialogOptions)

    void pending
      .then((result) => {
        if (item.getState() === 'cancelled') return
        if (result.canceled || typeof result.filePath !== 'string' || result.filePath.length === 0) {
          log('已取消保存下载文件', { url })
          item.cancel()
          return
        }
        item.setSavePath(result.filePath)
        item.resume()
        log('下载已开始保存', { path: result.filePath })
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'unknown error'
        log('选择下载保存路径失败，已取消下载', { url, error: reason })
        if (item.getState() !== 'cancelled') item.cancel()
      })

    item.once('done', (_doneEvent, state) => {
      log('下载结束', { state, path: item.getSavePath() })
    })
  })
}
