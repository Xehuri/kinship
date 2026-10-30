/// <reference types="vitest/globals" />

/**
 * useTopInset 模块级单例测试
 *
 * 验证:
 *   1. 初始值读取自 localStorage, 非法值收敛为 0;
 *   2. setTopInset 写入 localStorage 并同步 <html> 的 --user-top-inset;
 *   3. clamp: 越界取边界, 按步长取整, 非有限数归 0;
 *   4. 多次调用共享同一份 topInset (模块级单例);
 *   5. resetTopInset 归零。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  useTopInset,
  disposeTopInset,
  clampTopInset,
  TOP_INSET_MIN,
  TOP_INSET_MAX,
  TOP_INSET_STEP,
} from '@/composables/useTopInset'

const CSS_VAR = '--user-top-inset'

beforeEach(() => {
  disposeTopInset()
  localStorage.clear()
  document.documentElement.style.removeProperty(CSS_VAR)
})

afterEach(() => {
  disposeTopInset()
  localStorage.clear()
  document.documentElement.style.removeProperty(CSS_VAR)
})

describe('clampTopInset', () => {
  it('范围内按步长取整', () => {
    expect(clampTopInset(39)).toBe(40)
    expect(clampTopInset(41)).toBe(40)
    expect(clampTopInset(4)).toBe(4)
    expect(clampTopInset(0)).toBe(0)
  })

  it('越界收敛到边界', () => {
    expect(clampTopInset(-100)).toBe(TOP_INSET_MIN)
    expect(clampTopInset(9999)).toBe(TOP_INSET_MAX)
  })

  it('非有限数归 0', () => {
    expect(clampTopInset(Number.NaN)).toBe(TOP_INSET_MIN)
    expect(clampTopInset(Number.POSITIVE_INFINITY)).toBe(TOP_INSET_MIN)
  })
})

describe('useTopInset', () => {
  it('默认值为 0 且写入 CSS 变量', () => {
    const { topInset } = useTopInset()
    expect(topInset.value).toBe(0)
    expect(document.documentElement.style.getPropertyValue(CSS_VAR)).toBe('0px')
  })

  it('初始值读取自 localStorage', () => {
    localStorage.setItem('top_inset', '32')
    const { topInset } = useTopInset()
    expect(topInset.value).toBe(32)
    expect(document.documentElement.style.getPropertyValue(CSS_VAR)).toBe('32px')
  })

  it('非法 localStorage 值收敛为 0', () => {
    localStorage.setItem('top_inset', 'abc')
    const { topInset } = useTopInset()
    expect(topInset.value).toBe(0)
  })

  it('setTopInset 持久化并同步到 DOM', () => {
    const { topInset, setTopInset } = useTopInset()
    setTopInset(48)
    expect(topInset.value).toBe(48)
    expect(localStorage.getItem('top_inset')).toBe('48')
    expect(document.documentElement.style.getPropertyValue(CSS_VAR)).toBe('48px')
  })

  it('setTopInset 会收敛越界值', () => {
    const { topInset, setTopInset } = useTopInset()
    setTopInset(500)
    expect(topInset.value).toBe(TOP_INSET_MAX)
    expect(localStorage.getItem('top_inset')).toBe(String(TOP_INSET_MAX))
  })

  it('多次调用共享同一份状态', () => {
    const a = useTopInset()
    const b = useTopInset()
    a.setTopInset(20)
    expect(b.topInset.value).toBe(20)
  })

  it('resetTopInset 归零', () => {
    const { topInset, setTopInset, resetTopInset } = useTopInset()
    setTopInset(40)
    resetTopInset()
    expect(topInset.value).toBe(TOP_INSET_MIN)
    expect(localStorage.getItem('top_inset')).toBe('0')
    expect(document.documentElement.style.getPropertyValue(CSS_VAR)).toBe('0px')
  })

  it('导出调节参数常量', () => {
    expect(TOP_INSET_MIN).toBe(0)
    expect(TOP_INSET_MAX).toBe(80)
    expect(TOP_INSET_STEP).toBe(4)
  })
})
