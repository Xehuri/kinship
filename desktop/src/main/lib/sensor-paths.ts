import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface SensorPathsOptions {
  readonly resourcesPath: string
  readonly appPath: string
  readonly userDataPath: string
  readonly env?: NodeJS.ProcessEnv
}

export interface SensorPaths {
  readonly rootDir: string
  readonly candidateRoots: readonly string[]
  readonly runtimeDir: string
  readonly appDir: string
  readonly pythonExe: string
  readonly appScript: string
  readonly dataDir: string
  readonly agentConfigPath: string
  readonly collectionConfigPath: string
  readonly logPath: string
  readonly caBundlePath: string
}

const SENSOR_DIRECTORY = 'pc-sensor'
const RUNTIME_DIRECTORY = 'runtime'
const APP_DIRECTORY = 'app'
const AGENT_CONFIG_FILENAME = 'config.json'
const COLLECTION_CONFIG_FILENAME = 'pc_sensor_config.json'
const SENSOR_LOG_FILENAME = 'pc-sensor.log'
const CA_BUNDLE_FILENAME = 'ca-bundle.pem'
const USER_DATA_RUNTIME_DIRECTORY = 'pc-sensor-runtime'
const INSTALLED_APP_DIRECTORY = 'Kinship Desktop'
// Pre-rebrand per-user install directory; kept as a fallback for upgraded installs.
const LEGACY_INSTALLED_APP_DIRECTORY = 'Axeuh Health Desktop'

function trimmedEnvValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  return typeof value === 'string' ? value.trim() : ''
}

function hasRuntimeAt(rootDir: string): boolean {
  return (
    existsSync(join(rootDir, RUNTIME_DIRECTORY, 'python.exe')) &&
    existsSync(join(rootDir, APP_DIRECTORY, 'pc_sensor_app.py'))
  )
}

export function resolveSensorPathCandidates(options: SensorPathsOptions): readonly string[] {
  const env = options.env ?? process.env
  const rootOverride = trimmedEnvValue(env, 'AXEUH_PC_SENSOR_ROOT')
  const localAppData = trimmedEnvValue(env, 'LOCALAPPDATA')

  const candidates: string[] = []
  if (rootOverride.length > 0) {
    candidates.push(resolve(options.appPath, rootOverride))
  }
  candidates.push(join(options.resourcesPath, SENSOR_DIRECTORY))
  candidates.push(join(options.userDataPath, USER_DATA_RUNTIME_DIRECTORY))
  if (localAppData.length > 0) {
    for (const installedAppDirectory of [
      INSTALLED_APP_DIRECTORY,
      LEGACY_INSTALLED_APP_DIRECTORY,
    ]) {
      candidates.push(
        join(
          localAppData,
          'Programs',
          installedAppDirectory,
          'resources',
          SENSOR_DIRECTORY,
        ),
      )
    }
  }
  candidates.push(resolve(options.appPath, '..', SENSOR_DIRECTORY))

  const unique: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    unique.push(trimmed)
  }
  return unique
}

export function resolveSensorPaths(options: SensorPathsOptions): SensorPaths {
  const env = options.env ?? process.env
  const candidateRoots = resolveSensorPathCandidates(options)
  const detectedRoot = candidateRoots.find((candidate) => hasRuntimeAt(candidate))
  const rootDir = detectedRoot ?? candidateRoots[0] ?? join(options.resourcesPath, SENSOR_DIRECTORY)

  const dataOverride = trimmedEnvValue(env, 'AXEUH_PC_SENSOR_DATA_DIR')
  const dataDir =
    dataOverride.length > 0
      ? resolve(options.appPath, dataOverride)
      : join(options.userDataPath, SENSOR_DIRECTORY)

  const runtimeDir = join(rootDir, RUNTIME_DIRECTORY)
  const appDir = join(rootDir, APP_DIRECTORY)

  return {
    rootDir,
    candidateRoots,
    runtimeDir,
    appDir,
    pythonExe: join(runtimeDir, 'python.exe'),
    appScript: join(appDir, 'pc_sensor_app.py'),
    dataDir,
    agentConfigPath: join(dataDir, AGENT_CONFIG_FILENAME),
    collectionConfigPath: join(dataDir, COLLECTION_CONFIG_FILENAME),
    logPath: join(dataDir, SENSOR_LOG_FILENAME),
    caBundlePath: join(options.userDataPath, CA_BUNDLE_FILENAME),
  }
}

export function isRuntimePresent(paths: SensorPaths): boolean {
  return existsSync(paths.pythonExe) && existsSync(paths.appScript)
}
