// T27 会话域 API 出口（发送/语音中止再发/历史游标分页/中止/状态）。
// 消费者：T31 serve 装配（registerSessionRoutes + SessionRegistry）、T38 契约验收。
export { SessionRegistry } from "./registry.js";
export { registerSessionRoutes } from "./routes.js";
export {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  decodeCursor,
  encodeCursor,
  normalizeLimit,
  readHistoryPage,
  type HistoryPage,
  type HistoryQuery,
} from "./history.js";
export type {
  ContextProvider,
  SendMessageBody,
  SendOutcome,
  SessionApiDeps,
  SessionRecord,
  SessionRegistryOptions,
  SessionStatus,
  SessionStatusView,
  SessionView,
} from "./types.js";
export {
  TOKEN_ESTIMATE_DIVISOR,
  buildContextView,
  buildTraceContextView,
  estimateTokens,
  type ContextRow,
  type ContextView,
} from "./context.js";
export {
  buildContextFull,
  CONTEXT_FULL_NOTE,
  type ContextFullMessage,
  type ContextFullSegment,
  type ContextFullView,
} from "./context-full.js";
export {
  buildContextFullV2,
  CONTEXT_FULL_V2_NOTE,
  type ContextFullV2Input,
  type ContextFullV2View,
} from "./context-full-v2.js";
export {
  PROVIDER_PAYLOAD_ABSENT_REASON,
  buildWireView,
  redactSecrets,
  type WireMessageView,
  type WireRequestView,
  type WireToolView,
  type WireView,
} from "./wire-view.js";
export {
  assembleContextManifest,
  maskApiKey,
  type ContextManifest,
  type ContextManifestAssemblyInput,
  type ManifestAgentRoleFile,
  type ManifestMcpServer,
  type ManifestMemoryFile,
  type ManifestModel,
  type ManifestSkillFile,
} from "./context-manifest.js";
