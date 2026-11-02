/**
 * Flow Phase A 退休工具（离线、只读优先、零破坏性）。
 *
 * 设计约束（来自任务书）：
 *  - 绝不删除 / 移动 / chmod Flow 原始数据，只复制。
 *  - 绝不移除 Flow 代码、工具、配置 schema 或 wake 枚举值。
 *  - apply 必须在确认无存活 Loom / WakeQueue 实例锁后才写；锁检查用 process.kill(pid,0)，绝不 kill。
 *  - wake sidecar 改写只删 source=flow 或 action=flow.check 的条目，preserve 其余与 schema；原子 temp+rename。
 *  - 幂等：重复 apply 新建归档或检测既有 manifest；绝不删原。
 *
 * 真源布局（与 JsonFlowStore / JsonFlowContinuationStore / WakeQueue 对齐）：
 *   状态根 = stateRoot
 *   session/<sid>/flow/{subjects,items,index.json,unset.jsonl,unset.jsonl.1}
 *   session/wake-queue/<sid>.json  (schema 2, 原子写, 含 instance 锁 .instance.json)
 */

import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

/** 与 wake-queue.ts 对齐的枚举 / schema（复制常量，避免引入运行时模块导致的副作用）。 */
export const WAKE_QUEUE_SCHEMA = 2;
export type WakeQueueSource = "plan" | "flow" | "special";
const FLOW_WAKE_ACTION = "flow.check";
const SID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export class FlowRetireError extends Error {
  readonly phase: string;
  constructor(message: string, phase: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FlowRetireError";
    this.phase = phase;
  }
}

export interface FlowSessionReport {
  readonly sessionId: string;
  readonly subjectCount: number;
  readonly itemCount: number;
  readonly nonClosedCount: number;
  readonly flowWakeCount: number;
  readonly flowDirExists: boolean;
}

export interface FlowWakeEntryReport {
  readonly sessionId: string;
  readonly id: string;
  readonly source: string;
  readonly action: string | undefined;
  readonly at: number;
}

export interface FlowDryRunReport {
  readonly stateRoot: string;
  readonly sessions: readonly FlowSessionReport[];
  readonly flowWakeEntries: readonly FlowWakeEntryReport[];
  readonly totalFlowDirs: number;
  readonly targetArchivePath: string;
  readonly timestamp: string;
}

export interface FlowApplyManifest {
  readonly tool: "flow-retire";
  readonly phase: "A";
  readonly timestamp: string;
  readonly stateRoot: string;
  readonly archivePath: string;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly copiedFiles: number;
    readonly subjectCount: number;
    readonly itemCount: number;
    readonly nonClosedCount: number;
  }[];
  readonly totalCopiedFiles: number;
  readonly wakeEntriesCanceled: number;
  readonly idempotent: boolean;
}

export interface FlowVerifyResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly flowDirsRemaining: readonly string[];
  readonly flowWakeEntriesRemaining: readonly FlowWakeEntryReport[];
  readonly configFlowEnabled: boolean | null;
}

export interface FlowRetireOptions {
  readonly stateRoot: string;
  readonly configPath?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireStateRoot(stateRoot: string): string {
  const root = resolve(stateRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new FlowRetireError(`stateRoot 不存在或不是目录: ${root}`, "args");
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existsAt(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += countFiles(p);
    else n += 1;
  }
  return n;
}

function listSessionIds(root: string): string[] {
  const sessionRoot = join(root, "session");
  if (!existsAt(sessionRoot)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(sessionRoot)) {
    if (!SID_RE.test(name)) continue;
    ids.push(name);
  }
  return ids;
}

function inspectFlowSession(
  root: string,
  sessionId: string,
): {
  subjectCount: number;
  itemCount: number;
  nonClosedCount: number;
  flowDirExists: boolean;
} {
  const flowDir = join(root, "session", sessionId, "flow");
  if (!existsAt(flowDir)) {
    return { subjectCount: 0, itemCount: 0, nonClosedCount: 0, flowDirExists: false };
  }
  let subjectCount = 0;
  let nonClosedCount = 0;
  const subjectsDir = join(flowDir, "subjects");
  if (existsAt(subjectsDir)) {
    for (const file of readdirSync(subjectsDir)) {
      if (!file.endsWith(".json")) continue;
      subjectCount += 1;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(subjectsDir, file), "utf8"));
        if (isRecord(parsed) && parsed["state"] !== "closed") nonClosedCount += 1;
      } catch {
        // 损坏主体不计入非 closed（dry-run 只读报告，不抛）。
      }
    }
  }
  let itemCount = 0;
  const itemsDir = join(flowDir, "items");
  if (existsAt(itemsDir)) {
    for (const file of readdirSync(itemsDir)) {
      if (file.endsWith(".json")) itemCount += 1;
    }
  }
  return { subjectCount, itemCount, nonClosedCount, flowDirExists: true };
}

function readWakeSidecar(sidecar: string): unknown {
  try {
    return JSON.parse(readFileSync(sidecar, "utf8"));
  } catch {
    return null;
  }
}

function isFlowWakeEntry(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const source = raw["source"];
  const action = raw["action"];
  return source === "flow" || action === FLOW_WAKE_ACTION;
}

function collectFlowWakeEntries(root: string): FlowWakeEntryReport[] {
  const dir = join(root, "session", "wake-queue");
  if (!existsAt(dir)) return [];
  const out: FlowWakeEntryReport[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const sessionId = file.slice(0, -".json".length);
    const parsed = readWakeSidecar(join(dir, file));
    if (!isRecord(parsed)) continue;
    const entries = parsed["entries"];
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!isRecord(e)) continue;
      if (isFlowWakeEntry(e)) {
        out.push({
          sessionId,
          id: String(e["id"] ?? ""),
          source: String(e["source"] ?? ""),
          action: e["action"] !== undefined ? String(e["action"]) : undefined,
          at: typeof e["at"] === "number" ? (e["at"] as number) : 0,
        });
      }
    }
  }
  return out;
}

/** 检查 stateRoot/session/wake-queue/.instance.json 锁：存活 = 拒绝（绝不 kill）。 */
export function liveInstancePresent(root: string): { present: boolean; pid: number | null } {
  const lock = join(root, "session", "wake-queue", ".instance.json");
  if (!existsAt(lock)) return { present: false, pid: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lock, "utf8"));
  } catch {
    return { present: false, pid: null };
  }
  if (!isRecord(parsed)) return { present: false, pid: null };
  const pid = parsed["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { present: false, pid: null };
  }
  return { present: isPidAlive(pid), pid };
}

export function dryRun(options: FlowRetireOptions): FlowDryRunReport {
  const root = requireStateRoot(options.stateRoot);
  const timestamp = nowIso();
  const sessions: FlowSessionReport[] = [];
  for (const sid of listSessionIds(root)) {
    const inspection = inspectFlowSession(root, sid);
    if (!inspection.flowDirExists) continue;
    const flowWake = collectFlowWakeEntries(root).filter((e) => e.sessionId === sid);
    sessions.push({
      sessionId: sid,
      ...inspection,
      flowWakeCount: flowWake.length,
    });
  }
  const flowWakeEntries = collectFlowWakeEntries(root);
  const targetArchivePath = join(
    options.stateRoot,
    `flow.retired-${timestamp.replace(/[:.]/g, "-")}`,
  );
  return {
    stateRoot: root,
    sessions,
    flowWakeEntries,
    totalFlowDirs: sessions.length,
    targetArchivePath,
    timestamp,
  };
}

let tempSeq = 0;

function dirnameSafe(p: string): string {
  const i = p.lastIndexOf(sep);
  return i < 0 ? "." : p.slice(0, i);
}

/** 仓库既有口径：同目录 tmp + fsync + rename 原子写 JSON。 */
function writeJsonAtomicTempRename(target: string, value: unknown): void {
  const dir = dirnameSafe(target);
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${String(process.pid)}.${String(++tempSeq)}.tmp`;
  let renamed = false;
  try {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    renamed = true;
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // 目录 fsync 尽力而为
    }
  } catch (error) {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp 未落地
      }
    }
    throw new FlowRetireError(
      `原子写失败 ${target}: ${error instanceof Error ? error.message : String(error)}`,
      "write",
      error,
    );
  }
}

export function apply(options: FlowRetireOptions): FlowApplyManifest {
  const root = requireStateRoot(options.stateRoot);
  const timestamp = nowIso();
  const stamp = timestamp.replace(/[:.]/g, "-");

  const live = liveInstancePresent(root);
  if (live.present) {
    throw new FlowRetireError(
      `检测到存活 Loom/WakeQueue 实例锁（pid ${String(live.pid)}）。请先通过 systemd 停止服务再运行退休工具。`,
      "lock",
    );
  }

  const archivePath = join(options.stateRoot, `flow.retired-${stamp}`);
  let effectiveArchive = archivePath;
  if (existsAt(effectiveArchive)) {
    effectiveArchive = `${archivePath}-${String(Math.floor(Math.random() * 1e6))}`;
  }
  mkdirSync(effectiveArchive, { recursive: true });

  const sessions: FlowApplyManifest["sessions"][number][] = [];
  let totalCopiedFiles = 0;
  let wakeCanceled = 0;

  const sids = listSessionIds(root).filter((sid) =>
    existsAt(join(root, "session", sid, "flow")),
  );

  for (const sid of sids) {
    const srcFlow = join(root, "session", sid, "flow");
    const dstFlow = join(effectiveArchive, "session", sid, "flow");
    mkdirSync(dirnameSafe(dstFlow), { recursive: true });
    cpSync(srcFlow, dstFlow, { recursive: true });
    const copiedFiles = countFiles(dstFlow);
    totalCopiedFiles += copiedFiles;
    const inspection = inspectFlowSession(root, sid);
    sessions.push({
      sessionId: sid,
      copiedFiles,
      subjectCount: inspection.subjectCount,
      itemCount: inspection.itemCount,
      nonClosedCount: inspection.nonClosedCount,
    });
  }

  const wakeDir = join(root, "session", "wake-queue");
  if (existsAt(wakeDir)) {
    for (const file of readdirSync(wakeDir)) {
      if (!file.endsWith(".json")) continue;
      const sidecar = join(wakeDir, file);
      const parsed = readWakeSidecar(sidecar);
      if (!isRecord(parsed)) {
        throw new FlowRetireError(
          `wake sidecar 不可读，已中止（未做破坏性写入）: ${sidecar}`,
          "wake-unreadable",
        );
      }
      const entries = parsed["entries"];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((e) => !isFlowWakeEntry(e));
      const removed = entries.length - kept.length;
      if (removed === 0) continue;
      const next = { ...parsed, entries: kept };
      writeJsonAtomicTempRename(sidecar, next);
      wakeCanceled += removed;
    }
  }

  const manifest: FlowApplyManifest = {
    tool: "flow-retire",
    phase: "A",
    timestamp,
    stateRoot: root,
    archivePath: effectiveArchive,
    sessions,
    totalCopiedFiles,
    wakeEntriesCanceled: wakeCanceled,
    idempotent: effectiveArchive !== archivePath,
  };
  writeJsonAtomicTempRename(join(effectiveArchive, "retired.json"), manifest);
  return manifest;
}

export function verify(options: FlowRetireOptions): FlowVerifyResult {
  const root = requireStateRoot(options.stateRoot);
  const errors: string[] = [];
  const flowDirsRemaining: string[] = [];
  for (const sid of listSessionIds(root)) {
    if (existsAt(join(root, "session", sid, "flow"))) {
      flowDirsRemaining.push(sid);
      errors.push(`仍存在 flow 状态目录: session/${sid}/flow`);
    }
  }
  const flowWakeEntriesRemaining = collectFlowWakeEntries(root);
  if (flowWakeEntriesRemaining.length > 0) {
    errors.push(`仍存在 ${String(flowWakeEntriesRemaining.length)} 条 flow 唤醒条目`);
  }

  let configFlowEnabled: boolean | null = null;
  if (options.configPath !== undefined && existsAt(options.configPath)) {
    const text = readFileSync(options.configPath, "utf8");
    if (/^\s*flow\s*:/m.test(text) && /enabled\s*:\s*true/m.test(text)) {
      configFlowEnabled = true;
      errors.push(`配置文件 ${options.configPath} 仍启用 flow.enabled=true`);
    } else {
      configFlowEnabled = false;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    flowDirsRemaining,
    flowWakeEntriesRemaining,
    configFlowEnabled,
  };
}
