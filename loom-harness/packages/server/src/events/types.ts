/**
 * T29 事件域 —— 前端硬契约类型（docs/02 前端消费审计 + docs/04 §3.1 映射表）。
 *
 * 契约形状（换名可以、形状不能变）：
 *   - 帧 = 默认 message 事件（无 `event:` 行，由 http/sse.writeSseFrame 保证）；
 *   - 信封 = `{ seq, payload: { type, properties } }`，`properties` **必存在**（缺则前端丢弃）；
 *   - `properties.sessionID` 每条事件必带（前端 resolveSessionId 读 sessionID/session_id）；
 *   - id 字符集 `[a-zA-Z0-9_]`，连字符永久禁用（D31/D34）——发出前统一 sanitize。
 */

/** 连字符→下划线：id 边界归一（幂等；无连字符输入原样通过）。 */
export function sanitizeId(raw: string): string {
  return raw.replace(/-/g, "_");
}

/** 前端 id 白名单（验收断言用：所有发出的 id 字段都必须匹配）。 */
export const LOOM_ID_RE = /^[a-zA-Z0-9_]+$/;

/** 帧内 `event:` 字段行探测（正则多行锚定；验收要求恒为 false）。 */
export const SSE_EVENT_LINE_RE = /^event:/m;

/**
 * loom 事件域名（docs/01 §10.3 五族）。会话/消息族直接采用前端现名（docs/04 §3.1
 * 映射表「前端现名」列）：开发期按名发帧，切换日只在前端侧改名，形状已锁死。
 *
 * W11a 补齐波新增四名（逐字对齐 mybot-web/docs/EVENT_API_DOC.md）：
 * server.connected / server.heartbeat（文档 §1）、session.created（文档 §2）、
 * file.edited（文档 §File Events）。均为域层 publish 注入族，无 kernel 源事件。
 *
 * W11b 补一名：todo.updated（文档 §4 Todo Events，L293-308）。文档 JSON 样例只画
 * sessionID 一键，但前端消费真源（mybot-web sse.js handleTodoUpdated）要求
 * properties.todos 数组在场才更新面板——本波按「前端消费形状」倒推，properties =
 * { sessionID, todos }（sessionID 由 eventPayload 恒注入，todos 为整表替换后的全量清单）。
 *
 * W17-F 补一名：context.notice（域注入族，无 kernel 源事件）。registry 准入嗅探
 * （W16-A/D 每会话水位）检出非空 notices 即发帧：properties = { notices: [{action:
 * "set"|"replace"|"remove", relPath, bytes}], turnIdx, sessionID }。载荷纪律：帧只带
 * 路径与字节数，**绝不携文件正文**（内容真源在转录 prelude / wire 发线面）。
 *
 * W53 补一名：session.queue（待发队列快照）。properties = { pending: [{ text, at,
 * state: "queued"|"running"|"drained" }], sessionID }，由 registry 在队列变化时发布。
 */
export type LoomEventName =
  | "message.part.delta"
  | "message.part.updated"
  | "message.updated"
  | "session.idle"
  | "session.status"
  | "session.error"
  | "session.children"
  | "session.created"
  | "file.edited"
  | "server.connected"
  | "server.heartbeat"
  | "run.status"
  | "delivery.notify"
  | "watchdog.alarm"
  | "todo.updated"
  | "context.notice"
  | "session.queue"
  | "session.compacted"
  | "session.compaction.started"
  | "session.compaction.chunk"
  | "session.compaction.retry"
  | "session.compaction.aborted"
  | "session.compaction_failed";

/** 事件属性袋：sessionID 恒在，其余按事件族可选；未知键容忍（前端只读它认识的）。 */
export type EventProperties = { readonly sessionID: string } & {
  readonly [key: string]: unknown;
};

/** 一帧 payload = 类型 + 属性袋（properties 永不省略——前端无 properties 即丢弃）。 */
export interface EventPayload {
  readonly type: string;
  readonly properties: EventProperties;
}

/** 落到 SSE `data:` 行的完整帧对象。seq 为订阅者流内单调序号。 */
export interface LoomFrame {
  readonly seq: number;
  readonly payload: EventPayload;
}

/** 子智能体条目（children[].id 前端契约；useSubAgents 反解 `<task_metadata>`）。 */
export interface ChildInfo {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly status?: string;
}

/**
 * 组装事件 payload：extra 在前、sessionID 归一在后（sessionID 不可被 extra 覆盖成脏值）。
 * `properties` 恒存在（至少含 sessionID）——信封契约的构造点唯一收口在这里。
 */
export function eventPayload(
  type: string,
  sessionID: string,
  extra: Readonly<Record<string, unknown>> = {},
): EventPayload {
  return { type, properties: { ...extra, sessionID: sanitizeId(sessionID) } };
}
