/** 跨实例文件锁原语（T02）：O_EXCL + JSON owner + stale 接管 + 有界重试。 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const POLL_MIN_MS = 8;
const POLL_JITTER_MS = 10;
const BREAK_SUFFIX = ".break";

export interface FileLockOwner { readonly pid: number; readonly at: number; readonly token: string }

export interface FileLockOptions {
  readonly staleMs?: number; // 锁 mtime 超龄可接管；默认 10000
  readonly timeoutMs?: number; // 获取超时；默认 2000
  readonly now?: () => number; // 时钟注入；默认 Date.now
  readonly isPidAlive?: (pid: number) => boolean; // 默认 process.kill(pid, 0)
}

export type FileLockPhase = "acquire" | "inspect" | "takeover" | "release";

export interface FileLockErrorOptions {
  readonly lockPath: string;
  readonly phase: FileLockPhase;
  readonly cause?: unknown;
}

export class FileLockError extends Error {
  readonly lockPath: string;
  readonly phase: FileLockPhase;

  constructor(message: string, options: FileLockErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FileLockError";
    this.lockPath = options.lockPath;
    this.phase = options.phase;
  }
}

export class FileLockTimeoutError extends FileLockError {
  readonly timeoutMs: number;
  readonly owner: FileLockOwner | null;

  constructor(
    message: string,
    options: { readonly lockPath: string; readonly timeoutMs: number; readonly owner: FileLockOwner | null },
  ) {
    super(message, { lockPath: options.lockPath, phase: "acquire" });
    this.name = "FileLockTimeoutError";
    this.timeoutMs = options.timeoutMs;
    this.owner = options.owner;
  }
}

interface ResolvedOptions { readonly staleMs: number; readonly timeoutMs: number; readonly now: () => number; readonly isPidAlive: (pid: number) => boolean }

interface AcquiredLock { readonly token: string; readonly dev: number; readonly ino: number }

interface LockSnapshot { readonly owner: FileLockOwner | null; readonly dev: number; readonly ino: number; readonly stale: boolean }

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function wrap(lockPath: string, phase: FileLockPhase, error: unknown): FileLockError {
  if (error instanceof FileLockError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new FileLockError(`[file-lock:${phase}] ${lockPath}: ${detail}`, { lockPath, phase, cause: error });
}

function resolveOptions(lockPath: string, options: FileLockOptions): ResolvedOptions {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (const [name, value] of [["staleMs", staleMs], ["timeoutMs", timeoutMs]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new FileLockError(`[file-lock:acquire] ${name} 必须是非负有限数`, { lockPath, phase: "acquire" });
    }
  }
  return { staleMs, timeoutMs, now: options.now ?? Date.now, isPidAlive: options.isPidAlive ?? defaultIsPidAlive };
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function parseOwner(text: string): FileLockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const { pid, at, token } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (typeof token !== "string" || token === "") return null;
  return { pid, at, token };
}

export async function readLockOwner(lockPath: string): Promise<FileLockOwner | null> {
  try {
    return parseOwner(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw wrap(lockPath, "inspect", error);
  }
}

async function inspectLock(lockPath: string, opts: ResolvedOptions): Promise<LockSnapshot | null> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "r");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw wrap(lockPath, "inspect", error);
  }
  try {
    const info = await handle.stat();
    const owner = parseOwner(await handle.readFile("utf8"));
    const age = opts.now() - info.mtimeMs;
    const mtimeStale = Number.isFinite(age) && age > opts.staleMs;
    const stale = owner === null ? mtimeStale : !opts.isPidAlive(owner.pid) || mtimeStale;
    return { owner, dev: info.dev, ino: info.ino, stale };
  } catch (error) {
    throw wrap(lockPath, "inspect", error);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function tryAcquire(lockPath: string, now: () => number): Promise<AcquiredLock | null> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) return null;
    throw wrap(lockPath, "acquire", error);
  }

  const token = randomUUID();
  try {
    const owner: FileLockOwner = { pid: process.pid, at: now(), token };
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    const info = await handle.stat();
    await handle.close().catch(() => {});
    return { token, dev: info.dev, ino: info.ino };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw wrap(lockPath, "acquire", error);
  }
}

async function releaseLock(lockPath: string, acquired: AcquiredLock): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (info.dev !== acquired.dev || info.ino !== acquired.ino) return;
    const owner = parseOwner(await readFile(lockPath, "utf8"));
    if (owner?.token !== acquired.token) return;
    await unlink(lockPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw wrap(lockPath, "release", error);
  }
}

async function clearStaleBreaker(breakPath: string, lockPath: string, opts: ResolvedOptions): Promise<void> {
  try {
    const info = await stat(breakPath);
    if (opts.now() - info.mtimeMs > opts.staleMs) await unlink(breakPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw wrap(lockPath, "takeover", error);
  }
}

async function tryTakeover(lockPath: string, breakPath: string, opts: ResolvedOptions): Promise<boolean> {
  let breaker: FileHandle;
  try {
    breaker = await open(breakPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      await clearStaleBreaker(breakPath, lockPath, opts);
      return false;
    }
    throw wrap(lockPath, "takeover", error);
  }

  try {
    const snapshot = await inspectLock(lockPath, opts);
    if (snapshot === null) return true;
    if (!snapshot.stale) return false;

    let current: { readonly dev: number; readonly ino: number } | null;
    try {
      current = await stat(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) current = null;
      else throw wrap(lockPath, "takeover", error);
    }
    if (current === null || current.dev !== snapshot.dev || current.ino !== snapshot.ino) return false;
    await unlink(lockPath);
    return true;
  } finally {
    await breaker.close().catch(() => {});
    await unlink(breakPath).catch(() => {});
  }
}

function pollDelay(): number {
  return POLL_MIN_MS + Math.floor(Math.random() * POLL_JITTER_MS);
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  if (typeof lockPath !== "string" || lockPath.trim() === "") {
    throw new FileLockError("[file-lock:acquire] lockPath 必须是非空路径", { lockPath: String(lockPath), phase: "acquire" });
  }

  const opts = resolveOptions(lockPath, options);
  try {
    await mkdir(dirname(lockPath), { recursive: true });
  } catch (error) {
    throw wrap(lockPath, "acquire", error);
  }

  const breakPath = `${lockPath}${BREAK_SUFFIX}`;
  const deadline = opts.now() + opts.timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(opts.timeoutMs / POLL_MIN_MS) + 8);
  let acquired: AcquiredLock | null = null;
  let lastOwner: FileLockOwner | null = null;
  let attempts = 0;

  while (acquired === null) {
    attempts += 1;
    acquired = await tryAcquire(lockPath, opts.now);
    if (acquired !== null) break;

    const snapshot = await inspectLock(lockPath, opts);
    let tookOver = false;
    if (snapshot !== null) {
      if (snapshot.owner !== null) lastOwner = snapshot.owner;
      if (snapshot.stale) tookOver = await tryTakeover(lockPath, breakPath, opts);
    }

    if (opts.now() >= deadline || attempts >= maxAttempts) {
      const detail = lastOwner === null ? "" : `（owner pid ${String(lastOwner.pid)}）`;
      throw new FileLockTimeoutError(
        `[file-lock:timeout] ${lockPath}: ${String(opts.timeoutMs)}ms 内未获得锁${detail}`,
        { lockPath, timeoutMs: opts.timeoutMs, owner: lastOwner },
      );
    }
    if (!tookOver) await sleep(pollDelay());
  }

  let fnFailed = false;
  try {
    return await fn();
  } catch (error) {
    fnFailed = true;
    throw error;
  } finally {
    try {
      await releaseLock(lockPath, acquired);
    } catch (releaseError) {
      if (!fnFailed) throw releaseError;
    }
  }
}
