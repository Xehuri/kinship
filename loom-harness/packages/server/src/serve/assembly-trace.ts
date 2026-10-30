// T31 serve 装配 —— 主会话装配 span 落 trace（T39 前置接线波）。
// 目的：给"装配前缀含真实 workspace 记忆注入"提供 trace 侧可观测证明量——
// 每次主会话 run 结束，把 loop 记录的每个 turn 边界装配产物写成
// stage="assembly" 的 span 行，追加到 `{stateRoot}/trace/{date}.jsonl`
// （T21 Tracer 同布局，kind="span"；smoke-real-model.sh 的 trace 核验面由此出证）。
// 口径：
//   - assemblyRowCount = 注入源条数（assembly.memorySourceCount，>0 即记忆注入证明）；
//   - attrs.injectedLines = memory 段非空行数（tool-trace textLineCount 统一口径，
//     与副会话 assembly span 同字段名——fleet S02 的硬证据面）；
//   - degradeRows / incrementRows 如实入 attrs/span；
//   - 唯一时序真源 = MainSessionLoop.events()（loop 先记账、本回调后消费，
//     不依赖 hook 相对顺序）；写失败只留 warn 日志，绝不把异常抛回会话域。

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Assembly } from "@axeuh/loom-core/assembly";
import type { LoopEvent } from "@axeuh/loom-core/main-loop";
import { localDateKey, type RunSpan } from "@axeuh/loom-core";

import { textLineCount } from "./tool-trace.js";

type TraceLog = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => void;

/** 把一次主会话 run 的装配事件落成 trace span 行；返回写入行数。 */
export interface AssemblyTraceWriter {
  write(sessionId: string, events: readonly LoopEvent[]): number;
}

export function createAssemblyTraceWriter(opts: {
  readonly stateRoot: string;
  readonly log?: TraceLog;
  readonly now?: () => number;
}): AssemblyTraceWriter {
  const now = opts.now ?? Date.now;
  return {
    write(sessionId: string, events: readonly LoopEvent[]): number {
      const assemblies = events.filter(
        (e): e is Extract<LoopEvent, { type: "assembly" }> => e.type === "assembly",
      );
      if (assemblies.length === 0) return 0;
      const at = now();
      const dirPath = join(opts.stateRoot, "trace");
      const dayPath = join(dirPath, `${localDateKey(at)}.jsonl`);
      let written = 0;
      for (const ev of assemblies) {
        const line = JSON.stringify(assemblySpan(sessionId, ev.turnIdx, ev.assembly, at));
        try {
          mkdirSync(dirPath, { recursive: true });
          appendFileSync(dayPath, `${line}\n`, "utf8");
          written += 1;
        } catch (err) {
          // trace 是观测面：坏一次留痕即可，绝不反噬会话。
          opts.log?.("warn", "loom assembly span write failed", {
            path: dayPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return written;
    },
  };
}

/** 装配 span 行的构造（纯函数，测试直接钉形状；装配在 turn 边界同步完成，start=end）。 */
export function assemblySpan(sessionId: string, turnIdx: number, assembly: Assembly, at: number): RunSpan {
  const memorySeg = assembly.segments.find((s) => s.name === "memory");
  const injectedLines = memorySeg === undefined ? 0 : textLineCount(new TextDecoder().decode(memorySeg.bytes));
  return {
    kind: "span",
    runId: `run_${randomBytes(8).toString("hex")}`,
    sessionId,
    spanId: `spn_${randomBytes(8).toString("hex")}`,
    stage: "assembly",
    name: `assembly[${String(turnIdx)}]`,
    index: turnIdx,
    start: at,
    end: at,
    durationMs: 0,
    assemblyRowCount: assembly.memorySourceCount,
    attrs: { degradeRows: assembly.degrades.length, incrementRows: assembly.incrementRows, injectedLines },
  };
}
