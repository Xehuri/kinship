/**
 * 会话列表归一化
 *
 * 从 useChat 拆出的会话列表处理:
 *   - normalizeSessionList: 复用 api/session 的 normalizeSession 作为唯一归一化来源 (C8);
 *   - resolveCurrentSessionId: 决定当前会话 ID (后端 current_session 优先, 回退已有/首个)。
 */

import type { SessionInfo } from '@/types'
import { normalizeSession } from '@/api/session'

/**
 * 归一化会话列表 (C8)
 *
 * 后端可能返回 session_id 或 id, normalizeSession 统一映射为内部规范字段 id。
 */
export function normalizeSessionList(rawList: unknown[]): SessionInfo[] {
  return (rawList as unknown[]).map(normalizeSession)
}

/**
 * 决定当前会话 ID
 *
 * 优先使用后端返回的 current_session (仅当它确实存在于列表中),
 * 否则保留已有 ID, 已有 ID 为空时回退到列表首个会话。
 *
 * @param sessions 归一化后的会话列表 (非空)
 * @param currentSession 后端返回的 current_session
 * @param existingId 当前已有的会话 ID
 */
export function resolveCurrentSessionId(
  sessions: SessionInfo[],
  currentSession: string | undefined,
  existingId: string,
): string {
  if (currentSession && sessions.some((s) => s.id === currentSession || s.session_id === currentSession)) {
    return currentSession
  }
  if (!existingId && sessions.length > 0) {
    return sessions[0].id || sessions[0].session_id || ''
  }
  return existingId
}
