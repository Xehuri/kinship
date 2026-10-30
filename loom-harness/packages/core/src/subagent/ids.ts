/**
 * 子智能体 session id 生成（T11 / D34）—— 前端「无连字符」硬契约。
 *
 * 内核 `AgentSession` 缺省 id 走 `randomUUID()`（**含连字符**），直接透传给前端会破坏
 * `children[].id` / `<task_metadata>` 反解（docs/04 §3.2：id 字符集 `[a-zA-Z0-9_]`，
 * 连字符永久禁用，避免未来解析分支）。故 spawn 子 session 时**总是**用本函数造 id
 * 覆盖 `sessionId`，父侧续聊按此 id 寻址。
 *
 * 形状采用 docs/02「Open Questions 2」裁决：`[a-z][a-z0-9_]{2,4}_<hex16>`，
 * 子智能体统一前缀 `ses` → `ses_<hex16>`。
 */

import { randomBytes } from "node:crypto";

/** 前端反解兼容的 id 白名单正则（与 docs/02 裁决一致：字母数字下划线，禁连字符）。 */
export const SUBAGENT_ID_RE = /^[a-z][a-z0-9_]{2,4}_[0-9a-f]{16}$/;

/**
 * 造一个子智能体 session id：`ses_` + 8 字节 hex（16 字符）。
 * 纯 hex 后缀保证 `[a-zA-Z0-9_]` 字符集 + 不含连字符 + 大小写不敏感（全小写）。
 */
export function newSubagentSessionId(): string {
  return `ses_${randomBytes(8).toString("hex")}`;
}
