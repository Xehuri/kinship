/**
 * W47 自然停模式受理必生效——主会话 `convergenceEnforced:false` 的生产事故修复钉。
 *
 * 事故形状（hm/ai 实锤，explore 报告 H1/H2）：converge 工具无条件挂载且每轮受理
 * （"收束已受理，本轮到此结束。"），但自然停把唯一消费受理槽的 gate hooks 整体摘除
 * → 受理无人终审 → 内核唯一出口（session.ts 无 toolUse 轮才 done）永不触发 →
 * 主会话挂死至内核缺省 maxTurns=200；且槽复位点（gate.onSessionStart）本身是未挂
 * 的 hook → ACCEPTED_SLOT 跨 run 残留 → 新 run 合法首 converge 被假拒 "duplicate"。
 *
 * 修复语义（用户批准，不越 W26 的界）：自然停 =「系统不催办、不强制续跑、不封顶杀」，
 * 但模型自愿 converge 的**受理必须真实终结本轮**（终审子集：onSessionStart 复位 +
 * onTurnEnd 仅受理判别）。终结归类诚实化：受理终结 = converged，text-only 自然停 =
 * naturalStop，两态可区分。
 *
 * 本文件全部用 fake provider 复现事故形状：修复前逐条红（受理轮不终结 / 跨 run 假拒 /
 * 槽残留），修复后绿。
 */

import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  FORCE_MARK,
  type Hook,
  type Message,
  type StoredEntry,
} from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { MainSessionLoop } from "./loop.js";
import type { MainSessionLoopOptions } from "./types.js";
import type { Limits } from "../convergence/limits.js";
import {
  ACCEPTED_SLOT,
  FAIL_SLOT,
  RUN_GEN_SLOT,
  type AcceptedConvergence,
  type ConvergeFailInfo,
} from "../convergence/tool.js";

function quietSink(): void {
  /* 吞掉默认 console 输出，保持测试输出干净 */
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) =>
        typeof b === "object" && b !== null && "text" in b
          ? String((b as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

function allText(messages: ReadonlyArray<Message>): string {
  return messages.map((m) => textOf(m)).join("\n");
}

function terminalEntriesOf(entries: ReadonlyArray<StoredEntry>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const node of entries) {
    if (node.entry.kind === "terminal") {
      out.push(node.entry.result as unknown as Record<string, unknown>);
    }
  }
  return out;
}

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：W47 受理终结",
  body: "本轮结论：收束工具自愿调用并即时终结。",
};

/** 事故形状每轮回复：正文 + converge 合法调用混排（stopReason=toolUse，永不自然 done）。 */
const convergeTurn = (): FakeAssistantResponse => ({
  content: [
    { type: "text", text: "正文收束" },
    { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
  ],
});

/** 字段非法的 converge（wake 不可解析）：execute 层拒收 → 进 FAIL_SLOT，不写 ACCEPTED_SLOT。 */
const badConvergeTurn = (): FakeAssistantResponse => ({
  content: [
    { type: "text", text: "想收束但字段不齐" },
    {
      type: "toolCall",
      name: "converge",
      arguments: { status: "已完成", wake: "garbage" },
    },
  ],
});

const textTurn = (t: string): FakeAssistantResponse => ({
  content: [{ type: "text", text: t }],
});

function makeLoop(
  model: ReturnType<typeof createFakeModel>,
  opts: Partial<Omit<MainSessionLoopOptions, "model">> = {},
): MainSessionLoop {
  return MainSessionLoop.create({
    model,
    logSink: quietSink,
    consoleSink: quietSink,
    ...opts,
  });
}

/** 槽位探针：每个 turn 起点抓一次 ctx.state 槽快照（onTurnStart 先于本轮一切写入，读序确定）。 */
interface SlotProbe {
  readonly hook: Hook;
  readonly samples: Array<{
    runSeq: number;
    turnIdx: number;
    accepted: AcceptedConvergence | null;
    failCount: number;
    runGen: number | undefined;
  }>;
}

function makeProbe(): SlotProbe {
  const samples: SlotProbe["samples"] = [];
  let runSeq = 0;
  const hook: Hook = {
    name: "w47-slot-probe",
    onSessionStart() {
      runSeq += 1;
    },
    onTurnStart(input, ctx) {
      samples.push({
        runSeq,
        turnIdx: input.turnIdx,
        accepted: ctx.state.get(ACCEPTED_SLOT) ?? null,
        failCount: (ctx.state.get(FAIL_SLOT) ?? []).length,
        runGen: ctx.state.get(RUN_GEN_SLOT),
      });
    },
  };
  return { hook, samples };
}

describe("W47 自然停受理必生效（终审子集）", () => {
  it("(1) 受理即终结本轮：合法 converge 后 result=converged、第二次 LLM call 零发生", async () => {
    // 事故形状最小单元：模型收束后**不补**任何无工具轮（旧语义死锁的触发条件）。
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model, { convergenceEnforced: false });

    const result = await loop.start("汇报并收束，不要再补轮");

    expect(result.type, "受理必须终结").toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(result.receipt.status).toBe("已完成");
    expect(result.summary.reason).toBe("aborted");
    expect(String(result.summary.abortReason)).toContain("convergence:converged");
    // 即时 = 单次 LLM call（旧行为要烧完脚本直到 fake 耗尽才以 text-only done 逃逸）。
    expect(model.getCalls()).toHaveLength(1);
    // 账本诚实：恰一条 converged 终态（受理判别的记账），零催办零强制。
    const outcomes = loop.outcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.type).toBe("converged");
    expect(allText(loop.messages)).toContain("收束已受理");
    model.teardown();
  });

  it("(2) 事故形状复现：每轮正文+converge 的死循环脚本，第一轮受理即终结、不烧到回合封顶", async () => {
    // 25 轮全 toolUse（复刻 s5w46-sidL2 转录形状）。修复前：烧满 25 轮（fake 耗尽后
    // text-only done 逃逸 = naturalStop）；修复后：第 1 轮即终结，其后条目零消费。
    const model = createFakeModel(Array.from({ length: 25 }, () => convergeTurn()));
    const loop = makeLoop(model, { convergenceEnforced: false });

    const result = await loop.start("生产事故形状：回复正文并立即调用 converge");

    expect(result.type).toBe("converged");
    expect(model.getCalls(), "受理终结后内核不再续轮").toHaveLength(1);
    expect(loop.outcomes()).toHaveLength(1);
    model.teardown();
  });

  it("(3) 落盘 terminal 归类诚实：受理终结持久副本 reason=done + convergence 前缀（W16-F3 同形）", async () => {
    const store = new MemorySessionStore();
    const sessionId = "w47-terminal-honest";
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model, { store, sessionId, convergenceEnforced: false });

    await loop.start("受理即盖棺，落盘要诚实");

    // 改标门面自然停也要在位：受理轮的 aborted+convergence 前缀副本改标 done，
    // abortReason 原样留审计——与 enforced 路 W16-F3 形状逐字段同构。
    const terminals = terminalEntriesOf(await store.getPathToLeaf(sessionId));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.["reason"]).toBe("done");
    expect(String(terminals[0]?.["abortReason"])).toContain("convergence:converged");
    model.teardown();
  });

  it("(4) 两态可区分：text-only 自然停=naturalStop 无回执；自愿 converge=converged 带回执", async () => {
    // 钉"自然停不丢自然停"：终审子集只判受理，纯文本收尾仍走 naturalStop（W26 边界）。
    const store = new MemorySessionStore();
    const modelStop = createFakeModel([textTurn("只聊天不收束。")]);
    const stopLoop = makeLoop(modelStop, {
      store,
      sessionId: "w47-two-a",
      convergenceEnforced: false,
    });
    const rStop = await stopLoop.start("闲聊");
    expect(rStop.type).toBe("naturalStop");
    // naturalStop 形状里没有 receipt 字段可谎报（判别联合互斥 = 两态类型级可区分）。
    expect(Object.keys(rStop)).not.toContain("receipt");

    const modelConv = createFakeModel([convergeTurn()]);
    const convLoop = makeLoop(modelConv, {
      store,
      sessionId: "w47-two-b",
      convergenceEnforced: false,
    });
    const rConv = await convLoop.start("收束");
    expect(rConv.type).toBe("converged");
    if (rConv.type !== "converged") throw new Error("unreachable");
    expect(rConv.receipt.digest).toBe("已完成：W47 受理终结");

    // 落盘面同样可区分：text-only terminal 无 convergence 痕迹。
    const stopTerminals = terminalEntriesOf(await store.getPathToLeaf("w47-two-a"));
    expect(String(stopTerminals[0]?.["abortReason"] ?? "")).not.toContain("convergence");
    modelStop.teardown();
    modelConv.teardown();
  });

  it("(5) 新 run 首次 converge 必受理必终结（H2 跨 run 残留假拒修复）", async () => {
    // 同一长驻 loop 连跑两 run，都从 turnIdx=0 起数。修复前：run2 turn0 撞上 run1
    // 残留 ACCEPTED_SLOT{turnIdx:0} → 假拒"duplicate" → 本 run 永不受理（naturalStop）。
    const store = new MemorySessionStore();
    const sessionId = "w47-cross-run";
    const model = createFakeModel([convergeTurn(), convergeTurn()]);
    const loop = makeLoop(model, { store, sessionId, convergenceEnforced: false });

    const r1 = await loop.start("第一问");
    expect(r1.type).toBe("converged");
    const r2 = await loop.start("第二问");
    expect(r2.type, "新 run 合法首 converge 不得被上一 run 残留假拒").toBe("converged");
    expect(allText(loop.messages), "转录不得出现 duplicate 假拒文案").not.toContain(
      "重复收束不计数",
    );
    expect(model.getCalls()).toHaveLength(2);
    model.teardown();
  });

  it("(6) 槽代际跨 run 复位：run2 turn0 探针见 ACCEPTED_SLOT=null、FAIL_SLOT 清空、runGen 递增", async () => {
    const probe = makeProbe();
    const model = createFakeModel([convergeTurn(), textTurn("第二问自然停。")]);
    const loop = makeLoop(model, {
      convergenceEnforced: false,
      extraHooks: [probe.hook],
    });

    await loop.start("第一问");
    await loop.start("第二问");

    expect(probe.samples).toHaveLength(2);
    const [s1, s2] = probe.samples;
    expect(s1?.accepted, "run1 起点无残留").toBeNull();
    expect(s1?.failCount).toBe(0);
    expect(s2?.accepted, "run2 起点必须看到复位后的空槽（修复前残留 {turnIdx:0}）").toBeNull();
    expect(s2?.failCount).toBe(0);
    expect(s2?.runGen, "run 代际逐 run 递增").toBe(2);
    model.teardown();
  });

  it("(7) FAIL_SLOT 有界：多轮拒收跨 run 不复利；自然模式催办零发、账本零记账（不越 W26 界）", async () => {
    // 自然停不挂 onPostToolUse 消费方 → FAIL_SLOT 只推不Pop。复位进终审子集后按 run 有界。
    const probe = makeProbe();
    const model = createFakeModel([
      badConvergeTurn(),
      badConvergeTurn(),
      textTurn("第一轮放弃收束。"),
      badConvergeTurn(),
      textTurn("第二轮自然停。"),
    ]);
    const loop = makeLoop(model, {
      convergenceEnforced: false,
      extraHooks: [probe.hook],
    });

    const r1 = await loop.start("拒收两次再自然停");
    expect(r1.type).toBe("naturalStop");
    const r2 = await loop.start("再来一次拒收");
    expect(r2.type).toBe("naturalStop");

    // 采样点=每 turn 起点：run1 三 turn（0,1 拒收累积、2 文本收尾前 failCount=2）；
    // run2 turn0 必须看到复位后的 0（修复前=2 且 turn1 复利到 3）。
    const run2start = probe.samples.find((s) => s.runSeq === 2 && s.turnIdx === 0);
    expect(run2start?.failCount, "FAIL_SLOT 跨 run 复位").toBe(0);
    const run2turn1 = probe.samples.find((s) => s.runSeq === 2 && s.turnIdx === 1);
    expect(run2turn1?.failCount, "本 run 内至多累积当轮拒收数").toBe(1);

    // W26 边界照旧：零催办文案、零强制 marker、账本零条目（拒收不该触发任何终审记账）。
    expect(allText(loop.messages)).not.toContain("收束催办");
    expect(allText(loop.messages)).not.toContain(FORCE_MARK);
    expect(loop.outcomes()).toEqual([]);
    model.teardown();
  });

  it("(8) 终审子集不复活强制链：阈值再小也不催办/不硬顶/不续跑，未受理一律自然停", async () => {
    // 钉"终审 ≠ 强制"：nudgeLimit=1 / turnHardCap=1 的极小阈值下，无受理轮照常自然停
    // （强制在位时第一轮末就盖棺 forceEnded——这里必须零发生）。
    const limits: Limits = {
      nudgeLimit: 1,
      escalateSameError: 1,
      turnHardCap: 1,
      autoContinuations: 0,
    };
    const model = createFakeModel([badConvergeTurn(), textTurn("阈值极小仍自然停。")]);
    const loop = makeLoop(model, { limits, convergenceEnforced: false });

    const result = await loop.start("催办上限=1 也不许催");

    expect(result.type).toBe("naturalStop");
    expect(loop.outcomes()).toEqual([]);
    expect(loop.events().filter((e) => e.type === "loop-forced")).toEqual([]);
    expect(allText(loop.messages)).not.toContain("收束催办");
    expect(allText(loop.messages)).not.toContain("会话尚未收束");
    model.teardown();
  });
});
