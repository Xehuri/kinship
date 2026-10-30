// T26：HTTP 骨架共享类型（裸 node:http 方案 A，见 docs/05-http-framework-decision.md）
import type { IncomingMessage, ServerResponse } from "node:http";

/** 支持的路由方法（字面量联合，新增方法时编译器会强制检查全部匹配点）。 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * 传给 handler 的上下文。
 * - token：已通过鉴权的 token 原文（每条路由必有，来自 Authorization: Bearer 或 X-Loom-Token）
 * - params：路径 :param 捕获（无参数时为空对象）
 * - url：解析后的请求 URL（path/query 都从这里取；searchParams 可直接用）
 */
export interface HandlerCtx {
  readonly token: string;
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
}

/** 路由 handler 签名：(req, res, ctx)。允许 async；异常由 Router 统一兜底成 500 JSON。 */
export type LoomHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => void | Promise<void>;
