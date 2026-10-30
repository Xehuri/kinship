/**
 * W57 压缩状态 sidecar（P1 核心原语）。
 *
 * 布局：`<stateRoot>/session/compaction-state/<sid>.json`，内容为版本包装
 * `{version: 1, body: CompactionState}`，与 PLAN §Sidecar 一致。
 *
 * 纪律：
 * - 写：mkdir + 同目录 tmp + rename（读侧永不见半截）；失败清理 tmp 后原样抛错。
 * - 读：文件缺失 = "missing"，JSON/形状/版本坏 = "corrupt"，两者 state 均为 null，
 *   **绝不向调用方抛错**（boot 恢复不能因一份坏 sidecar 挂掉）。
 * - 文件名：安全 sid 原样保留；其余字符替换并追加原串 hash 前缀，杜绝路径逃逸与碰撞。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCompactionState, type CompactionState } from "./compaction-state.js";

/** 包装版本独立于 body.version，便于将来只升级外层而不动状态形状。 */
export const COMPACTION_STATE_SIDECAR_VERSION = 1 as const;

const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SANITIZED_PREFIX = 100;
let tempSeq = 0;

/**
 * 安全 sid 原样返回（保持可读的 `<sid>.json`）；含 `/`、`..`、空白等字符时
 * 做字符替换并追加 12 位 sha256 前缀，保证不同 sid 不落进同一文件。
 */
export function sanitizeSessionIdForFilename(sessionID: string): string {
  if (SAFE_FILENAME_RE.test(sessionID)) return sessionID;
  const cleaned = sessionID
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_SANITIZED_PREFIX);
  const digest = createHash("sha256").update(sessionID, "utf8").digest("hex").slice(0, 12);
  return cleaned.length > 0 ? `${cleaned}-${digest}` : `sid-${digest}`;
}

/** 纯路径计算（不建目录、不读盘）；所有 sidecar 路径的唯一真源。 */
export function compactionStateSidecarPath(stateRoot: string, sessionID: string): string {
  return join(
    stateRoot,
    "session",
    "compaction-state",
    `${sanitizeSessionIdForFilename(sessionID)}.json`,
  );
}

export type CompactionStateReadResult =
  | { readonly kind: "ok"; readonly state: CompactionState; readonly path: string }
  | { readonly kind: "missing"; readonly state: null; readonly path: string }
  | {
      readonly kind: "corrupt";
      readonly state: null;
      readonly path: string;
      readonly error: string;
    };

export interface CompactionStateStoreOptions {
  /** 实例 state 根（通常是 `<instance>/.loom`）；本类只在其下建 session/compaction-state。 */
  readonly stateRoot: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return asRecord(error)?.["code"] === code;
}

function corrupt(path: string, error: string): CompactionStateReadResult {
  return { kind: "corrupt", state: null, path, error };
}

export class CompactionStateStore {
  readonly #dir: string;

  constructor(options: CompactionStateStoreOptions) {
    if (options.stateRoot.length === 0) {
      throw new Error("CompactionStateStore: stateRoot must be non-empty");
    }
    this.#dir = join(options.stateRoot, "session", "compaction-state");
  }

  pathFor(sessionID: string): string {
    return join(this.#dir, `${sanitizeSessionIdForFilename(sessionID)}.json`);
  }

  /** 缺失/读坏/JSON 坏/形状坏一律 null 结果；不抛异常。 */
  read(sessionID: string): CompactionStateReadResult {
    const path = this.pathFor(sessionID);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { kind: "missing", state: null, path };
      return corrupt(path, `read failed: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return corrupt(path, `invalid JSON: ${errorMessage(error)}`);
    }
    const wrapper = asRecord(parsed);
    if (wrapper === null) return corrupt(path, "sidecar top level is not an object");
    if (wrapper["version"] !== COMPACTION_STATE_SIDECAR_VERSION) {
      return corrupt(
        path,
        `unsupported sidecar version: ${String(wrapper["version"])}`,
      );
    }
    const body = wrapper["body"];
    if (!isCompactionState(body)) return corrupt(path, "invalid compaction state body");
    return { kind: "ok", state: body, path };
  }

  /** 原子覆盖写；返回落盘路径。非法 state 会在写盘前抛 TypeError。 */
  write(sessionID: string, state: CompactionState): string {
    if (!isCompactionState(state)) {
      throw new TypeError("CompactionStateStore.write: invalid CompactionState");
    }
    const path = this.pathFor(sessionID);
    mkdirSync(this.#dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${++tempSeq}.tmp`;
    const payload = `${JSON.stringify({
      version: COMPACTION_STATE_SIDECAR_VERSION,
      body: state,
    })}\n`;
    try {
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 失败路径 tmp 可能尚未创建或已被 rename */
      }
      throw error;
    }
    return path;
  }
}
