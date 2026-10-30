/**
 * JsonLongTaskStore：LongTaskStore 的磁盘实现。
 *
 * 真源 `{planRoot}/plan/long-tasks/{id}.json`；派生人读视图 `{id}.md`。
 * JSON 先原子落盘，MD 渲染失败不反噬真源；归档只改 status。
 * CAS 以磁盘上的 version 为准（每个操作重新读盘），单写者由上层保证。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  LONG_TASK_ID_RE,
  LONG_TASK_SCHEMA,
  LongTaskArchivedError,
  LongTaskConflictError,
  LongTaskExistsError,
  LongTaskNotFoundError,
  LongTaskValidationError,
  assertLongTaskDate,
  assertLongTaskId,
  assertLongTaskVersion,
  parseLongTask,
  renderLongTaskMarkdown,
  validateLongTaskCreate,
  validateLongTaskListOptions,
  validateLongTaskPatch,
  type LongTask,
  type LongTaskCreateInput,
  type LongTaskListOptions,
  type LongTaskReadResult,
  type LongTaskStore,
  type LongTaskStoreOptions,
  type LongTaskUpdatePatch,
} from "./long-task-store.js";

const TASKS_DIR_SEGMENTS = ["plan", "long-tasks"] as const;
const MAX_GENERATED_ID_ATTEMPTS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function existsAt(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** 目标路径（含符号链接解析）必须仍在 root 内；不存在时向上找最近存在祖先。 */
function assertWithinRoot(rootReal: string, target: string): void {
  let probe = resolve(target);
  while (!existsAt(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = realpathSync(probe);
  if (escapesRoot(relative(rootReal, real))) {
    throw new LongTaskValidationError(
      "path",
      `拒绝越出 planRoot 的路径: ${target}`,
    );
  }
}

let tmpSeq = 0;

/** 同目录 tmp + rename：读侧永不见半截；失败清理 tmp 后原样抛出。 */
function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${String(++tmpSeq)}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 未落地（写前失败）时无需清理
    }
    throw error;
  }
}

/** 由 title 派生 id 词干：只保留 a-z0-9_，保证满足 `lt_[a-z0-9_]{4,32}`。 */
function slugifyTitle(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = ascii.length > 0 ? ascii : "task";
  const padded = stem.length >= 4 ? stem : `task_${stem}`;
  const trimmed = padded.slice(0, 32).replace(/_+$/g, "");
  return trimmed.length >= 4 ? trimmed : "task";
}

function utcDateOf(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

export class JsonLongTaskStore implements LongTaskStore {
  readonly #rootPath: string;
  readonly #now: () => number;
  #rootReal: string | null;

  constructor(options: LongTaskStoreOptions) {
    if (typeof options.planRoot !== "string" || options.planRoot.trim() === "") {
      throw new LongTaskValidationError("planRoot", "必须是非空绝对路径");
    }
    if (!isAbsolute(options.planRoot)) {
      throw new LongTaskValidationError(
        "planRoot",
        `必须是绝对路径（绝不猜测默认根）: ${options.planRoot}`,
      );
    }
    this.#rootPath = resolve(options.planRoot);
    this.#now = options.now ?? Date.now;
    if (existsAt(this.#rootPath)) {
      if (!statSync(this.#rootPath).isDirectory()) {
        throw new LongTaskValidationError("planRoot", `不是目录: ${this.#rootPath}`);
      }
      this.#rootReal = realpathSync(this.#rootPath);
    } else {
      this.#rootReal = null;
    }
  }

  async create(input: LongTaskCreateInput): Promise<LongTask> {
    const normalized = validateLongTaskCreate(input);
    const dir = this.#tasksDir();
    const id = normalized.id ?? this.#uniqueId(slugifyTitle(normalized.title), dir);
    if (this.#existsFor(id, dir)) {
      throw new LongTaskExistsError(id);
    }
    const now = this.#stamp();
    const task: LongTask = {
      schema: LONG_TASK_SCHEMA,
      id,
      title: normalized.title,
      intent: normalized.intent,
      cadence: normalized.cadence,
      next_check: normalized.next_check,
      last_done: normalized.last_done,
      status: "active",
      review_policy: normalized.review_policy,
      notes: normalized.notes,
      created_at: now,
      updated_at: now,
      version: 1,
    };
    this.#persist(task);
    return task;
  }

  async read(id: string): Promise<LongTaskReadResult> {
    const task = this.#load(assertLongTaskId(id));
    return { task, markdown: renderLongTaskMarkdown(task) };
  }

  async list(options: LongTaskListOptions = {}): Promise<readonly LongTask[]> {
    const normalized = validateLongTaskListOptions(options);
    const dir = this.#existingTasksDir();
    if (dir === null) return [];
    const root = this.#rootReal;
    if (root === null) return [];
    const today = normalized.date ?? utcDateOf(this.#validNow());
    const tasks: LongTask[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!LONG_TASK_ID_RE.test(id)) {
        throw new LongTaskValidationError("id", `非法长期任务文件名: ${name}`);
      }
      const file = join(dir, name);
      assertWithinRoot(root, file);
      tasks.push(this.#parseFile(file, id));
    }
    const filtered = tasks.filter((task) => {
      if (normalized.due === "today") {
        return task.status === "active" && task.next_check <= today;
      }
      if (normalized.due === "active") return task.status === "active";
      return true;
    });
    return filtered.sort((a, b) => {
      if (a.next_check !== b.next_check) return a.next_check < b.next_check ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    patch: LongTaskUpdatePatch,
  ): Promise<LongTask> {
    const taskId = assertLongTaskId(id);
    const expected = assertLongTaskVersion(expectedVersion);
    const normalized = validateLongTaskPatch(patch);
    const current = this.#load(taskId);
    this.#assertMutable(current, expected);
    const next: LongTask = {
      ...current,
      ...(normalized.title === undefined ? {} : { title: normalized.title }),
      ...(normalized.intent === undefined ? {} : { intent: normalized.intent }),
      ...(normalized.cadence === undefined ? {} : { cadence: normalized.cadence }),
      ...(normalized.next_check === undefined
        ? {}
        : { next_check: normalized.next_check }),
      ...(normalized.last_done === undefined
        ? {}
        : { last_done: normalized.last_done }),
      ...(normalized.review_policy === undefined
        ? {}
        : { review_policy: normalized.review_policy }),
      ...(normalized.notes === undefined ? {} : { notes: normalized.notes }),
      updated_at: this.#stamp(),
      version: current.version + 1,
    };
    this.#persist(next);
    return next;
  }

  async pause(id: string, expectedVersion: number, until?: string): Promise<LongTask> {
    const taskId = assertLongTaskId(id);
    const expected = assertLongTaskVersion(expectedVersion);
    const untilDate = until === undefined ? null : assertLongTaskDate(until, "until");
    const current = this.#load(taskId);
    this.#assertMutable(current, expected);
    const next: LongTask = {
      ...current,
      status: "paused",
      next_check: untilDate ?? current.next_check,
      updated_at: this.#stamp(),
      version: current.version + 1,
    };
    this.#persist(next);
    return next;
  }

  async resume(id: string, expectedVersion: number): Promise<LongTask> {
    const taskId = assertLongTaskId(id);
    const expected = assertLongTaskVersion(expectedVersion);
    const current = this.#load(taskId);
    this.#assertMutable(current, expected);
    const next: LongTask = {
      ...current,
      status: "active",
      updated_at: this.#stamp(),
      version: current.version + 1,
    };
    this.#persist(next);
    return next;
  }

  async archive(id: string, expectedVersion: number): Promise<LongTask> {
    const taskId = assertLongTaskId(id);
    const expected = assertLongTaskVersion(expectedVersion);
    const current = this.#load(taskId);
    this.#assertMutable(current, expected);
    const next: LongTask = {
      ...current,
      status: "archived",
      updated_at: this.#stamp(),
      version: current.version + 1,
    };
    this.#persist(next);
    return next;
  }

  #root(): string {
    if (this.#rootReal !== null) return this.#rootReal;
    mkdirSync(this.#rootPath, { recursive: true });
    this.#rootReal = realpathSync(this.#rootPath);
    return this.#rootReal;
  }

  #tasksDir(): string {
    const root = this.#root();
    const dir = join(root, ...TASKS_DIR_SEGMENTS);
    assertWithinRoot(root, dir);
    return dir;
  }

  /** 读路径不创建目录：根/tasks 目录不存在即视为空。 */
  #existingTasksDir(): string | null {
    const root = this.#rootReal;
    if (root === null) return null;
    const dir = join(root, ...TASKS_DIR_SEGMENTS);
    if (!existsAt(dir)) return null;
    assertWithinRoot(root, dir);
    return dir;
  }

  #existsFor(id: string, dir: string): boolean {
    return (
      existsAt(join(dir, `${id}.json`)) || existsAt(join(dir, `${id}.md`))
    );
  }

  #uniqueId(base: string, dir: string): string {
    for (let attempt = 1; attempt < MAX_GENERATED_ID_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 1 ? "" : `_${String(attempt)}`;
      const stem = base.slice(0, 32 - suffix.length).replace(/_+$/g, "") || "task";
      const id = `lt_${stem}${suffix}`;
      if (!LONG_TASK_ID_RE.test(id)) continue;
      if (!this.#existsFor(id, dir)) return id;
    }
    throw new LongTaskValidationError("id", "无法生成唯一长期任务 id");
  }

  #load(id: string): LongTask {
    const dir = this.#existingTasksDir();
    if (dir === null) throw new LongTaskNotFoundError(id);
    const root = this.#rootReal;
    if (root === null) throw new LongTaskNotFoundError(id);
    const file = join(dir, `${id}.json`);
    assertWithinRoot(root, file);
    if (!existsAt(file)) throw new LongTaskNotFoundError(id);
    return this.#parseFile(file, id);
  }

  #parseFile(file: string, id: string): LongTask {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new LongTaskValidationError(
        "record",
        `无法解析长期任务文件 ${file}: ${errorMessage(error)}`,
      );
    }
    return parseLongTask(parsed, id);
  }

  #assertMutable(current: LongTask, expected: number): LongTask {
    if (current.version !== expected) {
      throw new LongTaskConflictError(current.id, expected, current.version);
    }
    if (current.status === "archived") {
      throw new LongTaskArchivedError(current.id);
    }
    return current;
  }

  #persist(task: LongTask): void {
    const root = this.#root();
    const dir = join(root, ...TASKS_DIR_SEGMENTS);
    const jsonFile = join(dir, `${task.id}.json`);
    assertWithinRoot(root, jsonFile);
    writeAtomic(jsonFile, `${JSON.stringify(task)}\n`);
    const mdFile = join(dir, `${task.id}.md`);
    assertWithinRoot(root, mdFile);
    try {
      writeAtomic(mdFile, renderLongTaskMarkdown(task));
    } catch {
      // MD 是派生视图：JSON 真源已落盘，渲染失败不回滚、不反噬调用方
    }
  }

  #validNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new LongTaskValidationError("now", `时钟返回非法值: ${String(value)}`);
    }
    return value;
  }

  #stamp(): string {
    return new Date(this.#validNow()).toISOString();
  }
}
