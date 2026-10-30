import { app } from 'electron'

export interface LoginItemSettings {
  openAtLogin: boolean
  path?: string
}

export interface LoginItemEnvironment {
  readonly platform: NodeJS.Platform
  readonly portableExecutableFile?: string
  readonly setLoginItemSettings?: (settings: LoginItemSettings) => void
}

export interface LoginItemApplyResult {
  readonly applied: boolean
  readonly error?: string
}

export function buildLoginItemSettings(
  openAtLogin: boolean,
  environment: Omit<LoginItemEnvironment, 'setLoginItemSettings'>,
): LoginItemSettings | null {
  if (environment.platform !== 'win32') return null
  const portablePath = environment.portableExecutableFile?.trim() ?? ''
  if (portablePath.length === 0) return { openAtLogin }
  return { openAtLogin, path: portablePath }
}

export function applyLoginItemSetting(
  openAtLogin: boolean,
  environment: LoginItemEnvironment = {
    platform: process.platform,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    setLoginItemSettings:
      typeof app.setLoginItemSettings === 'function'
        ? (settings) => app.setLoginItemSettings(settings)
        : undefined,
  },
): LoginItemApplyResult {
  const settings = buildLoginItemSettings(openAtLogin, environment)
  if (settings === null) return { applied: false }
  if (environment.setLoginItemSettings === undefined) return { applied: false }

  try {
    environment.setLoginItemSettings(settings)
    return { applied: true }
  } catch (error) {
    return {
      applied: false,
      error: error instanceof Error ? error.message : 'unknown error',
    }
  }
}
