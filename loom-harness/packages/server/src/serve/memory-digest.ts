/**
 * B1 harness wake path：boot 期唤醒记忆摘要（虚拟 MemorySource）。
 *
 * 命令真源由外部 `stratum` CLI 提供；本模块只负责一次只读调用与 fail-soft 包装。
 * 摘要为 boot 常量（不含时间戳/生成时间），同一 stdout 恒得同一 content，便于
 * systemPromptResync 复用而不重跑命令。失败/空输出/`无` 一律返回 null，绝不 throw。
 */

import { execFileSync } from "node:child_process";

import type { MemorySource } from "@axeuh/loom-core/assembly";

/** 虚拟源标签：不是 workspace 文件，roster/contextSeed 必须过滤掉它。 */
export const MEMORY_DIGEST_SOURCE = "memory/.digest";

const DIGEST_COMMAND = "stratum";
const DIGEST_ARGS = ["memory", "digest", "--days", "30", "--budget", "3000"] as const;
const DIGEST_TIMEOUT_MS = 5_000;
const DIGEST_MAX_BUFFER = 64 * 1024;
/** stratum 在无可用记忆时的固定输出（不当作注入内容）。 */
const NO_DIGEST_OUTPUT = "无";

export type MemoryDigestLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;

export interface MemoryDigestRunOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly encoding: "utf8";
  readonly maxBuffer: number;
}

export type MemoryDigestRunner = (
  command: string,
  args: readonly string[],
  options: MemoryDigestRunOptions,
) => string;

export interface MemoryDigestOptions {
  readonly workspaceRoot: string;
  readonly enabled: boolean;
  readonly log?: MemoryDigestLog;
  readonly run?: MemoryDigestRunner;
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: MemoryDigestRunOptions,
): string {
  return execFileSync(command, [...args], {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
  });
}

/**
 * 执行一次 digest 并构造虚拟源：disabled = null（不跑命令）；任何失败 = null + warn。
 * 返回值 degrade 恒 null（虚拟源没有可降级的文件内容）。
 */
export function buildMemoryDigestSource(options: MemoryDigestOptions): MemorySource | null {
  const log = options.log ?? (() => {});
  if (!options.enabled) return null;

  let stdout: string;
  try {
    stdout = (options.run ?? defaultRun)(DIGEST_COMMAND, DIGEST_ARGS, {
      cwd: options.workspaceRoot,
      timeout: DIGEST_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: DIGEST_MAX_BUFFER,
    });
  } catch (err) {
    log("warn", "loom memory digest unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const text = stdout.trim();
  if (text.length === 0 || text === NO_DIGEST_OUTPUT) {
    log("warn", "loom memory digest empty", {
      reason: text.length === 0 ? "blank" : "no-content",
    });
    return null;
  }

  return {
    source: MEMORY_DIGEST_SOURCE,
    content: `# Wake Digest\n\n${text}\n`,
    degrade: null,
  };
}

/**
 * 把 digest 作为清单最后一源追加；null 时原样返回同一数组（disabled/fail 面字节与
 * 引用都不扰动既有静态清单）。boot 与 resync 共用此一处顺序语义。
 */
export function appendMemoryDigestSource(
  sources: readonly MemorySource[],
  digest: MemorySource | null,
): readonly MemorySource[] {
  return digest === null ? sources : [...sources, digest];
}
