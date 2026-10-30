/**
 * W9 切片 3 —— 内核后台 sub 账本机器单测。
 * Given: MemoryLedger + 闭包执行体（可编程 settle/hang-until-abort/reject）+ 注入时钟
 * When:  dispatchSubBackground（expected-before-fire / actual-at-terminal / crash 缺口 /
 *        deadline 定时器 / cancelSub 三态 / 撞号）
 * Then:  run 面（_runs/activeCount/listRuns/get）零污染（/runs 纯度的机制层）；
 *        sub 册状态机 queued→running→终态；deadline 到点=既有 failed+cancelRequested 形状；
 *        onRunTerminal 缝 durable 发射（同步面走不到的新覆盖）；onTerminalLocal 盖棺后恰一次。
 */

import { describe, expect, it } from "vitest";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import type { RunLaunchResult, RunRecord, RunRow } from "../run-engine/types.js";
import { SpawnKernel } from "./kernel.js";
import type { SubTaskRecord } from "./types.js";

function subRow(over: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "run_s3task00000001",
    workflow: "subagent.general",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: "ses_s3child00000001",
    ...over,
  };
}

const doneResult: RunLaunchResult = { status: "done", digest: "done：子结论", pointers: [], blockers: [] };

function baseArgs(over: Partial<Parameters<SpawnKernel["dispatchSubBackground"]>[0]> = {}) {
  return {
    row: subRow(),
    agentType: "general",
    task: "后台一步",
    parentSessionId: "ses_parent0000000001",
    depth: 1,
    run: async (): Promise<RunLaunchResult> => doneResult,
    ...over,
  };
}

describe("SpawnKernel 后台 sub 账本：durable 全序", () => {
  it("expected 先于执行、actual 盖棺、sub 身份入册、run 面查询零污染", async () => {
    const ledger = new MemoryLedger();
    const started: string[] = [];
    const terminals: RunRecord[] = [];
    let tagsAtEnter: string[] = [];
    const kernel = new SpawnKernel({
      ledger,
      sessionPort: { run: async () => doneResult }, // 不被 sub 面使用（执行体直注）
      now: () => 99,
      onRunStarted: (row) => started.push(row.run_id),
      onRunTerminal: (rec) => terminals.push(rec),
    });
    const handle = kernel.dispatchSubBackground(baseArgs({
      run: async (signal) => {
        // 进入瞬间取证：账本已有 expected 绝无 actual；aborter 在场（不吃父 signal 的自备通道）
        tagsAtEnter = ledger.entries.map((e) => e.t);
        void signal.aborted;
        return doneResult;
      },
    }));
    expect(tagsAtEnter).toEqual(["expected"]); // D15 铁律随 sub 面平移
    expect(started, "run-trace beginRun 缝对后台 durable 发射").toEqual(["run_s3task00000001"]);

    const rec = await handle.completion;
    expect(rec.kind).toBe("sub");
    expect(rec.taskId).toBe("run_s3task00000001");
    expect(rec.agentType).toBe("general");
    expect(rec.parentSessionId).toBe("ses_parent0000000001");
    expect(rec.state).toBe("done");
    expect(rec.terminal?.digest).toBe("done：子结论");
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected", "actual"]);
    // expected payload：六键原样 + additive 判别（reader 宽容、行形状冻结的边界）
    const payload = ledger.entries[0]!.payload as Record<string, unknown>;
    expect(payload["kind"]).toBe("sub");
    expect(payload["agent_type"]).toBe("general");
    expect(payload["parent_session"]).toBe("ses_parent0000000001");
    expect(payload["run_id"]).toBe("run_s3task00000001");
    // 三缝出口：终态观察者恰一次（run_end 语义原料）
    expect(terminals).toHaveLength(1);
    // run 面零污染（/runs 纯度机制层）
    expect(kernel.listRuns()).toHaveLength(0);
    expect(kernel.get("run_s3task00000001")).toBeUndefined();
    expect(kernel.activeCount()).toBe(0);
    expect(kernel.subActiveCount()).toBe(0);
  });

  // W49.2 有意为之的严格面更新：expected payload 键集从 **9 键 → 10 键**。
  // title 是条件展开的 additive 键（kernel.ts dispatchSubBackground：给了才落，
  // 缺省键**整体缺席**、绝不落 title:null 假键）；既有逐键宽容钉（上方 76-80 行）
  // 不覆盖「多键/假键」形态，本格用 toStrictEqual 整钉两态守双向字节保真。
  // adapters Ledger 对 payload 零校验 → 旧行（9 键）重放天然容忍，无需迁移。
  it("W49.2 expected payload 严格双格：带 title=10 键逐值；缺 title=旧 9 键逐字节（假键零出现）", async () => {
    const ledgerT = new MemoryLedger();
    const kT = new SpawnKernel({ ledger: ledgerT, sessionPort: { run: async () => doneResult } });
    await kT.dispatchSubBackground(baseArgs({ title: "10-16 夜·折扣审计" })).completion;
    expect(ledgerT.entries[0]!.payload).toStrictEqual({
      run_id: "run_s3task00000001",
      workflow: "subagent.general",
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: "ses_s3child00000001",
      kind: "sub",
      agent_type: "general",
      parent_session: "ses_parent0000000001",
      title: "10-16 夜·折扣审计",
    });
    const recT = kT.getSub("run_s3task00000001")!;
    expect(recT.title).toBe("10-16 夜·折扣审计");

    const ledger0 = new MemoryLedger();
    const k0 = new SpawnKernel({ ledger: ledger0, sessionPort: { run: async () => doneResult } });
    await k0.dispatchSubBackground(baseArgs()).completion;
    expect(ledger0.entries[0]!.payload).toStrictEqual({
      run_id: "run_s3task00000001",
      workflow: "subagent.general",
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: "ses_s3child00000001",
      kind: "sub",
      agent_type: "general",
      parent_session: "ses_parent0000000001",
    });
    const rec0 = k0.getSub("run_s3task00000001")!;
    expect("title" in rec0).toBe(false); // 登记册键缺席（视图面 ?? null 投影，不造假值）
  });

  it("执行体抛炸 = 崩溃形状：failed+crashed、账本留缺口、completion 恒 resolve", async () => {
    const ledger = new MemoryLedger();
    const kernel = new SpawnKernel({ ledger, sessionPort: { run: async () => doneResult } });
    const handle = kernel.dispatchSubBackground(baseArgs({
      run: async () => { throw new Error("child executor blew up"); },
    }));
    const rec = await handle.completion; // 恒 resolve
    expect(rec.state).toBe("failed");
    expect(rec.crashed).toBe(true);
    expect(rec.error).toContain("child executor blew up");
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected"]);
    expect(kernel.gaps()).toEqual(["run_s3task00000001"]);
    // crashed 仍是终态记录（闸计数=非终态归零；缺口由 gaps()/账本承载，T13 对账语义）
    expect(kernel.subActiveCount()).toBe(0);
  });

  it("deadline 到点 = 既有 failed+cancelRequested 形状（零新状态）+ 定时器不吊住事件循环", async () => {
    const kernel = new SpawnKernel({
      ledger: new MemoryLedger(),
      sessionPort: { run: async () => doneResult },
    });
    let local: SubTaskRecord | undefined;
    const handle = kernel.dispatchSubBackground(baseArgs({
      deadlineMs: 30,
      // 挂到 abort 才收场（协作式 session 语义）：到点后走正常终局路径。
      run: (signal) =>
        new Promise<RunLaunchResult>((resolve) => {
          const finish = (): void =>
            resolve({ status: "failed", digest: "failed：deadline", pointers: [], blockers: ["termination:aborted"] });
          if (signal.aborted) finish();
          else signal.addEventListener("abort", finish, { once: true });
        }),
      onTerminalLocal: (rec) => { local = rec; },
    }));
    const rec = await handle.completion;
    expect(rec.state).toBe("failed");
    expect(rec.cancelRequested).toBe("deadline");
    expect(rec.crashed).toBe(false); // 合法终态，非崩溃缺口
    expect(local?.taskId).toBe("run_s3task00000001");
    expect(kernel.subActiveCount()).toBe(0);
    expect(kernel.gaps()).toEqual([]);
  });

  it("cancelSub 三态（未知/在途/终态）与 handle.cancel 同语义；撞号响亮抛", async () => {
    const kernel = new SpawnKernel({
      ledger: new MemoryLedger(),
      sessionPort: { run: async () => doneResult },
    });
    expect(kernel.cancelSub("run_nosuch000000000")).toBe(false);
    let release: (r: RunLaunchResult) => void = () => {};
    const handle = kernel.dispatchSubBackground(baseArgs({
      run: () => new Promise<RunLaunchResult>((res) => { release = res; }),
    }));
    expect(kernel.subActiveCount()).toBe(1);
    expect(handle.cancel("operator stop")).toBe(true);
    const rec0 = kernel.getSub(handle.taskId)!;
    expect(rec0.cancelRequested).toBe("operator stop");
    // 在途重复 cancel：仍命中 true、原因覆盖（同 run cancel 面既有语义）
    expect(kernel.cancelSub(handle.taskId, "second")).toBe(true);
    release(doneResult);
    const rec = await handle.completion;
    expect(rec.state).toBe("done");
    expect(kernel.cancelSub(handle.taskId)).toBe(false);
    await expect(
      Promise.resolve().then(() => kernel.dispatchSubBackground(baseArgs())),
    ).rejects.toThrow(/already known/);
  });

  it("死信 sub-kind：failed 终态投 dead-letter payload 带自证三键；done 不发", async () => {
    const emitted: Record<string, unknown>[] = [];
    const kernel = new SpawnKernel({
      ledger: new MemoryLedger(),
      sessionPort: { run: async () => doneResult },
      deadLetterSink: { emit: (p) => { emitted.push(p as unknown as Record<string, unknown>); } },
    });
    await kernel.dispatchSubBackground(baseArgs({
      run: async () => ({ status: "failed", digest: "failed：子未成", pointers: [], blockers: ["b"] }),
    })).completion;
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!["sub_kind"]).toBe("sub");
    expect(emitted[0]!["agent_type"]).toBe("general");
    expect(emitted[0]!["parent_session"]).toBe("ses_parent0000000001");
    await kernel.dispatchSubBackground(baseArgs({
      row: subRow({ run_id: "run_s3done000000001", session_id: "ses_s3donechild0001" }),
    })).completion;
    expect(emitted, "done 不发死信（run 面同款纪律）").toHaveLength(1);
  });

  it("onTerminalLocal 抛错只 warn 反噬面零：盖棺与 completion 不受影响", async () => {
    const warns: string[] = [];
    const kernel = new SpawnKernel({
      ledger: new MemoryLedger(),
      sessionPort: { run: async () => doneResult },
      log: (level, msg) => { if (level === "warn") warns.push(msg); },
    });
    const h = kernel.dispatchSubBackground(baseArgs({
      onTerminalLocal: () => { throw new Error("local hook blew up"); },
    }));
    const rec = await h.completion;
    expect(rec.state).toBe("done");
    expect(warns).toContain("sub:terminal-observer-failed");
  });
});
