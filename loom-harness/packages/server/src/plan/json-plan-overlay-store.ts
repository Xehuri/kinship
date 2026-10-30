/**
 * JsonPlanOverlayStore：日计划 diff 覆盖层的磁盘实现（T06）。
 *
 * 真源 `{planRoot}/daily/{date}/plan-{date}.overlay.json`；
 * 有效视图 `{planRoot}/daily/{date}/计划-{date}.md`；
 * v1 `{planRoot}/daily/{date}/plan-{date}.json` 只读回退，永不写入。
 * 所有写路径统一走 T02 的 `.plan.lock` 文件锁 + 原子写。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { writeJsonAtomic, writeTextAtomic } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import type { MasterPlanDocument } from "./master-plan.js";
import {
  OVERLAY_SCHEMA,
  PlanOverlayClosedError,
  PlanOverlayConflictError,
  PlanOverlayCorruptError,
  PlanOverlayNotFoundError,
  PlanOverlayValidationError,
  assertOverlayBaseFresh,
  effectiveFromLegacyPlan,
  mergeOverlay,
  renderEffectiveMarkdown,
  requireOverlayDate,
  validateCareEntries,
  validatePlanOverlayAgainstMaster,
  validatePlanOverlayDocument,
  validatePlanOverlayReviseInput,
  validatePlanOverlayWriteInput,
  type EffectivePlan,
  type PlanOverlayDocument,
  type PlanOverlayReviseInput,
  type PlanOverlayWriteInput,
} from "./plan-overlay.js";
import { validatePlanDocument, type PlanDocument } from "./plan-store.js";

/** 只读母版来源；生产直接传 JsonMasterPlanStore。 */
export interface MasterPlanReader {
  read(): Promise<MasterPlanDocument>;
}

export interface JsonPlanOverlayStoreOptions {
  /** 显式绝对根；生产应指向 `ai/data`，本层绝不猜测默认路径。 */
  readonly planRoot: string;
  /** 母版只读来源；commit 的 base_version 对账与有效视图渲染都依赖它。 */
  readonly master: MasterPlanReader;
  /** 时钟注入（测试固定时间戳）；缺省 Date.now。 */
  readonly now?: () => number;
  /** 写锁获取超时；缺省交给 withFileLock（2000ms）。 */
  readonly lockTimeoutMs?: number;
  /** 写锁 stale 接管阈值；缺省交给 withFileLock（10000ms）。 */
  readonly lockStaleMs?: number;
}

export interface PlanOverlayPaths {
  readonly dir: string;
  readonly overlay: string;
  readonly markdown: string;
  readonly legacy: string;
  readonly lock: string;
}

export interface PlanOverlayCommitResult {
  readonly overlay: PlanOverlayDocument;
  readonly effective: EffectivePlan;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PlanOverlayValidationError("expectedVersion", `必须是 >=1 的整数: ${String(value)}`);
  }
  return value;
}

export class JsonPlanOverlayStore {
  readonly #root: string;
  readonly #masterReader: MasterPlanReader;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number | undefined;
  readonly #lockStaleMs: number | undefined;

  constructor(options: JsonPlanOverlayStoreOptions) {
    if (typeof options.planRoot !== "string" || options.planRoot.trim() === "") {
      throw new PlanOverlayValidationError("planRoot", "必须是非空绝对路径");
    }
    if (!isAbsolute(options.planRoot)) {
      throw new PlanOverlayValidationError(
        "planRoot",
        `必须是绝对路径（绝不猜测默认根）: ${options.planRoot}`,
      );
    }
    if (typeof options.master?.read !== "function") {
      throw new PlanOverlayValidationError("master", "必须提供只读母版来源");
    }
    this.#root = resolve(options.planRoot);
    this.#masterReader = options.master;
    this.#now = options.now ?? Date.now;
    this.#lockTimeoutMs = options.lockTimeoutMs;
    this.#lockStaleMs = options.lockStaleMs;
  }

  paths(date: string): PlanOverlayPaths {
    const day = requireOverlayDate(date);
    const dir = join(this.#root, "daily", day);
    return {
      dir,
      overlay: join(dir, `plan-${day}.overlay.json`),
      markdown: join(dir, `计划-${day}.md`),
      legacy: join(dir, `plan-${day}.json`),
      lock: join(dir, ".plan.lock"),
    };
  }

  /** 只读覆盖层真源；不存在抛 not-found，schema/JSON 损坏抛 corrupt。 */
  async read(date: string): Promise<PlanOverlayDocument> {
    const day = requireOverlayDate(date);
    return this.#readOverlay(day);
  }

  /**
   * 有效视图：有覆盖层时合并母版；否则回退到 v1 `plan-{date}.json`（只读）。
   * 两者都不存在时抛 not-found。
   */
  async readEffective(date: string): Promise<EffectivePlan> {
    const day = requireOverlayDate(date);
    const paths = this.paths(day);
    const hasOverlay = existsSync(paths.overlay);
    const hasLegacy = existsSync(paths.legacy);
    if (!hasOverlay && !hasLegacy) throw new PlanOverlayNotFoundError(day, paths.overlay);
    const master = await this.#master();
    if (hasOverlay) return mergeOverlay(master, this.#readOverlay(day), day);
    return effectiveFromLegacyPlan(this.#readLegacy(day), master);
  }

  /** 读取 v1 旧日计划；不存在返回 null；损坏抛 corrupt。只读，永不写。 */
  async readLegacy(date: string): Promise<PlanDocument | null> {
    const day = requireOverlayDate(date);
    const paths = this.paths(day);
    return existsSync(paths.legacy) ? this.#readLegacy(day) : null;
  }

  /** 创建 version 1 draft；已有覆盖层（含 closed）抛 conflict。 */
  async write(input: PlanOverlayWriteInput): Promise<PlanOverlayDocument> {
    const draft = validatePlanOverlayWriteInput(input);
    const paths = this.paths(draft.date);
    return withFileLock(
      paths.lock,
      async () => {
        if (existsSync(paths.overlay)) {
          const existing = this.#readOverlay(draft.date);
          throw new PlanOverlayConflictError(draft.date, null, existing.version);
        }
        const now = this.#timestamp();
        const overlay = validatePlanOverlayDocument({
          schema: OVERLAY_SCHEMA,
          kind: "plan-overlay",
          date: draft.date,
          base_version: draft.base_version,
          version: 1,
          status: "draft",
          created_at: now,
          updated_at: now,
          ops: draft.ops,
          notes: draft.notes,
          coverage: draft.coverage,
          ...(draft.user_intent === undefined ? {} : { user_intent: draft.user_intent }),
        });
        const master = await this.#master();
        validateCareEntries(master, overlay, draft.date);
        this.#persist(paths, overlay, master);
        return overlay;
      },
      this.#lockOptions(),
    );
  }

  /**
   * CAS 修订：只对覆盖层 version 做乐观并发，不检查 base_version。
   * 这样母版漂移后仍可先改差量，再由 commit 统一对账。
   */
  async revise(
    date: string,
    expectedVersion: number,
    input: PlanOverlayReviseInput,
  ): Promise<PlanOverlayDocument> {
    const day = requireOverlayDate(date);
    const expected = requireExpectedVersion(expectedVersion);
    const patch = validatePlanOverlayReviseInput(input);
    const paths = this.paths(day);
    return withFileLock(
      paths.lock,
      async () => {
        const current = this.#readOverlay(day);
        if (current.status === "closed") throw new PlanOverlayClosedError(day);
        if (current.version !== expected) {
          throw new PlanOverlayConflictError(day, expected, current.version);
        }
        const now = this.#timestamp();
        const next = validatePlanOverlayDocument({
          ...current,
          base_version: patch.base_version ?? current.base_version,
          ops: patch.ops ?? current.ops,
          coverage: patch.coverage ?? current.coverage,
          notes: [...current.notes, ...(patch.notes_append ?? [])],
          version: current.version + 1,
          updated_at: now,
          ...(patch.user_intent === undefined ? {} : { user_intent: patch.user_intent }),
        });
        const master = await this.#master();
        validateCareEntries(master, next, day, { priorOps: current.ops });
        this.#persist(paths, next, master);
        return next;
      },
      this.#lockOptions(),
    );
  }

  /**
   * CAS 提交：base_version 必须等于当前母版 version，并显式对账 op 目标；
   * 通过后状态转 committed 并渲染有效视图。
   */
  async commit(date: string, expectedVersion: number): Promise<PlanOverlayCommitResult> {
    const day = requireOverlayDate(date);
    const expected = requireExpectedVersion(expectedVersion);
    const paths = this.paths(day);
    return withFileLock(
      paths.lock,
      async () => {
        const current = this.#readOverlay(day);
        if (current.status === "closed") throw new PlanOverlayClosedError(day);
        if (current.version !== expected) {
          throw new PlanOverlayConflictError(day, expected, current.version);
        }
        const master = await this.#master();
        assertOverlayBaseFresh(current, master);
        validatePlanOverlayAgainstMaster(master, current, day);
        const now = this.#timestamp();
        const next = validatePlanOverlayDocument({
          ...current,
          status: "committed",
          version: current.version + 1,
          updated_at: now,
        });
        this.#persist(paths, next, master);
        return { overlay: next, effective: mergeOverlay(master, next, day) };
      },
      this.#lockOptions(),
    );
  }

  /** CAS 收口；closed 后 revise/commit/close 一律拒绝。 */
  async close(date: string, expectedVersion: number): Promise<PlanOverlayDocument> {
    const day = requireOverlayDate(date);
    const expected = requireExpectedVersion(expectedVersion);
    const paths = this.paths(day);
    return withFileLock(
      paths.lock,
      async () => {
        const current = this.#readOverlay(day);
        if (current.status === "closed") throw new PlanOverlayClosedError(day);
        if (current.version !== expected) {
          throw new PlanOverlayConflictError(day, expected, current.version);
        }
        const now = this.#timestamp();
        const next = validatePlanOverlayDocument({
          ...current,
          status: "closed",
          version: current.version + 1,
          updated_at: now,
        });
        const master = await this.#master();
        this.#persist(paths, next, master);
        return next;
      },
      this.#lockOptions(),
    );
  }

  async #master(): Promise<MasterPlanDocument> {
    return this.#masterReader.read();
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
      throw new PlanOverlayValidationError("now", `时钟必须返回非负整数毫秒: ${String(now)}`);
    }
    return now;
  }

  #readOverlay(date: string): PlanOverlayDocument {
    const paths = this.paths(date);
    if (!existsSync(paths.overlay)) throw new PlanOverlayNotFoundError(date, paths.overlay);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(paths.overlay, "utf8"));
    } catch (error) {
      throw new PlanOverlayCorruptError(
        paths.overlay,
        `无法解析 JSON: ${errorMessage(error)}`,
        error,
      );
    }
    try {
      return validatePlanOverlayDocument(parsed);
    } catch (error) {
      if (error instanceof PlanOverlayValidationError) {
        throw new PlanOverlayCorruptError(paths.overlay, error.message, error);
      }
      throw error;
    }
  }

  #readLegacy(date: string): PlanDocument {
    const paths = this.paths(date);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(paths.legacy, "utf8"));
    } catch (error) {
      throw new PlanOverlayCorruptError(
        paths.legacy,
        `无法解析 JSON: ${errorMessage(error)}`,
        error,
      );
    }
    try {
      return validatePlanDocument(parsed, date);
    } catch (error) {
      throw new PlanOverlayCorruptError(paths.legacy, errorMessage(error), error);
    }
  }

  #persist(
    paths: PlanOverlayPaths,
    overlay: PlanOverlayDocument,
    master: MasterPlanDocument,
  ): void {
    writeJsonAtomic(paths.overlay, overlay);
    writeTextAtomic(paths.markdown, renderEffectiveMarkdown(mergeOverlay(master, overlay, overlay.date)));
  }
}
