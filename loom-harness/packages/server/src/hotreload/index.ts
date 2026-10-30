// T20 包内出口聚合（hotreload 四件套对外表面）。
export type {
  ApplyResult,
  AuditSink,
  ConfigAppliedEvent,
  FailureStage,
} from "./types.js";
export {
  ConfigNotLoadedError,
  HotConfigStore,
  checkReferences,
  type HotConfigStoreOptions,
  type WatchOptions,
} from "./store.js";
export { createFileAuditSink } from "./audit.js";
