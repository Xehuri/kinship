/**
 * 通用格式化工具
 *
 * 集中存放跨组件复用的纯格式化函数, 避免在多个 .vue 中重复定义:
 *   - formatTokenDisplay: Token 数量显示 (>=10000 显示为 "X万")
 *   - formatSize: 文件体积显示 (B/KB/MB/GB, 保留 1 位小数)
 *   - formatDate: 文件日期显示 (本年 "MM-DD", 跨年 "YYYY-MM-DD")
 *   - formatTime: 文件时间显示 ("HH:MM")
 *   - formatRelativeTime: 会话相对时间显示 (刚刚/N 分钟前/昨天/短日期)
 *   - getFileIconClass: 依据扩展名返回 FontAwesome 文件图标类名
 */

/** 格式化 Token 数量显示 (>=10000 显示为 "X万") */
export function formatTokenDisplay(n: number): string {
  if (!n || n < 10000) return String(n || 0)
  return Math.round(n / 10000) + '万'
}

/** 格式化文件体积 (B/KB/MB/GB, 保留 1 位小数) */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

/**
 * 格式化日期: 本年显示 "MM-DD", 跨年显示 "YYYY-MM-DD"。
 * 解析失败时原样返回入参。
 */
export function formatDate(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    if (isNaN(d.getTime())) return isoStr
    const now = new Date()
    const isThisYear = d.getFullYear() === now.getFullYear()
    const m = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    if (isThisYear) {
      return m + '-' + day
    }
    return d.getFullYear() + '-' + m + '-' + day
  } catch {
    return isoStr
  }
}

/** 格式化时间: "HH:MM"。解析失败时原样返回入参。 */
export function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    if (isNaN(d.getTime())) return isoStr
    const h = d.getHours().toString().padStart(2, '0')
    const m = d.getMinutes().toString().padStart(2, '0')
    return h + ':' + m
  } catch {
    return isoStr
  }
}

/**
 * 格式化相对时间: "刚刚" / "N 分钟前" / "N 小时前" / "昨天" / "N 天前",
 * 超过 7 天显示短日期 (本年 "MM-DD", 跨年 "YYYY-MM-DD")。
 *
 * 兼容三种输入 (会话时间字段在后端可能是数字时间戳而非 ISO 字符串):
 *   - Unix 时间戳数字 (秒或毫秒, < 1e12 视为秒);
 *   - 纯数字字符串 (同上);
 *   - 其他可被 Date 解析的字符串 (如 ISO)。
 * 解析失败返回 '' (由调用方决定是否回退显示原始文本)。
 */
export function formatRelativeTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  let ms: number
  if (typeof value === 'number') {
    ms = toEpochMs(value)
  } else {
    const trimmed = value.trim()
    if (!trimmed) return ''
    const numeric = Number(trimmed)
    ms = /^\d+(\.\d+)?$/.test(trimmed) ? toEpochMs(numeric) : new Date(trimmed).getTime()
  }
  if (!Number.isFinite(ms)) return ''
  const now = Date.now()
  const diff = now - ms
  if (diff < 0) return '刚刚'
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return Math.floor(diff / minute) + ' 分钟前'
  if (diff < day) return Math.floor(diff / hour) + ' 小时前'
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前'
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (d.getFullYear() === new Date(now).getFullYear()) return mm + '-' + dd
  return d.getFullYear() + '-' + mm + '-' + dd
}

/** 将 Unix 时间戳 (秒或毫秒) 转为毫秒; 非法值返回 NaN */
function toEpochMs(v: number): number {
  if (!Number.isFinite(v) || v <= 0 || v >= 8.64e15) return NaN
  return v < 1e12 ? v * 1000 : v
}

/** 依据文件扩展名返回 FontAwesome 文件图标类名 */
export function getFileIconClass(name: string): string {
  const lower = name.toLowerCase()
  // 图片
  if (lower.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/)) return 'fa-file-image'
  // 文本
  if (lower.match(/\.(md|txt|log)$/)) return 'fa-file-alt'
  // 代码 / 数据
  if (lower.match(/\.(json|jsonl|yaml|yml|toml|ini|cfg|conf)$/)) return 'fa-file-code'
  // 音频
  if (lower.match(/\.(mp3|wav|ogg|m4a|aac|flac|wma)$/)) return 'fa-file-audio'
  // 视频
  if (lower.match(/\.(mp4|avi|mkv|mov|wmv|flv)$/)) return 'fa-file-video'
  // 代码文件
  if (lower.match(/\.(js|ts|tsx|jsx|vue|html|css|scss|kt|java|py|go|rs|c|cpp|h|hpp|rb|php|sh|bash|ps1|sql)$/)) return 'fa-file-code'
  // PDF
  if (lower.endsWith('.pdf')) return 'fa-file-pdf'
  // 压缩包
  if (lower.match(/\.(zip|rar|7z|tar|gz)$/)) return 'fa-file-archive'
  // Office
  if (lower.match(/\.(doc|docx|xls|xlsx|ppt|pptx)$/)) return 'fa-file-word'
  // 默认
  return 'fa-file'
}
