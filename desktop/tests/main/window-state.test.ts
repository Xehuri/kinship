// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  isBoundsVisible,
  sanitizeWindowBounds,
} from '../../src/main/lib/window-state'
import type { DisplayLike } from '../../src/main/lib/window-state'

const primary: DisplayLike = { x: 0, y: 0, width: 1920, height: 1080 }
const secondary: DisplayLike = { x: 1920, y: 0, width: 1920, height: 1080 }

describe('sanitizeWindowBounds', () => {
  it('centers on the first display when x and y are undefined', () => {
    expect(sanitizeWindowBounds({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, [primary])).toEqual(
      { x: 360, y: 130, width: 1200, height: 820 },
    )
  })

  it('centers on the first display when the saved position is offscreen', () => {
    expect(
      sanitizeWindowBounds({ x: 5000, y: 5000, width: 1200, height: 820 }, [
        primary,
        secondary,
      ]),
    ).toEqual({ x: 360, y: 130, width: 1200, height: 820 })
  })

  it('preserves coordinates on a secondary display when mostly visible', () => {
    expect(
      sanitizeWindowBounds({ x: 2000, y: 100, width: 1200, height: 820 }, [
        primary,
        secondary,
      ]),
    ).toEqual({ x: 2000, y: 100, width: 1200, height: 820 })
  })

  it('clamps a tiny window up to the minimum size', () => {
    expect(sanitizeWindowBounds({ x: 100, y: 100, width: 200, height: 100 }, [primary])).toEqual({
      x: 100,
      y: 100,
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    })
  })

  it('falls back to defaults when there are no displays', () => {
    expect(sanitizeWindowBounds({ width: 100, height: 100 }, [])).toEqual({
      x: 0,
      y: 0,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    })
  })

  it('clamps an oversized window to the largest display', () => {
    expect(sanitizeWindowBounds({ width: 4000, height: 3000 }, [primary])).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
  })

  it('re-centers when less than a quarter of the window is visible', () => {
    expect(
      sanitizeWindowBounds({ x: -1000, y: 100, width: 1200, height: 820 }, [primary]),
    ).toEqual({ x: 360, y: 130, width: 1200, height: 820 })
  })

  it('clamps a mostly visible window inside the chosen display', () => {
    expect(
      sanitizeWindowBounds({ x: 900, y: 500, width: 1200, height: 820 }, [primary]),
    ).toEqual({ x: 720, y: 260, width: 1200, height: 820 })
  })
})

describe('isBoundsVisible', () => {
  it('reports whether any display shows the bounds', () => {
    expect(isBoundsVisible({ x: 2000, y: 100, width: 1200, height: 820 }, [primary, secondary])).toBe(
      true,
    )
    expect(isBoundsVisible({ x: 5000, y: 5000, width: 1200, height: 820 }, [primary])).toBe(false)
    expect(isBoundsVisible({ width: 1200, height: 820 }, [])).toBe(false)
  })
})
