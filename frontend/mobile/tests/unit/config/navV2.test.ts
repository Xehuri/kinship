import { describe, expect, it } from 'vitest'
import {
  NAV_V2_DESKTOP,
  NAV_V2_MOBILE,
  NAV_V2_SHORTCUT_ROUTES,
} from '@/config/navV2'

describe('navV2', () => {
  it('defines exactly six desktop items in order', () => {
    expect(NAV_V2_DESKTOP.map((item) => item.route)).toEqual([
      '/chat',
      '/plan',
      '/reminders',
      '/reports',
      '/files',
      '/settings',
    ])
    expect(NAV_V2_DESKTOP.map((item) => item.label)).toEqual([
      '对话',
      '计划',
      '提醒',
      '报告',
      '文件',
      '设置',
    ])
  })

  it('defines exactly four mobile items in order', () => {
    expect(NAV_V2_MOBILE.map((item) => item.route)).toEqual([
      '/chat',
      '/plan',
      '/reports',
      '/settings',
    ])
    expect(NAV_V2_MOBILE.map((item) => item.label)).toEqual([
      '对话',
      '计划',
      '报告',
      '设置',
    ])
  })

  it('has no dashboard or health entry', () => {
    const routes = [...NAV_V2_DESKTOP, ...NAV_V2_MOBILE].map((item) => item.route)
    expect(routes).not.toContain('/dashboard')
    expect(routes.some((route) => route.includes('health'))).toBe(false)
  })

  it('uses the AppIcon names shipped in T1', () => {
    expect(NAV_V2_DESKTOP.map((item) => item.icon)).toEqual([
      'chat-circle-text',
      'list-checks',
      'bell',
      'chart-bar',
      'files',
      'gear',
    ])
  })

  it('places plan after chat and before reminders', () => {
    const routes = NAV_V2_DESKTOP.map((item) => item.route)
    expect(routes.indexOf('/plan')).toBe(routes.indexOf('/chat') + 1)
    expect(routes.indexOf('/plan')).toBe(routes.indexOf('/reminders') - 1)
  })

  it('derives Ctrl+1~6 shortcuts from the desktop order', () => {
    expect(NAV_V2_SHORTCUT_ROUTES).toEqual({
      '1': '/chat',
      '2': '/plan',
      '3': '/reminders',
      '4': '/reports',
      '5': '/files',
      '6': '/settings',
    })
  })
})
