/**
 * 文件浏览类型
 *
 * 对应 /api/mobile/files、/api/mobile/files/content 与 /api/mobile/files/raw 接口。
 * 后端条目使用 mtime 字段, API 层统一归一化为 modified_at。
 */

/** 文件条目类型 */
export type FileEntryType = 'dir' | 'file'

/** 文件图标分类 (历史字段, 保留兼容) */
export type FileIconClass = 'dir' | 'audio' | 'image' | 'doc'

/** 预览类型 (决定前端使用哪个预览组件) */
export type FilePreviewKind =
  | 'md'
  | 'jsonl'
  | 'json'
  | 'text'
  | 'image'
  | 'audio'
  | 'code'
  | 'unsupported'

/** 单个文件/目录条目 */
export interface FileEntry {
  /** 文件/目录名称 */
  name: string
  /** 条目类型 */
  type: FileEntryType
  /** 文件大小 (字节) */
  size?: number
  /** 最后修改时间 (ISO 字符串, 由后端 mtime 归一化而来) */
  modified_at?: string
}

/** 后端 /api/mobile/files 原始条目 */
export interface RawFileEntry {
  name: string
  type?: string
  size?: number
  /** 后端最后修改时间字段 */
  mtime?: string
  /** 已归一化字段 (兼容未来后端直出) */
  modified_at?: string
}

/** /api/mobile/files 响应: 目录列表 */
export interface FileTreeResponse {
  entries: FileEntry[]
}

/** 后端 /api/mobile/files 原始响应 */
export interface RawFileTreeResponse {
  entries?: RawFileEntry[]
}

/** 树形/搜索结果行 (由 composable 派生, 供 FileTree 渲染) */
export interface FileTreeRow {
  entry: FileEntry
  /** 相对 scope 根目录的完整路径 (不含前导斜杠) */
  path: string
  /** 缩进层级 */
  depth: number
  /** 目录是否展开 */
  expanded: boolean
  /** 目录是否正在懒加载 */
  loading: boolean
  /** 是否为当前目录 */
  current: boolean
  /** 已加载目录的子项数量 */
  childCount?: number
  /** 目录加载失败信息 */
  error?: string | null
}

/** 当前选中的文件 */
export interface SelectedFile {
  entry: FileEntry
  /** 相对 scope 根目录的完整路径 (不含前导斜杠) */
  path: string
}

/**
 * /api/mobile/files/content 响应
 * 文本文件返回 { content: string }
 * JSON/JSONL 文件返回 { objects: PerceptionObject[] }
 */
export interface FileContentJsonResponse {
  /** 文件文本内容 */
  content?: string
  /** JSON/JSONL 解析后的对象数组 */
  objects?: Array<Record<string, unknown>>
}

/** 文件搜索查询参数 */
export interface FileSearchQuery {
  /** 搜索关键词 */
  q?: string
  /** 搜索范围路径 */
  path?: string
  /** 文件类型过滤 */
  type?: 'dir' | 'file'
}
