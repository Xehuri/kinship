/**
 * 一次性连接票据 (ticket) 获取模块
 *
 * 背景 (安全整改 FE-H2):
 *   浏览器的 EventSource / WebSocket 以及 <img>/<audio>/<a download> 均无法携带
 *   Authorization 头, 过去只能把长期 token 拼进 URL query, 存在被日志、Referer、
 *   浏览器历史等泄露的风险。
 *
 *   后端新增 POST /auth/ws-ticket (需 Authorization: Bearer <token>),
 *   返回随机、一次性 (用后即焚)、30 秒过期的 ticket; 仅白名单路径接受
 *   `?ticket=` query 认证。因此每次建立 SSE/WS/下载连接都必须重新获取。
 *
 * 约束:
 *   - 严禁长期缓存 ticket (一次性, 且 30s 过期)。
 *   - 获取失败要优雅降级: 返回 null 并记录日志, 由调用方决定降级策略。
 */

import { apiPost } from '@/api/client';

/** /auth/ws-ticket 响应体 */
interface WsTicketResponse {
  /** 一次性票据 (随机 hex) */
  ticket: string;
  /** 有效期 (秒) */
  expires_in: number;
}

/**
 * 获取一次性连接票据
 *
 * POST /auth/ws-ticket, 复用 client 的 apiPost:
 *   - 自动注入 `Authorization: Bearer <token>`
 *   - 401 时自动触发 auth fail 回调 (弹出登录层)
 *
 * 票据为一次性, 调用方每次建立连接前都需重新调用, 不得缓存复用。
 *
 * @returns 票据字符串; 无 token / 请求失败 / 响应异常时返回 null (已打印日志)
 */
export async function fetchWsTicket(): Promise<string | null> {
  const data = await apiPost<WsTicketResponse>('/auth/ws-ticket', {});
  if (!data || typeof data.ticket !== 'string' || data.ticket.length === 0) {
    console.warn('[ticket] 获取连接票据失败或响应缺少 ticket 字段');
    return null;
  }
  return data.ticket;
}
