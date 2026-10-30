// T29 事件域 —— SSE 多订阅者扇出枢纽（D33 修正一）+ 前端硬契约信封。
// 消费者：T27（会话域接线）、T31（serve 装配）、T38（契约验收表）。
// 注意：本 barrel 故意**不**导出 http/、adapters、core 的任何东西（只 import 装配）。

export {
  EventHub,
  parseLastEventId,
  type DropReason,
  type EventHubOptions,
  type Unsubscribe,
} from "./hub.js";

export { sseStreamHandler } from "./route.js";

export {
  REASONING_STREAM_EVENTS,
  VENDOR_TO_LOOM_EVENT,
  childrenFromText,
  isCleanId,
  loomNameOf,
  readConvergence,
  readFlow,
  tokensFromUsage,
  type ConvergenceDraft,
  type FlowDraft,
} from "./mapping.js";

export {
  newProjectionState,
  projectEnvelope,
  projectEvent,
  projectReasoningStream,
  type FrameDraft,
  type ProjectionState,
} from "./project.js";

export { projectTraceRecord } from "./replay.js";

export {
  TOOL_OUTPUT_THROTTLE_MS,
  TOOL_OUTPUT_TAIL_CHARS,
  createToolOutputStream,
  currentToolExecSite,
  teeBashOperations,
  type ToolExecSite,
  type ToolOutputStream,
  type ToolOutputStreamOptions,
  type ToolOutputSink,
} from "./tool-stream.js";

export {
  LOOM_ID_RE,
  SSE_EVENT_LINE_RE,
  eventPayload,
  sanitizeId,
  type ChildInfo,
  type EventPayload,
  type EventProperties,
  type LoomEventName,
  type LoomFrame,
} from "./types.js";
