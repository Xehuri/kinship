// script-host 对外桶导出（T28 消费此接口；T04 worker 在动 tools 根 index.ts，
// 本桶不从根 re-export，避免冲突）。

export { ScriptHost, computeBackoff } from "./host.js";
export type {
  BackoffConfig,
  EventListener,
  HostEvent,
  HostLogEntry,
  HostLogger,
  LogLevel,
  ScriptHostOptions,
} from "./types.js";
export type { Lang, ScriptMeta } from "./frontmatter.js";
export { parseFrontmatter } from "./frontmatter.js";
export { parseEventLine } from "./protocol.js";
export type { ParsedLine, ScriptEvent } from "./protocol.js";
