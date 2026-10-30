// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationHeader,
  buildAuthTokenUrl,
  buildConfigUrl,
  buildPanelUrl,
  buildSensorArgs,
  buildSensorSpawnOptions,
  buildShutdownUrl,
  buildStatusUrl,
  buildTestLoginUrl,
} from '../../src/main/lib/sensor-command'

describe('buildSensorArgs', () => {
  it('builds the silent bundled sensor arguments in order', () => {
    const args = buildSensorArgs({
      appScript: 'C:\\app\\pc_sensor_app.py',
      dataDir: 'C:\\Users\\user\\AppData\\Roaming\\Axeuh Health\\pc-sensor',
      parentPid: 4321,
    })

    expect(args).toEqual([
      'C:\\app\\pc_sensor_app.py',
      '--silent',
      '--no-tray',
      '--data-dir',
      'C:\\Users\\user\\AppData\\Roaming\\Axeuh Health\\pc-sensor',
      '--parent-pid',
      '4321',
    ])
  })
})

describe('buildSensorSpawnOptions', () => {
  it('runs from the app directory without a console window', () => {
    expect(buildSensorSpawnOptions('C:\\app')).toEqual({
      cwd: 'C:\\app',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })
})

describe('sensor URL helpers', () => {
  const baseUrl = 'http://127.0.0.1:18888'

  it('builds the panel, status, auth-token, config, and shutdown URLs', () => {
    expect(buildPanelUrl(baseUrl)).toBe('http://127.0.0.1:18888/pc-config')
    expect(buildStatusUrl(baseUrl)).toBe('http://127.0.0.1:18888/pc-sensor/status')
    expect(buildAuthTokenUrl(baseUrl)).toBe('http://127.0.0.1:18888/pc-sensor/auth-token')
    expect(buildConfigUrl(baseUrl)).toBe('http://127.0.0.1:18888/pc-sensor/config')
    expect(buildShutdownUrl(baseUrl)).toBe('http://127.0.0.1:18888/shutdown')
    expect(buildTestLoginUrl(baseUrl)).toBe('http://127.0.0.1:18888/pc-sensor/test-login')
  })

  it('normalizes a trailing slash', () => {
    expect(buildPanelUrl('http://127.0.0.1:18888/')).toBe('http://127.0.0.1:18888/pc-config')
    expect(buildAuthTokenUrl('http://127.0.0.1:18888/')).toBe(
      'http://127.0.0.1:18888/pc-sensor/auth-token',
    )
  })
})

describe('buildAuthorizationHeader', () => {
  it('uses a Bearer token', () => {
    expect(buildAuthorizationHeader('abc123')).toBe('Bearer abc123')
  })
})
