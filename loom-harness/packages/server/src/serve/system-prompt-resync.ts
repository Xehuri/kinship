/**
 * 主会话 systemPrompt / memory 重读（session-start 与 compaction 两触发点）。
 *
 * 契约：每次调用重读 persona 与 memory 注入源，产出新的 AssemblyPlan 与同一稳定
 * 快照派生的 ContextBaseline；调用方（MainSessionLoop）自行比较
 * `renderAssemblyPrefix(plan)` 决定是否真正换前缀，并把 baseline 交给会话水位 rebase。
 *
 * 稳定性保证是**逐文件 best-effort**，不是跨文件事务快照：
 *   - 单次快照内先 stat 全部已知路径（pre）→ 读 persona/memory → 再 stat（post）；
 *     任一路径 pre/post 指纹（mtime/size/ino/ctime）不等 = 本次快照不稳定，重试。
 *     基线 stat 因而绝不晚于它所描述的内容；
 *   - 两次连续快照间内容、降级状态、stat 指纹全等才采用第二次快照；
 *   - 无文件系统锁（write 工具就地写），两次读之间仍有半写窗口；指纹只收敛窗口，
 *     不声称原子性；
 *   - unreadable/invalid 降级是**拒绝**而非采用（占位文本绝不能顶替好内容）；
 *     `missing` 是真实移除语义，允许采用；
 *   - 超时是 Promise.race 的 best-effort 边界，底层读无法取消：超时直接判不可用，
 *     不重试（重试会与未落的读重叠，破坏单读者不变式）。
 *
 * 并发：同一 session 的并发调用共享同一个 in-flight promise；每次 attempt 内快照
 * 顺序读（stat → persona → memory → stat），活跃读不超过 1。
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  renderAssemblyPrefix,
  type AssemblyPlan,
  type ContextBaseline,
  type MemorySource,
} from "@axeuh/loom-core/assembly";

/** 重读触发点：主会话起会话 / 压缩后重建前缀。 */
export type SystemPromptResyncReason = "session-start" | "compaction";

/** 重读在 maxAttempts 内无法取得稳定快照（或 persona 不可读）时的类型化错误。 */
export class SystemPromptResyncUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SystemPromptResyncUnavailableError";
  }
}

type ResyncLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;

export interface SystemPromptResyncOptions {
  /** 工作区根；相对 source 路径按它解析，绝对路径原样使用。 */
  readonly workspaceRoot: string;
  /** boot 期主会话计划；只复用 workflows / convergenceToolNote，systemPrompt 与 memory 被重读覆盖。 */
  readonly plan: AssemblyPlan;
  /** persona 文件绝对路径（也接受 workspace 相对），仅用于 stat 指纹。 */
  readonly personaFile?: string;
  /** persona 读取器；缺省 = 冻结的 boot plan.systemPrompt（不重读文件）。 */
  readonly loadPersona?: () => Promise<string>;
  /** boot 注入：`bindings.mainSessionMemorySources(declaredMainGlobs)` 闭包。 */
  readonly loadMemorySources: () => readonly MemorySource[];
  readonly log?: ResyncLog;
  /** 不稳定/降级快照的最大尝试数（缺省 3）。 */
  readonly maxAttempts?: number;
  /** 单次 attempt 总超时（缺省 2000ms；超时直接判不可用，不重试）。 */
  readonly timeoutMs?: number;
}

/** 一次稳定重读的产物：新 plan + 同一快照派生的会话水位基线。 */
export interface SystemPromptResyncResult {
  readonly plan: AssemblyPlan;
  readonly contextBaseline: ContextBaseline;
}

/**
 * 一个 session 的重读入口；返回 null 仅供调用方表达「本轮不采用」，本实现恒返回
 * result 或抛错。
 */
export type SystemPromptResyncProvider = (
  reason: SystemPromptResyncReason,
) => Promise<SystemPromptResyncResult | null>;

interface ResyncRuntime {
  readonly workspaceRoot: string;
  readonly plan: AssemblyPlan;
  readonly personaPath: string | null;
  readonly loadPersona: () => Promise<string>;
  readonly loadMemorySources: () => readonly MemorySource[];
  readonly log: ResyncLog;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
}

interface Snapshot {
  readonly personaBody: string;
  readonly memorySources: readonly MemorySource[];
  /** 绝对路径 → `${mtimeMs}:${size}:${ino}:${ctimeMs}` 或 "missing"/"error:<code>"。 */
  readonly fingerprints: ReadonlyMap<string, string>;
  /** 绝对路径 → 本快照内容读取前（pre）的数值 stat；基线 stat 的同一稳定快照来源。 */
  readonly stats: ReadonlyMap<string, FileStat>;
}

interface FileStat {
  readonly mtimeMs: number;
  readonly size: number;
}

interface StatObservation {
  readonly key: string;
  readonly stat: FileStat | null;
}

type AttemptOutcome =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly problem: string; readonly cause: unknown };

class ResyncTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`system prompt resync attempt timed out after ${String(timeoutMs)}ms`);
    this.name = "ResyncTimeoutError";
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 2000;
/** 两次快照之间的短间隔：覆盖同 tick 内就地写的半写窗口，测试保持确定性。 */
const STABILITY_DELAY_MS = 10;

function resolvePath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
}

function errnoCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code: unknown = err.code;
  return typeof code === "string" ? code : null;
}

function errorLabel(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}

/** 单文件 stat：等值键（含 ino/ctime 抵消半写窗口）+ 数值 stat（基线水位用）。 */
async function statObservation(path: string): Promise<StatObservation> {
  try {
    const info = await stat(path);
    return {
      key: `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}:${String(info.ctimeMs)}`,
      stat: { mtimeMs: info.mtimeMs, size: info.size },
    };
  } catch (err) {
    const code = errnoCode(err);
    return {
      key: code === "ENOENT" || code === "ENOTDIR" ? "missing" : `error:${code ?? "unknown"}`,
      stat: null,
    };
  }
}

function sameDegrade(left: MemorySource["degrade"], right: MemorySource["degrade"]): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.segment === right.segment &&
    left.source === right.source &&
    left.reason === right.reason &&
    left.detail === right.detail
  );
}

function sameSource(left: MemorySource, right: MemorySource): boolean {
  return (
    left.source === right.source &&
    left.content === right.content &&
    sameDegrade(left.degrade, right.degrade)
  );
}

function sameFingerprints(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, value] of left) {
    if (right.get(path) !== value) return false;
  }
  return true;
}

function sameSnapshots(left: Snapshot, right: Snapshot): boolean {
  if (left.personaBody !== right.personaBody) return false;
  if (left.memorySources.length !== right.memorySources.length) return false;
  for (let i = 0; i < left.memorySources.length; i += 1) {
    const a = left.memorySources[i];
    const b = right.memorySources[i];
    if (a === undefined || b === undefined || !sameSource(a, b)) return false;
  }
  return sameFingerprints(left.fingerprints, right.fingerprints);
}

function snapshotProblem(plan: AssemblyPlan, snapshot: Snapshot): string | null {
  for (const source of snapshot.memorySources) {
    const reason = source.degrade?.reason;
    if (reason === "unreadable" || reason === "invalid") {
      return `source "${source.source}" degraded: ${reason}`;
    }
  }
  if (snapshot.personaBody.length === 0 && plan.systemPrompt.length > 0) {
    return "persona body is empty";
  }
  return null;
}

/**
 * 一次快照：pre-stat 全部已知路径 → persona/memory 读取 → post-stat 全部路径。
 * post 与 pre 指纹不等 = 内容读取跨越了写窗口，本次快照不稳定（return null 重试），
 * 从而保证基线里的 stat 绝不新于它描述的内容。新发现的 source 路径在首次出现时只
 * 有 post stat；该路径已并入 knownPaths，下一次快照即按 pre 约束。
 */
async function readSnapshot(
  runtime: ResyncRuntime,
  knownPaths: Set<string>,
): Promise<Snapshot | null> {
  const prePaths = new Set(knownPaths);
  if (runtime.personaPath !== null) prePaths.add(runtime.personaPath);
  for (const source of runtime.plan.memorySources) {
    prePaths.add(resolvePath(runtime.workspaceRoot, source.source));
  }
  const preFingerprints = new Map<string, string>();
  for (const path of prePaths) {
    preFingerprints.set(path, (await statObservation(path)).key);
  }

  const personaBody = await runtime.loadPersona();
  const memorySources = [...runtime.loadMemorySources()];

  const postPaths = new Set(prePaths);
  for (const source of memorySources) {
    const path = resolvePath(runtime.workspaceRoot, source.source);
    knownPaths.add(path);
    postPaths.add(path);
  }

  const fingerprints = new Map<string, string>();
  const stats = new Map<string, FileStat>();
  for (const path of postPaths) {
    const observation = await statObservation(path);
    fingerprints.set(path, observation.key);
    const before = preFingerprints.get(path);
    if (before === undefined) {
      if (observation.stat !== null) stats.set(path, observation.stat);
      continue;
    }
    if (before !== observation.key) return null;
    if (observation.stat !== null) stats.set(path, observation.stat);
  }
  return { personaBody, memorySources, fingerprints, stats };
}

/** 两次连续快照全等才稳定；降级/空 persona 在第一次快照即可判定，省掉第二次读。 */
async function collectStableSnapshot(
  runtime: ResyncRuntime,
  knownPaths: Set<string>,
): Promise<AttemptOutcome> {
  let first: Snapshot;
  try {
    const snapshot = await readSnapshot(runtime, knownPaths);
    if (snapshot === null) {
      return { ok: false, problem: "snapshot changed during read", cause: undefined };
    }
    first = snapshot;
  } catch (err) {
    return { ok: false, problem: `first snapshot failed (${errorLabel(err)})`, cause: err };
  }
  const firstProblem = snapshotProblem(runtime.plan, first);
  if (firstProblem !== null) return { ok: false, problem: firstProblem, cause: undefined };

  await delay(STABILITY_DELAY_MS);

  let second: Snapshot;
  try {
    const snapshot = await readSnapshot(runtime, knownPaths);
    if (snapshot === null) {
      return { ok: false, problem: "snapshot changed during read", cause: undefined };
    }
    second = snapshot;
  } catch (err) {
    return { ok: false, problem: `second snapshot failed (${errorLabel(err)})`, cause: err };
  }
  const secondProblem = snapshotProblem(runtime.plan, second);
  if (secondProblem !== null) return { ok: false, problem: secondProblem, cause: undefined };
  if (!sameSnapshots(first, second)) {
    return { ok: false, problem: "snapshot changed between reads", cause: undefined };
  }
  return { ok: true, snapshot: second };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ResyncTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function resolveRuntime(options: SystemPromptResyncOptions): ResyncRuntime {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`system prompt resync: maxAttempts must be a positive integer, got ${String(maxAttempts)}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`system prompt resync: timeoutMs must be a positive number, got ${String(timeoutMs)}`);
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const personaPath =
    options.personaFile === undefined ? null : resolvePath(workspaceRoot, options.personaFile);
  const plan = options.plan;
  return {
    workspaceRoot,
    plan,
    personaPath,
    loadPersona: options.loadPersona ?? (() => Promise.resolve(plan.systemPrompt)),
    loadMemorySources: options.loadMemorySources,
    log: options.log ?? (() => {}),
    maxAttempts,
    timeoutMs,
  };
}

function buildContextBaseline(runtime: ResyncRuntime, snapshot: Snapshot): ContextBaseline {
  const baseline: {
    relPath: string;
    content: string;
    mtimeMs: number;
    size: number;
  }[] = [];
  for (const source of snapshot.memorySources) {
    if (source.degrade !== null) continue;
    const fileStat = snapshot.stats.get(resolvePath(runtime.workspaceRoot, source.source));
    if (fileStat === undefined) continue;
    baseline.push({
      relPath: source.source,
      content: source.content,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    });
  }
  return baseline;
}

async function resync(
  runtime: ResyncRuntime,
  sessionID: string,
  reason: SystemPromptResyncReason,
): Promise<SystemPromptResyncResult> {
  const knownPaths = new Set<string>();
  if (runtime.personaPath !== null) knownPaths.add(runtime.personaPath);
  for (const source of runtime.plan.memorySources) {
    knownPaths.add(resolvePath(runtime.workspaceRoot, source.source));
  }

  let lastProblem = "no attempt completed";
  let lastCause: unknown;

  for (let attempt = 1; attempt <= runtime.maxAttempts; attempt += 1) {
    let outcome: AttemptOutcome;
    try {
      outcome = await withTimeout(collectStableSnapshot(runtime, knownPaths), runtime.timeoutMs);
    } catch (err) {
      if (err instanceof ResyncTimeoutError) {
        runtime.log("warn", "loom system prompt resync unavailable", {
          reason,
          attempts: attempt,
          problem: "timeout",
        });
        throw new SystemPromptResyncUnavailableError(
          `system prompt resync timed out after ${String(runtime.timeoutMs)}ms (session ${sessionID})`,
          { cause: err },
        );
      }
      lastProblem = `attempt failed (${errorLabel(err)})`;
      lastCause = err;
      runtime.log("debug", "loom system prompt resync retry", {
        reason,
        attempt,
        problem: lastProblem,
      });
      continue;
    }

    if (!outcome.ok) {
      lastProblem = outcome.problem;
      lastCause = outcome.cause;
      runtime.log("debug", "loom system prompt resync retry", {
        reason,
        attempt,
        problem: lastProblem,
      });
      continue;
    }

    const freshPlan: AssemblyPlan = {
      ...runtime.plan,
      systemPrompt: outcome.snapshot.personaBody,
      memorySources: outcome.snapshot.memorySources,
    };
    const contextBaseline = buildContextBaseline(runtime, outcome.snapshot);
    const rendered = renderAssemblyPrefix(freshPlan);
    const digest = createHash("sha256").update(rendered, "utf8").digest("hex");
    runtime.log("info", "loom system prompt resync applied", {
      reason,
      attempts: attempt,
      sha256: `sha256:${digest}`,
      bytes: Buffer.byteLength(rendered, "utf8"),
      sourceCount: freshPlan.memorySources.length,
    });
    return { plan: freshPlan, contextBaseline };
  }

  runtime.log("warn", "loom system prompt resync unavailable", {
    reason,
    attempts: runtime.maxAttempts,
    problem: lastProblem,
  });
  throw new SystemPromptResyncUnavailableError(
    `system prompt resync unavailable after ${String(runtime.maxAttempts)} attempt(s) (session ${sessionID}): ${lastProblem}`,
    lastCause === undefined ? undefined : { cause: lastCause },
  );
}

/**
 * 构造 per-session provider 工厂：同一 sessionID 复用同一 provider（单一 in-flight
 * promise），不同 session 各自独立。读盘失败/不稳定按 maxAttempts 重试后抛
 * SystemPromptResyncUnavailableError；调用方据此保留旧前缀。
 */
export function createSystemPromptResync(
  options: SystemPromptResyncOptions,
): (sessionID: string) => SystemPromptResyncProvider {
  const runtime = resolveRuntime(options);
  const providers = new Map<string, SystemPromptResyncProvider>();

  return (sessionID: string): SystemPromptResyncProvider => {
    const existing = providers.get(sessionID);
    if (existing !== undefined) return existing;

    let inFlight: Promise<SystemPromptResyncResult | null> | null = null;
    const provider: SystemPromptResyncProvider = (reason) => {
      if (inFlight !== null) return inFlight;
      const current: Promise<SystemPromptResyncResult | null> = resync(runtime, sessionID, reason).finally(() => {
        inFlight = null;
      });
      inFlight = current;
      return current;
    };
    providers.set(sessionID, provider);
    return provider;
  };
}
