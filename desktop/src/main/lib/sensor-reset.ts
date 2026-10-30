import { rmSync } from 'node:fs'
import type { SensorPaths } from './sensor-paths'

const CONFIG_PATHS = ['agentConfigPath', 'collectionConfigPath', 'caBundlePath'] as const

export function resetSensorConfigFiles(paths: SensorPaths): void {
  let failure: unknown
  for (const key of CONFIG_PATHS) {
    const target = paths[key]
    for (const file of [target, `${target}.bak`]) {
      try {
        rmSync(file, { force: true })
      } catch (error) {
        failure ??= error
      }
    }
  }
  if (failure !== undefined) throw failure
}
