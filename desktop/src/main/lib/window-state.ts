export interface DisplayLike {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface WindowBoundsLike {
  readonly x?: number
  readonly y?: number
  readonly width: number
  readonly height: number
}

export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const MIN_WIDTH = 960
export const MIN_HEIGHT = 640
export const DEFAULT_WIDTH = 1200
export const DEFAULT_HEIGHT = 820

const VISIBLE_RATIO = 0.25

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function area(display: DisplayLike): number {
  return display.width * display.height
}

function intersectionArea(rect: WindowBounds, display: DisplayLike): number {
  const left = Math.max(rect.x, display.x)
  const top = Math.max(rect.y, display.y)
  const right = Math.min(rect.x + rect.width, display.x + display.width)
  const bottom = Math.min(rect.y + rect.height, display.y + display.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

function centerOn(display: DisplayLike, width: number, height: number): WindowBounds {
  return {
    x: Math.round(display.x + (display.width - width) / 2),
    y: Math.round(display.y + (display.height - height) / 2),
    width,
    height,
  }
}

function clampToDisplay(rect: WindowBounds, display: DisplayLike): WindowBounds {
  return {
    x: clamp(rect.x, display.x, display.x + display.width - rect.width),
    y: clamp(rect.y, display.y, display.y + display.height - rect.height),
    width: rect.width,
    height: rect.height,
  }
}

function largestDisplay(displays: readonly DisplayLike[]): DisplayLike {
  return displays.reduce((largest, candidate) =>
    area(candidate) > area(largest) ? candidate : largest,
  )
}

function bestDisplay(
  rect: WindowBounds,
  displays: readonly DisplayLike[],
): DisplayLike | undefined {
  let best: DisplayLike | undefined
  let bestArea = 0
  for (const display of displays) {
    const visible = intersectionArea(rect, display)
    if (visible > bestArea) {
      best = display
      bestArea = visible
    }
  }
  return best
}

export function sanitizeWindowBounds(
  bounds: WindowBoundsLike,
  displays: readonly DisplayLike[],
): WindowBounds {
  if (displays.length === 0) {
    return { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  }

  const largest = largestDisplay(displays)
  const width = clamp(bounds.width, MIN_WIDTH, largest.width)
  const height = clamp(bounds.height, MIN_HEIGHT, largest.height)
  const first = displays[0]
  const center = (): WindowBounds => clampToDisplay(centerOn(first, width, height), first)

  if (bounds.x === undefined || bounds.y === undefined) return center()

  const proposed: WindowBounds = { x: bounds.x, y: bounds.y, width, height }
  const chosen = bestDisplay(proposed, displays)
  if (chosen === undefined || intersectionArea(proposed, chosen) < width * height * VISIBLE_RATIO) {
    return center()
  }

  return clampToDisplay(proposed, chosen)
}

export function isBoundsVisible(
  bounds: WindowBoundsLike,
  displays: readonly DisplayLike[],
): boolean {
  const rect: WindowBounds = {
    x: bounds.x ?? 0,
    y: bounds.y ?? 0,
    width: bounds.width,
    height: bounds.height,
  }
  return displays.some((display) => intersectionArea(rect, display) > 0)
}
