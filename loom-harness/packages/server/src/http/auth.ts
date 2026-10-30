// T26：token 鉴权（无未鉴权路径）。
// 接受两种头：`Authorization: Bearer <t>` 或 `X-Loom-Token: <t>`；token 列表由构造方注入。
// 设计取舍：
// - 用 constant-time 比较防 token 时序侧信道（列表规模小，逐个 timingSafeEqual 足够）。
// - health 端点同样要求 token（前端可带 token；留此注释说明，见 docs/05）。
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.js";

export class TokenAuth {
  readonly #tokens: readonly string[];

  constructor(tokens: readonly string[]) {
    // 空列表 = 拒绝一切；启动时由调用方保证配置了 token。
    this.#tokens = tokens;
  }

  /** 提取请求携带的 token 原文；无头或格式非法返回 null（不抛，交由 authenticate 统一 401）。 */
  extractToken(req: IncomingMessage): string | null {
    const bearer = req.headers.authorization;
    if (typeof bearer === "string" && bearer.length > 0) {
      const match = /^Bearer[ ]+(.+)$/i.exec(bearer);
      const carried = match?.[1]?.trim();
      if (carried !== undefined && carried.length > 0) return carried;
    }
    const custom = req.headers["x-loom-token"];
    if (typeof custom === "string" && custom.trim().length > 0) return custom.trim();
    return null;
  }

  /**
   * 鉴权并返回 token 原文；失败抛 HttpError.unauthorized。
   * 注意：不区分「没带头」与「头不对」——对外同一 401，避免探测。
   */
  authenticate(req: IncomingMessage): string {
    const token = this.extractToken(req);
    if (token === null) throw HttpError.unauthorized("missing token header");
    // 先对候选做 sha256 摘要再定长比较：长度不等也不泄漏，且 timingSafeEqual 不会因长度不同抛错。
    const presented = sha256(token);
    for (const known of this.#tokens) {
      if (timingSafeEqual(presented, sha256(known))) return token;
    }
    throw HttpError.unauthorized("invalid token");
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
