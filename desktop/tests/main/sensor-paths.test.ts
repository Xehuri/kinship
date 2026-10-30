// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveSensorPaths } from '../../src/main/lib/sensor-paths'

function createRuntime(root: string): void {
  mkdirSync(join(root, 'runtime'), { recursive: true })
  mkdirSync(join(root, 'app'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'python.exe'), '')
  writeFileSync(join(root, 'app', 'pc_sensor_app.py'), '')
}

describe('resolveSensorPaths', () => {
  let directory = ''
  let appPath = ''
  let resourcesPath = ''
  let userDataPath = ''
  let localAppData = ''
  let primaryRoot = ''
  let userDataRuntimeRoot = ''
  let installedRoot = ''
  let legacyInstalledRoot = ''
  let legacyRoot = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-sensor-paths-'))
    appPath = join(directory, 'desktop')
    resourcesPath = join(appPath, 'resources')
    userDataPath = join(directory, 'userdata')
    localAppData = join(directory, 'localappdata')
    primaryRoot = join(resourcesPath, 'pc-sensor')
    userDataRuntimeRoot = join(userDataPath, 'pc-sensor-runtime')
    installedRoot = join(
      localAppData,
      'Programs',
      'Kinship Desktop',
      'resources',
      'pc-sensor',
    )
    legacyInstalledRoot = join(
      localAppData,
      'Programs',
      'Axeuh Health Desktop',
      'resources',
      'pc-sensor',
    )
    legacyRoot = resolve(appPath, '..', 'pc-sensor')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('chooses the bundled resources runtime when it is present', () => {
    createRuntime(primaryRoot)

    const paths = resolveSensorPaths({
      resourcesPath,
      appPath,
      userDataPath,
      env: {},
    })

    expect(paths.rootDir).toBe(primaryRoot)
    expect(paths.pythonExe).toBe(join(primaryRoot, 'runtime', 'python.exe'))
    expect(paths.appScript).toBe(join(primaryRoot, 'app', 'pc_sensor_app.py'))
    expect(paths.candidateRoots[0]).toBe(primaryRoot)
    expect(paths.dataDir).toBe(join(userDataPath, 'pc-sensor'))
    expect(paths.caBundlePath).toBe(join(userDataPath, 'ca-bundle.pem'))
  })

  it('falls back to the userData runtime directory when the bundle is missing', () => {
    createRuntime(userDataRuntimeRoot)

    const paths = resolveSensorPaths({
      resourcesPath,
      appPath,
      userDataPath,
      env: {},
    })

    expect(paths.rootDir).toBe(userDataRuntimeRoot)
    expect(paths.pythonExe).toBe(
      join(userDataRuntimeRoot, 'runtime', 'python.exe'),
    )
  })

  it('falls back to the installed application resources directory', () => {
    createRuntime(installedRoot)

    const paths = resolveSensorPaths({
      resourcesPath,
      appPath,
      userDataPath,
      env: { LOCALAPPDATA: localAppData },
    })

    expect(paths.rootDir).toBe(installedRoot)
    expect(paths.appScript).toBe(
      join(installedRoot, 'app', 'pc_sensor_app.py'),
    )
  })

  it('falls back to the legacy install directory when the new one is absent', () => {
    createRuntime(legacyInstalledRoot)

    const paths = resolveSensorPaths({
      resourcesPath,
      appPath,
      userDataPath,
      env: { LOCALAPPDATA: localAppData },
    })

    expect(paths.rootDir).toBe(legacyInstalledRoot)
    expect(paths.appScript).toBe(
      join(legacyInstalledRoot, 'app', 'pc_sensor_app.py'),
    )
  })

  it('keeps the primary root and lists every candidate when nothing exists', () => {
    const paths = resolveSensorPaths({
      resourcesPath,
      appPath,
      userDataPath,
      env: { LOCALAPPDATA: localAppData },
    })

    expect(paths.rootDir).toBe(primaryRoot)
    expect(paths.candidateRoots).toEqual([
      primaryRoot,
      userDataRuntimeRoot,
      installedRoot,
      legacyInstalledRoot,
      legacyRoot,
    ])
  })
})
