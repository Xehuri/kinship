import type { FilePreviewKind } from '@/types/files'
import { languageFromName } from '@/utils/codeFormat'

const IMAGE_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i
const AUDIO_PATTERN = /\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i
const CODE_PATTERN =
  /\.(py|js|ts|tsx|jsx|vue|kt|java|go|rs|c|cpp|h|hpp|rb|php|sh|bash|ps1|sql|yaml|yml|toml|ini|cfg|conf|xml|html|css|scss)$/i

/** 根据文件名推断预览类型 */
export function getFilePreviewKind(fileName: string): FilePreviewKind {
  const lower = fileName.toLowerCase()
  if (IMAGE_PATTERN.test(lower)) return 'image'
  if (AUDIO_PATTERN.test(lower)) return 'audio'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.jsonl')) return 'jsonl'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text'
  if (CODE_PATTERN.test(lower)) return 'code'
  return 'unsupported'
}

/** 预览类型对应的图标名 (AppIcon) */
export function getFileIconName(kind: FilePreviewKind, isDirectory = false): string {
  if (isDirectory) return 'Folder'

  switch (kind) {
    case 'image':
      return 'Image'
    case 'audio':
      return 'Waveform'
    case 'json':
    case 'jsonl':
      return 'Database'
    case 'code':
      return 'Code'
    case 'text':
      return 'FileText'
    default:
      return 'FileText'
  }
}

/** 代码预览语言标识 (映射真源: utils/codeFormat.ts) */
export function getCodeLanguage(fileName: string): string {
  return languageFromName(fileName)
}
