/**
 * T29 事件域 —— `/events/stream` 路由 handler 工厂（装配 http 骨架，不改 http/）。
 *
 * 鉴权由 Router 统一前置（无未鉴权路径）；本 handler 只做：解析 Last-Event-ID →
 * 注册订阅 → 挂在 res 'close' 上退订。handler 抛错时 Router 对已发头的 SSE 只能
 * destroy 断流——所以订阅者生命周期完全由 hub 的 close 通路自管，不留悬挂。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventHub } from "./hub.js";
import { parseLastEventId } from "./hub.js";
import type { LoomHandler } from "../http/types.js";

/**
 * 创建 SSE 订阅 handler。`resolveHub` 按会话 id 取 hub（T27/T31 的会话注册表负责
 * 建 hub；路由本身不猜有哪些会话）。取不到 → 抛错由 Router 映射 500/404 JSON
 * （headers 未发出，错误体照常）。
 */
export function sseStreamHandler(resolveHub: (sessionId: string | undefined) => EventHub): LoomHandler {
  return (req: IncomingMessage, res: ServerResponse, ctx): void => {
    const hub = resolveHub(ctx.params["sessionId"] ?? ctx.url.searchParams.get("sessionId") ?? undefined);
    const carried = req.headers["last-event-id"];
    const lastEventId = parseLastEventId(typeof carried === "string" ? carried : undefined);
    const unsubscribe = hub.subscribe(res, lastEventId);
    // 'close' 同时覆盖正常结束与客户端断开；unsubscribe 幂等，双保险不冲突。
    res.on("close", unsubscribe);
  };
}
