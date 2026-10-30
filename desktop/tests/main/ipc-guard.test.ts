// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  guardSettingsSender,
  isSettingsSender,
} from '../../src/main/ipc/sender-guard'

const controller = {
  getSettingsWebContents: () => ({ id: 7 }),
}

describe('sender guard', () => {
  it('accepts the settings view sender', () => {
    expect(isSettingsSender({ sender: { id: 7 } }, controller)).toBe(true)
    expect(guardSettingsSender({ sender: { id: 7 } }, controller)).toBeNull()
  })

  it('returns FORBIDDEN for the SPA or any other renderer', () => {
    expect(isSettingsSender({ sender: { id: 8 } }, controller)).toBe(false)
    expect(guardSettingsSender({ sender: { id: 8 } }, controller)).toEqual({
      ok: false,
      error: '仅允许本地设置界面调用此接口',
      code: 'FORBIDDEN',
    })
  })

  it('rejects every sender when the settings view is closed', () => {
    const closed = { getSettingsWebContents: () => null }
    expect(isSettingsSender({ sender: { id: 7 } }, closed)).toBe(false)
    expect(guardSettingsSender({ sender: { id: 7 } }, closed)).not.toBeNull()
  })
})
