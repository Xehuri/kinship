/**
 * JsonMasterPlanStore：Master Plan 的磁盘实现（T04）。
 *
 * 真源 `{planRoot}/plan/master.json`；派生人读视图 `{planRoot}/plan/master.md`；
 * 最近一次成功写入的备份 `{planRoot}/plan/master.last-good.json`。
 * 所有写路径统一走 T02 的跨实例文件锁 + 原子写；读路径永不创建文件。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { writeJsonAtomic, writeTextAtomic } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import {
  MASTER_SCHEMA,
  MasterPlanConflictError,
  MasterPlanCorruptError,
  MasterPlanNotFoundError,
  MasterPlanValidationError,
  applyMasterEditOps,
  renderMasterMarkdown,
  validateMasterEditOps,
  validateMasterPlanDocument,
  type MasterEditOp,
  type MasterPlanDocument,
} from "./master-plan.js";

export interface JsonMasterPlanStoreOptions {
  /** 显式绝对根；生产应指向 `ai/data`，本层绝不猜测默认路径。 */
  readonly planRoot: string;
  /** 时钟注入（测试固定时间戳）；缺省 Date.now。 */
  readonly now?: () => number;
  /** 写锁获取超时；缺省交给 withFileLock（2000ms）。 */
  readonly lockTimeoutMs?: number;
  /** 写锁 stale 接管阈值；缺省交给 withFileLock（10000ms）。 */
  readonly lockStaleMs?: number;
}

export interface MasterPlanPaths {
  readonly dir: string;
  readonly json: string;
  readonly markdown: string;
  readonly lastGood: string;
  readonly lock: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireExpectedVersion(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new MasterPlanValidationError(
      "expectedVersion",
      `必须是 null 或 >=1 的整数: ${String(value)}`,
    );
  }
  return value;
}

function requireReason(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MasterPlanValidationError("reason", "必须是非空字符串");
  }
  return value;
}

export class JsonMasterPlanStore {
  readonly #root: string;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number | undefined;
  readonly #lockStaleMs: number | undefined;

  constructor(options: JsonMasterPlanStoreOptions) {
    if (typeof options.planRoot !== "string" || options.planRoot.trim() === "") {
      throw new MasterPlanValidationError("planRoot", "必须是非空绝对路径");
    }
    if (!isAbsolute(options.planRoot)) {
      throw new MasterPlanValidationError(
        "planRoot",
        `必须是绝对路径（绝不猜测默认根）: ${options.planRoot}`,
      );
    }
    this.#root = resolve(options.planRoot);
    this.#now = options.now ?? Date.now;
    this.#lockTimeoutMs = options.lockTimeoutMs;
    this.#lockStaleMs = options.lockStaleMs;
  }

  paths(): MasterPlanPaths {
    const dir = join(this.#root, "plan");
    return {
      dir,
      json: join(dir, "master.json"),
      markdown: join(dir, "master.md"),
      lastGood: join(dir, "master.last-good.json"),
      lock: join(dir, ".master.lock"),
    };
  }

  async read(): Promise<MasterPlanDocument> {
    const paths = this.paths();
    if (!existsSync(paths.json)) throw new MasterPlanNotFoundError(paths.json);
    return this.#readDocument(paths.json);
  }

  async write(
    document: MasterPlanDocument,
    expectedVersion: number | null,
  ): Promise<MasterPlanDocument> {
    const draft = validateMasterPlanDocument(document);
    const expected = requireExpectedVersion(expectedVersion);
    const paths = this.paths();
    return withFileLock(
      paths.lock,
      () => {
        const current = existsSync(paths.json) ? this.#readDocument(paths.json) : null;
        if (expected === null) {
          if (current !== null) {
            throw new MasterPlanConflictError(null, current.version);
          }
        } else {
          const actual = current?.version ?? 0;
          if (actual !== expected) throw new MasterPlanConflictError(expected, actual);
        }
        const now = this.#timestamp();
        const next = validateMasterPlanDocument({
          ...draft,
          version: current === null ? 1 : expected === null ? 1 : expected + 1,
          created_at: current === null ? draft.created_at : current.created_at,
          updated_at: now,
        });
        this.#persist(paths, next);
        return next;
      },
      this.#lockOptions(),
    );
  }

  async edit(
    ops: unknown,
    expectedVersion: number,
    reason: string,
  ): Promise<MasterPlanDocument> {
    const expected = requireExpectedVersion(expectedVersion);
    if (expected === null) {
      throw new MasterPlanValidationError("expectedVersion", "edit 不接受 null");
    }
    requireReason(reason);
    const validated: readonly MasterEditOp[] = validateMasterEditOps(ops);
    const paths = this.paths();
    return withFileLock(
      paths.lock,
      () => {
        if (!existsSync(paths.json)) throw new MasterPlanNotFoundError(paths.json);
        const current = this.#readDocument(paths.json);
        if (current.version !== expected) {
          throw new MasterPlanConflictError(expected, current.version);
        }
        const now = this.#timestamp();
        const entries = applyMasterEditOps(current, validated, now);
        const next = validateMasterPlanDocument({
          schema: MASTER_SCHEMA,
          kind: "master-plan",
          timezone: current.timezone,
          version: current.version + 1,
          created_at: current.created_at,
          updated_at: now,
          entries,
        });
        this.#persist(paths, next);
        return next;
      },
      this.#lockOptions(),
    );
  }

  /**
   * 最近一次成功写入的文档。主文件可读时返回主文件；只有主文件损坏时才
   * 回落到 last-good 备份。主文件不存在不算损坏，直接抛 not-found。
   */
  async readLastGood(): Promise<MasterPlanDocument> {
    const paths = this.paths();
    if (!existsSync(paths.json)) throw new MasterPlanNotFoundError(paths.json);
    try {
      return this.#readDocument(paths.json);
    } catch (error) {
      if (!(error instanceof MasterPlanCorruptError)) throw error;
      if (!existsSync(paths.lastGood)) throw error;
      try {
        return this.#readDocument(paths.lastGood);
      } catch (fallbackError) {
        throw new MasterPlanCorruptError(
          paths.lastGood,
          `主文件损坏且 last-good 不可用：${errorMessage(fallbackError)}`,
          fallbackError,
        );
      }
    }
  }

  /** readLastGood 的同义入口，供调用方按语义命名。 */
  async lastGood(): Promise<MasterPlanDocument> {
    return this.readLastGood();
  }

  #lockOptions(): { timeoutMs?: number; staleMs?: number } {
    return {
      ...(this.#lockTimeoutMs === undefined ? {} : { timeoutMs: this.#lockTimeoutMs }),
      ...(this.#lockStaleMs === undefined ? {} : { staleMs: this.#lockStaleMs }),
    };
  }

  #timestamp(): number {
    const now = this.#now();
    if (!Number.isInteger(now) || now < 0) {
      throw new MasterPlanValidationError("now", `时钟必须返回非负整数毫秒: ${String(now)}`);
    }
    return now;
  }

  #readDocument(path: string): MasterPlanDocument {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new MasterPlanCorruptError(path, `无法解析 JSON: ${errorMessage(error)}`, error);
    }
    try {
      return validateMasterPlanDocument(parsed);
    } catch (error) {
      throw new MasterPlanCorruptError(path, errorMessage(error), error);
    }
  }

  #persist(paths: MasterPlanPaths, document: MasterPlanDocument): void {
    writeJsonAtomic(paths.json, document);
    writeTextAtomic(paths.markdown, renderMasterMarkdown(document));
    writeJsonAtomic(paths.lastGood, document);
  }
}
