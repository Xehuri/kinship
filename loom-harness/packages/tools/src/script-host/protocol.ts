// 挂载脚本事件协议（D17/D18：语言中立子进程，stdout 逐行 JSON）。
//
// 约定：脚本每向 stdout 打印一行，该行必须是一个 JSON 对象，其 "type" 字段取值
// fact / deliver / dispatch / heartbeat（可选报活）。"exec" 是**保留类型**：
// 本模块只负责把它识别为 reserved，宿主负责拒绝并记录——任何代码路径都不得
// 依据它执行命令。
//
// 本文件是纯函数（无 IO、无 child_process），可独立单测。
// T28（task/run-domain API）依赖 ScriptEvent 的透传形状：payload 保留原始 JSON
// 对象（含 type 字段），宿主不解释业务字段。

export type ScriptEventType = "fact" | "deliver" | "dispatch" | "heartbeat";

/** 一条被宿主接受的事件。 */
export interface ScriptEvent {
  readonly type: ScriptEventType;
  /** 原始 JSON 对象（含 "type"），原样透传给上层。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 解析成功的事件行。 */
export interface EventParsedLine {
  readonly kind: "event";
  readonly event: ScriptEvent;
}

/** 保留事件行（当前唯一保留类型是 "exec"）：宿主必须拒绝+记录，绝不执行。 */
export interface ReservedParsedLine {
  readonly kind: "reserved";
  readonly reservedType: "exec";
  readonly line: string;
  readonly reason: string;
}

/** 无法解析的行（非 JSON、缺 type、未知 type 等）。 */
export interface InvalidParsedLine {
  readonly kind: "invalid";
  readonly line: string;
  readonly reason: string;
}

/** 空白行：直接忽略。 */
export interface BlankParsedLine {
  readonly kind: "blank";
}

export type ParsedLine =
  | EventParsedLine
  | ReservedParsedLine
  | InvalidParsedLine
  | BlankParsedLine;

/** 穷尽匹配的守卫：走到这里说明上游 switch 漏了分支。 */
export function assertNever(value: never): never {
  throw new Error(`穷尽匹配违约（漏分支）: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** switch 穷尽收窄：把字符串窄化为合法事件类型，否则 undefined。 */
function asScriptEventType(value: string): ScriptEventType | undefined {
  switch (value) {
    case "fact":
    case "deliver":
    case "dispatch":
    case "heartbeat":
      return value;
    default:
      return undefined;
  }
}

/**
 * 解析 stdout 的一行。不抛异常：一切失败都编码进 ParsedLine 的 kind/reason，
 * 由宿主决定记录级别（reserved=error、invalid=warn、blank=忽略）。
 */
export function parseEventLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { kind: "blank" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid", line: trimmed, reason: "非 JSON 行" };
  }

  if (!isRecord(parsed)) {
    return { kind: "invalid", line: trimmed, reason: "JSON 不是对象" };
  }

  const rawType: unknown = parsed["type"];
  if (typeof rawType !== "string") {
    return { kind: "invalid", line: trimmed, reason: "缺少字符串 type 字段" };
  }

  if (rawType === "exec") {
    return {
      kind: "reserved",
      reservedType: "exec",
      line: trimmed,
      reason: "exec 为保留事件类型，宿主拒绝执行",
    };
  }

  const type = asScriptEventType(rawType);
  if (type === undefined) {
    return { kind: "invalid", line: trimmed, reason: `未知事件类型: ${rawType}` };
  }

  return { kind: "event", event: { type, payload: parsed } };
}
