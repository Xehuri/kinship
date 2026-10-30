/**
 * plan 工具（Todo 10）—— 日计划的唯一模型写入口。
 *
 * 五个动作全部落在 PlanStore 上（本文件不碰磁盘、不拼路径）：
 *   read   读当日计划，不存在时返回带 not-found 的 isError 结果；
 *   commit 首次 write(status=committed)；已存在则 read 当前版本后 revise，
 *          绝不用 write 覆盖（write 只接受空位，第二次调用必然冲突）；
 *   revise CAS 修订（expected_version + reason），patch / ops 二选一；
 *   note   追加一条笔记；省略 expected_version 时先读当前版本再 CAS；
 *   close  CAS 收口，未完成条目转 carried 并随结果返回。
 *
 * 错误面：PlanValidationError / PlanConflictError / PlanNotFoundError /
 * PlanClosedError 一律折叠成 isError 工具结果回灌模型，不抛、不中断 run；
 * 只有非类型化异常（真正的 bug）才向上抛给 kernel。
 */

import { Type } from "@axeuh/loom-core";
import type { HarnessTool, HookContext, ToolExecResult } from "@axeuh/loom-core";

import {
  PlanClosedError,
  PlanConflictError,
  PlanNotFoundError,
  PlanValidationError,
  requireExpectedVersion,
  requirePlanCoverage,
  requirePlanDate,
  requirePlanItem,
  requireReason,
  requireReviewAt,
  type PlanCloseResult,
  type PlanCoverage,
  type PlanCoverageProfile,
  type PlanDocument,
  type PlanItem,
  type PlanPatch,
  type PlanReviseOp,
  type PlanStore,
  type PlanWriteInput,
} from "../plan/plan-store.js";
import { renderPlanLegacyText } from "./plan-legacy-text.js";

export const PLAN_TOOL_NAME = "plan" as const;

export const PLAN_TOOL_ACTIONS = ["read", "commit", "revise", "note", "close"] as const;
export type PlanToolAction = (typeof PLAN_TOOL_ACTIONS)[number];

export interface PlanToolOptions {
  readonly store: PlanStore;
}

/** commit 已存在计划时的审计原因（新计划由 Store 的 write 记录）。 */
const COMMIT_REVISE_REASON = "plan commit";
/** note 动作的审计原因。 */
const NOTE_REVISE_REASON = "append note";

/**
 * 每个 coverage profile 必须齐全的检查点（对齐 ai/data/plan/coverage.yaml）。
 * Store 只校验形状；commit 在这里守住"不许漏窗"的契约。
 */
const PROFILE_CHECKPOINTS: Record<PlanCoverageProfile, readonly string[]> = {
  merged_7: ["cov-00", "cov-06", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
  merged_6: ["cov-night", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
};

export function planToolParameters() {
  const item = Type.Object({
    id: Type.String({ description: "Stable item id: letters/digits/_/-, max 64 chars." }),
    kind: Type.Union([
      Type.Literal("care"),
      Type.Literal("coverage"),
      Type.Literal("review"),
      Type.Literal("long_task"),
      Type.Literal("note"),
    ]),
    intent: Type.String({ description: "What this item wants to achieve." }),
    status: Type.Union([
      Type.Literal("planned"),
      Type.Literal("done"),
      Type.Literal("skipped"),
      Type.Literal("carried"),
      Type.Literal("blocked"),
    ]),
    target_date: Type.Optional(Type.String({ description: "YYYY-MM-DD." })),
    window: Type.Optional(Type.String()),
    checkpoint_id: Type.Optional(Type.String()),
    done_when: Type.Optional(Type.String()),
    not_do: Type.Optional(Type.Array(Type.String())),
    source: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
  });

  const coverage = Type.Object({
    profile: Type.Union([Type.Literal("merged_7"), Type.Literal("merged_6")]),
    checkpoints: Type.Array(Type.String({ description: "Coverage checkpoint ids." })),
    debt: Type.Array(Type.String({ description: "Accepted coverage gaps." })),
  });

  const patch = Type.Object({
    status: Type.Optional(
      Type.Union([Type.Literal("draft"), Type.Literal("committed")]),
    ),
    review_at: Type.Optional(Type.String({ description: "HH:MM." })),
    items: Type.Optional(Type.Array(item, { description: "Whole-table replacement." })),
    coverage: Type.Optional(coverage),
    notes_append: Type.Optional(Type.Array(Type.String())),
  });

  const ops = Type.Array(
    Type.Union([
      Type.Object({
        op: Type.Literal("set_status"),
        status: Type.Union([Type.Literal("draft"), Type.Literal("committed")]),
      }),
      Type.Object({
        op: Type.Literal("set_review_at"),
        review_at: Type.String({ description: "HH:MM." }),
      }),
      Type.Object({ op: Type.Literal("upsert_item"), item }),
      Type.Object({ op: Type.Literal("remove_item"), id: Type.String() }),
      Type.Object({ op: Type.Literal("set_coverage"), coverage }),
      Type.Object({ op: Type.Literal("append_note"), note: Type.String() }),
    ]),
    { description: "Ordered incremental operations." },
  );

  return Type.Object({
    action: Type.Union([
      Type.Literal("read"),
      Type.Literal("commit"),
      Type.Literal("revise"),
      Type.Literal("note"),
      Type.Literal("close"),
    ]),
    date: Type.String({ description: "Plan date, YYYY-MM-DD." }),

    // commit
    items: Type.Optional(Type.Array(item, { description: "commit: full item table." })),
    coverage: Type.Optional(coverage),
    review_at: Type.Optional(Type.String({ description: "commit: HH:MM, default 07:30." })),
    notes: Type.Optional(Type.Array(Type.String(), { description: "commit: notes to append." })),

    // revise
    expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
    reason: Type.Optional(Type.String()),
    patch: Type.Optional(patch),
    ops,

    // note
    text: Type.Optional(Type.String()),

    // close
    summary: Type.Optional(Type.String()),
  });
}

/* ───────────────────────── 参数解析（第二道防线） ───────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanValidationError(field, "必须是非空字符串");
  }
  return value;
}

function requireAction(value: unknown): PlanToolAction {
  if (
    typeof value !== "string" ||
    !(PLAN_TOOL_ACTIONS as readonly string[]).includes(value)
  ) {
    throw new PlanValidationError(
      "action",
      `必须是 ${PLAN_TOOL_ACTIONS.join(" | ")} 之一`,
    );
  }
  return value as PlanToolAction;
}

function parseItems(raw: unknown, field: string): readonly PlanItem[] {
  if (!Array.isArray(raw)) {
    throw new PlanValidationError(field, "必须是条目数组");
  }
  return raw.map((entry, index) => requirePlanItem(entry, `${field}[${String(index)}]`));
}

function parseCoverage(raw: unknown): ReturnType<typeof requirePlanCoverage> {
  return requirePlanCoverage(raw);
}

function assertCoverageComplete(coverage: PlanCoverage): void {
  const expected = PROFILE_CHECKPOINTS[coverage.profile];
  const actual = coverage.checkpoints;
  const missing = expected.filter((id) => !actual.includes(id));
  if (missing.length > 0) {
    throw new PlanValidationError(
      "coverage.checkpoints",
      `profile ${coverage.profile} 缺少检查点: ${missing.join(", ")}`,
    );
  }
  const extra = actual.filter((id) => !expected.includes(id));
  if (extra.length > 0) {
    throw new PlanValidationError(
      "coverage.checkpoints",
      `profile ${coverage.profile} 存在未定义检查点: ${extra.join(", ")}`,
    );
  }
}

function parseNotes(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new PlanValidationError("notes", "必须是字符串数组");
  }
  return raw.map((entry, index) => requireNonEmpty(entry, `notes[${String(index)}]`));
}

/* ───────────────────────── 动作实现 ───────────────────────── */

async function readAction(
  store: PlanStore,
  args: Record<string, unknown>,
): Promise<PlanDocument> {
  return store.read(requirePlanDate(args["date"]));
}

async function commitAction(
  store: PlanStore,
  args: Record<string, unknown>,
): Promise<PlanDocument> {
  const date = requirePlanDate(args["date"]);
  const items = parseItems(args["items"], "items");
  const coverage = parseCoverage(args["coverage"]);
  assertCoverageComplete(coverage);
  const reviewAt =
    args["review_at"] === undefined ? undefined : requireReviewAt(args["review_at"]);
  const notes = parseNotes(args["notes"]);

  let current: PlanDocument | null = null;
  try {
    current = await store.read(date);
  } catch (error) {
    if (!(error instanceof PlanNotFoundError)) throw error;
  }

  if (current === null) {
    const input: PlanWriteInput = {
      date,
      status: "committed",
      items,
      coverage,
      ...(reviewAt === undefined ? {} : { review_at: reviewAt }),
      ...(notes === undefined ? {} : { notes }),
    };
    return store.write(input);
  }

  const patch: PlanPatch = {
    status: "committed",
    items,
    coverage,
    ...(reviewAt === undefined ? {} : { review_at: reviewAt }),
    ...(notes === undefined ? {} : { notes_append: notes }),
  };
  return store.revise(date, current.version, patch, COMMIT_REVISE_REASON);
}

async function reviseAction(
  store: PlanStore,
  args: Record<string, unknown>,
): Promise<PlanDocument> {
  const date = requirePlanDate(args["date"]);
  const expectedVersion = requireExpectedVersion(args["expected_version"]);
  const reason = requireReason(args["reason"]);

  const hasPatch = args["patch"] !== undefined;
  const hasOps = args["ops"] !== undefined;
  if (hasPatch === hasOps) {
    throw new PlanValidationError("patch", "patch 与 ops 必须且只能提供一个");
  }

  if (hasPatch) {
    const rawPatch = args["patch"];
    if (!isRecord(rawPatch)) {
      throw new PlanValidationError("patch", "必须是对象");
    }
    return store.revise(date, expectedVersion, rawPatch as PlanPatch, reason);
  }

  const rawOps = args["ops"];
  if (!Array.isArray(rawOps)) {
    throw new PlanValidationError("ops", "必须是操作数组");
  }
  return store.revise(
    date,
    expectedVersion,
    rawOps as readonly PlanReviseOp[],
    reason,
  );
}

async function noteAction(
  store: PlanStore,
  args: Record<string, unknown>,
): Promise<PlanDocument> {
  const date = requirePlanDate(args["date"]);
  const text = requireNonEmpty(args["text"], "text");
  const expectedVersion =
    args["expected_version"] === undefined
      ? (await store.read(date)).version
      : requireExpectedVersion(args["expected_version"]);

  return store.revise(
    date,
    expectedVersion,
    [{ op: "append_note", note: text }],
    NOTE_REVISE_REASON,
  );
}

async function closeAction(
  store: PlanStore,
  args: Record<string, unknown>,
): Promise<PlanCloseResult> {
  const date = requirePlanDate(args["date"]);
  const expectedVersion = requireExpectedVersion(args["expected_version"]);
  const summary = requireNonEmpty(args["summary"], "summary");
  return store.close(date, expectedVersion, summary);
}

interface PlanToolOutcome {
  readonly action: PlanToolAction;
  readonly payload: PlanDocument | PlanCloseResult;
}

async function runAction(
  store: PlanStore,
  args: Record<string, unknown>,
): Promise<PlanToolOutcome> {
  if (!isRecord(args)) {
    throw new PlanValidationError("args", "必须是对象");
  }
  const action = requireAction(args["action"]);
  switch (action) {
    case "read":
      return { action, payload: await readAction(store, args) };
    case "commit":
      return { action, payload: await commitAction(store, args) };
    case "revise":
      return { action, payload: await reviseAction(store, args) };
    case "note":
      return { action, payload: await noteAction(store, args) };
    case "close":
      return { action, payload: await closeAction(store, args) };
  }
}

/* ───────────────────────── 结果投影 ───────────────────────── */

type PlanToolError =
  | PlanValidationError
  | PlanConflictError
  | PlanNotFoundError
  | PlanClosedError;

function isPlanToolError(error: unknown): error is PlanToolError {
  return (
    error instanceof PlanValidationError ||
    error instanceof PlanConflictError ||
    error instanceof PlanNotFoundError ||
    error instanceof PlanClosedError
  );
}

function successResult(
  action: PlanToolAction,
  payload: PlanDocument | PlanCloseResult,
): ToolExecResult {
  return {
    content: [{ type: "text", text: renderPlanLegacyText(action, payload) }],
    details: { __plan: payload },
  };
}

function errorResult(error: PlanToolError): ToolExecResult {
  return {
    content: [{ type: "text", text: `plan 被拒绝：${error.name}: ${error.message}` }],
    isError: true,
    details: { __plan: { error: error.name, message: error.message } },
  };
}

const PLAN_TOOL_DESCRIPTION =
  "Read and write the daily plan (single writer: this tool). Actions: " +
  "read {date}; commit {date, items, coverage, review_at?, notes?} creating the plan or " +
  "replacing items/coverage on an existing plan with status=committed (notes are appended); " +
  "revise {date, expected_version, reason, patch XOR ops} for CAS updates; " +
  "note {date, text, expected_version?} appends one note (reads the current version when omitted); " +
  "close {date, expected_version, summary} marks the plan closed and returns the carried items. " +
  "All failures come back as isError results with the typed reason; re-read the plan to get the current version.";

export function createPlanTool(opts: PlanToolOptions): HarnessTool {
  const store = opts.store;
  return {
    name: PLAN_TOOL_NAME,
    label: "计划",
    description: PLAN_TOOL_DESCRIPTION,
    parameters: planToolParameters(),
    isReadOnly: false,
    // 同一日期计划的写路径必须串行：commit 的 read->revise 依赖版本单调。
    isConcurrencySafe: () => false,
    async execute(
      args: Record<string, unknown>,
      _ctx: HookContext,
      _signal: AbortSignal,
    ): Promise<ToolExecResult> {
      try {
        const outcome = await runAction(store, args);
        return successResult(outcome.action, outcome.payload);
      } catch (error) {
        if (!isPlanToolError(error)) throw error;
        return errorResult(error);
      }
    },
  };
}
