/**
 * T37 压缩边界 e2e 装配层 —— 真 CompactionRoutine(T19) + 真 assemble(T18) +
 * 真 SessionShards/StateLayout(T08) 端到端长历史多轮场景的驱动与观测记录。
 *
 * 组件全真：压缩例程、boundary 账本（幂等写经 SessionShards 落盘）、分片+目录索引、
 * 装配 reader/装配核心、token 计数器（生产默认 request 级估算 defaultTokenCounter）、
 * 溢出归档编排（jsonlOverflowArchive + FileArchiveSink 落盘）全部走生产实现；
 * **只有模型面假化**——Summarizer 注入确定性 fake（绝不触真模型/网络，对齐 D21 测试接缝）。
 * 场景脚本与消息工厂在 `fixtures.ts`；本文件零断言（纯编排），断言集中在
 * compaction-boundary.test.ts。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultTokenCounter, type Message } from "@axeuh/loom-core";
import { createTestContext } from "@axeuh/loom-core/testing";
import {
  BoundaryLedger,
  CompactionRoutine,
  jsonlOverflowArchive,
  messageRow,
  parseBoundaryRow,
  type BoundaryRecord,
  type CompactionResult,
  type CompactionTraceInfo,
} from "@axeuh/loom-core/compaction";
import {
  assemble,
  createFsAssemblyReader,
  resolveMemorySources,
  type Assembly,
  type AssemblyPlan,
} from "@axeuh/loom-core/assembly";
import { SessionShards, StateLayout } from "@axeuh/loom-adapters";

import {
  E2E_LIMITS,
  FileArchiveSink,
  FIXED_NOW,
  SCENARIO_STEPS,
  SESSION_ID,
  TURNS_PER_SHARD,
  textOf,
  turnMessages,
  type CompactInputSnapshot,
  type E2EScenario,
  type TurnRecord,
} from "./fixtures.js";

export {
  E2E_LIMITS,
  FileArchiveSink,
  FIXED_NOW,
  SCENARIO_STEPS,
  SESSION_ID,
  textOf,
  TURNS_PER_SHARD,
  turnMessages,
  incrementText,
} from "./fixtures.js";
export type { CompactInputSnapshot, E2EScenario, TurnRecord } from "./fixtures.js";

/** 真 CompactionRoutine 接线（场景与重开放映共用；summarize 为唯一 fake 面）。 */
function makeRoutine(deps: {
  readonly shards: SessionShards;
  readonly overflowDir: string;
  readonly summarize: { n: number };
  readonly traces: CompactionTraceInfo[];
}): CompactionRoutine {
  const archive = jsonlOverflowArchive(new FileArchiveSink(deps.overflowDir));
  return new CompactionRoutine({
    limits: { ...E2E_LIMITS },
    ledger: new BoundaryLedger(deps.shards),
    archive,
    tokenCounter: defaultTokenCounter,
    compactableTools: ["read"],
    summarize: (early) => {
      deps.summarize.n += 1;
      return `SUM#${String(deps.summarize.n)}(early=${String(early.length)})`;
    },
    onTrace: (info) => {
      deps.traces.push(info);
    },
    now: FIXED_NOW,
  });
}

/** 打开同一 L0 布局上的真分片读写器。 */
function openShards(root: string): SessionShards {
  const layout = new StateLayout({ root: join(root, "state") });
  layout.ensureDirs();
  return new SessionShards(layout.sessionDir(SESSION_ID), { turnsPerShard: TURNS_PER_SHARD });
}

/**
 * 跑完整场景（纯 IO+编排，零断言）：
 * 每轮 = flush 消息进真分片 → 真装配（游标增量读）→ 真压缩例程（full 时 boundary
 * 经真 BoundaryLedger 幂等写进同一 SessionShards 落盘，live 视图接续 summary+tail）。
 */
export async function runScenario(root: string): Promise<E2EScenario> {
  const shards = openShards(root);

  const workspaceRoot = join(root, "workspace");
  mkdirSync(join(workspaceRoot, "memory/self"), { recursive: true });
  writeFileSync(join(workspaceRoot, "AGENTS.md"), "# 一级记忆\n稳定正文。\n");
  writeFileSync(join(workspaceRoot, "memory/self/SELF-INDEX.md"), "# SELF-INDEX\n索引正文\n");

  const resolved = resolveMemorySources(
    createFsAssemblyReader({ workspaceRoot, shards: null }),
    ["AGENTS.md", "memory/self/SELF-INDEX.md"],
  );
  const plan: AssemblyPlan = {
    systemPrompt: "你是 loom 主会话。",
    memorySources: resolved.sources,
    workflows: [{ name: "daily-review", prompt: "复盘工作流模板" }],
  };
  const reader = createFsAssemblyReader({ workspaceRoot, shards });

  const summarize = { n: 0 };
  const traces: CompactionTraceInfo[] = [];
  const overflowDir = join(root, "overflow");
  const routine = makeRoutine({ shards, overflowDir, summarize, traces });
  const { ctx } = createTestContext({ sessionId: SESSION_ID });

  const records: TurnRecord[] = [];
  const boundaries: BoundaryRecord[] = [];
  const compactInputs: CompactInputSnapshot[] = [];

  let live: Message[] = [];
  let liveSeq = 0;
  let cursor = 0;

  for (let turn = 1; turn <= SCENARIO_STEPS.length; turn += 1) {
    const step = SCENARIO_STEPS[turn - 1];
    if (step === undefined) throw new Error(`missing scenario step ${String(turn)}`);
    const msgs = turnMessages(turn, step);
    for (const m of msgs) {
      shards.appendTurn(messageRow(m));
      live.push(m);
    }

    const cursorBefore = cursor;
    const historyLenBefore = reader.historyLength();
    const assembly: Assembly = assemble(plan, reader, {
      historyCursor: cursor,
      currentMessage: `#t${String(turn)}# user prompt`,
    });
    cursor = reader.historyLength();

    const snapshot: CompactInputSnapshot = { messages: [...live], startSeq: liveSeq };
    const compact: CompactionResult = await routine.compact({
      sessionId: SESSION_ID,
      messages: live,
      ctx,
      startSeq: liveSeq,
    });

    let boundaryRowIndex: number | null = null;
    let boundary: BoundaryRecord | null = null;
    if (compact.executed === "full" && compact.boundary !== null) {
      boundary = compact.boundary;
      boundaryRowIndex = shards.turnCount() - 1;
      boundaries.push(boundary);
      compactInputs.push(snapshot);
      // boundary 替换前缀后的存活视图成为下一压缩域的 live；全局 seq 接续：
      // live[0]（summary）占 through+1 槽位，tail 首条真消息保真 seq。
      live = [...compact.view];
      liveSeq = snapshot.startSeq + boundary.trimmedCount;
    }

    records.push({
      turn,
      flushedRows: msgs.length,
      cursorBefore,
      historyLenBefore,
      assembly,
      compact,
      boundaryRowIndex,
      boundary,
    });
  }

  return {
    root,
    shards,
    records,
    boundaries,
    compactInputs,
    traces,
    summarizeCalls: summarize.n,
    plan,
    overflowDir,
    finalLive: live,
    finalLiveSeq: liveSeq,
  };
}

/** 重开实例读盘上的 boundary 行（撕裂容忍重放走真 Journal/SessionShards 路径）。 */
export function boundaryRowsOnDisk(scenario: E2EScenario): BoundaryRecord[] {
  const reopened = openShards(scenario.root);
  return reopened
    .readAfter(0)
    .rows.filter((r) => r["t"] === "compaction_boundary")
    .map((r) => parseBoundaryRow(r));
}

/**
 * 崩溃重放证明：重开分片 + 重挂 boundary 行 + 以最后一条 boundary 的原始输入重跑
 * compact —— 幂等预检命中 → duplicate、不重调 summarize、不再写行。
 */
export async function replayLastCompact(scenario: E2EScenario): Promise<{
  readonly outcome: "written" | "duplicate" | null;
  readonly boundaryKey: string | null;
  readonly viewFirstText: string | null;
  readonly freshSummarizeCalls: number;
}> {
  const last = scenario.compactInputs[scenario.compactInputs.length - 1];
  if (last === undefined) throw new Error("no compact inputs to replay");
  const summarize = { n: 0 };
  const traces: CompactionTraceInfo[] = [];
  const shards = openShards(scenario.root);
  const routine = makeRoutine({ shards, overflowDir: scenario.overflowDir, summarize, traces });
  const { ctx } = createTestContext({ sessionId: SESSION_ID });
  const r = await routine.compact({
    sessionId: SESSION_ID,
    messages: [...last.messages],
    ctx,
    startSeq: last.startSeq,
  });
  const first = r.view[0];
  return {
    outcome: r.writeOutcome,
    boundaryKey: r.boundary?.key ?? null,
    viewFirstText: first === undefined ? null : textOf(first),
    freshSummarizeCalls: summarize.n,
  };
}
