// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveUserDataDir } from '../../src/main/lib/user-data'

describe('resolveUserDataDir', () => {
  it('keeps the legacy storage directory under appData', () => {
    const directory = resolveUserDataDir('/appdata', {})

    expect(directory).toBe(join('/appdata', 'Axeuh Health Desktop'))
    expect(directory).not.toBe(join('/appdata', 'Kinship'))
  })

  it('honors the AXEUH_USER_DATA_DIR override', () => {
    const directory = resolveUserDataDir('/appdata', {
      AXEUH_USER_DATA_DIR: '/custom',
    })

    expect(directory).toBe('/custom')
  })
})
