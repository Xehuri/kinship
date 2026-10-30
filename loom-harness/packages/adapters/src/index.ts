// @axeuh/loom-adapters —— vendor 自 harness-pi adapters（T05）。
// 范围：JsonlSessionStore + EventPump + 新增 SSESink。
// 不移植：web-socket-sink.ts / postgres-session-store.ts（不在计划内）。

// SessionStore 适配器：在内核 SessionStore 协议之上的 JSONL 落盘实现（docs/09 §4.5）。
export { JsonlSessionStore } from "./jsonl-session-store.js";

// Event Bus → transport 适配器（§4.6）。
export { EventPump } from "./event-pump.js";
export type {
  TransportEnvelope,
  TransportSink,
  EventPumpOptions,
} from "./event-pump.js";

// TransportSink → SSE 适配器（T05 新增）：只发 data 帧、绝不写 event: 行。
export { SSESink } from "./sse-sink.js";
export type { SSEResponseLike } from "./sse-sink.js";

// L0 状态层（T08）：JSONL journal / 期望账本 / 会话分片 + 目录索引 + 根路径注入。
export * from "./state/index.js";
