/**
 * `<task_metadata>` 契约（T11 / docs/04 §3.2）—— 前端子智能体面板**反解**依赖的字面块。
 *
 * 回灌进主会话的工具结果文本尾部追加此块，让前端从 toolResult 文本里解析出
 * 子 session id（`children[].id`）。id 必须匹配 `[a-zA-Z0-9_]`（禁连字符），
 * 生成侧由 `./ids.js` 保证；本文件只做渲染 + 类型化解析，不做展示逻辑。
 *
 * 形状（key 每行一个，前端按行解析）：
 *   <task_metadata>
 *   agent_type: general
 *   session_id: ses_0a1b2c3d4e5f6789
 *   reason: done
 *   turns: 1
 *   depth: 1
 *   </task_metadata>
 */

import type { Usage } from "../index.js";

/** 字面开/闭标签——导出给测试与 T38 前端契约表复用，绝不各处手拼字符串。 */
export const TASK_METADATA_OPEN = "<task_metadata>";
export const TASK_METADATA_CLOSE = "</task_metadata>";

/** 元数据块字段（渲染输入；全部由子终态/派发上下文推出，无业务概念）。 */
export interface TaskMetadataFields {
  /** 路由到的 agent 类型名。 */
  readonly agentType: string;
  /** 子 session id（无连字符，`./ids.js` 生成）。 */
  readonly sessionId: string;
  /** 子 RunSummary 终态判别（done/aborted/error/max_turns/max_continuations）。 */
  readonly reason: string;
  /** 子跑过的 turn 数。 */
  readonly turns: number;
  /** 子的递归深度（父 +1）。 */
  readonly depth: number;
  /**
   * W49.2 人读标题（派发显式或 derived，单行——task-tool 入口已折叠空白）。
   * **缺省=键缺席，块形状逐字节旧 5 键形**：既有消费者按精确 5 行正则反解，
   * 附加行只允许在显式给定时出现。
   */
  readonly title?: string;
}

/** 渲染整块（不含前导文本；调用方负责与子正文以换行拼接）。 */
export function renderTaskMetadata(f: TaskMetadataFields): string {
  return [
    TASK_METADATA_OPEN,
    // W49.2 additive：title 行置块首（agent_type 前），行式解析器按键名宽容跳过；缺省整段缺席。
    ...(f.title === undefined ? [] : [`title: ${f.title}`]),
    `agent_type: ${f.agentType}`,
    `session_id: ${f.sessionId}`,
    `reason: ${f.reason}`,
    `turns: ${f.turns}`,
    `depth: ${f.depth}`,
    TASK_METADATA_CLOSE,
  ].join("\n");
}

const BLOCK_RE = /<task_metadata>([\s\S]*?)<\/task_metadata>/;

/** 从任意文本里解析 `<task_metadata>` 块；无块返回 null（前端同款反解通路，供测试/契约断言复用）。 */
export function parseTaskMetadata(text: string): Partial<TaskMetadataFields> | null {
  const m = BLOCK_RE.exec(text);
  if (m === null) return null;
  const out: Record<string, string | number> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv === null) continue;
    const key = kv[1] ?? "";
    const value = kv[2] ?? "";
    if (key === "turns") {
      const n = Number(value);
      out.turns = Number.isFinite(n) ? n : value;
    } else if (key === "depth") {
      const n = Number(value);
      out.depth = Number.isFinite(n) ? n : value;
    } else {
      out[key] = value;
    }
  }
  // 物理键 → 类型化字段（parse-don't-validate：出了边界就是类型化的值）。
  const sessionId = out.session_id;
  const agentType = out.agent_type;
  const reason = out.reason;
  return {
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(typeof agentType === "string" ? { agentType } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof out.turns === "number" ? { turns: out.turns } : {}),
    ...(typeof out.depth === "number" ? { depth: out.depth } : {}),
  };
}

/**
 * vendored `subAgentTool` 结果 details 的类型化提取（`details` 是 `unknown`——边界处 parse，
 * 内部不重复校验）。形状 = sub-agent-tool.ts `subAgentResult` 写入的
 * `{subAgent:{sessionId, reason, turns, usage, stopReason?}}`。
 * 形状不符（非本管线产的结果）返回 null，调用方据此跳过元数据追加。
 */
export interface SubAgentResultInfo {
  readonly sessionId: string;
  readonly reason: string;
  readonly turns: number;
  /** 子 RunSummary 累计 usage（内核总是填充；缺失 = 非本管线产物 → 字段缺省）。 */
  readonly usage?: Usage;
}

export function extractSubAgentResultInfo(details: unknown): SubAgentResultInfo | null {
  if (typeof details !== "object" || details === null) return null;
  const sub = (details as { subAgent?: unknown }).subAgent;
  if (typeof sub !== "object" || sub === null) return null;
  const s = sub as { sessionId?: unknown; reason?: unknown; turns?: unknown; usage?: unknown };
  if (typeof s.sessionId !== "string") return null;
  if (typeof s.reason !== "string") return null;
  if (typeof s.turns !== "number") return null;
  // usage 由内核 RunSummary 保证是对象（含 cost 嵌套）；非对象 = 形状不符 → 缺省该字段。
  const usage = s.usage;
  return {
    sessionId: s.sessionId,
    reason: s.reason,
    turns: s.turns,
    ...(typeof usage === "object" && usage !== null ? { usage: usage as Usage } : {}),
  };
}
