// ScriptHost 的公共类型 + 指数退避纯函数。

import type { Lang, ScriptMeta } from "./frontmatter.js";
import type { InterpreterOverride } from "./runtime.js";
import type { ScriptEvent } from "./protocol.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface HostLogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type HostLogger = (entry: HostLogEntry) => void;

/** 宿主向上层（T28 task/run-domain API）派发的事件。 */
export interface HostEvent {
  readonly script: string;
  readonly filePath: string;
  readonly event: ScriptEvent;
}

/** onEvent 回调签名；types 与 host 共用。 */
export type EventListener = (e: HostEvent) => void;

/** child.ts 向上回报的生命周期回调（纯传输层，不含 respawn 决策）。 */
export interface ChildHandlers {
  readonly onLaunch: (pid: number) => void;
  readonly onStdoutLine: (line: string) => void;
  readonly onStderrLine: (line: string) => void;
  readonly onError: (err: unknown) => void;
  /** 进程结束：code/signal 至少其一；spawn 失败时两者皆 null。 */
  readonly onExit: (why: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

/** 一次 spawn 的句柄：terminate 走"杀进程组 + 宽限升级 SIGKILL"。 */
export interface ChildHandle {
  readonly pid: number | undefined;
  terminate(graceMs: number): void;
}

export interface ScriptHostOptions {
  readonly scriptsDir: string;
  /** 退避基数 ms，默认 1000（launcher ensure_opencode 范式起步 1s）。 */
  readonly baseBackoffMs?: number;
  /** 退避封顶 ms，默认 60000，可配。 */
  readonly capBackoffMs?: number;
  /** SIGTERM 后升级 SIGKILL 的宽限 ms，默认 1500。 */
  readonly killGraceMs?: number;
  /** 追加到最小白名单环境之外的变量（由挂载方自行确认可信）。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 逐语言解释器覆盖（lang=ts 必须注入，node20 无内置 TS runner）。 */
  readonly interpreters?: Partial<Record<Lang, InterpreterOverride>>;
  readonly logger?: HostLogger;
  /** 退避等待实现；测试注入假 sleep 防慢。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** >0 时按该间隔自动 rescan（mtime+size 轮询）；默认 0 仅手动 rescan。 */
  readonly watchIntervalMs?: number;
  /** 每次子进程拉起后回调 pid（测试用于孤儿检查）。 */
  readonly onChildLaunch?: (pid: number) => void;
}

/** 内部挂载态。 */
export interface Mounted {
  readonly meta: ScriptMeta;
  readonly filePath: string;
  /** 挂载时校验过的解释器调用（respawn 复用，不再重解析）。 */
  readonly command: string;
  readonly prefixArgs: readonly string[];
  /** 代数：stop/unmount/remount 时自增，令在途 sleep 与 exit 回调失效。 */
  generation: number;
  attempt: number;
  stopping: boolean;
  child: ChildHandle | undefined;
  /** mtime+size 水位线（D16 轮询 diff 用）。 */
  mtimeMs: number;
  size: number;
}

/** 退避参数：基数 + 封顶。 */
export interface BackoffConfig {
  readonly baseMs: number;
  readonly capMs: number;
}

/** 指数退避：min(base * 2^attempt, cap)。纯函数，单独可测。 */
export function computeBackoff(attempt: number, cfg: BackoffConfig): number {
  const raw = cfg.baseMs * 2 ** Math.max(0, attempt);
  return Math.min(raw, cfg.capMs);
}
