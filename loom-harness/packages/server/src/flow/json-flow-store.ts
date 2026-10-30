/**
 * JsonFlowStore：FlowStore 的磁盘实现（L1）。
 *
 * 真源 `{stateRoot}/session/{sessionID}/flow/subjects/{subjectID}.json`（一主体一文件）；
 * 派生 `{stateRoot}/session/{sessionID}/flow/index.json`（可重建，绝不作为真源）；
 * 审计 `{stateRoot}/session/{sessionID}/flow/unset.jsonl`（只追加，1MB 单次轮转）。
 *
 * CAS/closed/限额/默认主体/重名等语义全部委托 MemoryFlowStore；
 * 本类只负责身份校验、磁盘编解码、原子落盘与重启水合。
 */

import {
  appendFileSync,
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
  FLOW_SUBJECT_SCHEMA,
  FlowValidationError,
  MemoryFlowStore,
  type FlowCommitInput,
  type FlowCommitOptions,
  type FlowCommitResult,
  type FlowDefaultOptions,
  type FlowLimits,
  type FlowStore,
  type FlowSubject,
  type FlowUnsetInput,
  type FlowUnsetRecord,
} from "@axeuh/loom-core";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_FILE_RE = /^flow_[0-9a-f]{12}\.json$/;
const SUBJECT_ID_RE = /^flow_[0-9a-f]{12}$/;
const UNSET_FILE = "unset.jsonl";
const UNSET_ROTATED_FILE = "unset.jsonl.1";
const INDEX_FILE = "index.json";
export const FLOW_UNSET_ROTATE_BYTES = 1024 * 1024;

export interface JsonFlowStoreOptions {
  readonly stateRoot: string;
  /** 时钟注入（测试固定 now）；缺省 Date.now。 */
  readonly now?: () => number;
  /** subject_id 生成器；缺省 crypto 随机。 */
  readonly idFactory?: () => string;
  /** unset 落盘成功后的观察回调；回调自炸吞断（观察面绝不反噬审计写入）。 */
  readonly onUnset?: (record: FlowUnsetRecord) => void;
  /** 容量与 notes 限额；缺省 = FLOW_LIMITS（委托 MemoryFlowStore 兜底）。 */
  readonly limits?: FlowLimits;
}

interface LoadedState {
  readonly subjects: readonly unknown[];
  readonly unsets: readonly unknown[];
  readonly sessionIndex: ReadonlyMap<string, readonly string[]>;
}

interface LoadedSubjects {
  readonly rows: readonly unknown[];
  readonly ids: readonly string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
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

let tmpSeq = 0;

/** 同目录 tmp + rename：读侧永不见半截；失败清理 tmp 后原样抛出。 */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${String(++tmpSeq)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 未落地（写失败）时无需清理
    }
    throw error;
  }
}

function rotateUnsetFile(flowDir: string): void {
  try {
    renameSync(join(flowDir, UNSET_FILE), join(flowDir, UNSET_ROTATED_FILE));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export class JsonFlowStore implements FlowStore {
  private readonly _inner: MemoryFlowStore;
  private readonly _rootPath: string;
  private readonly _now: () => number;
  private readonly _onUnset: ((record: FlowUnsetRecord) => void) | undefined;
  private readonly _unsetSizes = new Map<string, number>();
  private _rootReal: string | null;

  constructor(options: JsonFlowStoreOptions) {
    if (typeof options.stateRoot !== "string" || options.stateRoot.trim() === "") {
      throw new FlowValidationError("stateRoot", "必须是非空路径");
    }
    this._rootPath = resolve(options.stateRoot);
    this._now = options.now ?? Date.now;
    this._onUnset = options.onUnset;
    if (existsAt(this._rootPath)) {
      if (!statSync(this._rootPath).isDirectory()) {
        throw new FlowValidationError("stateRoot", `不是目录: ${this._rootPath}`);
      }
      this._rootReal = realpathSync(this._rootPath);
    } else {
      this._rootReal = null;
    }
    const loaded = this.#load();
    const memoryOptions = {
      now: this._now,
      initialSubjects: loaded.subjects,
      initialUnsets: loaded.unsets,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    };
    this._inner = new MemoryFlowStore(memoryOptions);
    for (const [sessionId, ids] of loaded.sessionIndex) {
      this.#writeIndexFrom(sessionId, ids);
    }
  }

  async list(sessionId: string): Promise<readonly FlowSubject[]> {
    return this._inner.list(requireSessionId(sessionId));
  }

  async get(subjectId: string): Promise<FlowSubject | null> {
    return this._inner.get(subjectId);
  }

  async findByName(sessionId: string, subjectName: string): Promise<FlowSubject | null> {
    return this._inner.findByName(requireSessionId(sessionId), subjectName);
  }

  async ensureDefault(
    sessionId: string,
    options: FlowDefaultOptions = {},
  ): Promise<FlowSubject | null> {
    const sid = requireSessionId(sessionId);
    const subject = await this._inner.ensureDefault(sid, options);
    if (subject !== null) {
      this.#persistSubject(subject);
      await this.#writeIndex(sid);
    }
    return subject;
  }

  async commit(
    sessionId: string,
    input: FlowCommitInput,
    options: FlowCommitOptions,
  ): Promise<FlowCommitResult> {
    const sid = requireSessionId(sessionId);
    const result = await this._inner.commit(sid, input, options);
    this.#persistSubject(result.subject);
    await this.#writeIndex(sid);
    return result;
  }

  async appendUnset(sessionId: string, input: FlowUnsetInput): Promise<FlowUnsetRecord> {
    const sid = requireSessionId(sessionId);
    const record = await this._inner.appendUnset(sid, input);
    this.#persistUnset(record);
    try {
      this._onUnset?.(record);
    } catch {
      /* 观察回调自炸吞断：unset 审计已落盘，不影响调用方 */
    }
    return record;
  }

  async listSessionIds(): Promise<readonly string[]> {
    return this._inner.listSessionIds();
  }

  async earliestPending(sessionId: string, now?: number): Promise<FlowSubject | null> {
    const sid = requireSessionId(sessionId);
    return now === undefined
      ? this._inner.earliestPending(sid)
      : this._inner.earliestPending(sid, now);
  }

  #root(): string {
    if (this._rootReal !== null) return this._rootReal;
    mkdirSync(this._rootPath, { recursive: true });
    this._rootReal = realpathSync(this._rootPath);
    return this._rootReal;
  }

  #flowDir(sessionId: string): string {
    const root = this.#root();
    const dir = join(root, "session", sessionId, "flow");
    assertWithinRoot(root, dir);
    return dir;
  }

  #persistSubject(subject: FlowSubject): void {
    const dir = this.#flowDir(subject.session_id);
    const file = join(dir, "subjects", `${subject.subject_id}.json`);
    assertWithinRoot(this.#root(), file);
    writeJsonAtomic(file, subject);
  }

  #persistUnset(record: FlowUnsetRecord): void {
    const dir = this.#flowDir(record.session_id);
    mkdirSync(dir, { recursive: true });
    const main = join(dir, UNSET_FILE);
    assertWithinRoot(this.#root(), main);
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    const current =
      this._unsetSizes.get(record.session_id) ?? (existsAt(main) ? statSync(main).size : 0);
    const rotate = current > 0 && current + bytes > FLOW_UNSET_ROTATE_BYTES;
    if (rotate) {
      assertWithinRoot(this.#root(), join(dir, UNSET_ROTATED_FILE));
      rotateUnsetFile(dir);
    }
    appendFileSync(main, line, "utf8");
    this._unsetSizes.set(record.session_id, rotate ? bytes : current + bytes);
  }

  async #writeIndex(sessionId: string): Promise<void> {
    const subjects = await this._inner.list(sessionId);
    if (subjects.length === 0) return;
    this.#writeIndexFrom(
      sessionId,
      subjects.map((subject) => subject.subject_id),
    );
  }

  /** 派生索引写失败不反噬真源：下次提交或重启重建时自愈。 */
  #writeIndexFrom(sessionId: string, subjectIds: readonly string[]): void {
    if (subjectIds.length === 0) return;
    const file = join(this.#flowDir(sessionId), INDEX_FILE);
    assertWithinRoot(this.#root(), file);
    const payload = {
      schema: FLOW_SUBJECT_SCHEMA,
      session_id: sessionId,
      updated_at: this._now(),
      subject_ids: [...subjectIds],
    };
    try {
      writeJsonAtomic(file, payload);
    } catch {
      // 索引是派生物，真源已落盘；下次启动从主体文件重建
    }
  }

  #load(): LoadedState {
    const empty: LoadedState = { subjects: [], unsets: [], sessionIndex: new Map() };
    const root = this._rootReal;
    if (root === null) return empty;
    const sessionRoot = join(root, "session");
    if (!existsAt(sessionRoot)) return empty;
    assertWithinRoot(root, sessionRoot);
    const subjects: unknown[] = [];
    const unsets: unknown[] = [];
    const sessionIndex = new Map<string, readonly string[]>();
    for (const name of readdirSync(sessionRoot)) {
      const flowDir = join(sessionRoot, name, "flow");
      if (!existsAt(flowDir)) continue;
      assertWithinRoot(root, flowDir);
      requireSessionId(name);
      const loaded = this.#loadSubjects(flowDir, name, root);
      if (loaded.rows.length > 0) {
        subjects.push(...loaded.rows);
        sessionIndex.set(name, loaded.ids);
      }
      unsets.push(...this.#loadUnsets(flowDir, name, root));
      const main = join(flowDir, UNSET_FILE);
      if (existsAt(main)) this._unsetSizes.set(name, statSync(main).size);
    }
    return { subjects, unsets, sessionIndex };
  }

  #loadSubjects(flowDir: string, sessionId: string, root: string): LoadedSubjects {
    const subjectsDir = join(flowDir, "subjects");
    if (!existsAt(subjectsDir)) return { rows: [], ids: [] };
    assertWithinRoot(root, subjectsDir);
    const indexOrder = this.#readIndex(flowDir, sessionId, root);
    const byId = new Map<string, unknown>();
    const writtenAt = new Map<string, number>();
    for (const file of readdirSync(subjectsDir)) {
      if (!file.endsWith(".json")) continue;
      if (!SUBJECT_FILE_RE.test(file)) {
        throw new FlowValidationError("subject_id", `非法主体文件名: ${file}`);
      }
      const filePath = join(subjectsDir, file);
      assertWithinRoot(root, filePath);
      const subjectId = file.slice(0, -".json".length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8"));
      } catch (error) {
        throw new FlowValidationError(
          "subject",
          `无法解析主体文件 ${filePath}: ${errorMessage(error)}`,
        );
      }
      if (
        !isRecord(parsed) ||
        parsed["subject_id"] !== subjectId ||
        parsed["session_id"] !== sessionId
      ) {
        throw new FlowValidationError("subject", `主体文件身份不一致: ${filePath}`);
      }
      byId.set(subjectId, parsed);
      writtenAt.set(subjectId, statSync(filePath).mtimeMs);
    }
    const ids: string[] = [];
    const rows: unknown[] = [];
    if (indexOrder !== null) {
      for (const subjectId of indexOrder) {
        if (!byId.has(subjectId)) continue;
        ids.push(subjectId);
        rows.push(byId.get(subjectId));
        byId.delete(subjectId);
      }
    }
    const rest = [...byId.entries()].sort((a, b) => {
      const atA = createdMillis(a[1]);
      const atB = createdMillis(b[1]);
      if (atA !== atB) return atA - atB;
      const writtenA = writtenAt.get(a[0]) ?? 0;
      const writtenB = writtenAt.get(b[0]) ?? 0;
      if (writtenA !== writtenB) return writtenA - writtenB;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    for (const [subjectId, row] of rest) {
      ids.push(subjectId);
      rows.push(row);
    }
    return { rows, ids };
  }

  #readIndex(flowDir: string, sessionId: string, root: string): readonly string[] | null {
    const file = join(flowDir, INDEX_FILE);
    if (!existsAt(file)) return null;
    assertWithinRoot(root, file);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (
        !isRecord(parsed) ||
        parsed["schema"] !== FLOW_SUBJECT_SCHEMA ||
        parsed["session_id"] !== sessionId ||
        !Array.isArray(parsed["subject_ids"])
      ) {
        return null;
      }
      const ids: string[] = [];
      for (const id of parsed["subject_ids"]) {
        if (typeof id !== "string" || !SUBJECT_ID_RE.test(id)) return null;
        ids.push(id);
      }
      return ids;
    } catch (error) {
      if (error instanceof FlowValidationError) throw error;
      return null;
    }
  }

  #loadUnsets(flowDir: string, sessionId: string, root: string): readonly unknown[] {
    const rows: unknown[] = [];
    for (const name of [UNSET_ROTATED_FILE, UNSET_FILE]) {
      const file = join(flowDir, name);
      if (!existsAt(file)) continue;
      assertWithinRoot(root, file);
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          const trailing = index === lines.length - 1 && !content.endsWith("\n");
          if (trailing) continue;
          throw new FlowValidationError(
            "unset",
            `无法解析 ${file}:${String(index + 1)}: ${errorMessage(error)}`,
          );
        }
        if (!isRecord(parsed) || parsed["session_id"] !== sessionId) {
          throw new FlowValidationError("unset", `${file}:${String(index + 1)} 身份不一致`);
        }
        rows.push(parsed);
      }
    }
    return rows;
  }
}

function createdMillis(row: unknown): number {
  if (!isRecord(row)) return 0;
  const created = row["created_at"];
  return typeof created === "number" && Number.isFinite(created) ? created : 0;
}
