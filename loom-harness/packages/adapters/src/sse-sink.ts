/**
 * SSESink —— 把 EventPump 的 `TransportSink` 接到一条 SSE（Server-Sent Events）响应（T05 新增）。
 *
 * EventPump 是 sink 注入式、domain-free 的；本适配器把 envelope 写成 SSE 帧：
 *   `res.write("data:" + JSON.stringify(envelope) + "\n\n")`
 *
 * **前端硬约束：绝不写 `event:` 字段行**。SSE 规范里缺省 `event:` 即 `message` 事件，浏览端
 * `EventSource.onmessage` / `addEventListener("message")` 直接可收；一旦写了 `event: xxx`，
 * 标准 `onmessage` 就收不到了。所以这里只发 data 帧，语义固定为默认的 message 事件。
 *
 * **帧安全**：`JSON.stringify` 默认不会输出裸换行（控制字符全部转义为 \n 字面量），所以信封内容
 * 天然不会破坏 `data:` 单行帧 + 空行分隔的 SSE framing。
 *
 * **失败分层**（与 vendor 的 WebSocketSink 同一哲学）：`res.write` 抛错（连接已断等）**原样向上抛**，
 * 交给 EventPump 的 `onError` 隔离——sink 自身不 try/catch，避免双重兜底；失败的 envelope 已占 seq，
 * 消费端凭跳号检测丢失。
 *
 * 零依赖：对 res 只做最小结构化要求 `{ write(chunk: string): void }`——node:http 的 ServerResponse
 * 与测试里的假对象都天生满足（write 返回 boolean 也兼容 void 签名）。
 */

import type { TransportEnvelope, TransportSink } from "./event-pump.js";

/** SSE 目标的最小结构；node:http `ServerResponse` 直接满足。 */
export interface SSEResponseLike {
  write(chunk: string): void;
}

export class SSESink implements TransportSink {
  constructor(private readonly res: SSEResponseLike) {}

  send(envelope: TransportEnvelope): void {
    // data 帧、无 event: 行（前端约束：缺省即 message 事件）；write 抛错原样上抛 → EventPump.onError。
    this.res.write("data:" + JSON.stringify(envelope) + "\n\n");
  }
}
