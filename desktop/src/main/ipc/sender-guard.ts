import type { IpcResult } from '../../shared/types'

export interface SettingsWebContentsLike {
  readonly id: number
}

export interface ControllerLike {
  getSettingsWebContents(): SettingsWebContentsLike | null
}

export interface SenderLike {
  readonly sender: { readonly id: number }
}

const FORBIDDEN_MESSAGE = '仅允许本地设置界面调用此接口'

export function isSettingsSender(event: SenderLike, controller: ControllerLike): boolean {
  const settings = controller.getSettingsWebContents()
  if (settings === null) return false
  return event.sender.id === settings.id
}

export function guardSettingsSender(
  event: SenderLike,
  controller: ControllerLike,
): IpcResult<never> | null
export function guardSettingsSender<T>(
  event: SenderLike,
  controller: ControllerLike,
): IpcResult<T> | null
export function guardSettingsSender<T>(
  event: SenderLike,
  controller: ControllerLike,
): IpcResult<T> | null {
  if (isSettingsSender(event, controller)) return null
  return { ok: false, error: FORBIDDEN_MESSAGE, code: 'FORBIDDEN' }
}
