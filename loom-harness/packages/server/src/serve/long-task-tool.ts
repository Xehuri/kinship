/**
 * long_task —— 长期任务模板工具（create/update/pause/resume/archive/list/read）。
 *
 * 职责只有一层：把模型的结构化调用翻译成 LongTaskStore 调用，再把结果投影成
 * 紧凑纯文本 + details.__long_task（list 用 __long_tasks）。本工具不持有文件路径、
 * 不做排班、不直接读写 ai/data——根由装配方注入 store，工具只认 store 契约。
 *
 * 错误纪律：store 的类型化拒绝（validation/conflict/not-found/exists/archived）
 * 一律回 isError 工具结果，不抛错、不终止 run；只有非预期编程错误才向上抛。
 * 参数层同样先落到 LongTaskValidationError，保证直调通路（不吃 TypeBox schema）
 * 也得到同构的 isError 结果。
 */

import { Type } from "@axeuh/loom-core";
import type { HarnessTool, ToolExecResult } from "@axeuh/loom-core";

import {
  LongTaskArchivedError,
  LongTaskConflictError,
  LongTaskExistsError,
  LongTaskNotFoundError,
  LongTaskValidationError,
  assertLongTaskDate,
  assertLongTaskId,
  assertLongTaskVersion,
  validateLongTaskListOptions,
  type LongTask,
  type LongTaskCreateInput,
  type LongTaskDueFilter,
  type LongTaskListOptions,
  type LongTaskReadResult,
  type LongTaskStore,
  type LongTaskUpdatePatch,
} from "../plan/long-task-store.js";

import {
  renderLongTaskList,
  renderLongTaskRead,
  renderLongTaskRecord,
  type LongTaskRecordAction,
} from "./long-task-text.js";

export const LONG_TASK_TOOL_NAME = "long_task" as const;

export const LONG_TASK_ACTIONS = [
  "create",
  "update",
  "pause",
  "resume",
  "archive",
  "list",
  "read",
] as const;
export type LongTaskAction = (typeof LONG_TASK_ACTIONS)[number];

export interface LongTaskToolOptions {
  readonly store: LongTaskStore;
}

type LongTaskStoreError =
  | LongTaskValidationError
  | LongTaskConflictError
  | LongTaskNotFoundError
  | LongTaskExistsError
  | LongTaskArchivedError;

type ParsedCall =
  | { readonly action: "create"; readonly input: LongTaskCreateInput }
  | {
      readonly action: "update";
      readonly id: string;
      readonly expectedVersion: number;
      readonly patch: LongTaskUpdatePatch;
    }
  | {
      readonly action: "pause";
      readonly id: string;
      readonly expectedVersion: number;
      readonly until: string | undefined;
    }
  | { readonly action: "resume"; readonly id: string; readonly expectedVersion: number }
  | { readonly action: "archive"; readonly id: string; readonly expectedVersion: number }
  | {
      readonly action: "list";
      readonly options: LongTaskListOptions;
      readonly due: string;
      readonly date: string | null;
    }
  | { readonly action: "read"; readonly id: string };

type ListCall = Extract<ParsedCall, { readonly action: "list" }>;

const DATE_DESCRIPTION = "本地日期 `YYYY-MM-DD`（不是 cron，也不是时间戳）。";
const ID_DESCRIPTION = "任务 id，形如 `lt_weekly_review`（`lt_` + 4-32 位 a-z0-9_）。";

function taskInputSchema() {
  return Type.Object({
    id: Type.Optional(Type.String({ pattern: "^lt_[a-z0-9_]{4,32}$", description: ID_DESCRIPTION })),
    title: Type.String({ description: "短标题，展示在列表与人读 MD 的一级标题。" }),
    intent: Type.String({ description: "为什么长期保留这个任务、做到什么算完成。" }),
    cadence: Type.Union(
      [Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly"), Type.Literal("once")],
      { description: "检查节奏；只用于描述，排班由上层 consumer 负责。" },
    ),
    next_check: Type.String({ description: `下一次要看它的日期。${DATE_DESCRIPTION}` }),
    review_policy: Type.Optional(
      Type.Union([Type.Literal("after_done"), Type.Literal("none")], {
        description: "完成后是否触发复盘（缺省 after_done）。",
      }),
    ),
    notes: Type.Optional(
      Type.Array(Type.String(), { description: "备注条目；不要在备注里放密钥。" }),
    ),
  });
}

function taskPatchSchema() {
  return Type.Object({
    title: Type.Optional(Type.String()),
    intent: Type.Optional(Type.String()),
    cadence: Type.Optional(
      Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly"), Type.Literal("once")]),
    ),
    next_check: Type.Optional(Type.String({ description: DATE_DESCRIPTION })),
    last_done: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "上次完成日期或 null。" })),
    review_policy: Type.Optional(Type.Union([Type.Literal("after_done"), Type.Literal("none")])),
    notes: Type.Optional(Type.Array(Type.String(), { description: "整组替换备注。" })),
  });
}

export function longTaskParameters() {
  return Type.Object({
    action: Type.Union(
      [
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("archive"),
        Type.Literal("list"),
        Type.Literal("read"),
      ],
      { description: "create | update | pause | resume | archive | list | read。" },
    ),
    id: Type.Optional(Type.String({ description: ID_DESCRIPTION })),
    expected_version: Type.Optional(
      Type.Integer({ minimum: 1, description: "乐观并发版本号；update/pause/resume/archive 必填。" }),
    ),
    task: Type.Optional(taskInputSchema()),
    patch: Type.Optional(taskPatchSchema()),
    until: Type.Optional(
      Type.String({ description: `暂停到期日；缺省保留原 next_check。${DATE_DESCRIPTION}` }),
    ),
    due: Type.Optional(
      Type.Union(
        [Type.Literal("today"), Type.Literal("active"), Type.Literal("all")],
        {
          description:
            "list 过滤器：today = active 且 next_check <= date；active = 全部 active；all = 含 archived（缺省）。",
        },
      ),
    ),
    date: Type.Optional(Type.String({ description: `list 的参考日期；缺省取 store 时钟的 UTC 今天。${DATE_DESCRIPTION}` })),
  });
}

const LONG_TASK_DESCRIPTION =
  "Manage long-lived task templates (archive instead of delete). " +
  "Actions: create {task}, update {id, expected_version, patch}, pause {id, expected_version, until?}, " +
  "resume {id, expected_version}, archive {id, expected_version}, list {due?, date?}, read {id}. " +
  "list due filters: today = active tasks with next_check <= date; active = all active; all = includes archived (default). " +
  "read returns the rendered Markdown; list returns one line per task. " +
  "Every mutation uses optimistic concurrency: pass the current version from a prior read/list; " +
  "a stale version is rejected with isError. Archived tasks are read-only. " +
  "This tool only manages its injected store: it has no filesystem paths, no bash, and no scheduling.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLongTaskStoreError(error: unknown): error is LongTaskStoreError {
  return (
    error instanceof LongTaskValidationError ||
    error instanceof LongTaskConflictError ||
    error instanceof LongTaskNotFoundError ||
    error instanceof LongTaskExistsError ||
    error instanceof LongTaskArchivedError
  );
}

function requireAction(value: unknown): LongTaskAction {
  if (typeof value !== "string" || !(LONG_TASK_ACTIONS as readonly string[]).includes(value)) {
    throw new LongTaskValidationError(
      "action",
      `必须是 ${LONG_TASK_ACTIONS.join("|")} 之一: ${String(value)}`,
    );
  }
  return value as LongTaskAction;
}

/** 错误信封里的 action 标签：非法 action 也要能定位到调用。 */
function actionLabel(value: unknown): LongTaskAction | "unknown" {
  return typeof value === "string" && (LONG_TASK_ACTIONS as readonly string[]).includes(value)
    ? (value as LongTaskAction)
    : "unknown";
}

function parseListOptions(raw: Record<string, unknown>): ListCall {
  const normalized = validateLongTaskListOptions({
    ...(raw["due"] === undefined ? {} : { due: raw["due"] as LongTaskDueFilter }),
    ...(raw["date"] === undefined ? {} : { date: raw["date"] as string }),
  });
  const options: LongTaskListOptions = {
    due: normalized.due,
    ...(normalized.date === null ? {} : { date: normalized.date }),
  };
  return {
    action: "list",
    options,
    due: normalized.due,
    date: normalized.date,
  };
}

/** 第二道防线：TypeBox 之外再解析一次，坏参数统一落 LongTaskValidationError。 */
function parseCall(raw: unknown): ParsedCall {
  if (!isRecord(raw)) {
    throw new LongTaskValidationError("args", "必须是对象");
  }
  const action = requireAction(raw["action"]);
  switch (action) {
    case "create": {
      const task = raw["task"];
      if (!isRecord(task)) {
        throw new LongTaskValidationError("task", "create 需要 task 对象");
      }
      // 字段级校验归 store（validateLongTaskCreate），此处只保证形状是对象。
      return { action, input: task as unknown as LongTaskCreateInput };
    }
    case "update": {
      const patch = raw["patch"];
      if (!isRecord(patch)) {
        throw new LongTaskValidationError("patch", "update 需要 patch 对象");
      }
      return {
        action,
        id: assertLongTaskId(raw["id"]),
        expectedVersion: assertLongTaskVersion(raw["expected_version"]),
        patch: patch as unknown as LongTaskUpdatePatch,
      };
    }
    case "pause": {
      const until = raw["until"] === undefined ? undefined : assertLongTaskDate(raw["until"], "until");
      return {
        action,
        id: assertLongTaskId(raw["id"]),
        expectedVersion: assertLongTaskVersion(raw["expected_version"]),
        until,
      };
    }
    case "resume":
      return {
        action,
        id: assertLongTaskId(raw["id"]),
        expectedVersion: assertLongTaskVersion(raw["expected_version"]),
      };
    case "archive":
      return {
        action,
        id: assertLongTaskId(raw["id"]),
        expectedVersion: assertLongTaskVersion(raw["expected_version"]),
      };
    case "list":
      return parseListOptions(raw);
    case "read":
      return { action, id: assertLongTaskId(raw["id"]) };
  }
}

function successResult(action: LongTaskRecordAction, task: LongTask): ToolExecResult {
  return {
    content: [{ type: "text", text: renderLongTaskRecord(action, task) }],
    details: { __long_task: task },
  };
}

function listResult(tasks: readonly LongTask[], call: ListCall): ToolExecResult {
  return {
    content: [
      { type: "text", text: renderLongTaskList(tasks, { due: call.due, date: call.date }) },
    ],
    details: { __long_tasks: tasks },
  };
}

function readResult(read: LongTaskReadResult): ToolExecResult {
  return {
    content: [{ type: "text", text: renderLongTaskRead(read) }],
    details: { __long_task: { task: read.task, markdown: read.markdown } },
  };
}

function errorResult(action: LongTaskAction | "unknown", error: LongTaskStoreError): ToolExecResult {
  const payload = {
    ok: false as const,
    action,
    error: error.name,
    message: error.message,
  };
  return {
    content: [{ type: "text", text: `long_task ${action} 被拒绝：${error.message}` }],
    isError: true,
    details: { __long_task: payload },
  };
}

async function runCall(store: LongTaskStore, call: ParsedCall): Promise<ToolExecResult> {
  switch (call.action) {
    case "create":
      return successResult(call.action, await store.create(call.input));
    case "update":
      return successResult(
        call.action,
        await store.update(call.id, call.expectedVersion, call.patch),
      );
    case "pause":
      return successResult(
        call.action,
        await store.pause(call.id, call.expectedVersion, call.until),
      );
    case "resume":
      return successResult(call.action, await store.resume(call.id, call.expectedVersion));
    case "archive":
      return successResult(call.action, await store.archive(call.id, call.expectedVersion));
    case "list":
      return listResult(await store.list(call.options), call);
    case "read":
      return readResult(await store.read(call.id));
  }
}

/** 工厂：纯装配，无 I/O 副作用；store 的根/时钟全部由调用方注入。 */
export function createLongTaskTool({ store }: LongTaskToolOptions): HarnessTool {
  return {
    name: LONG_TASK_TOOL_NAME,
    label: "长期任务",
    description: LONG_TASK_DESCRIPTION,
    parameters: longTaskParameters(),
    isReadOnly: false,
    // 生命周期写同一批文件；同 turn 并行会互相覆盖版本，必须串行。
    isConcurrencySafe: () => false,

    async execute(raw: Record<string, unknown>): Promise<ToolExecResult> {
      let action = actionLabel(raw?.["action"]);
      try {
        const call: ParsedCall = parseCall(raw);
        action = call.action;
        return await runCall(store, call);
      } catch (error) {
        if (!isLongTaskStoreError(error)) throw error;
        return errorResult(action, error);
      }
    },
  };
}
