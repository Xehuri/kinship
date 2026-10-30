// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSensorConfigFiles } from '../../src/main/lib/sensor-reset'
import type { SensorPaths } from '../../src/main/lib/sensor-paths'

function createPaths(root: string): SensorPaths {
  const runtimeDir = join(root, 'runtime')
  const appDir = join(root, 'app')
  const dataDir = join(root, 'data')
  return {
    rootDir: root,
    candidateRoots: [root],
    runtimeDir,
    appDir,
    pythonExe: join(runtimeDir, 'python.exe'),
    appScript: join(appDir, 'pc_sensor_app.py'),
    dataDir,
    agentConfigPath: join(dataDir, 'config.json'),
    collectionConfigPath: join(dataDir, 'pc_sensor_config.json'),
    logPath: join(dataDir, 'pc-sensor.log'),
    caBundlePath: join(root, 'ca-bundle.pem'),
  }
}

describe('resetSensorConfigFiles', () => {
  let directory = ''
  let paths: SensorPaths

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-sensor-reset-'))
    paths = createPaths(directory)
    mkdirSync(paths.dataDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('removes agent, collection, CA files and stale backups while keeping logs', () => {
    writeFileSync(paths.agentConfigPath, JSON.stringify({ agent_token: 'secret-token' }), 'utf8')
    writeFileSync(paths.collectionConfigPath, JSON.stringify({ backend_token: 'secret' }), 'utf8')
    writeFileSync(`${paths.collectionConfigPath}.bak`, '{"backend_token":"stale"}', 'utf8')
    writeFileSync(paths.caBundlePath, '-----BEGIN CERTIFICATE-----', 'utf8')
    writeFileSync(paths.logPath, 'keep this log', 'utf8')

    resetSensorConfigFiles(paths)

    expect(existsSync(paths.agentConfigPath)).toBe(false)
    expect(existsSync(paths.collectionConfigPath)).toBe(false)
    expect(existsSync(`${paths.collectionConfigPath}.bak`)).toBe(false)
    expect(existsSync(paths.caBundlePath)).toBe(false)
    expect(existsSync(paths.logPath)).toBe(true)
    expect(readFileSync(paths.logPath, 'utf8')).toBe('keep this log')
    expect(existsSync(paths.dataDir)).toBe(true)
  })

  it('is idempotent when the files and data directory are missing', () => {
    rmSync(paths.dataDir, { recursive: true, force: true })

    expect(() => {
      resetSensorConfigFiles(paths)
      resetSensorConfigFiles(paths)
    }).not.toThrow()
  })
})
