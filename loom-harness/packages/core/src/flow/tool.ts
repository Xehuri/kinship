/**
 * flow_commit（L2）—— 心流台账的唯一写入口。
 *
 * 工具只负责「把一次提交交给 FlowStore 并把结果投影成工具输出」：
 *   - 成功：写 FLOW_COMMIT_SLOT（同 session 同 turn），返回紧凑文本 + details.__flow；
 *   - 类型化拒绝（conflict/closed/validation/limit/not-found）：isError 工具结果回灌模型，
 *     不抛错、不终止 run；
 *   - 终止决策全部归 FlowGate：工具绝不自作主张设 waiting_user，也不结束回合。
 *
 * 参数边界解析在 args.ts（TypeBox 之后第二道防线）。
 */

import { Type } from "@earendil-works/pi-ai";
// 环纪律：深路径直引真源，不 import 自身 barrel。
import type { HookContext } from "../hook.js";
import type { HarnessTool, ToolExecResult } from "../types.js";
import { parseCommitArgs } from "./args.js";
import {
  FlowContinuationConflictError,
  FlowContinuationNotFoundError,
  normalizeContinuationSource,
  type FlowContinuationStore,
} from "./continuation-store.js";
import {
  FlowClosedError,
  FlowConflictError,
  FlowLimitError,
  FlowNotFoundError,
  FlowValidationError,
  type FlowStore,
} from "./store.js";
import { FLOW_COMMIT_SLOT } from "./slot.js";
import { FLOW_DISPLAY_TIME_ZONE, formatFlowTime } from "./time.js";
import {
  DEFAULT_FLOW_SUBJECT_NAME,
  type FlowCommitInput,
  type FlowCommitResult,
  type FlowContinuation,
  type FlowContinuationSource,
  type FlowSubject,
  type FlowTimeInput,
} from "./types.js";

export const FLOW_COMMIT_TOOL_NAME = "flow_commit" as const;

export interface FlowCommitToolOptions {
  readonly store: FlowStore;
}

const TIME_INPUT_DESCRIPTION =
  "字符串（倒计时 30s/10m/1h30m，秒/分/时/天均可，最小 5s；带时区 ISO；本地日期时间；" +
  "HH:MM）、epoch 毫秒或 null（清空）；缺省=不改动。";

export function flowCommitParameters() {
  const time = () =>
    Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()]));
  return Type.Object({
    subject_id: Type.Optional(Type.String()),
    subject_name: Type.Optional(Type.String()),
    kind: Type.Optional(
      Type.Union([Type.Literal("thread"), Type.Literal("task")]),
    ),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    notes_append: Type.Optional(Type.Array(Type.String())),
    notes_ref: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    state: Type.Union([
      Type.Literal("active"),
      Type.Literal("waiting_user"),
      Type.Literal("waiting_event"),
      Type.Literal("closed"),
    ]),
    focus: Type.Optional(
      Type.Union([
        Type.Literal("foreground"),
        Type.Literal("background"),
        Type.Literal("parked"),
      ]),
    ),
    expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
    next_decision_at: time(),
    soft_deadline: time(),
    due_at: time(),
    timezone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    schedule: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    parent_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    close_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
}

type FlowCommitError =
  | FlowConflictError
  | FlowClosedError
  | FlowValidationError
  | FlowLimitError
  | FlowNotFoundError;

function isFlowCommitError(error: unknown): error is FlowCommitError {
  return (
    error instanceof FlowConflictError ||
    error instanceof FlowClosedError ||
    error instanceof FlowValidationError ||
    error instanceof FlowLimitError ||
    error instanceof FlowNotFoundError
  );
}

function formatNextDecision(at: number | null, timeZone: string): string {
  if (at === null) return "";
  return `，下次决策 ${formatFlowTime(at, timeZone)}`;
}

function successText(subject: FlowSubject, created: boolean): string {
  const origin = created ? "新建" : "既有";
  return (
    `flow_commit 已受理（${origin}）：「${subject.subject_name}」(${subject.subject_id})` +
    ` state=${subject.state} v${subject.version}` +
    `${formatNextDecision(subject.next_decision_at, subject.timezone ?? FLOW_DISPLAY_TIME_ZONE)}。`
  );
}

/**
 * 模型只给名称（或什么都不给）时，把提交解析成对既有主体的 CAS 更新：
 * 工具层补齐 subject_id 与当前版本，store 契约保持不变。
 */
async function resolveSubjectReference(
  store: FlowStore,
  sessionId: string,
  input: FlowCommitInput,
): Promise<FlowCommitInput> {
  if (input.subject_id !== undefined) return input;
  const subjectName = input.subject_name ?? DEFAULT_FLOW_SUBJECT_NAME;
  const existing = await store.findByName(sessionId, subjectName);
  if (existing === null) return input;
  return {
    ...input,
    subject_id: existing.subject_id,
    subject_name: subjectName,
    expected_version: input.expected_version ?? existing.version,
  };
}

function errorResult(error: FlowCommitError): ToolExecResult {
  return {
    content: [{ type: "text", text: `flow_commit 被拒绝：${error.message}` }],
    isError: true,
    details: { __flow: { committed: false, error: error.name } },
  };
}

function successResult(
  result: FlowCommitResult,
  ctx: HookContext,
): ToolExecResult {
  const subject = result.subject;
  return {
    content: [{ type: "text", text: successText(subject, result.created) }],
    details: {
      __flow: {
        subject_id: subject.subject_id,
        subject_name: subject.subject_name,
        state: subject.state,
        focus: subject.focus,
        version: subject.version,
        next_decision_at: subject.next_decision_at,
        created: result.created,
        turn_idx: ctx.turnIdx,
      },
    },
  };
}

const FLOW_COMMIT_DESCRIPTION =
  "记录当前心流主体状态（唯一写入口）。state=waiting_user/waiting_event/closed 时本轮结束，" +
  "active 表示继续并放行下一轮。更新既有主体可给 subject_id + expected_version 走显式 CAS；" +
  "也可只给 subject_name（缺省时用默认「主线」），工具会自动解析成既有主体并采用其当前版本。" +
  "显式 expected_version 仍做版本校验，冲突会被拒绝，重新读取版本后重试。" +
  "零主体会话可省略 subject_id/subject_name，自动创建默认「主线」。" +
  "notes_append 是受支持的摘要字段（追加字符串数组）；converge 的 body/digest 不被接受、不会持久化。" +
  `next_decision_at/soft_deadline/due_at 接受${TIME_INPUT_DESCRIPTION}`;

export function FlowCommitTool(opts: FlowCommitToolOptions): HarnessTool {
  const store = opts.store;
  return {
    name: FLOW_COMMIT_TOOL_NAME,
    label: "心流",
    description: FLOW_COMMIT_DESCRIPTION,
    parameters: flowCommitParameters(),
    isReadOnly: false,
    // 不变量：同 session 的提交必须串行——并行写槽/提交会互相覆盖。
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, ctx: HookContext) {
      try {
        const input = await resolveSubjectReference(
          store,
          ctx.sessionId,
          parseCommitArgs(args),
        );
        const result = await store.commit(ctx.sessionId, input, {
          turn_idx: ctx.turnIdx,
        });
        const subject = result.subject;
        ctx.state.set(FLOW_COMMIT_SLOT, {
          session_id: ctx.sessionId,
          subject_id: subject.subject_id,
          subject_name: subject.subject_name,
          state: subject.state,
          next_decision_at: subject.next_decision_at,
          version: subject.version,
          turn_idx: ctx.turnIdx,
        });
        return successResult(result, ctx);
      } catch (error) {
        if (!isFlowCommitError(error)) throw error;
        return errorResult(error);
      }
    },
  };
}

export const FLOW_TOOL_NAME = "flow" as const;

export const FLOW_TOOL_ACTIONS = ["wait", "resume", "close", "read"] as const;
export type FlowToolAction = (typeof FLOW_TOOL_ACTIONS)[number];

export interface FlowToolOptions {
  readonly store: FlowContinuationStore;
}

export function flowToolParameters() {
  return Type.Object({
    action: Type.Union([
      Type.Literal("wait"),
      Type.Literal("resume"),
      Type.Literal("close"),
      Type.Literal("read"),
    ]),
    id: Type.Optional(Type.String()),
    source: Type.Optional(
      Type.Object({
        plan_date: Type.Optional(Type.String()),
        checkpoint_id: Type.Optional(Type.String()),
        open_loop_id: Type.Optional(Type.String()),
      }),
    ),
    waiting_on: Type.Optional(Type.String()),
    next_at: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    close_condition: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  });
}

type FlowToolError =
  | FlowValidationError
  | FlowContinuationConflictError
  | FlowContinuationNotFoundError;

function isFlowToolError(error: unknown): error is FlowToolError {
  return (
    error instanceof FlowValidationError ||
    error instanceof FlowContinuationConflictError ||
    error instanceof FlowContinuationNotFoundError
  );
}

function flowActionOf(value: unknown): FlowToolAction | null {
  return value === "wait" ||
    value === "resume" ||
    value === "close" ||
    value === "read"
    ? value
    : null;
}

function requireFlowAction(args: Record<string, unknown>): FlowToolAction {
  const value = args["action"];
  const action = flowActionOf(value);
  if (action === null) {
    throw new FlowValidationError(
      "action",
      `必须是 wait/resume/close/read 之一: ${String(value)}`,
    );
  }
  return action;
}

function requireFlowId(args: Record<string, unknown>): string {
  const value = args["id"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FlowValidationError("id", "必须是非空字符串");
  }
  return value;
}

function requireTextArg(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FlowValidationError(key, "必须是非空字符串");
  }
  return value;
}

function optionalTextArg(
  args: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new FlowValidationError(key, "必须是非空字符串或 null");
  }
  return value;
}

function requireNextAtArg(args: Record<string, unknown>): FlowTimeInput {
  const value = args["next_at"];
  if (value === undefined || value === null) {
    throw new FlowValidationError("next_at", "wait 必须给出 next_at");
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new FlowValidationError("next_at", "必须是字符串、有限数字或 null");
  }
  return value;
}

function optionalSourceArg(
  args: Record<string, unknown>,
): FlowContinuationSource | undefined {
  const value = args["source"];
  if (value === undefined) return undefined;
  return normalizeContinuationSource(value);
}

function flowContinuationText(
  action: FlowToolAction,
  record: FlowContinuation,
): string {
  const waiting =
    record.waiting_on === null ? "" : `，等待：${record.waiting_on}`;
  const next =
    record.next_at === null
      ? ""
      : `，下次 ${formatFlowTime(record.next_at)}`;
  const reason = record.reason === null ? "" : `，原因：${record.reason}`;
  return `flow ${action}：「${record.id}」state=${record.state}${waiting}${next}${reason}。`;
}

function flowSuccessResult(
  action: FlowToolAction,
  continuation: FlowContinuation,
): ToolExecResult {
  return {
    content: [{ type: "text", text: flowContinuationText(action, continuation) }],
    details: {
      __flow: { action, ok: true, continuation },
    },
  };
}

function flowErrorResult(
  action: FlowToolAction | null,
  error: FlowToolError,
): ToolExecResult {
  return {
    content: [
      {
        type: "text",
        text: `flow ${action ?? "?"} 被拒绝：${error.message}`,
      },
    ],
    isError: true,
    details: { __flow: { action, ok: false, error: error.name } },
  };
}

async function runFlowAction(
  store: FlowContinuationStore,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<{ action: FlowToolAction; continuation: FlowContinuation }> {
  const action = requireFlowAction(args);
  const id = requireFlowId(args);
  switch (action) {
    case "wait": {
      const source = optionalSourceArg(args);
      const waitingOn = requireTextArg(args, "waiting_on");
      const nextAt = requireNextAtArg(args);
      const closeCondition = optionalTextArg(args, "close_condition");
      const reason = optionalTextArg(args, "reason");
      return {
        action,
        continuation: await store.wait(sessionId, {
          id,
          ...(source === undefined ? {} : { source }),
          waiting_on: waitingOn,
          next_at: nextAt,
          ...(closeCondition === undefined
            ? {}
            : { close_condition: closeCondition }),
          ...(reason === undefined ? {} : { reason }),
        }),
      };
    }
    case "resume": {
      const reason = optionalTextArg(args, "reason");
      return {
        action,
        continuation: await store.resume(sessionId, {
          id,
          ...(reason === undefined ? {} : { reason }),
        }),
      };
    }
    case "close":
      return {
        action,
        continuation: await store.close(sessionId, {
          id,
          reason: requireTextArg(args, "reason"),
        }),
      };
    case "read":
      return { action, continuation: await store.read(sessionId, id) };
  }
}

const FLOW_TOOL_DESCRIPTION =
  "简化持续记录（每个 plan 条目最多一条）：wait 创建/更新等待（必须给 waiting_on 与 next_at），" +
  "resume 恢复为 active，close 关闭（必须给 reason），read 读取单条记录。" +
  "source 可指 checkpoint_id 或 open_loop_id；旧 flow_commit 保持原契约不变。";

export function FlowTool(opts: FlowToolOptions): HarnessTool {
  const store = opts.store;
  return {
    name: FLOW_TOOL_NAME,
    label: "持续记录",
    description: FLOW_TOOL_DESCRIPTION,
    parameters: flowToolParameters(),
    isReadOnly: false,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, ctx: HookContext) {
      try {
        const result = await runFlowAction(store, ctx.sessionId, args);
        return flowSuccessResult(result.action, result.continuation);
      } catch (error) {
        if (!isFlowToolError(error)) throw error;
        return flowErrorResult(flowActionOf(args["action"]), error);
      }
    },
  };
}
