/**
 * T29 事件域 —— vendor 内核事件名 → loom 事件名的映射表 + 共享形状 helper。
 *
 * 映射依据（唯一真源，勿在此之外另起事件名）：
 *   - docs/01 §10.3 事件域五族：消息增量 / 消息完成(三态收束) / 工具开始·结果 /
 *     会话状态(空闲·压缩) / 运行状态 / 投递通知 / 看门狗告警。
 *   - docs/04 §3.1 切换日映射表：「前端现名」列 = 开发期 loom 直接采用的名字；
 *     切换日只在前端侧改名，形状由本模块 + project.ts 锁死。
 *   - docs/02 前端消费审计硬契约：信封 `{payload:{type,properties}}`、每条事件带
 *     `sessionID`、`session.idle` 必带 id、`part.id`、`field==='text'`、
 *     `info.tokens.{total,input,output,reasoning,cache.read,cache.write}`、
 *     `children[].id`、id 字符集 `[a-zA-Z0-9_]`（禁连字符）。
 */

import { isFlowState, type FlowState, type Usage } from "@axeuh/loom-core";
import { LOOM_ID_RE, sanitizeId } from "./types.js";
import type { ChildInfo, LoomEventName } from "./types.js";

/**
 * `null` = **本版有意不发帧**（缺口登记见下 TODO）；未列入本表的事件类型视为未知，
 * 容忍丢弃（unknown-event tolerance，与前端"只读它认识的"对称）。
 *
 * TODO(T38)：以下缺口定形后把 null 换成实际名并删对应条目注释：
 *   1. `toolcall_delta` —— 工具入参增量无前端消费者。
   *   2. `message_start` —— 不发帧，但 W32 起投影层在此推进会话级单调消息序号
   *      （身份 tick，见 project.ts）；帧身份仍由 delta 占位 / message_end 快照确立。
 *   3. `message_update` —— 中间快照是否下发由 T38 权衡（流量 vs 断流重绘）。
 *   4. `continuation-check` —— 收束推进细节，无 UI 消费者。
 *   5. `session.children` —— 事件名自定（子面板数据源 T31 切 /runs+trace 后此帧
 *      可能降级为冗余通道，名字与保留与否待 T38）。
 *   6. 运行状态 / 投递通知 / 看门狗告警三族无 kernel 源事件，由 T28/T15/T13 经
 *      `EventHub.publish()` 注入；事件名与 properties 形状待 T38 定稿。
 *
 * W13 已落地：`thinking_delta` 不占本表单帧位（保持 null）——它是**双帧通道**
 * （reasoning 流），帧名真源见下方 REASONING_STREAM_EVENTS；展开逻辑在
 * project.ts 的 projectEnvelope（注册一次 + 逐增量），与「一事件一名」的单表语义
 * 不同故不入表。
 */
export const VENDOR_TO_LOOM_EVENT: Readonly<Record<string, LoomEventName | null>> = {
  // ── LiveEvent（live 轨：回合进行中的细粒度 delta）──
  message_start: null, // 不发帧；W32：投影层于此单调推进 messageSeq（身份 tick，project.ts）
  text_delta: "message.part.delta",
  thinking_delta: null, // W13 reasoning 流双帧通道，见 REASONING_STREAM_EVENTS（不入单表）
  toolcall_delta: null,
  message_update: null,
  message_end: "message.part.updated",
  // ── SessionEvent（recorded 轨：粗粒度生命周期）──
  "session-start": "session.status",
  "turn-start": "session.status",
  "turn-end": null, // 回合尾帧与 message.updated 信息重复（stopReason 已在 info 里）
  "llm-end": "message.updated",
  "tool-end": "message.part.updated",
  "continuation-check": null,
  "session-end": "session.idle",
  error: "session.error",
};

/** kernel 事件名 → loom 事件名；`null`/未列 = 不发该帧。 */
export function loomNameOf(kernelName: string): LoomEventName | null {
  return VENDOR_TO_LOOM_EVENT[kernelName] ?? null;
}

/**
 * W13 reasoning 流（`thinking_delta`）双帧通道的事件名收口点（映射表外唯一名字来源）。
 *
 * 形状真源 = mybot-web/docs/EVENT_API_DOC.md §3：
 *   - 注册帧 `message.part.updated`：文档 Part Types 明列 `reasoning`；样例 part 形状
 *     `{id, sessionID, messageID, type}`（无 text）——首块发一次，前端据此把后续同
 *     partID 的增量渲染成思考块而非正文（mybot-web 对无 type 的 part 会退化为正文）。
 *   - 增量帧 `message.part.delta`：文档原文 "Streaming text content (reasoning or
 *     output)"，field="text" + delta——增量式下发，避免 part.updated 快照语义下
 *     每个 delta 重发累计全文的 O(n²) 流量。
 *   - 终态帧 `message.part.updated`（带 text，由 llm-end 快照产出）：断流重绘/回看兜底。
 *
 * 内核 live 事件带 contentIndex（块序号）不带块 id——part id 由投影层按
 * `part_${messageSeq}_reasoning_${contentIndex}` 生成（与 text/tool part 同坐标系）。
 */
export const REASONING_STREAM_EVENTS = {
  /** 首块注册（part.type='reasoning' 定型，一块一次）。 */
  register: "message.part.updated",
  /** 增量帧（field='text'，与 text_delta 同族）。 */
  delta: "message.part.delta",
} as const satisfies Readonly<Record<"register" | "delta", LoomEventName>>;

/** 三态收束投影（D25/D30；主会话 {已完成,待用户回应,需用户确认}，副会话 {done,partial,failed}）。 */
export interface ConvergenceDraft {
  readonly status: string;
  readonly converged: boolean;
  readonly blockers?: string;
}

/** flow_commit 的 idle 投影（只带控制值；拒收结果 committed:false 不产生草稿）。 */
export interface FlowDraft {
  readonly subject_id: string;
  readonly subject_name: string;
  readonly state: FlowState;
  readonly next_decision_at: number | null;
}

/** 判别：unknown details 是否为已受理的 `__flow` 提交投影（parse-don't-validate）。 */
export function readFlow(details: unknown): FlowDraft | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["__flow"];
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (f["committed"] === false) return null;
  const subjectId = f["subject_id"];
  const subjectName = f["subject_name"];
  const state = f["state"];
  const next = f["next_decision_at"];
  if (typeof subjectId !== "string" || typeof subjectName !== "string") return null;
  if (!isFlowState(state)) return null;
  if (next !== null && typeof next !== "number") return null;
  return {
    subject_id: subjectId,
    subject_name: subjectName,
    state,
    next_decision_at: next,
  };
}

/** token 用量：形状锁死 `info.tokens.{total,input,output,reasoning,cache.read,cache.write}`。 */
export function tokensFromUsage(usage: Usage): Record<string, unknown> {
  // reasoning 段：内核 Usage 类型无该字段（TODO(T38) 模型侧透出后替换实值），先如实给 0。
  return {
    total: usage.totalTokens,
    input: usage.input,
    output: usage.output,
    reasoning: 0,
    cache: { read: usage.cacheRead, write: usage.cacheWrite },
  };
}

/** `<task_metadata>` 字面块反解（T11 契约；core 渲染器未从 barrel 导出，此处做最小解析）。 */
const TASK_METADATA_RE = /<task_metadata>([\s\S]*?)<\/task_metadata>/;
const META_LINE_RE = /^([a-z_]+):\s*(.*)$/;

/**
 * 从工具结果文本反解 `<task_metadata>` → children[]（前端 `children[].id` 契约）。
 * 无块 / 脏 id（含连字符）→ null：脏 id 绝不外泄进帧。
 */
export function childrenFromText(text: string): ChildInfo[] | null {
  const body = TASK_METADATA_RE.exec(text)?.[1];
  if (body === undefined) return null;
  let sessionId = "";
  let agentType = "unknown";
  let reason = "";
  for (const line of body.split("\n")) {
    const kv = META_LINE_RE.exec(line.trim());
    if (kv === null) continue;
    const key = kv[1] ?? "";
    const value = kv[2] ?? "";
    if (key === "session_id") sessionId = value;
    else if (key === "agent_type") agentType = value;
    else if (key === "reason") reason = value;
  }
  const id = sanitizeId(sessionId);
  if (!LOOM_ID_RE.test(id)) return null;
  return [{ id, name: agentType, type: agentType, status: reason }];
}

/** id 是否非空且无连字符（D31/D34 永久禁连字符；前端子面板按此反解）。 */
export function isCleanId(raw: string): boolean {
  return raw.length > 0 && !raw.includes("-");
}

/**
 * 判别：unknown details 是否为含 `__convergence` 的收束回执（parse-don't-validate，
 * 出了这个函数就是类型化值）。结构不符一律 null（收束工具之外的 tool 都走这里）。
 */
export function readConvergence(details: unknown): ConvergenceDraft | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["__convergence"];
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (c["converged"] !== true) return null;
  const receipt = c["receipt"];
  const rec = typeof receipt === "object" && receipt !== null ? (receipt as Record<string, unknown>) : {};
  const status = typeof rec["status"] === "string" ? rec["status"] : "需用户确认";
  const blockers = typeof rec["blockers"] === "string" ? rec["blockers"] : undefined;
  return { status, converged: true, ...(blockers !== undefined ? { blockers } : {}) };
}
