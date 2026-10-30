// @vitest-environment jsdom
/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import GpsMapOverlay from '@/components/dashboard/GpsMapOverlay.vue'
import type { MergedGpsPoint } from '@/types/gps'

// ==================== 伪百度地图 ====================

interface FakeMarker {
  listeners: Map<string, Set<Function>>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

/** 构造一个记录调用的伪 BMap 命名空间 */
function createFakeBMap() {
  const markers: FakeMarker[] = []
  const overlayRemovals: unknown[] = []
  const mapAddEventListener = vi.fn()
  const mapRemoveEventListener = vi.fn()

  class Point {
    constructor(public lng: number, public lat: number) {}
  }
  class Size {
    constructor(public width: number, public height: number) {}
  }
  class Bounds {
    extend = vi.fn()
    getNorthEast = vi.fn()
    getSouthWest = vi.fn()
  }
  class Icon {
    constructor(public url: string, public size: unknown, public opts?: unknown) {}
  }
  class Polyline {
    constructor(public points: unknown[], public opts?: unknown) {}
  }
  class Marker implements FakeMarker {
    listeners = new Map<string, Set<Function>>()
    addEventListener = vi.fn((event: string, handler: () => void) => {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(handler)
    })
    removeEventListener = vi.fn((event: string, handler: () => void) => {
      this.listeners.get(event)?.delete(handler)
    })
    constructor(public point: unknown, public opts?: unknown) {
      markers.push(this)
    }
  }
  class MapClass {
    centerAndZoom = vi.fn()
    setViewport = vi.fn()
    setMapStyle = vi.fn()
    reset = vi.fn()
    destroy = vi.fn()
    addOverlay = vi.fn()
    removeOverlay = vi.fn((o: unknown) => {
      overlayRemovals.push(o)
    })
    addEventListener = mapAddEventListener
    removeEventListener = mapRemoveEventListener
  }

  const namespace = {
    Map: MapClass,
    Point,
    Size,
    Bounds,
    Icon,
    Polyline,
    Marker,
  }

  return { namespace, markers, overlayRemovals, mapAddEventListener, mapRemoveEventListener }
}

const points: MergedGpsPoint[] = [
  { t: '10:00', lat: 31.2, lng: 121.4, place: '', count: 1 },
  { t: '11:00', lat: 31.3, lng: 121.5, place: '', count: 2 },
]

/** 挂载并触发地图初始化 (等待受管理定时器) */
async function mountOverlay(fake: ReturnType<typeof createFakeBMap>) {
  ;(window as unknown as Record<string, unknown>).BMap = fake.namespace
  const wrapper = mount(GpsMapOverlay, {
    props: { visible: false, gpsPoints: points },
  })
  await wrapper.setProps({ visible: true })
  await nextTick()
  await vi.advanceTimersByTimeAsync(200) // initMap 延迟
  await flushPromises()
  await vi.advanceTimersByTimeAsync(400) // reset 兜底定时器
  await flushPromises()
  return wrapper
}

describe('GpsMapOverlay - marker 监听解绑 (FE-L2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as Record<string, unknown>).BMap
  })

  it('初始化时为每个 GPS 点创建 marker 并注册 click 监听', async () => {
    const fake = createFakeBMap()
    const wrapper = await mountOverlay(fake)

    expect(fake.markers.length).toBe(points.length)
    for (const m of fake.markers) {
      expect(m.addEventListener).toHaveBeenCalledWith('click', expect.any(Function))
    }
    wrapper.unmount()
  })

  it('组件卸载时解绑 marker click 监听', async () => {
    const fake = createFakeBMap()
    const wrapper = await mountOverlay(fake)
    const addedHandlers = fake.markers.map((m) => m.addEventListener.mock.calls[0][1])

    wrapper.unmount()

    fake.markers.forEach((m, i) => {
      expect(m.removeEventListener).toHaveBeenCalledWith('click', addedHandlers[i])
    })
  })

  it('关闭覆盖层时解绑并移除 marker, 重新打开不残留旧监听', async () => {
    const fake = createFakeBMap()
    const wrapper = await mountOverlay(fake)
    const firstBatch = fake.markers.slice()
    expect(firstBatch.length).toBe(points.length)

    await wrapper.setProps({ visible: false })
    await flushPromises()

    firstBatch.forEach((m) => {
      expect(m.removeEventListener).toHaveBeenCalled()
      expect(fake.overlayRemovals).toContain(m)
    })

    // 重新打开 -> 生成新一批 marker (不与旧批次重叠)
    await wrapper.setProps({ visible: true })
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    expect(fake.markers.length).toBe(points.length * 2)

    wrapper.unmount()
  })
})
