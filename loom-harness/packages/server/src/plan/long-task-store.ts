/**
 * LongTaskStore：长期任务模板的契约、类型与校验。
 *
 * LongTask 是「写一次、长期存在」的模板：真源 `{planRoot}/plan/long-tasks/{id}.json`，
 * 人读视图 `{id}.md` 由 JSON 渲染；归档只改 status，绝不删除文件。
 * 本层不排班：05:00 拉 due slice 由上层负责。
 */

export const LONG_TASK_SCHEMA = 1 as const;
export const LONG_TASK_ID_RE = /^lt_[a-z0-9_]{4,32}$/;
export const LONG_TASK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LONG_TASK_CADENCES = ["daily", "weekly", "monthly", "once"] as const;
export const LONG_TASK_STATUSES = ["active", "paused", "archived"] as const;
export const LONG_TASK_REVIEW_POLICIES = ["after_done", "none"] as const;
export const LONG_TASK_DUE_FILTERS = ["today", "active", "all"] as const;

export type LongTaskCadence = (typeof LONG_TASK_CADENCES)[number];
export type LongTaskStatus = (typeof LONG_TASK_STATUSES)[number];
export type LongTaskReviewPolicy = (typeof LONG_TASK_REVIEW_POLICIES)[number];
export type LongTaskDueFilter = (typeof LONG_TASK_DUE_FILTERS)[number];

export interface LongTask {
  readonly schema: typeof LONG_TASK_SCHEMA;
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly cadence: LongTaskCadence;
  /** 下一次要看它的日期（`YYYY-MM-DD`），不是 cron。 */
  readonly next_check: string;
  readonly last_done: string | null;
  readonly status: LongTaskStatus;
  readonly review_policy: LongTaskReviewPolicy;
  readonly notes: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
}

export interface LongTaskCreateInput {
  /** 缺省时由 title 派生（`lt_` + slug），冲突自动加数字后缀。 */
  readonly id?: string;
  readonly title: string;
  readonly intent: string;
  readonly cadence: LongTaskCadence;
  readonly next_check: string;
  readonly last_done?: string | null;
  readonly review_policy?: LongTaskReviewPolicy;
  readonly notes?: readonly string[];
}

/** 只允许改内容字段；status 走 pause/resume/archive，id/版本/时间戳不可写。 */
export interface LongTaskUpdatePatch {
  readonly title?: string;
  readonly intent?: string;
  readonly cadence?: LongTaskCadence;
  readonly next_check?: string;
  readonly last_done?: string | null;
  readonly review_policy?: LongTaskReviewPolicy;
  readonly notes?: readonly string[];
}

export interface LongTaskListOptions {
  /** `today` = active 且 next_check <= date；`active` = 全部 active；`all` = 含 archived。 */
  readonly due?: LongTaskDueFilter;
  /** 参考日期（`YYYY-MM-DD`），缺省按注入时钟取 UTC 日期。 */
  readonly date?: string;
}

export interface LongTaskReadResult {
  readonly task: LongTask;
  readonly markdown: string;
}

export interface LongTaskStoreOptions {
  /** 显式绝对根；生产应指向 `ai/data`，本层绝不猜测默认路径。 */
  readonly planRoot: string;
  /** 时钟注入（测试固定时间戳与 today）；缺省 Date.now。 */
  readonly now?: () => number;
}

export interface LongTaskStore {
  create(input: LongTaskCreateInput): Promise<LongTask>;
  /** 返回 JSON 真源与由它重新渲染的 MD（不信任磁盘上的派生物）。 */
  read(id: string): Promise<LongTaskReadResult>;
  list(options?: LongTaskListOptions): Promise<readonly LongTask[]>;
  update(id: string, expectedVersion: number, patch: LongTaskUpdatePatch): Promise<LongTask>;
  /**
   * 暂停：status=paused，不清空 next_check。
   * 传 until（`YYYY-MM-DD`）时把 next_check 指向该日期，恢复后按它到期；不传则原值保留。
   */
  pause(id: string, expectedVersion: number, until?: string): Promise<LongTask>;
  resume(id: string, expectedVersion: number): Promise<LongTask>;
  /** 归档：status=archived；文件保留且仍可 read，list 的 active/due 不再返回。 */
  archive(id: string, expectedVersion: number): Promise<LongTask>;
}

/** 输入形状/语义非法（字段缺失、枚举越界、日期非法、路径穿越等）。 */
export class LongTaskValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[long-task:validation] ${field}: ${message}`);
    this.name = "LongTaskValidationError";
    this.field = field;
  }
}

/** 乐观并发冲突：expectedVersion 与磁盘上的 version 不符，本次写入未生效。 */
export class LongTaskConflictError extends Error {
  readonly id: string;
  readonly expected: number;
  readonly actual: number;
  constructor(id: string, expected: number, actual: number) {
    super(`[long-task:conflict] ${id} expected version ${String(expected)}, actual ${String(actual)}`);
    this.name = "LongTaskConflictError";
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

/** id 不存在（或根目录/文件尚未创建）。 */
export class LongTaskNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`[long-task:not-found] ${id}`);
    this.name = "LongTaskNotFoundError";
    this.id = id;
  }
}

/** create 时 id 已存在；不覆盖既有模板。 */
export class LongTaskExistsError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`[long-task:exists] ${id}`);
    this.name = "LongTaskExistsError";
    this.id = id;
  }
}

/** 已归档记录不接受任何变更；只能 read/list。 */
export class LongTaskArchivedError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`[long-task:archived] ${id}`);
    this.name = "LongTaskArchivedError";
    this.id = id;
  }
}

export interface NormalizedLongTaskCreate {
  readonly id: string | null;
  readonly title: string;
  readonly intent: string;
  readonly cadence: LongTaskCadence;
  readonly next_check: string;
  readonly last_done: string | null;
  readonly review_policy: LongTaskReviewPolicy;
  readonly notes: readonly string[];
}

export interface NormalizedLongTaskPatch {
  readonly title?: string;
  readonly intent?: string;
  readonly cadence?: LongTaskCadence;
  readonly next_check?: string;
  readonly last_done?: string | null;
  readonly review_policy?: LongTaskReviewPolicy;
  readonly notes?: readonly string[];
}

export interface NormalizedLongTaskListOptions {
  readonly due: LongTaskDueFilter;
  readonly date: string | null;
}

const MAX_TITLE_CHARS = 200;
const MAX_INTENT_CHARS = 4000;
const MAX_NOTE_CHARS = 2000;
const MAX_NOTES = 50;

const PATCH_KEYS: ReadonlySet<string> = new Set([
  "title",
  "intent",
  "cadence",
  "next_check",
  "last_done",
  "review_policy",
  "notes",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new LongTaskValidationError(
      field,
      `必须是 ${allowed.join("|")} 之一: ${String(value)}`,
    );
  }
  return value as T;
}

function requireText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new LongTaskValidationError(field, `必须是字符串: ${String(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new LongTaskValidationError(field, "不能为空");
  }
  if (trimmed.length > maxChars) {
    throw new LongTaskValidationError(field, `长度不得超过 ${String(maxChars)} 字符`);
  }
  return trimmed;
}

/** 读取既有记录时保留原文，不做 trim 改写。 */
function requireStoredText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LongTaskValidationError(field, `必须是非空字符串: ${String(value)}`);
  }
  if (value.length > maxChars) {
    throw new LongTaskValidationError(field, `长度不得超过 ${String(maxChars)} 字符`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new LongTaskValidationError(field, `必须是 ISO 8601 时间戳: ${String(value)}`);
  }
  return value;
}

function normalizeNotes(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new LongTaskValidationError("notes", "必须是字符串数组");
  }
  if (value.length > MAX_NOTES) {
    throw new LongTaskValidationError("notes", `最多 ${String(MAX_NOTES)} 条`);
  }
  const notes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new LongTaskValidationError("notes", `条目必须是字符串: ${String(entry)}`);
    }
    const trimmed = entry.trim();
    if (trimmed === "") {
      throw new LongTaskValidationError("notes", "条目不能为空");
    }
    if (trimmed.length > MAX_NOTE_CHARS) {
      throw new LongTaskValidationError(
        "notes",
        `单条不得超过 ${String(MAX_NOTE_CHARS)} 字符`,
      );
    }
    notes.push(trimmed);
  }
  return notes;
}

export function assertLongTaskId(value: unknown): string {
  if (typeof value !== "string" || !LONG_TASK_ID_RE.test(value)) {
    throw new LongTaskValidationError(
      "id",
      `必须匹配 ${LONG_TASK_ID_RE.source}: ${String(value)}`,
    );
  }
  return value;
}

/** 校验 `YYYY-MM-DD` 且日期真实存在（2026-02-30 会被拒绝）。 */
export function assertLongTaskDate(value: unknown, field = "date"): string {
  if (typeof value !== "string" || !LONG_TASK_DATE_RE.test(value)) {
    throw new LongTaskValidationError(field, `必须是 YYYY-MM-DD: ${String(value)}`);
  }
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new LongTaskValidationError(field, `日期不存在: ${value}`);
  }
  return value;
}

export function assertLongTaskVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new LongTaskValidationError(
      "expectedVersion",
      `必须是正整数: ${String(value)}`,
    );
  }
  return value;
}

export function validateLongTaskCreate(input: LongTaskCreateInput): NormalizedLongTaskCreate {
  if (!isRecord(input)) {
    throw new LongTaskValidationError("input", "必须是对象");
  }
  const id = input.id === undefined ? null : assertLongTaskId(input.id);
  const title = requireText(input.title, "title", MAX_TITLE_CHARS);
  const intent = requireText(input.intent, "intent", MAX_INTENT_CHARS);
  const cadence = requireEnum(input.cadence, LONG_TASK_CADENCES, "cadence");
  const nextCheck = assertLongTaskDate(input.next_check, "next_check");
  const lastDone = input.last_done === undefined || input.last_done === null
    ? null
    : assertLongTaskDate(input.last_done, "last_done");
  const reviewPolicy = input.review_policy === undefined
    ? "after_done"
    : requireEnum(input.review_policy, LONG_TASK_REVIEW_POLICIES, "review_policy");
  const notes = normalizeNotes(input.notes);
  return {
    id,
    title,
    intent,
    cadence,
    next_check: nextCheck,
    last_done: lastDone,
    review_policy: reviewPolicy,
    notes,
  };
}

export function validateLongTaskPatch(patch: LongTaskUpdatePatch): NormalizedLongTaskPatch {
  if (!isRecord(patch)) {
    throw new LongTaskValidationError("patch", "必须是对象");
  }
  const keys = Object.keys(patch);
  for (const key of keys) {
    if (!PATCH_KEYS.has(key)) {
      throw new LongTaskValidationError(
        key,
        "不允许修改（status 走 pause/resume/archive；id/schema/version/时间戳只读）",
      );
    }
  }
  if (keys.length === 0) {
    throw new LongTaskValidationError("patch", "至少需要一个字段");
  }
  const title = patch.title === undefined
    ? undefined
    : requireText(patch.title, "title", MAX_TITLE_CHARS);
  const intent = patch.intent === undefined
    ? undefined
    : requireText(patch.intent, "intent", MAX_INTENT_CHARS);
  const cadence = patch.cadence === undefined
    ? undefined
    : requireEnum(patch.cadence, LONG_TASK_CADENCES, "cadence");
  const nextCheck = patch.next_check === undefined
    ? undefined
    : assertLongTaskDate(patch.next_check, "next_check");
  const lastDone = patch.last_done === undefined
    ? undefined
    : patch.last_done === null
      ? null
      : assertLongTaskDate(patch.last_done, "last_done");
  const reviewPolicy = patch.review_policy === undefined
    ? undefined
    : requireEnum(patch.review_policy, LONG_TASK_REVIEW_POLICIES, "review_policy");
  const notes = patch.notes === undefined ? undefined : normalizeNotes(patch.notes);
  return {
    ...(title === undefined ? {} : { title }),
    ...(intent === undefined ? {} : { intent }),
    ...(cadence === undefined ? {} : { cadence }),
    ...(nextCheck === undefined ? {} : { next_check: nextCheck }),
    ...(lastDone === undefined ? {} : { last_done: lastDone }),
    ...(reviewPolicy === undefined ? {} : { review_policy: reviewPolicy }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function validateLongTaskListOptions(
  options: LongTaskListOptions = {},
): NormalizedLongTaskListOptions {
  if (!isRecord(options)) {
    throw new LongTaskValidationError("options", "必须是对象");
  }
  const due = options.due === undefined
    ? "all"
    : requireEnum(options.due, LONG_TASK_DUE_FILTERS, "due");
  const date = options.date === undefined ? null : assertLongTaskDate(options.date);
  return { due, date };
}

/** 读取既有 JSON 时做全字段校验；损坏记录 fail-loud，不静默丢行。 */
export function parseLongTask(value: unknown, expectedId?: string): LongTask {
  if (!isRecord(value)) {
    throw new LongTaskValidationError("record", "必须是对象");
  }
  if (value["schema"] !== LONG_TASK_SCHEMA) {
    throw new LongTaskValidationError(
      "schema",
      `只支持 schema ${String(LONG_TASK_SCHEMA)}: ${String(value["schema"])}`,
    );
  }
  const id = assertLongTaskId(value["id"]);
  if (expectedId !== undefined && id !== expectedId) {
    throw new LongTaskValidationError("id", `文件身份不一致: 期望 ${expectedId}, 实际 ${id}`);
  }
  const title = requireStoredText(value["title"], "title", MAX_TITLE_CHARS);
  const intent = requireStoredText(value["intent"], "intent", MAX_INTENT_CHARS);
  const cadence = requireEnum(value["cadence"], LONG_TASK_CADENCES, "cadence");
  const nextCheck = assertLongTaskDate(value["next_check"], "next_check");
  const lastDone = value["last_done"] === null
    ? null
    : assertLongTaskDate(value["last_done"], "last_done");
  const status = requireEnum(value["status"], LONG_TASK_STATUSES, "status");
  const reviewPolicy = requireEnum(
    value["review_policy"],
    LONG_TASK_REVIEW_POLICIES,
    "review_policy",
  );
  const notes = normalizeNotes(value["notes"]);
  const createdAt = requireTimestamp(value["created_at"], "created_at");
  const updatedAt = requireTimestamp(value["updated_at"], "updated_at");
  const version = value["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new LongTaskValidationError("version", `必须是正整数: ${String(version)}`);
  }
  return {
    schema: LONG_TASK_SCHEMA,
    id,
    title,
    intent,
    cadence,
    next_check: nextCheck,
    last_done: lastDone,
    status,
    review_policy: reviewPolicy,
    notes,
    created_at: createdAt,
    updated_at: updatedAt,
    version,
  };
}

/** 由 JSON 真源渲染人读视图；确定性输出，便于测试逐字比对。 */
export function renderLongTaskMarkdown(task: LongTask): string {
  const notes = task.notes.length === 0
    ? "- （无）"
    : task.notes.map((note) => `- ${note}`).join("\n");
  return [
    `# ${task.title}`,
    "",
    `- 任务 ID：\`${task.id}\``,
    `- 状态：${task.status}`,
    `- 周期：${task.cadence}`,
    `- 下次检查：${task.next_check}`,
    `- 上次完成：${task.last_done ?? "尚未完成"}`,
    `- 复盘策略：${task.review_policy}`,
    `- 版本：${String(task.version)}`,
    `- 创建时间：${task.created_at}`,
    `- 更新时间：${task.updated_at}`,
    "",
    "## 意图",
    "",
    task.intent,
    "",
    "## 备注",
    "",
    notes,
    "",
  ].join("\n");
}
