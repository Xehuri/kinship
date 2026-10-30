import type { DesktopApi } from '../../../shared/ipc'

declare global {
  interface Window {
    readonly axeuh: DesktopApi
  }
}

export {}
