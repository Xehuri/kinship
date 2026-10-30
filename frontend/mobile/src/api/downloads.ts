/**
 * 客户端下载模块 (PC 采集端)
 *
 * 背景:
 *   浏览器的 <a download> 无法携带 Authorization 头, 因此下载链接不能直接用 API token。
 *   与 SSE/WS/音频流一致, 改用一次性连接票据:
 *     1. POST /auth/ws-ticket 取票 (随机, 30 秒过期, 用后即焚)
 *     2. GET /api/pc-sensor/download?ticket=xxx
 *   后端中间件 QUERY_CREDENTIAL_PATH_PREFIXES 白名单接受该路径的 ?ticket= 凭证,
 *   但仍要求认证 (不在 PUBLIC_PATHS 中)。
 *
 * 约束:
 *   - 严禁长期缓存 ticket (一次性, 且 30s 过期)。
 *   - 文件路径与存在性由后端判定, 前端只负责展示与触发下载。
 */

import { apiGet } from '@/api/client'
import { fetchWsTicket } from '@/api/ticket'

/** PC 采集端文件信息 (GET /api/pc-sensor/info) */
export interface PcSensorInfo {
  /** 服务端是否已构建该文件 */
  exists: boolean
  /** 下载文件名 */
  filename: string
  /** 文件字节数 (不存在时 0) */
  size: number
  /** 人类可读大小 (如 "33.9 MB"; 不存在时为空串) */
  size_text: string
  /** 修改时间 (Unix 秒; 不存在时 0) */
  mtime: number
  /** 文件 SHA-256 (不存在时为 null) */
  sha256: string | null
}

/**
 * 查询 PC 采集端文件信息
 * @returns 文件信息; 请求失败时返回 null (已打印日志, 不抛异常)
 */
export async function fetchPcSensorInfo(): Promise<PcSensorInfo | null> {
  try {
    return await apiGet<PcSensorInfo>('/api/pc-sensor/info')
  } catch (e) {
    console.warn('[downloads] 查询 PC 采集端信息失败:', e)
    return null
  }
}

/**
 * 触发 PC 采集端下载 (经一次性票据)
 *
 * 通过临时 <a download> 触发浏览器原生下载, 不跳转当前页面。
 * @returns 是否成功发起下载 (取票失败时返回 false)
 */
export async function downloadPcSensor(): Promise<boolean> {
  const ticket = await fetchWsTicket()
  if (!ticket) return false

  const link = document.createElement('a')
  link.href = `/api/pc-sensor/download?ticket=${encodeURIComponent(ticket)}`
  link.download = 'Kinship-PCSensor.exe'
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  return true
}
