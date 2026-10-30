// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  applyLoginItemSetting,
  buildLoginItemSettings,
  type LoginItemSettings,
} from '../../src/main/lib/login-item'

describe('buildLoginItemSettings', () => {
  it('is a no-op on non-Windows platforms', () => {
    expect(
      buildLoginItemSettings(true, {
        platform: 'linux',
        portableExecutableFile: 'C:\\Kinship.exe',
      }),
    ).toBeNull()
    expect(
      buildLoginItemSettings(true, {
        platform: 'darwin',
      }),
    ).toBeNull()
  })

  it('uses the default executable for installed Windows builds', () => {
    expect(buildLoginItemSettings(true, { platform: 'win32' })).toEqual({
      openAtLogin: true,
    })
  })

  it('targets PORTABLE_EXECUTABLE_FILE for portable builds', () => {
    expect(
      buildLoginItemSettings(false, {
        platform: 'win32',
        portableExecutableFile: ' C:\\Apps\\Kinship Portable.exe ',
      }),
    ).toEqual({
      openAtLogin: false,
      path: 'C:\\Apps\\Kinship Portable.exe',
    })
  })
})

describe('applyLoginItemSetting', () => {
  it('calls setLoginItemSettings with the built payload', () => {
    const setLoginItemSettings = vi.fn<(settings: LoginItemSettings) => void>()
    const result = applyLoginItemSetting(true, {
      platform: 'win32',
      setLoginItemSettings,
    })

    expect(result).toEqual({ applied: true })
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })

  it('skips without an adapter and reports adapter errors', () => {
    expect(applyLoginItemSetting(true, { platform: 'win32' })).toEqual({
      applied: false,
    })
    expect(
      applyLoginItemSetting(true, {
        platform: 'win32',
        setLoginItemSettings: () => {
          throw new Error('registry denied')
        },
      }),
    ).toEqual({ applied: false, error: 'registry denied' })
  })
})
