/**
 * 装配读路径的 fs 实现（T18）。
 *
 * 组合两路注入源，产出 `AssemblyReader`：
 *   - 稳定文件：workspace 相对路径逐个读（缺失→null，IO 异常原样抛给 resolve 层归一化）。
 *   - 历史增量：duck-typed 接 `SessionShards`（readAfter/turnCount，T08）——
 *     core 不 import adapters（依赖方向 adapters → core），此处只声明最小形状；
 *     server/tools 层把真 SessionShards 实例传进来即可，openedShards 如实透传
 *     （行数恒定契约的可观测证明量）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssemblyReader, HistoryIncrement } from "./types.js";

/** SessionShards 的最小消费形状（adapters 包实现，结构化匹配即可传入）。 */
export interface ShardSourceLike {
  readAfter(startTurn: number): { readonly rows: readonly { readonly [k: string]: unknown }[]; readonly openedShards: number };
  turnCount(): number;
}

/** 历史行 JSON → 稳定文本行：key 字典序序列化，杜绝属性序抖动进字节流。 */
export function canonicalRow(row: { readonly [k: string]: unknown }): string {
  const keys = Object.keys(row).sort();
  const out: string[] = [];
  for (const k of keys) {
    out.push(`${k}=${JSON.stringify(row[k])}`);
  }
  return out.join(" ");
}

export interface FsReaderOptions {
  /** 工作区根（注入 `loom.yaml` 的 workspace 值，禁止硬编码，D33）。 */
  readonly workspaceRoot: string;
  /** 历史源（SessionShards 实例或测试替身）；null = 本轮无历史（收口/无会话）。 */
  readonly shards: ShardSourceLike | null;
}

/** ENOENT/ENOTDIR = 源缺失（fail-soft 语义）；其余 IO 错误留给 resolve 层归一化。 */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code: unknown = err.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 构造装配 reader：稳定文件走 workspace 相对路径，历史走分片增量读。 */
export function createFsAssemblyReader(opts: FsReaderOptions): AssemblyReader {
  return {
    readText(path: string): string | null {
      try {
        return readFileSync(join(opts.workspaceRoot, path), "utf8");
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    readHistoryIncrement(fromIndex: number): HistoryIncrement {
      if (opts.shards === null) return { lines: [], openedShards: 0 };
      const slice = opts.shards.readAfter(fromIndex);
      return { lines: slice.rows.map(canonicalRow), openedShards: slice.openedShards };
    },
    historyLength(): number {
      return opts.shards === null ? 0 : opts.shards.turnCount();
    },
  };
}
