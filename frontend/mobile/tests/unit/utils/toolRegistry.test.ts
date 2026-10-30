import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_DESCRIPTOR,
  TOOL_REGISTRY,
  toolDescriptor,
} from '@/utils/toolRegistry'

describe('toolRegistry', () => {
  it('maps representative tools to family, icon, verb and result kind', () => {
    expect(toolDescriptor('bash')).toEqual({
      family: 'terminal',
      icon: 'Terminal',
      verb: '运行',
      resultKind: 'terminal',
      activity: '运行命令',
    })
    expect(toolDescriptor('read')).toEqual({
      family: 'read',
      icon: 'FileText',
      verb: '读取',
      resultKind: 'read',
      activity: '读取文件',
    })
    expect(toolDescriptor('edit')).toEqual({
      family: 'edit',
      icon: 'Code',
      verb: '编辑',
      resultKind: 'diff',
      activity: '编辑文件',
    })
    expect(toolDescriptor('grep')).toEqual({
      family: 'search',
      icon: 'MagnifyingGlass',
      verb: '搜索',
      resultKind: 'search',
      activity: '搜索',
    })
    expect(toolDescriptor('web_fetch')).toEqual({
      family: 'web',
      icon: 'Globe',
      verb: '获取',
      resultKind: 'web',
      activity: '获取网页',
    })
    expect(toolDescriptor('task')).toEqual({
      family: 'subagent',
      icon: 'GitBranch',
      verb: '委派',
      resultKind: 'subagent',
      activity: '委派子任务',
    })
  })

  it('falls back to a generic wrench for unknown or missing names', () => {
    for (const name of [undefined, '', 'unknown tool xyz']) {
      expect(toolDescriptor(name)).toEqual(DEFAULT_TOOL_DESCRIPTOR)
    }
  })

  it('keeps every registered entry reachable through the typed lookup', () => {
    for (const [name, descriptor] of Object.entries(TOOL_REGISTRY)) {
      expect(toolDescriptor(name)).toBe(descriptor)
    }
  })
})
