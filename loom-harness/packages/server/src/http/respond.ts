// T26：JSON 响应 helper。所有 HTTP 层出口统一走这里，保证错误体形状一致。
import type { ServerResponse } from "node:http";

/** 发送 JSON 响应（Content-Type: application/json; charset=utf-8）。调用方负责不要再写 body。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** 标准错误体：{ error: { code, message } }。401/404/405/413 等全部用它。 */
export function sendErrorJson(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}
