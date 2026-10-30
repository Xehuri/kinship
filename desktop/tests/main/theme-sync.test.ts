// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  THEME_MESSAGE_PREFIX,
  backgroundColorForTheme,
  buildThemeObserverScript,
  mapWebThemeToNative,
  parseThemeMessage,
} from '../../src/main/shell/theme-sync'

describe('mapWebThemeToNative', () => {
  it('maps dark to dark', () => {
    expect(mapWebThemeToNative('dark')).toBe('dark')
  })

  it('maps light to light', () => {
    expect(mapWebThemeToNative('light')).toBe('light')
  })

  it('maps glacier to light', () => {
    expect(mapWebThemeToNative('glacier')).toBe('light')
  })

  it('falls back to dark for unknown and empty themes', () => {
    expect(mapWebThemeToNative('sepia')).toBe('dark')
    expect(mapWebThemeToNative('')).toBe('dark')
  })
})

describe('backgroundColorForTheme', () => {
  it('prefers a reported #rrggbb color', () => {
    expect(backgroundColorForTheme('light', '#123abc')).toBe('#123abc')
  })

  it('accepts a reported #aarrggbb color', () => {
    expect(backgroundColorForTheme('dark', '#80123456')).toBe('#80123456')
  })

  it('ignores invalid reported colors', () => {
    expect(backgroundColorForTheme('light', '#12345')).toBe('#f5f7fa')
    expect(backgroundColorForTheme('light', 'rgb(1, 2, 3)')).toBe('#f5f7fa')
    expect(backgroundColorForTheme('light', '')).toBe('#f5f7fa')
    expect(backgroundColorForTheme('light', '#1234567')).toBe('#f5f7fa')
  })

  it('uses per-theme fallbacks when no color is reported', () => {
    expect(backgroundColorForTheme('dark')).toBe('#0d0d14')
    expect(backgroundColorForTheme('light')).toBe('#f5f7fa')
    expect(backgroundColorForTheme('glacier')).toBe('#e8f4fc')
  })

  it('falls back to dark for unknown themes', () => {
    expect(backgroundColorForTheme('sepia')).toBe('#0d0d14')
    expect(backgroundColorForTheme('')).toBe('#0d0d14')
  })
})

describe('parseThemeMessage', () => {
  it('parses a theme snapshot', () => {
    expect(
      parseThemeMessage(`${THEME_MESSAGE_PREFIX}{"theme":"glacier","bg":"#e8f4fc"}`),
    ).toEqual({ theme: 'glacier', bg: '#e8f4fc' })
  })

  it('rejects messages without the marker', () => {
    expect(parseThemeMessage('{"theme":"light","bg":"#f5f7fa"}')).toBeNull()
  })

  it('rejects the marker without JSON', () => {
    expect(parseThemeMessage(THEME_MESSAGE_PREFIX)).toBeNull()
    expect(parseThemeMessage(`${THEME_MESSAGE_PREFIX}   `)).toBeNull()
  })

  it('rejects malformed JSON', () => {
    expect(parseThemeMessage(`${THEME_MESSAGE_PREFIX}{not json}`)).toBeNull()
  })

  it('rejects snapshots with non-string fields', () => {
    expect(parseThemeMessage(`${THEME_MESSAGE_PREFIX}{"theme":1,"bg":"#fff"}`)).toBeNull()
    expect(parseThemeMessage(`${THEME_MESSAGE_PREFIX}{"theme":"dark","bg":null}`)).toBeNull()
    expect(parseThemeMessage(`${THEME_MESSAGE_PREFIX}["dark","#0d0d14"]`)).toBeNull()
    expect(parseThemeMessage(`${THEME_MESSAGE_PREFIX}null`)).toBeNull()
  })
})

describe('buildThemeObserverScript', () => {
  it('emits the marker and observes theme mutations', () => {
    const script = buildThemeObserverScript()
    expect(script).toContain(THEME_MESSAGE_PREFIX)
    expect(script).toContain('MutationObserver')
    expect(script).toContain('data-theme')
    expect(script).toContain('__axeuhThemeSyncV1')
  })
})
