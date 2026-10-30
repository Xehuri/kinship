// T26：SSE writer helper。前端硬约束：帧只写 `data:` 行 + 空行，绝不写 `event:` 字段
// （缺省即 message 事件，EventSource.onmessage 才可收；写了 event: 行 onmessage 就失效）。
import type { ServerResponse } from "node:http";

/** 打开一条 SSE 流：设头并 flush 首块，让客户端 EventSource 立即进入 open 状态。 */
export function startSseStream(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 禁用 nginx 缓冲，事件实时透传
  });
  res.flushHeaders();
}

/**
 * 写一帧 SSE：`data:<json>\n\n`，使用默认 message 事件。
 * JSON.stringify 输出的字符串不含裸换行（控制字符全部转义），因此单行 data 帧安全。
 * write 失败（连接断开）原样上抛，由调用方（如 T29 扇出枢纽）做订阅者隔离。
 */
export function writeSseFrame(res: ServerResponse, obj: unknown): void {
  res.write(`data:${JSON.stringify(obj)}\n\n`);
}

/** 心跳注释帧（`: keepalive\n\n`），防止代理空闲断连；注释行不影响前端解析。 */
export function writeSseKeepalive(res: ServerResponse): void {
  res.write(": keepalive\n\n");
}
