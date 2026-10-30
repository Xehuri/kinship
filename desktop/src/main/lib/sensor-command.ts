import type { SpawnOptions } from 'node:child_process'

export interface SensorArgsOptions {
  readonly appScript: string
  readonly dataDir: string
  readonly parentPid: number
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export function buildSensorArgs(options: SensorArgsOptions): string[] {
  return [
    options.appScript,
    '--silent',
    '--no-tray',
    '--data-dir',
    options.dataDir,
    '--parent-pid',
    String(options.parentPid),
  ]
}

export function buildSensorSpawnOptions(appDir: string): SpawnOptions {
  return {
    cwd: appDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
}

export function buildPanelUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/pc-config`
}

export function buildStatusUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/pc-sensor/status`
}

export function buildConfigUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/pc-sensor/config`
}

export function buildAuthTokenUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/pc-sensor/auth-token`
}

export function buildTestLoginUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/pc-sensor/test-login`
}

export function buildShutdownUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/shutdown`
}

export function buildRestartUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/restart`
}

export function buildAuthorizationHeader(token: string): string {
  return `Bearer ${token}`
}
