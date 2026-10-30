/**
 * 原子文件写入原语（T02）。
 *
 * 口径：同目录 temp + fsync(file) + rename + fsync(dir)。rename 原子替换目标，
 * 读侧只会看到完整旧文件或完整新文件；任何一步失败都会清理 temp 并抛
 * AtomicWriteError，绝不留下半截目标文件。
 *
 * 写路径是同步的（与 JsonPlanStore 现有 writeFileAtomic 同口径）；JSON 序列化
 * 采用键字典序，保证同一逻辑值逐字节稳定，写盘 diff 不因属性序抖动。
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type AtomicWritePhase =
  | "serialize"
  | "mkdir"
  | "write"
  | "open"
  | "fsync"
  | "rename";

export interface AtomicWriteErrorOptions {
  readonly target: string;
  readonly phase: AtomicWritePhase;
  readonly cause?: unknown;
}

export class AtomicWriteError extends Error {
  readonly target: string;
  readonly phase: AtomicWritePhase;

  constructor(message: string, options: AtomicWriteErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AtomicWriteError";
    this.target = options.target;
    this.phase = options.phase;
  }
}

let tempSeq = 0;

function tempPathFor(target: string): string {
  const suffix = randomBytes(6).toString("hex");
  return `${target}.${String(process.pid)}.${String(++tempSeq)}.${suffix}.tmp`;
}

function fail(target: string, phase: AtomicWritePhase, error: unknown): AtomicWriteError {
  const detail = error instanceof Error ? error.message : String(error);
  return new AtomicWriteError(`[atomic-write:${phase}] ${target}: ${detail}`, {
    target,
    phase,
    cause: error,
  });
}

/** 删除 temp；失败时不掩盖主错误，ENOENT 表示 temp 尚未落地。 */
function cleanupTemp(temp: string): void {
  try {
    unlinkSync(temp);
  } catch {
    // 尽力清理，主错误优先
  }
}

/** 目录 fsync 尽力而为：部分文件系统不支持（EINVAL/EPERM）。 */
function syncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // rename 已完成，目标内容完整；目录项持久化交给文件系统
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

/** 同步原子写文本：同目录 temp + fsync + rename + 目录 fsync。 */
export function writeTextAtomic(target: string, text: string): void {
  if (typeof target !== "string" || target.trim() === "") {
    throw new AtomicWriteError("[atomic-write:write] target 必须是非空路径", {
      target: String(target),
      phase: "write",
    });
  }
  if (typeof text !== "string") {
    throw new AtomicWriteError("[atomic-write:write] text 必须是字符串", {
      target,
      phase: "write",
    });
  }

  const dir = dirname(target);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw fail(target, "mkdir", error);
  }

  const temp = tempPathFor(target);
  let renamed = false;
  try {
    try {
      writeFileSync(temp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      throw fail(target, "write", error);
    }

    let fd: number;
    try {
      fd = openSync(temp, "r+");
    } catch (error) {
      throw fail(target, "open", error);
    }
    try {
      try {
        fsyncSync(fd);
      } catch (error) {
        throw fail(target, "fsync", error);
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不改变已完成的 fsync
      }
    }

    try {
      renameSync(temp, target);
      renamed = true;
    } catch (error) {
      throw fail(target, "rename", error);
    }
    syncDirectory(dir);
  } catch (error) {
    if (!renamed) cleanupTemp(temp);
    throw error instanceof AtomicWriteError ? error : fail(target, "write", error);
  }
}

/**
 * 稳定 JSON：递归按键字典序重排对象键、保留数组顺序、尊重 toJSON。
 * 循环引用与顶层不可序列化值抛 TypeError，由 writeJsonAtomic 转成类型化错误。
 */
function stableOrder(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("JSON 值存在循环引用");
    seen.add(value);
    try {
      return value.map((entry) => stableOrder(entry, seen));
    } finally {
      seen.delete(value);
    }
  }

  const record = value as Record<string, unknown>;
  if (seen.has(record)) throw new TypeError("JSON 值存在循环引用");
  seen.add(record);
  try {
    const toJSON: unknown = record["toJSON"];
    if (typeof toJSON === "function") {
      return stableOrder(toJSON.call(record), seen);
    }
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) ordered[key] = stableOrder(entry, seen);
    }
    return ordered;
  } finally {
    seen.delete(record);
  }
}

export function stringifyStableJson(value: unknown): string {
  const encoded = JSON.stringify(stableOrder(value, new Set<object>()), null, 2);
  if (encoded === undefined) throw new TypeError("值不是可序列化的 JSON");
  return encoded;
}

/** 稳定 JSON + 尾随换行；序列化失败发生在碰盘之前。 */
export function writeJsonAtomic(target: string, value: unknown): void {
  let text: string;
  try {
    text = `${stringifyStableJson(value)}\n`;
  } catch (error) {
    throw fail(target, "serialize", error);
  }
  writeTextAtomic(target, text);
}
