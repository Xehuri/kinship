/**
 * Owns PTY sessions: spawn, buffered output access, lifecycle, timeouts and
 * exit notification. node-pty is required lazily so tests never load the
 * native addon.
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { RingBuffer } from "./buffer.js";
import { buildExitNotification } from "./notifications.js";
import { safeShellEnv } from "../seam/index.js";
import type {
  PtyCaps,
  PtyExitNotifier,
  PtyManagerOptions,
  PtyProcessHandle,
  PtyReadResult,
  PtySearchResult,
  PtySession,
  PtySessionInfo,
  PtySpawnOptions,
  PtyStatus,
  SpawnPtyFn,
} from "./types.js";

export const DEFAULT_PTY_CAPS: PtyCaps = {
  maxSessionsPerLoomSession: 16,
  maxSessionsTotal: 64,
};

export const DEFAULT_PTY_BUFFER_CHARS = 1_000_000;

const SESSION_ID_BYTES = 4;
const TERMINAL_STATUSES: ReadonlySet<PtyStatus> = new Set<PtyStatus>(["exited", "killed"]);

interface NodePtyLike {
  spawn(
    command: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): PtyProcessHandle;
}

function defaultSpawnPty(
  command: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): PtyProcessHandle {
  const require = createRequire(import.meta.url);
  const nodePty = require("node-pty") as NodePtyLike;
  return nodePty.spawn(command, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: options.cwd,
    env: options.env,
  });
}

function generateSessionId(): string {
  return `pty_${randomBytes(SESSION_ID_BYTES).toString("hex")}`;
}

function isTerminal(status: PtyStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class PtyManager {
  private readonly caps: PtyCaps;
  private readonly bufferChars: number;
  private readonly spawnPty: SpawnPtyFn;
  private readonly onExit: PtyExitNotifier | undefined;
  private readonly log: NonNullable<PtyManagerOptions["log"]>;
  private readonly now: () => number;
  private readonly sessions = new Map<string, PtySession>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(opts: PtyManagerOptions = {}) {
    this.caps = { ...DEFAULT_PTY_CAPS, ...opts.caps };
    this.bufferChars = opts.bufferChars ?? DEFAULT_PTY_BUFFER_CHARS;
    this.spawnPty = opts.spawnPty ?? defaultSpawnPty;
    this.onExit = opts.onExit;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  spawn(ownerSessionId: string, opts: PtySpawnOptions): PtySessionInfo {
    const timeoutSeconds = this.normalizeTimeoutSeconds(opts.timeoutSeconds);

    this.pruneTerminalSessions(ownerSessionId);
    this.assertCapacity(ownerSessionId);

    const id = generateSessionId();
    const args = opts.args ?? [];
    const workdir = opts.workdir ?? process.cwd();
    const env = opts.env ?? safeShellEnv();
    const handle = this.spawnPty(opts.command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: workdir,
      env,
    });

    const buffer = new RingBuffer(this.bufferChars);
    const session: PtySession = {
      id,
      title: opts.title ?? opts.description,
      description: opts.description,
      command: opts.command,
      args,
      workdir,
      ownerSessionId,
      status: "running",
      pid: handle.pid,
      createdAt: this.now(),
      notifyOnExit: opts.notifyOnExit ?? false,
      timedOut: false,
      notified: false,
      buffer,
      process: handle,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    };

    // Register before wiring callbacks so a synchronous fake exit still finds it.
    this.sessions.set(id, session);

    handle.onData((data) => {
      buffer.append(data);
    });
    handle.onExit((event) => {
      this.handleExit(session, event);
    });
    this.scheduleTimeout(session, timeoutSeconds);

    return this.toInfo(session);
  }

  write(id: string, ownerSessionId: string, data: string): void {
    const session = this.requireSession(id, ownerSessionId);
    if (session.status !== "running") {
      throw new Error(
        `Cannot write to PTY '${id}' - session status is '${session.status}'`,
      );
    }
    session.process.write(data);
  }

  read(id: string, ownerSessionId: string, offset = 0, limit = 500): PtyReadResult {
    const session = this.requireSession(id, ownerSessionId);
    const result = session.buffer.read(offset, limit);
    return {
      id,
      status: session.status,
      lines: result.lines,
      totalLines: result.totalLines,
      offset: result.offset,
      hasMore: result.hasMore,
    };
  }

  search(
    id: string,
    ownerSessionId: string,
    pattern: string,
    offset = 0,
    limit = 500,
    ignoreCase = false,
  ): PtySearchResult {
    const session = this.requireSession(id, ownerSessionId);
    // Validate once up front; invalid patterns propagate as native SyntaxError.
    new RegExp(pattern, ignoreCase ? "i" : "");
    const all = session.buffer.search(pattern, ignoreCase).matches;
    const matches = limit <= 0 ? [] : all.slice(offset, offset + limit);
    return {
      id,
      status: session.status,
      matches,
      totalMatches: all.length,
      offset,
      hasMore: offset + matches.length < all.length,
    };
  }

  list(ownerSessionId: string): PtySessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.ownerSessionId === ownerSessionId)
      .map((session) => this.toInfo(session));
  }

  get(id: string, ownerSessionId: string): PtySessionInfo | undefined {
    const session = this.sessions.get(id);
    if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
    return this.toInfo(session);
  }

  kill(id: string, ownerSessionId: string, cleanup = false): PtySessionInfo {
    const session = this.requireSession(id, ownerSessionId);
    this.clearSessionTimeout(id);

    if (session.status === "running") {
      session.status = "killing";
      try {
        session.process.kill();
      } catch {
        // A dead process may reject kill; the state transition still holds.
      }
    }

    const info = this.toInfo(session);
    if (cleanup) {
      session.buffer.clear();
      this.sessions.delete(id);
    }
    return info;
  }

  disposeAll(): void {
    this.disposed = true;
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
    for (const session of this.sessions.values()) {
      if (session.status === "running") {
        session.status = "killing";
        try {
          session.process.kill();
        } catch {
          // Best-effort shutdown.
        }
      }
    }
    this.sessions.clear();
  }

  private normalizeTimeoutSeconds(timeoutSeconds: number | undefined): number | undefined {
    if (timeoutSeconds === undefined) return undefined;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error("timeoutSeconds must be a positive integer in seconds");
    }
    return timeoutSeconds;
  }

  private countSessions(ownerSessionId?: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (ownerSessionId === undefined || session.ownerSessionId === ownerSessionId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Retained terminal sessions still consume capacity; drop the oldest ones
   * until the incoming spawn fits both caps (or no terminal remains).
   */
  private pruneTerminalSessions(ownerSessionId: string): void {
    const terminals = [...this.sessions.values()]
      .filter((session) => isTerminal(session.status))
      .sort((a, b) => a.createdAt - b.createdAt);

    let total = this.sessions.size;
    for (const session of terminals) {
      if (total < this.caps.maxSessionsTotal) break;
      this.sessions.delete(session.id);
      total--;
    }

    let own = this.countSessions(ownerSessionId);
    if (own < this.caps.maxSessionsPerLoomSession) return;
    const ownTerminals = [...this.sessions.values()]
      .filter(
        (session) =>
          isTerminal(session.status) && session.ownerSessionId === ownerSessionId,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const session of ownTerminals) {
      if (own < this.caps.maxSessionsPerLoomSession) break;
      this.sessions.delete(session.id);
      own--;
    }
  }

  private assertCapacity(ownerSessionId: string): void {
    const own = this.countSessions(ownerSessionId);
    const total = this.sessions.size;
    if (
      own >= this.caps.maxSessionsPerLoomSession ||
      total >= this.caps.maxSessionsTotal
    ) {
      throw new Error(
        `PTY session limit reached for ${ownerSessionId}: ${own}/${this.caps.maxSessionsPerLoomSession} per Loom session, ${total}/${this.caps.maxSessionsTotal} total`,
      );
    }
  }

  private requireSession(id: string, ownerSessionId: string): PtySession {
    const session = this.sessions.get(id);
    if (!session || session.ownerSessionId !== ownerSessionId) {
      throw new Error(`PTY session not found: ${id}`);
    }
    return session;
  }

  private scheduleTimeout(session: PtySession, timeoutSeconds: number | undefined): void {
    if (timeoutSeconds === undefined) return;
    const timer = setTimeout(() => {
      this.timeouts.delete(session.id);
      if (session.status !== "running") return;
      session.timedOut = true;
      session.status = "killing";
      try {
        session.process.kill();
      } catch {
        // Exit handling will still run when the handle reports it.
      }
    }, timeoutSeconds * 1000);
    timer.unref();
    this.timeouts.set(session.id, timer);
  }

  private clearSessionTimeout(id: string): void {
    const timer = this.timeouts.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timeouts.delete(id);
  }

  private handleExit(
    session: PtySession,
    event: { exitCode: number; signal?: number | string },
  ): void {
    if (isTerminal(session.status)) return;

    this.clearSessionTimeout(session.id);
    session.buffer.flushPartial();
    session.status = session.status === "killing" ? "killed" : "exited";
    session.exitCode = event.exitCode;
    if (event.signal !== undefined) session.exitSignal = event.signal;
    session.exitAt = this.now();

    if (!session.notifyOnExit || session.notified || this.disposed) return;
    session.notified = true;
    try {
      this.onExit?.(session.ownerSessionId, buildExitNotification(session));
    } catch (err) {
      this.log("warn", "PTY exit notification failed", {
        id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private toInfo(session: PtySession): PtySessionInfo {
    return {
      id: session.id,
      title: session.title,
      description: session.description,
      command: session.command,
      args: [...session.args],
      workdir: session.workdir,
      status: session.status,
      pid: session.pid,
      createdAt: session.createdAt,
      notifyOnExit: session.notifyOnExit,
      timedOut: session.timedOut,
      lineCount: session.buffer.length,
      ...(session.timeoutSeconds !== undefined
        ? { timeoutSeconds: session.timeoutSeconds }
        : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.exitSignal !== undefined ? { exitSignal: session.exitSignal } : {}),
      ...(session.exitAt !== undefined ? { exitAt: session.exitAt } : {}),
    };
  }
}
