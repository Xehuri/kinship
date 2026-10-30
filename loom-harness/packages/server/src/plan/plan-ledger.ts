/**
 * PlanLedger：日计划的只追加事件账本（T07）。
 *
 * 真源 `{planRoot}/daily/{date}/plan-ledger.jsonl`，每行一条
 * `{schema:1, at, date, source, event, entry_id?, status?, version?, reason?}`。
 * 追加走 O_APPEND 单次 write（不截断、不改写历史）；读取对坏行宽容，
 * 跳过无法解析或结构不符的行，绝不让一行脏数据阻塞整日计划。
 *
 * 账本只记录事实，不承担并发写状态：同一行的完整性由 O_APPEND 的单次
 * write 保证，调用方不需要 CAS（版本号在行里仅作审计）。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { requireOverlayDate } from "./plan-overlay.js";

export const PLAN_LEDGER_SCHEMA = 1 as const;
export const PLAN_LEDGER_SOURCES = ["plan", "scheduler"] as const;
export type PlanLedgerSource = (typeof PLAN_LEDGER_SOURCES)[number];

export interface PlanLedgerRow {
  readonly schema: typeof PLAN_LEDGER_SCHEMA;
  /** Unix epoch 毫秒，与 plan 各 store 的时间戳同口径。 */
  readonly at: number;
  readonly date: string;
  readonly source: PlanLedgerSource;
  readonly event: string;
  readonly entry_id?: string;
  readonly status?: string;
  readonly version?: number;
  readonly reason?: string;
}

export interface PlanLedgerAppendInput {
  readonly date: string;
  readonly source: PlanLedgerSource;
  readonly event: string;
  readonly entry_id?: string;
  readonly status?: string;
  readonly version?: number;
  readonly reason?: string;
}

export interface PlanLedgerOptions {
  /** 显式绝对根；生产指向 `ai/data`，本层绝不猜默认路径。 */
  readonly planRoot: string;
  /** 时钟注入（测试固定时间戳）；缺省 Date.now。 */
  readonly now?: () => number;
}

export interface PlanLedgerPaths {
  readonly dir: string;
  readonly ledger: string;
}

export class PlanLedgerValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[plan-ledger:validation] ${field}: ${message}`);
    this.name = "PlanLedgerValidationError";
    this.field = field;
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanLedgerValidationError(field, `必须是非空字符串: ${describe(value)}`);
  }
  return value;
}

function requireSource(value: unknown): PlanLedgerSource {
  if (
    typeof value !== "string" ||
    !(PLAN_LEDGER_SOURCES as readonly string[]).includes(value)
  ) {
    throw new PlanLedgerValidationError(
      "source",
      `必须是 ${PLAN_LEDGER_SOURCES.join(" | ")} 之一: ${describe(value)}`,
    );
  }
  return value as PlanLedgerSource;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, field);
}

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PlanLedgerValidationError("version", `必须是 >=1 的整数: ${describe(value)}`);
  }
  return value;
}

function validateAppendInput(input: unknown, at: number): PlanLedgerRow {
  if (!isRecord(input)) {
    throw new PlanLedgerValidationError("row", `必须是对象: ${describe(input)}`);
  }
  const date = requireOverlayDate(input["date"]);
  const source = requireSource(input["source"]);
  const event = requireNonEmptyString(input["event"], "event");
  const entryId = optionalNonEmptyString(input["entry_id"], "entry_id");
  const status = optionalNonEmptyString(input["status"], "status");
  const version = optionalVersion(input["version"]);
  const reason = optionalNonEmptyString(input["reason"], "reason");
  return {
    schema: PLAN_LEDGER_SCHEMA,
    at,
    date,
    source,
    event,
    ...(entryId === undefined ? {} : { entry_id: entryId }),
    ...(status === undefined ? {} : { status }),
    ...(version === undefined ? {} : { version }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** 宽容解析单行：核心字段不合法返回 null，可选字段类型不符同样丢弃。 */
function parseLedgerRow(line: string, date: string): PlanLedgerRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed["schema"] !== PLAN_LEDGER_SCHEMA) return null;
  if (typeof parsed["at"] !== "number" || !Number.isFinite(parsed["at"])) return null;
  if (parsed["date"] !== date) return null;
  if (
    typeof parsed["source"] !== "string" ||
    !(PLAN_LEDGER_SOURCES as readonly string[]).includes(parsed["source"])
  ) {
    return null;
  }
  if (typeof parsed["event"] !== "string" || parsed["event"].trim() === "") return null;

  const entryId = parsed["entry_id"];
  const status = parsed["status"];
  const version = parsed["version"];
  const reason = parsed["reason"];
  if (entryId !== undefined && (typeof entryId !== "string" || entryId.trim() === "")) return null;
  if (status !== undefined && (typeof status !== "string" || status.trim() === "")) return null;
  if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
    return null;
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "")) return null;

  const row: PlanLedgerRow = {
    schema: PLAN_LEDGER_SCHEMA,
    at: parsed["at"],
    date,
    source: parsed["source"] as PlanLedgerSource,
    event: parsed["event"],
    ...(entryId === undefined ? {} : { entry_id: entryId }),
    ...(status === undefined ? {} : { status }),
    ...(version === undefined ? {} : { version }),
    ...(reason === undefined ? {} : { reason }),
  };
  return row;
}

export class PlanLedger {
  readonly #root: string;
  readonly #now: () => number;

  constructor(options: PlanLedgerOptions) {
    if (typeof options.planRoot !== "string" || options.planRoot.trim() === "") {
      throw new PlanLedgerValidationError("planRoot", "必须是非空绝对路径");
    }
    if (!isAbsolute(options.planRoot)) {
      throw new PlanLedgerValidationError(
        "planRoot",
        `必须是绝对路径（绝不猜测默认根）: ${options.planRoot}`,
      );
    }
    this.#root = resolve(options.planRoot);
    this.#now = options.now ?? Date.now;
  }

  paths(date: string): PlanLedgerPaths {
    const day = requireOverlayDate(date);
    const dir = join(this.#root, "daily", day);
    return { dir, ledger: join(dir, "plan-ledger.jsonl") };
  }

  /**
   * O_APPEND 单次写一行。同一进程内同步完成，跨进程并发由内核 O_APPEND
   * 的偏移原子性保证；绝不 open 截断、绝不重写历史行。
   */
  async append(input: PlanLedgerAppendInput): Promise<PlanLedgerRow> {
    const now = this.#timestamp();
    const row = validateAppendInput(input, now);
    const paths = this.paths(row.date);
    mkdirSync(paths.dir, { recursive: true });
    const line = `${JSON.stringify(row)}\n`;
    const fd = openSync(paths.ledger, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return row;
  }

  /** 按文件顺序返回全部合法行；文件不存在返回空数组。 */
  async read(date: string): Promise<readonly PlanLedgerRow[]> {
    const day = requireOverlayDate(date);
    const paths = this.paths(day);
    if (!existsSync(paths.ledger)) return [];
    const text = readFileSync(paths.ledger, "utf8");
    const rows: PlanLedgerRow[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const row = parseLedgerRow(trimmed, day);
      if (row !== null) rows.push(row);
    }
    return rows;
  }

  /** 最近 limit 行；limit<=0 返回空数组。 */
  async tail(date: string, limit = 20): Promise<readonly PlanLedgerRow[]> {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new PlanLedgerValidationError("limit", `必须是非负整数: ${describe(limit)}`);
    }
    if (limit === 0) return [];
    const rows = await this.read(date);
    return rows.slice(-limit);
  }

  #timestamp(): number {
    const now = this.#now();
    if (!Number.isInteger(now) || now < 0) {
      throw new PlanLedgerValidationError("now", `时钟必须返回非负整数毫秒: ${String(now)}`);
    }
    return now;
  }
}
