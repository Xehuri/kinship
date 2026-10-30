/**
 * T17 暂停开关验收（docs/02 §T17 TDD：admission-block test first）。
 *
 * 冻结验收：
 *   1. paused global 拦全部（含逐工作流未设的）；
 *   2. paused workflow 只拦该工作流，其他照常放行；
 *   3. 准入审计行必记（scope 分层、reason=paused、行字段齐）；
 *   4. 热读：每次 admit 现读开关源，翻转即时生效、无缓存脏值；
 *   5. 引擎集成：paused → dispatch 返回 paused、账本零痕迹、引擎不登记；
 *      解除后同输入照常开火走终态。
 */

import { describe, expect, it } from "vitest";
import { RunEngine } from "../run-engine/engine.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import {
  type DispatchInput,
  type RunLaunchResult,
  type RunRow,
  type RunSessionPort,
} from "../run-engine/types.js";
import {
  PAUSE_REASON,
  MemoryPauseAudit,
  PauseAdmission,
  PauseSwitchBoard,
  type PauseSwitches,
} from "./pause.js";

/* ────────────── helpers ────────────── */

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

function rowOf(over: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "run_0000000000000001",
    workflow: "nightly-audit",
    attempt: 1,
    trigger: "cron",
    parent_run: null,
    session_id: "ses_0000000000000002",
    ...over,
  };
}

/** 固定开关快照（不翻转时的源）。 */
function staticSwitches(sw: PauseSwitches): () => PauseSwitches {
  return () => sw;
}

const EMPTY: PauseSwitches = { global: false, perWorkflow: new Map() };

/* ────────────── 1-3：函数级准入判定 + 审计行 ────────────── */

describe("PauseAdmission 判定与审计", () => {
  it("global paused 拦截全部工作流并记 scope=global 审计行", () => {
    const audit = new MemoryPauseAudit();
    const pa = new PauseAdmission({
      switches: staticSwitches({ global: true, perWorkflow: new Map() }),
      audit,
      now: () => 1000,
    });

    const d1 = pa.admit(rowOf({ workflow: "nightly-audit" }));
    const d2 = pa.admit(rowOf({ run_id: "run_0000000000000003", workflow: "other-flow" }));

    expect(d1).toEqual({ kind: "paused", reason: PAUSE_REASON });
    expect(d2).toEqual({ kind: "paused", reason: PAUSE_REASON });
    expect(audit.entries.length).toBe(2);
    expect(nth(audit.entries, 0)).toEqual({
      kind: "pause:blocked",
      scope: "global",
      reason: "paused",
      run_id: "run_0000000000000001",
      workflow: "nightly-audit",
      attempt: 1,
      trigger: "cron",
      at: 1000,
    });
    // 全局命中时 scope 记 global（即便该工作流也显式暂停，不重复记行）
    expect(nth(audit.entries, 1).scope).toBe("global");
  });

  it("workflow paused 只拦该工作流；其他放行且不记审计行", () => {
    const audit = new MemoryPauseAudit();
    const pa = new PauseAdmission({
      switches: staticSwitches({ global: false, perWorkflow: new Map([["nightly-audit", true]]) }),
      audit,
    });

    const blocked = pa.admit(rowOf({ workflow: "nightly-audit" }));
    const passed = pa.admit(rowOf({ run_id: "run_0000000000000004", workflow: "mail-sync" }));

    expect(blocked).toEqual({ kind: "paused", reason: PAUSE_REASON });
    expect(passed).toEqual({ kind: "admit" });
    expect(audit.entries.length).toBe(1);
    expect(nth(audit.entries, 0).scope).toBe("workflow");
    expect(nth(audit.entries, 0).workflow).toBe("nightly-audit");
  });

  it("缺键=放行、显式 false=放行（只有显式 true 才拦）", () => {
    const audit = new MemoryPauseAudit();
    const pa = new PauseAdmission({
      switches: staticSwitches({
        global: false,
        perWorkflow: new Map([["a", false], ["b", true]]),
      }),
      audit,
    });

    expect(pa.admit(rowOf({ workflow: "missing" }))).toEqual({ kind: "admit" });
    expect(pa.admit(rowOf({ run_id: "run_0000000000000005", workflow: "a" }))).toEqual({ kind: "admit" });
    expect(pa.admit(rowOf({ run_id: "run_0000000000000006", workflow: "b" })).kind).toBe("paused");
    expect(audit.entries.length).toBe(1);
  });

  it("admit 决策绝不写审计行（只有拦截留痕）", () => {
    const audit = new MemoryPauseAudit();
    const pa = new PauseAdmission({ switches: staticSwitches(EMPTY), audit });
    expect(pa.admit(rowOf())).toEqual({ kind: "admit" });
    expect(audit.entries.length).toBe(0);
  });
});

/* ────────────── 4：热读（无缓存脏值） ────────────── */

describe("热读语义", () => {
  it("每次 admit 现读开关源一次；翻转即时生效", () => {
    const board = new PauseSwitchBoard();
    let reads = 0;
    const audit = new MemoryPauseAudit();
    const pa = new PauseAdmission({
      switches: () => {
        reads += 1;
        return board.read();
      },
      audit,
    });

    // 初始全开 → 放行，读了 1 次
    expect(pa.admit(rowOf())).toEqual({ kind: "admit" });
    expect(reads).toBe(1);

    // 翻暂停 → 同一实例下一次 admit 立即拦截（证明没缓存旧快照）
    board.setWorkflow("nightly-audit", true);
    expect(pa.admit(rowOf({ run_id: "run_0000000000000007" })).kind).toBe("paused");
    expect(reads).toBe(2);

    // 翻回 → 又立即放行
    board.setWorkflow("nightly-audit", false);
    expect(pa.admit(rowOf({ run_id: "run_0000000000000008" }))).toEqual({ kind: "admit" });
    expect(reads).toBe(3);
  });
});

/* ────────────── 5：引擎集成（假端口循环） ────────────── */

/** 常开假端口：run 立即 done（暂停路径下根本不该被调到）。 */
class AlwaysDonePort implements RunSessionPort {
  calls = 0;
  async run(): Promise<RunLaunchResult> {
    this.calls += 1;
    return { status: "done", digest: "ok", pointers: [], blockers: [] };
  }
}

function inputOf(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    workflow: "nightly-audit",
    prompt: "巡检并落盘报告",
    trigger: "cron",
    ...over,
  };
}

describe("RunEngine × PauseAdmission 集成", () => {
  it("global paused → dispatch 返回 paused、账本零痕迹、引擎不登记、端口零调用；解除后照常开火到终态", async () => {
    const board = new PauseSwitchBoard();
    const audit = new MemoryPauseAudit();
    const ledger = new MemoryLedger();
    const port = new AlwaysDonePort();
    const engine = new RunEngine({
      ledger,
      sessionPort: port,
      admission: new PauseAdmission({ switches: () => board.read(), audit }),
      now: () => 2000,
    });

    board.setGlobal(true);
    const r1 = await engine.dispatch(inputOf({ runId: "run_0000000000000009" }));
    expect(r1).toEqual({
      kind: "paused",
      row: expect.objectContaining({ run_id: "run_0000000000000009" }),
      reason: PAUSE_REASON,
    });
    expect(ledger.entries.length).toBe(0); // 账本零痕迹（D31：expected 不落盘）
    expect(engine.get("run_0000000000000009")).toBeUndefined(); // 引擎不登记
    expect(port.calls).toBe(0); // 绝不开火
    expect(audit.entries.length).toBe(1); // 暂停留痕归 T17 审计通道
    expect(nth(audit.entries, 0).run_id).toBe("run_0000000000000009");

    // 热解除：同一引擎实例立即恢复开火（无重启、无脏缓存）
    board.setGlobal(false);
    const r2 = await engine.dispatch(inputOf({ runId: "run_000000000000000a" }));
    expect(r2.kind).toBe("launched");
    if (r2.kind !== "launched") throw new Error("unreachable");
    const rec = await r2.completion;
    expect(rec.state).toBe("done");
    expect(ledger.entries.length).toBe(2); // expected + actual 成对
    expect(ledger.gaps()).toEqual([]);
  });

  it("workflow paused 经引擎只拦该流，他流照常开火", async () => {
    const board = new PauseSwitchBoard();
    board.setWorkflow("nightly-audit", true);
    const audit = new MemoryPauseAudit();
    const ledger = new MemoryLedger();
    const port = new AlwaysDonePort();
    const engine = new RunEngine({
      ledger,
      sessionPort: port,
      admission: new PauseAdmission({ switches: () => board.read(), audit }),
    });

    const blocked = await engine.dispatch(inputOf({ runId: "run_000000000000000b" }));
    expect(blocked.kind).toBe("paused");

    const launched = await engine.dispatch(
      inputOf({ runId: "run_000000000000000c", workflow: "mail-sync" }),
    );
    expect(launched.kind).toBe("launched");
    if (launched.kind !== "launched") throw new Error("unreachable");
    await launched.completion;

    expect(audit.entries.length).toBe(1);
    expect(nth(audit.entries, 0).workflow).toBe("nightly-audit");
    expect(port.calls).toBe(1); // 只有 mail-sync 开火
  });
});
