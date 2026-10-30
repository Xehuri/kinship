/**
 * 文件浏览 API
 *
 * 对应:
 *   - /api/mobile/files?scope=root&path=... — 目录列表
 *   - /api/mobile/files/content?scope=root&path=... — 文件内容
 *   - /api/mobile/files/raw?scope=root&path=... — 原始文件 (图片/音频)
 *
 * 后端返回的条目使用 mtime, 前端统一归一化为 FileEntry.modified_at。
 */

import { apiGet, apiGetVerbose, type VerboseResponse } from '@/api/client'
import { fetchWsTicket } from '@/api/ticket'
import type {
  FileContentJsonResponse,
  FileEntry,
  FileTreeResponse,
  RawFileEntry,
  RawFileTreeResponse,
} from '@/types/files'

/**
 * 将后端原始条目归一化为前端 FileEntry。
 *
 * - mtime -> modified_at (后端契约固定为 mtime)
 * - 后端细分类型 (json/md/wav/...) 统一折叠为 file
 */
export function normalizeFileEntry(raw: RawFileEntry): FileEntry {
  return {
    name: raw.name,
    type: raw.type === 'dir' ? 'dir' : 'file',
    size: typeof raw.size === 'number' ? raw.size : undefined,
    modified_at: raw.modified_at ?? raw.mtime,
  }
}

function isRawFileEntry(value: unknown): value is RawFileEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof (value as { name: unknown }).name === 'string'
  )
}

/**
 * 获取目录列表
 * GET /api/mobile/files?scope={scope}&path={path}
 */
export async function fetchDirectory(
  path: string,
  scope: string = 'root',
): Promise<FileTreeResponse | null> {
  const result = await apiGet<RawFileTreeResponse>(
    `/api/mobile/files?scope=${scope}&path=` + encodeURIComponent(path),
  )
  if (result === null) return null

  const rawEntries = Array.isArray(result.entries) ? result.entries : []
  return {
    entries: rawEntries.filter(isRawFileEntry).map(normalizeFileEntry),
  }
}

/**
 * 获取文件文本/JSON 内容
 * GET /api/mobile/files/content?scope={scope}&path={path}
 *
 * @param path - 文件路径（相对于 scope 根目录）
 * @param scope - 作用域: "root"(ai/) 或 "data"(ai/data/)，默认 "root"
 */
export async function fetchFileContent(
  path: string,
  scope: string = 'root',
): Promise<FileContentJsonResponse | string | null> {
  return apiGet<FileContentJsonResponse | string>(
    `/api/mobile/files/content?scope=${scope}&path=` + encodeURIComponent(path),
  )
}

/**
 * 获取文件内容 (详细版, 保留 HTTP 状态供预览区分 401/403/404/5xx)
 */
export async function fetchFileContentVerbose(
  path: string,
  scope: string = 'root',
): Promise<VerboseResponse<FileContentJsonResponse | string>> {
  return apiGetVerbose<FileContentJsonResponse | string>(
    `/api/mobile/files/content?scope=${scope}&path=` + encodeURIComponent(path),
  )
}

/**
 * 获取原始文件 URL (用于 <img>/<audio>/<a download> src)
 *
 * 安全整改 (FE-H2):
 *   <img>/<audio>/<a download> 无法携带 Authorization header, 故先带 Bearer 头
 *   换取一次性 ticket, 再以 `?ticket=` 附加到下载/预览 URL。
 *   ticket 用后即焚且 30s 过期, 因此每次调用都重新获取, 不得缓存。
 *
 * 降级: 票据获取失败时返回不带任何凭证的基础 URL 并打印日志,
 *       绝不回退到把长期 token 拼进 URL。
 */
export async function getFileRawUrl(
  path: string,
  scope: string = 'root',
): Promise<string> {
  const base =
    `/api/mobile/files/raw?scope=${scope}&path=` + encodeURIComponent(path)
  const ticket = await fetchWsTicket()
  if (!ticket) {
    console.warn('[files] 无法获取下载票据, 使用无凭证 URL (将可能被拒绝)')
    return base
  }
  return base + `&ticket=${encodeURIComponent(ticket)}`
}
