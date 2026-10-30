/// <reference types="vitest/globals" />

/**
 * 路由配置测试 (T5: v2-only)
 *
 * 验证 6 个页面路由 + 根重定向 + 404 兜底, 全部带 meta.shell='v2',
 * 且 /dashboard 已被移除 (落入 404)。
 */

import { describe, it, expect } from 'vitest'
import router from '@/router'

const PAGE_ROUTES = ['/chat', '/plan', '/reminders', '/reports', '/files', '/settings']

describe('router v2-only', () => {
  it('只暴露 6 个页面路由 + 根重定向 + 404', () => {
    const paths = router
      .getRoutes()
      .map((route) => route.path)
      .sort()

    expect(paths).toEqual(
      ['/', '/chat', '/plan', '/files', '/reminders', '/reports', '/settings', '/:pathMatch(.*)*'].sort(),
    )
  })

  it('根路径重定向到 /chat', () => {
    const root = router.getRoutes().find((route) => route.path === '/')
    expect(root?.redirect).toBe('/chat')
  })

  it('路由名称保持稳定', () => {
    const names = router.getRoutes().map((route) => route.name)
    expect(names).toEqual(
      expect.arrayContaining(['chat', 'plan', 'reminders', 'reports', 'files', 'settings', 'not-found']),
    )
    for (const path of PAGE_ROUTES) {
      const resolved = router.resolve(path)
      expect(resolved.name).toBe(path.replace(/^\//, ''))
    }
  })

  it('所有页面路由使用 v2 壳层', () => {
    for (const path of PAGE_ROUTES) {
      expect(router.resolve(path).meta.shell).toBe('v2')
    }
  })

  it('/plan 指向计划视图且只读路由', () => {
    const plan = router.resolve('/plan')
    expect(plan.name).toBe('plan')
    expect(plan.meta.shell).toBe('v2')
    expect(plan.matched).toHaveLength(1)
    expect(plan.matched[0].components?.default).toBeTypeOf('function')
  })

  it('未知路由仍落入 404', () => {
    const route = router.resolve('/no-such-page')
    expect(route.name).toBe('not-found')
    expect(route.meta.shell).toBe('v2')
  })

  it('看板路由已移除并落入 404', () => {
    const route = router.resolve('/dashboard')
    expect(route.name).toBe('not-found')
    expect(route.meta.shell).toBe('v2')
  })
})
