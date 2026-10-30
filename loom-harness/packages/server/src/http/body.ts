// T26：JSON body reader。限 1MB、Content-Type 校验、超限 413、坏 JSON 400。
import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.js";

export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 完整读取请求体并解析为 JSON。
 * - 无 body（Content-Length 0 或缺头）返回 undefined，交给 handler 判空。
 * - Content-Length 声明即超限走快速 413；流式累计超限则停止消费并 413（不 destroy socket，保证 413 响应可达客户端）。
 * - Content-Type 若存在，必须以 application/json 开头（允许 charset 等参数）。
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string" && contentType.trim().length > 0) {
    if (!contentType.trim().toLowerCase().startsWith("application/json")) {
      throw HttpError.unsupportedMediaType(contentType);
    }
  }

  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw HttpError.payloadTooLarge(MAX_BODY_BYTES);
  }

  const chunks: Buffer[] = [];
  let received = 0;
  let overflow = false;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > MAX_BODY_BYTES) {
      overflow = true;
      break; // 停止消费；剩余字节留在内核缓冲，响应由 keep-alive 或连接关闭处理
    }
    chunks.push(buf);
  }
  if (overflow) {
    req.pause(); // 迭代器 break 后已自动移除异步消费，pause 防御后续 data 监听者
    throw HttpError.payloadTooLarge(MAX_BODY_BYTES);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw HttpError.badJson(err instanceof Error ? err.message : "parse failed");
  }
}
