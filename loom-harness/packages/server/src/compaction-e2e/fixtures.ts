/**
 * T37 压缩边界 e2e 的场景定义与假面构件（纯测试基建，零断言）。
 *
 * 分工：本文件只放「场景脚本 + 确定性消息构造 + 溢出档案落盘 + 增量段观测」；
 * 压缩/装配/分片的编排在 `e2e-harness.ts`。组件全真、仅模型假——Summarizer fake
 * 与这里的消息工厂是仅有的两个假面（绝不触真模型/网络，对齐 docs/01 D21 测试接缝）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createUserMessage,
  type AssistantMessage,
  type Message,
  type ToolResultMessage,
  type Usage,
} from "@axeuh/loom-core";
import type { Assembly, AssemblyPlan } from "@axeuh/loom-core/assembly";
import type {
  BoundaryRecord,
  CompactionResult,
  CompactionTraceInfo,
} from "@axeuh/loom-core/compaction";
import type { SessionShards } from "@axeuh/loom-adapters";

/** e2e 会话 id（StateLayout assertSafeSegment 合法）。 */
export const SESSION_ID = "s37-e2e";

/** 固定时钟：boundary.at / trace 耗时确定，可重放比对。 */
export const FIXED_NOW = (): number => 1_760_000_000_000;

/**
 * 测试阈值（热配置 seam 的真实形态，docs/01 D21）：2000 token 窗口、85% 水位、
 * 95% 规划 full、微压缩目标 50%、full 后保留最近 4 条、微压缩保留最近 2 条 toolResult。
 */
export const E2E_LIMITS = {
  contextWindow: 2000,
  watermarkRatio: 0.85,
  fullRatio: 0.95,
  microTargetRatio: 0.5,
  keepRecent: 4,
  microKeepRecent: 2,
};

/** 每 N turn 封一片（T08 目录索引的 e2e 观测面）。 */
export const TURNS_PER_SHARD = 5;

/** ASCII 填充（走 defaultTokenCounter 的 chars/4+每消息4 规则）：mail ~700 / read ~600 token。 */
const MAIL_PAD = 2790;
const READ_PAD = 2390;

/** 一个模拟 turn：工具名 + 输出体量档位。 */
export interface TurnStep {
  readonly tool: "mail_send" | "read";
  readonly pad: number;
}

/**
 * 场景脚本（10 轮，覆盖三档）：
 *  1-4  mail 大输出（非白名单）→ 连跨水位 → 连续 full 压缩出 boundary；
 *  5-7  read 大输出（白名单）→ 微压缩先行可救回（executed=micro、不花 summarize）；
 *  8-10 mail 再灌 → 追加 boundary（多边界、范围接续）。
 */
export const SCENARIO_STEPS: readonly TurnStep[] = [
  ...Array.from<unknown, TurnStep>({ length: 4 }, () => ({ tool: "mail_send", pad: MAIL_PAD })),
  ...Array.from<unknown, TurnStep>({ length: 3 }, () => ({ tool: "read", pad: READ_PAD })),
  ...Array.from<unknown, TurnStep>({ length: 3 }, () => ({ tool: "mail_send", pad: MAIL_PAD })),
];

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 一条 turn 的三条消息（user → assistant → toolResult）；`#tN#` 标记嵌入每条文本。 */
export function turnMessages(turn: number, step: TurnStep): Message[] {
  const userMsg = createUserMessage(`#t${String(turn)}# user prompt`);
  const a: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: `#t${String(turn)}# ok` }],
    api: "e2e-fake",
    provider: "fake",
    model: "fake-main",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: FIXED_NOW(),
  };
  const t: ToolResultMessage = {
    role: "toolResult",
    toolCallId: `tc${String(turn)}`,
    toolName: step.tool,
    content: [{ type: "text", text: `#t${String(turn)}#${step.tool}:` + "y".repeat(step.pad) }],
    isError: false,
    timestamp: FIXED_NOW(),
  };
  return [userMsg, a, t];
}

/** 提取消息文本（string content 或 text 块拼接）。 */
export function textOf(m: Message): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("");
}

/** 溢出原文档案的文件实现（D21「溢出原文留档，read 按需读回」的落盘面，harness 侧接线）。 */
export class FileArchiveSink {
  private readonly _dir: string;

  constructor(dir: string) {
    this._dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** `overflow://a/b.jsonl` → `<dir>/a/b.jsonl`；路径段拒绝 `.`/`..`（指针不可逃逸）。 */
  private resolve(pointer: string): string {
    if (!pointer.startsWith("overflow://")) {
      throw new Error(`FileArchiveSink: bad pointer scheme: ${pointer}`);
    }
    const segments = pointer.slice("overflow://".length).split("/");
    for (const seg of segments) {
      if (seg === "" || seg === "." || seg === "..") {
        throw new Error(`FileArchiveSink: unsafe pointer segment: ${pointer}`);
      }
    }
    return join(this._dir, ...segments);
  }

  put(pointer: string, text: string): void {
    const p = this.resolve(pointer);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }

  get(pointer: string): string | null {
    const p = this.resolve(pointer);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
}

/** 装配增量段的解码文本（指针/标记缺席断言的观测面）。 */
export function incrementText(a: Assembly): string {
  const seg = a.segments.find((x) => x.name === "increment");
  if (seg === undefined) throw new Error("increment segment missing");
  return new TextDecoder().decode(seg.bytes);
}

/** 每次 full 压缩的输入快照（崩溃重开放映/幂等重放用）。 */
export interface CompactInputSnapshot {
  readonly messages: readonly Message[];
  readonly startSeq: number;
}

/** 一轮的完整观测记录（断言的唯一取数面）。 */
export interface TurnRecord {
  readonly turn: number;
  /** 本轮 flush 进 L0 的消息行数。 */
  readonly flushedRows: number;
  /** 本轮装配时的历史游标（= 上轮 historyLength）。 */
  readonly cursorBefore: number;
  /** 装配前的历史总行数（增量行数 = 此值 - cursorBefore）。 */
  readonly historyLenBefore: number;
  readonly assembly: Assembly;
  readonly compact: CompactionResult;
  /** boundary 行落盘的 L0 turn 下标（未产生 boundary → null）。 */
  readonly boundaryRowIndex: number | null;
  /** 本轮 full 压缩产出的 boundary（无 → null）。 */
  readonly boundary: BoundaryRecord | null;
}

/** 整场景的运行结果（纯数据；断言只消费它，不再触任何实现）。 */
export interface E2EScenario {
  readonly root: string;
  readonly shards: SessionShards;
  readonly records: readonly TurnRecord[];
  readonly boundaries: readonly BoundaryRecord[];
  readonly compactInputs: readonly CompactInputSnapshot[];
  readonly traces: readonly CompactionTraceInfo[];
  readonly summarizeCalls: number;
  readonly plan: AssemblyPlan;
  readonly overflowDir: string;
  readonly finalLive: readonly Message[];
  readonly finalLiveSeq: number;
}
