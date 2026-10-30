/**
 * Loom native PTY 功能共享类型契约。
 * 仅类型声明，无运行时实现。
 */
import type { RingBuffer } from "./buffer.js";

export type PtyStatus = "running" | "killing" | "exited" | "killed";

/** Minimal handle over node-pty's IPty surface; injectable for tests. */
export interface PtyProcessHandle {
  readonly pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void } | void;
  onExit(
    listener: (event: { exitCode: number; signal?: number | string }) => void,
  ): { dispose(): void } | void;
}

export type SpawnPtyFn = (
  command: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => PtyProcessHandle;

export interface PtySession {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly ownerSessionId: string;
  status: PtyStatus;
  readonly pid: number;
  readonly createdAt: number;
  readonly notifyOnExit: boolean;
  readonly timeoutSeconds?: number;
  timedOut: boolean;
  exitCode?: number;
  exitSignal?: number | string;
  exitAt?: number;
  notified: boolean;
  readonly buffer: RingBuffer;
  readonly process: PtyProcessHandle;
}

/** JSON-safe projection for list/info; MUST NOT expose env values. */
export interface PtySessionInfo {
  id: string;
  title: string;
  description: string;
  command: string;
  args: string[];
  workdir: string;
  status: PtyStatus;
  pid: number;
  createdAt: number;
  notifyOnExit: boolean;
  timeoutSeconds?: number;
  timedOut: boolean;
  exitCode?: number;
  exitSignal?: number | string;
  exitAt?: number;
  lineCount: number;
}

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  workdir?: string;
  env?: Record<string, string>;
  title?: string;
  description: string;
  notifyOnExit?: boolean;
  timeoutSeconds?: number;
}

export interface PtyReadResult {
  id: string;
  status: PtyStatus;
  lines: string[];
  totalLines: number;
  offset: number;
  hasMore: boolean;
  pattern?: string;
  totalMatches?: number;
}

export interface PtySearchResult {
  id: string;
  status: PtyStatus;
  matches: Array<{ lineNumber: number; text: string }>;
  totalMatches: number;
  offset: number;
  hasMore: boolean;
}

export interface PtyCaps {
  maxSessionsPerLoomSession: number;
  maxSessionsTotal: number;
}

export type PtyExitNotifier = (ownerSessionId: string, line: string) => void;

export interface PtyManagerOptions {
  readonly caps?: Partial<PtyCaps>;
  readonly bufferChars?: number;
  readonly spawnPty?: SpawnPtyFn;
  readonly onExit?: PtyExitNotifier;
  readonly log?: (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly now?: () => number;
}

export interface PtyToolOptions {
  /** Default working directory when pty_spawn omits workdir (the Loom workspace realpath). */
  readonly defaultWorkdir: string;
  /** Workspace root used by cwd containment validation. */
  readonly workspaceRoot: string;
  readonly caps?: Partial<PtyCaps>;
  readonly notifyOnExitDefault?: boolean;
  readonly onExit?: PtyExitNotifier;
  /** Injected spawn-time authorization (deny/net/cwd/permission) executed BEFORE spawning. Throw to reject. */
  readonly validateSpawn?: (
    command: string,
    args: readonly string[],
    workdir: string,
  ) => void | Promise<void>;
  readonly spawnPty?: SpawnPtyFn;
  readonly log?: (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly now?: () => number;
}
