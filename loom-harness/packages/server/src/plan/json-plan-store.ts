/**
 * JsonPlanStore：PlanStore 的磁盘实现（Todo 9）。
 *
 * 路径契约（planRoot 必须由调用方显式给出，绝不猜 ai/data）：
 *   {planRoot}/daily/{date}/plan-{date}.json     真源
 *   {planRoot}/daily/{date}/计划-{date}.md       由 JSON 渲染，人可读
 *   {planRoot}/daily/{date}/plan-{date}.audit.jsonl 只追加审计
 *
 * 写路径统一 same-dir temp + fsync + rename；读侧永不见半截文件。
 * JSON 是唯一真源：先落 JSON，再渲染 MD；MD 写失败不会回滚已提交的 JSON，
 * 调用方会收到错误并可在下一次写入时自愈。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  PLAN_SCHEMA,
  PlanConflictError,
  PlanNotFoundError,
  PlanValidationError,
  closePlanDocument,
  normalizePlanAudit,
  requireExpectedVersion,
  requirePlanDate,
  requireReason,
  revisePlanDocument,
  validatePlanDocument,
  validatePlanWriteInput,
  type PlanAuditInput,
  type PlanAuditRecord,
  type PlanCloseResult,
  type PlanDocument,
  type PlanReviseInput,
  type PlanStore,
  type PlanWriteInput,
} from "./plan-store.js";

export interface JsonPlanStoreOptions {
  /** 绝对路径；空值/相对路径一律拒绝，不提供任何默认根。 */
  readonly planRoot: string;
  /** 时钟注入（测试固定 now）；缺省 Date.now。 */
  readonly now?: () => number;
}

export interface PlanPaths {
  readonly dir: string;
  readonly json: string;
  readonly markdown: string;
  readonly audit: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existsAt(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** 目标路径（含符号链接解析）必须仍在 planRoot 内；不存在时向上找最近存在祖先。 */
function assertWithinRoot(rootReal: string, target: string): void {
  let probe = resolve(target);
  while (!existsAt(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = realpathSync(probe);
  if (escapesRoot(relative(rootReal, real))) {
    throw new PlanValidationError("path", `拒绝越出 planRoot 的路径: ${target}`);
  }
}

/** 目录 fsync 在部分文件系统上不支持（EINVAL/EPERM），失败不影响数据落盘。 */
function syncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // best effort：rename 已完成，目录项持久化交给文件系统
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不改变已完成的 rename
      }
    }
  }
}

let tmpSeq = 0;

/** 同目录 tmp + fsync + rename：读侧永不见半截；失败清理 tmp 后原样抛出。 */
function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${String(++tmpSeq)}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8" });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    syncDirectory(dirname(file));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 未落地（写失败）时无需清理
    }
    throw error;
  }
}

/** 追加一行审计并 fsync；写满 buffer 前循环处理短写。 */
function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  try {
    const buffer = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function bullet(label: string, value: string): string {
  return `- ${label}: ${value}`;
}

/** 从 JSON 渲染人类可读 Markdown；顺序与条目顺序完全由 JSON 决定。 */
export function renderPlanMarkdown(plan: PlanDocument): string {
  const lines: string[] = [];
  lines.push(`# ${plan.date} 计划`, "");
  lines.push(bullet("状态", plan.status));
  lines.push(bullet("版本", String(plan.version)));
  lines.push(bullet("复查", plan.review_at));
  lines.push(bullet("覆盖档", plan.coverage.profile));
  lines.push(
    bullet(
      "覆盖检查点",
      plan.coverage.checkpoints.length === 0 ? "无" : plan.coverage.checkpoints.join(", "),
    ),
  );
  lines.push(
    bullet("覆盖债", plan.coverage.debt.length === 0 ? "无" : plan.coverage.debt.join(", ")),
  );
  lines.push("", "## 条目", "");
  if (plan.items.length === 0) {
    lines.push("（空计划）", "");
  }
  for (const item of plan.items) {
    lines.push(`### ${item.id} [${item.kind}] ${item.intent}`, "");
    lines.push(bullet("状态", item.status));
    if (item.target_date !== undefined) lines.push(bullet("目标日期", item.target_date));
    if (item.window !== undefined) lines.push(bullet("窗口", item.window));
    if (item.checkpoint_id !== undefined) lines.push(bullet("检查点", item.checkpoint_id));
    if (item.done_when !== undefined) lines.push(bullet("完成条件", item.done_when));
    if (item.not_do !== undefined) lines.push(bullet("不做", item.not_do.join(" | ")));
    if (item.source !== undefined) lines.push(bullet("来源", item.source));
    if (item.note !== undefined) lines.push(bullet("备注", item.note));
    lines.push("");
  }
  lines.push("## 笔记", "");
  if (plan.notes.length === 0) {
    lines.push("（无）");
  } else {
    for (const note of plan.notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

export class JsonPlanStore implements PlanStore {
  private readonly _rootPath: string;
  private readonly _now: () => number;
  private _rootReal: string | null;

  constructor(options: JsonPlanStoreOptions) {
    if (typeof options.planRoot !== "string" || options.planRoot.trim() === "") {
      throw new PlanValidationError("planRoot", "必须是非空绝对路径");
    }
    if (!isAbsolute(options.planRoot)) {
      throw new PlanValidationError("planRoot", `必须是绝对路径: ${options.planRoot}`);
    }
    this._rootPath = resolve(options.planRoot);
    this._now = options.now ?? Date.now;
    if (existsAt(this._rootPath)) {
      if (!statSync(this._rootPath).isDirectory()) {
        throw new PlanValidationError("planRoot", `不是目录: ${this._rootPath}`);
      }
      this._rootReal = realpathSync(this._rootPath);
    } else {
      this._rootReal = null;
    }
  }

  async read(date: string): Promise<PlanDocument> {
    const day = requirePlanDate(date);
    if (this._rootReal === null) throw new PlanNotFoundError(day);
    const paths = this.#pathsInRoot(this._rootReal, day);
    if (!existsAt(paths.json)) throw new PlanNotFoundError(day);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(paths.json, "utf8"));
    } catch (error) {
      throw new PlanValidationError(
        "json",
        `无法解析 ${paths.json}: ${errorMessage(error)}`,
      );
    }
    return validatePlanDocument(parsed, day);
  }

  async write(input: PlanWriteInput): Promise<PlanDocument> {
    const draft = validatePlanWriteInput(input);
    const root = this.#root();
    const paths = this.#pathsInRoot(root, draft.date);
    if (existsAt(paths.json)) {
      const existing = await this.read(draft.date);
      throw new PlanConflictError(draft.date, 0, existing.version);
    }

    const now = this.#timestamp();
    const plan = validatePlanDocument(
      {
        schema: PLAN_SCHEMA,
        date: draft.date,
        status: draft.status,
        version: 1,
        created_at: now,
        updated_at: now,
        review_at: draft.review_at,
        items: draft.items,
        coverage: draft.coverage,
        notes: draft.notes,
      },
      draft.date,
    );
    this.#persist(paths, plan);
    this.#appendAudit(paths, plan.date, "write", plan.version, null, null, now);
    return plan;
  }

  async revise(
    date: string,
    expectedVersion: number,
    patchOrOps: PlanReviseInput,
    reason: string,
  ): Promise<PlanDocument> {
    const day = requirePlanDate(date);
    const expected = requireExpectedVersion(expectedVersion);
    const why = requireReason(reason);
    const current = await this.read(day);
    if (current.version !== expected) {
      throw new PlanConflictError(day, expected, current.version);
    }
    const now = this.#timestamp();
    const revised = revisePlanDocument(current, patchOrOps, now);
    const paths = this.#pathsInRoot(this.#root(), day);
    this.#persist(paths, revised);
    this.#appendAudit(paths, day, "revise", revised.version, expected, why, now);
    return revised;
  }

  async close(date: string, expectedVersion: number, summary: string): Promise<PlanCloseResult> {
    const day = requirePlanDate(date);
    const expected = requireExpectedVersion(expectedVersion);
    const why = requireReason(summary);
    const current = await this.read(day);
    if (current.version !== expected) {
      throw new PlanConflictError(day, expected, current.version);
    }
    const now = this.#timestamp();
    const closed = closePlanDocument(current, now);
    const paths = this.#pathsInRoot(this.#root(), day);
    this.#persist(paths, closed.plan);
    this.#appendAudit(paths, day, "close", closed.plan.version, expected, why, now);
    return { plan: closed.plan, carried: closed.carried, summary: why };
  }

  async appendAudit(date: string, entry: PlanAuditInput): Promise<PlanAuditRecord> {
    const day = requirePlanDate(date);
    const now = this.#timestamp();
    const record = normalizePlanAudit(day, entry, now);
    const paths = this.#pathsInRoot(this.#root(), day);
    appendLine(paths.audit, `${JSON.stringify(record)}\n`);
    return record;
  }

  #timestamp(): number {
    const now = this._now();
    if (typeof now !== "number" || !Number.isInteger(now) || now < 0) {
      throw new PlanValidationError("now", `时钟必须返回非负整数毫秒: ${String(now)}`);
    }
    return now;
  }

  #root(): string {
    if (this._rootReal !== null) return this._rootReal;
    mkdirSync(this._rootPath, { recursive: true });
    if (!statSync(this._rootPath).isDirectory()) {
      throw new PlanValidationError("planRoot", `不是目录: ${this._rootPath}`);
    }
    this._rootReal = realpathSync(this._rootPath);
    return this._rootReal;
  }

  #pathsInRoot(root: string, date: string): PlanPaths {
    const dir = join(root, "daily", date);
    assertWithinRoot(root, dir);
    const json = join(dir, `plan-${date}.json`);
    const markdown = join(dir, `计划-${date}.md`);
    const audit = join(dir, `plan-${date}.audit.jsonl`);
    assertWithinRoot(root, json);
    assertWithinRoot(root, markdown);
    assertWithinRoot(root, audit);
    if (existsAt(dir) && !statSync(dir).isDirectory()) {
      throw new PlanValidationError("path", `计划目录不是目录: ${dir}`);
    }
    return { dir, json, markdown, audit };
  }

  #persist(paths: PlanPaths, plan: PlanDocument): void {
    writeFileAtomic(paths.json, `${JSON.stringify(plan)}\n`);
    writeFileAtomic(paths.markdown, renderPlanMarkdown(plan));
  }

  #appendAudit(
    paths: PlanPaths,
    date: string,
    action: "write" | "revise" | "close",
    version: number,
    expectedVersion: number | null,
    reason: string | null,
    at: number,
  ): void {
    const record = normalizePlanAudit(
      date,
      {
        action,
        version,
        ...(expectedVersion === null ? {} : { expected_version: expectedVersion }),
        ...(reason === null ? {} : { reason }),
        at,
      },
      at,
    );
    appendLine(paths.audit, `${JSON.stringify(record)}\n`);
  }
}
