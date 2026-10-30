/**
 * JsonFlowContinuationStore：简化持续记录的磁盘实现（Todo 25）。
 *
 * 真源 `{stateRoot}/session/{sid}/flow/items/{id}.json`（一条记录一文件）。
 * 旧 `{stateRoot}/session/{sid}/flow/subjects/` 只读：本类从不扫描、写入或删除它，
 * 旧 JsonFlowStore 的读取面保持原样。语义全部委托 MemoryFlowContinuationStore；
 * 本类只负责身份校验、磁盘编解码、原子落盘与重启水合。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
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
  FlowValidationError,
  hydrateFlowContinuation,
  MemoryFlowContinuationStore,
  type FlowContinuation,
  type FlowContinuationCloseInput,
  type FlowContinuationCreateInput,
  type FlowContinuationResumeInput,
  type FlowContinuationStore,
  type FlowContinuationWaitInput,
} from "@axeuh/loom-core";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ITEM_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/;

export interface JsonFlowContinuationStoreOptions {
  readonly stateRoot: string;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_RE.test(value)) {
    throw new FlowValidationError(
      "session_id",
      `必须匹配 ${SESSION_ID_RE.source}: ${String(value)}`,
    );
  }
  return value;
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

/** 目标路径（含符号链接解析）必须仍在 stateRoot 内；不存在时向上找最近存在祖先。 */
function assertWithinRoot(rootReal: string, target: string): void {
  let probe = resolve(target);
  while (!existsAt(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = realpathSync(probe);
  if (escapesRoot(relative(rootReal, real))) {
    throw new FlowValidationError("path", `拒绝越出 stateRoot 的路径: ${target}`);
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
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${String(++tmpSeq)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
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

export class JsonFlowContinuationStore implements FlowContinuationStore {
  private readonly _inner: MemoryFlowContinuationStore;
  private readonly _rootPath: string;
  private _rootReal: string | null;

  constructor(options: JsonFlowContinuationStoreOptions) {
    if (typeof options.stateRoot !== "string" || options.stateRoot.trim() === "") {
      throw new FlowValidationError("stateRoot", "必须是非空路径");
    }
    this._rootPath = resolve(options.stateRoot);
    if (existsAt(this._rootPath)) {
      if (!statSync(this._rootPath).isDirectory()) {
        throw new FlowValidationError("stateRoot", `不是目录: ${this._rootPath}`);
      }
      this._rootReal = realpathSync(this._rootPath);
    } else {
      this._rootReal = null;
    }
    this._inner = new MemoryFlowContinuationStore({
      ...(options.now === undefined ? {} : { now: options.now }),
      initialBySession: this.#load(),
    });
  }

  async create(
    sessionId: string,
    input: FlowContinuationCreateInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const record = await this._inner.create(sid, input);
    this.#persist(sid, record);
    return record;
  }

  async wait(
    sessionId: string,
    input: FlowContinuationWaitInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const record = await this._inner.wait(sid, input);
    this.#persist(sid, record);
    return record;
  }

  async resume(
    sessionId: string,
    input: FlowContinuationResumeInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const record = await this._inner.resume(sid, input);
    this.#persist(sid, record);
    return record;
  }

  async close(
    sessionId: string,
    input: FlowContinuationCloseInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const record = await this._inner.close(sid, input);
    this.#persist(sid, record);
    return record;
  }

  async read(sessionId: string, id: string): Promise<FlowContinuation> {
    return this._inner.read(requireSessionId(sessionId), id);
  }

  async list(sessionId: string): Promise<readonly FlowContinuation[]> {
    return this._inner.list(requireSessionId(sessionId));
  }

  #root(): string {
    if (this._rootReal !== null) return this._rootReal;
    mkdirSync(this._rootPath, { recursive: true });
    this._rootReal = realpathSync(this._rootPath);
    return this._rootReal;
  }

  #itemsDir(sessionId: string): string {
    const root = this.#root();
    const dir = join(root, "session", sessionId, "flow", "items");
    assertWithinRoot(root, dir);
    return dir;
  }

  #persist(sessionId: string, record: FlowContinuation): void {
    const file = join(this.#itemsDir(sessionId), `${record.id}.json`);
    assertWithinRoot(this.#root(), file);
    writeJsonAtomic(file, record);
  }

  #load(): Map<string, readonly unknown[]> {
    const loaded = new Map<string, readonly unknown[]>();
    const root = this._rootReal;
    if (root === null) return loaded;
    const sessionRoot = join(root, "session");
    if (!existsAt(sessionRoot)) return loaded;
    assertWithinRoot(root, sessionRoot);
    for (const name of readdirSync(sessionRoot)) {
      const itemsDir = join(sessionRoot, name, "flow", "items");
      if (!existsAt(itemsDir)) continue;
      assertWithinRoot(root, itemsDir);
      requireSessionId(name);
      const rows: unknown[] = [];
      for (const file of readdirSync(itemsDir)) {
        if (!file.endsWith(".json")) continue;
        const match = ITEM_FILE_RE.exec(file);
        if (match === null) {
          throw new FlowValidationError(
            "id",
            `非法持续记录文件名: ${file}`,
          );
        }
        const id = match[1];
        if (id === undefined) {
          throw new FlowValidationError("id", `非法持续记录文件名: ${file}`);
        }
        const filePath = join(itemsDir, file);
        assertWithinRoot(root, filePath);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(filePath, "utf8"));
        } catch (error) {
          if (isEnoent(error)) continue;
          throw new FlowValidationError(
            "continuation",
            `无法解析持续记录 ${filePath}: ${errorMessage(error)}`,
          );
        }
        rows.push(hydrateFlowContinuation(parsed, id));
      }
      if (rows.length > 0) loaded.set(name, rows);
    }
    return loaded;
  }
}
