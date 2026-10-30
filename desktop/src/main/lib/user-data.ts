import { join } from 'node:path'
import { APP_STORAGE_DIR_NAME } from '../../shared/constants'

export function resolveUserDataDir(
  appDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.AXEUH_USER_DATA_DIR
  if (override !== undefined && override.length > 0) return override
  return join(appDataDir, APP_STORAGE_DIR_NAME)
}
