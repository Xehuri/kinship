export interface SettingsWebContentsHandle {
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>
  capturePage(): Promise<{ toPNG(): Buffer }>
}

export interface AxeuhQaControllerHandle {
  getSettingsWebContents(): SettingsWebContentsHandle | null
}

export interface AxeuhQaGlobal {
  readonly __AXEUH_QA__?: { readonly controller: AxeuhQaControllerHandle }
}

declare global {
  var __AXEUH_QA__: AxeuhQaGlobal['__AXEUH_QA__']
}
