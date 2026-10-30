/**
 * 工具展示注册表：工具名 -> 图标 / 动词 / 结果卡类型 / 活动摘要。
 *
 * 组件只消费 descriptor，不在模板里硬编码工具外观。未登记的工具
 * 一律回 generic，不静默丢弃。
 */

export type ToolFamily =
  | 'terminal'
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'web'
  | 'subagent'
  | 'image'
  | 'todo'
  | 'skill'
  | 'generic'

export type ToolResultKind =
  | 'terminal'
  | 'read'
  | 'diff'
  | 'search'
  | 'web'
  | 'subagent'
  | 'image'
  | 'generic'

export interface ToolDescriptor {
  family: ToolFamily
  /** AppIcon 名称（AppIcon 自带大小写归一化） */
  icon: string
  verb: string
  resultKind: ToolResultKind
  activity: string
}

const TERMINAL: ToolDescriptor = {
  family: 'terminal',
  icon: 'Terminal',
  verb: '运行',
  resultKind: 'terminal',
  activity: '运行命令',
}

const READ: ToolDescriptor = {
  family: 'read',
  icon: 'FileText',
  verb: '读取',
  resultKind: 'read',
  activity: '读取文件',
}

const WRITE: ToolDescriptor = {
  family: 'write',
  icon: 'FileText',
  verb: '写入',
  resultKind: 'read',
  activity: '写入文件',
}

const EDIT: ToolDescriptor = {
  family: 'edit',
  icon: 'Code',
  verb: '编辑',
  resultKind: 'diff',
  activity: '编辑文件',
}

const SEARCH: ToolDescriptor = {
  family: 'search',
  icon: 'MagnifyingGlass',
  verb: '搜索',
  resultKind: 'search',
  activity: '搜索',
}

const WEB: ToolDescriptor = {
  family: 'web',
  icon: 'Globe',
  verb: '获取',
  resultKind: 'web',
  activity: '获取网页',
}

const SUBAGENT: ToolDescriptor = {
  family: 'subagent',
  icon: 'GitBranch',
  verb: '委派',
  resultKind: 'subagent',
  activity: '委派子任务',
}

const IMAGE: ToolDescriptor = {
  family: 'image',
  icon: 'Image',
  verb: '查看',
  resultKind: 'image',
  activity: '查看图片',
}

const TODO: ToolDescriptor = {
  family: 'todo',
  icon: 'ListChecks',
  verb: '更新',
  resultKind: 'generic',
  activity: '更新待办',
}

const SKILL: ToolDescriptor = {
  family: 'skill',
  icon: 'Lightning',
  verb: '调用',
  resultKind: 'generic',
  activity: '调用技能',
}

export const DEFAULT_TOOL_DESCRIPTOR: ToolDescriptor = {
  family: 'generic',
  icon: 'Wrench',
  verb: '调用',
  resultKind: 'generic',
  activity: '处理',
}

export const TOOL_REGISTRY: Readonly<Record<string, ToolDescriptor>> = {
  bash: TERMINAL,
  terminal: TERMINAL,
  shell: TERMINAL,
  'pty spawn': TERMINAL,
  'pty read': TERMINAL,
  'pty list': TERMINAL,
  'pty kill': TERMINAL,
  read: READ,
  'task fetch': READ,
  write: WRITE,
  edit: EDIT,
  diff: EDIT,
  'apply patch': EDIT,
  grep: SEARCH,
  glob: SEARCH,
  'web search': SEARCH,
  websearch: SEARCH,
  web_search: SEARCH,
  web_fetch: WEB,
  webfetch: WEB,
  task: SUBAGENT,
  child: SUBAGENT,
  'child run': SUBAGENT,
  image: IMAGE,
  'view image': IMAGE,
  'read image': IMAGE,
  todo: TODO,
  todowrite: TODO,
  skill: SKILL,
}

export function toolDescriptor(name: string | undefined): ToolDescriptor {
  if (name === undefined) {
    return DEFAULT_TOOL_DESCRIPTOR
  }

  const normalized = name.trim().toLowerCase()
  if (normalized.length === 0) {
    return DEFAULT_TOOL_DESCRIPTOR
  }

  const exact = TOOL_REGISTRY[normalized]
  if (exact !== undefined) {
    return exact
  }

  if (normalized.startsWith('pty')) {
    return TERMINAL
  }
  if (normalized.includes('search')) {
    return SEARCH
  }
  if (normalized.includes('fetch')) {
    return WEB
  }
  if (normalized.includes('child')) {
    return SUBAGENT
  }
  if (normalized.startsWith('read ')) {
    return READ
  }
  if (normalized.startsWith('write ')) {
    return WRITE
  }
  if (normalized.startsWith('edit ') || normalized.startsWith('diff ')) {
    return EDIT
  }

  return DEFAULT_TOOL_DESCRIPTOR
}
