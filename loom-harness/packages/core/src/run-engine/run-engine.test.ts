/**
 * T12 副会话运行引擎验收（docs/02 §T12 TDD：expected-before-execute ordering first）。
 *
 * 覆盖（冻结验收 + 计划补充形状）：
 *   1. 时序铁律——执行器进入时账本必已含 expected、绝无 actual（mock 执行器内快照断言）；
 *   2. 终态盖棺——done/partial/failed 各写 actual（payload = TerminalSnapshot 形状）；
 *   3. 崩溃形状——执行器炸 → 账本留 expected 无 actual（T13 对账输入 / T35）；
 *   4. 全新会话零残留——同一 port 两次 run，第二次 LLM context 不见第一次消息（D19）；
 *   5. 状态机观察点——admit 时 queued、执行时 running、completion 后终态；
 *   6. 行字段 run_id/attempt/trigger/parent_run/workflow/session_id + id 形状契约；
 *   7. 准入钩子 paused → 账本零痕迹、引擎不登记（T17 接缝）；
 *   8. 产物快照交注入 ArtifactSink；failed 写死信形状（搬运属 T13）；sink 炸不回滚账本。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Limits } from "../convergence/index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { RunEngine, type RunEngineOptions } from "./engine.js";
import { MemoryLedger } from "./memory-ledger.js";
import { createSideSessionPort } from "./side-session-port.js";
import {
  RunEngineError,
  type ArtifactSnapshot,
  type DeadLetterPayload,
  type DispatchInput,
  type LedgerPort,
  type RunLaunchContext,
  type RunLaunchResult,
  type RunRecord,
  type RunRow,
  type RunSessionPort,
} from "./types.js";

/* ────────────── helpers ────────────── */

const HEX16_RE = /^[a-z][a-z0-9_]{2,4}_[0-9a-f]{16}$/;

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

function dispatchInput(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    workflow: "nightly-audit",
    prompt: "巡检并落盘报告",
    trigger: "manual",
    ...over,
  };
}

const okResult = (over: Partial<RunLaunchResult> = {}): RunLaunchResult => ({
  status: "done",
  digest: "done：测试批次 3 件产物全部落盘",
  pointers: ["file:ai/data/out.json", "git:deadbeef"],
  blockers: [],
  ...over,
});

/** 可编程 mock 端口：enter 时抓账本快照；settle/blow 由测试摆布终局。 */
class MockPort implements RunSessionPort {
  /** 每次 enter 的现场快照（执行器被调用瞬间的观察数据 = 时序断言的证据链）。 */
  readonly observations: Array<{
    ctx: RunLaunchContext;
    ledgerAtEnter: readonly string[]; // 进入瞬间账本各行标签（"expected"/"actual" 前缀）
    stateAtEnter: string | undefined; // 引擎记录状态
  }> = [];

  private _gates: Array<{
    resolve: (r: RunLaunchResult) => void;
    reject: (e: Error) => void;
  }> = [];

  constructor(
    private readonly _ledger: MemoryLedger,
    private readonly _engine: () => RunEngine,
  ) {}

  run(ctx: RunLaunchContext): Promise<RunLaunchResult> {
    const engine = this._engine();
    this.observations.push({
      ctx,
      ledgerAtEnter: this._ledger.entries.map((e) => e.t),
      stateAtEnter: engine.get(ctx.row.run_id)?.state,
    });
    return new Promise<RunLaunchResult>((resolve, reject) => {
      this._gates.push({ resolve, reject });
    });
  }

  /** 第 n 次 enter 的执行放行（测试在 await dispatch 之后调用）。 */
  settle(n: number, result: RunLaunchResult): void {
    nth(this._gates, n).resolve(result);
  }

  /** 第 n 次 enter 的执行炸掉。 */
  blow(n: number, err: Error): void {
    nth(this._gates, n).reject(err);
  }
}

function makeEngine(ledger: MemoryLedger, over: Partial<RunEngineOptions> = {}) {
  let engineRef: RunEngine | null = null;
  const port = new MockPort(ledger, () => {
    if (engineRef === null) throw new Error("engine not constructed yet");
    return engineRef;
  });
  const opts = {
    ledger,
    sessionPort: port as RunSessionPort,
    now: () => 1727000000000,
    ...over,
  };
  engineRef = new RunEngine(opts);
  return { engine: engineRef, port };
}

/** 等 completion（launched 分支 narrow）。 */
async function finish(res: Awaited<ReturnType<RunEngine["dispatch"]>>): Promise<RunRecord> {
  if (res.kind !== "launched") throw new Error(`expected launched, got ${res.kind}`);
  return res.completion;
}

/* ────────────── 1. expected 先于执行（时序铁律） ────────────── */

describe("expected-before-execute（D15 时序铁律）", () => {
  it("执行器进入瞬间：账本已含 expected 且绝无 actual；引擎状态=running", async () => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger);

    const res = await engine.dispatch(dispatchInput());
    expect(res.kind).toBe("launched");

    // mock 端口进入时抓的现场 = 铁证：那一刻账本恰好只有 expected 一行
    const obs = nth(port.observations, 0);
    expect(obs.ledgerAtEnter).toEqual(["expected"]);
    expect(obs.stateAtEnter).toBe("running");

    port.settle(0, okResult());
    const rec = await finish(res);
    expect(rec.state).toBe("done");
  });

  it("dispatch 同步返回（未 await completion）时 expected 已落盘；port 未放行前 actual 缺席", async () => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger);

    const res = await engine.dispatch(dispatchInput());
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected"]);
    expect(ledger.gaps()).toHaveLength(1);

    port.settle(0, okResult());
    await finish(res);
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected", "actual"]);
    expect(ledger.gaps()).toEqual([]);
  });

  it("expected 行的 payload = 完整 RunRow（run_id/workflow/attempt/trigger/parent_run/session_id）", async () => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger);

    const parent = "run_0123456789abcdef";
    const res = await engine.dispatch(
      dispatchInput({ trigger: "rerun", attempt: 3, parentRun: parent, runId: "run_fedcba9876543210" }),
    );
    const entry = nth(ledger.entries, 0);
    expect(entry.t).toBe("expected");
    expect(entry.runId).toBe("run_fedcba9876543210");
    const row = entry.payload as RunRow;
    expect(row).toMatchObject({
      run_id: "run_fedcba9876543210",
      workflow: "nightly-audit",
      attempt: 3,
      trigger: "rerun",
      parent_run: parent,
    });
    expect(row.session_id).toMatch(HEX16_RE);

    port.settle(0, okResult());
    await finish(res);
  });

  it("默认 id：run_/ses_ 前缀 + hex16（连字符永久禁用）；parent_run 撞号即拒", async () => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger);
    const res = await engine.dispatch(dispatchInput());
    expect(res.row.run_id).toMatch(HEX16_RE);
    expect(res.row.session_id).toMatch(HEX16_RE);
    expect(res.row.parent_run).toBeNull();
    port.settle(0, okResult());
    await finish(res);

    await expect(
      engine.dispatch(dispatchInput({ runId: "run_bad-id_with_hyphen_outside" })),
    ).rejects.toThrow(RunEngineError);
  });
});

/* ────────────── 2. 终态盖棺：三态各写 actual ────────────── */

describe("终态写 actual（D19 盖棺）", () => {
  it.each([
    ["done", "done：三类检查全过"],
    ["partial", "partial：2 项待用户处置"],
    ["failed", "failed：网关连续超时"],
  ] as const)("status=%s → actual 行 status/载荷形状一致", async (status, digest) => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger);

    const res = await engine.dispatch(dispatchInput());
    port.settle(0, okResult({ status, digest, blockers: status === "partial" ? ["需确认磁盘项"] : [] }));
    const rec = await finish(res);

    expect(rec.state).toBe(status);
    expect(rec.crashed).toBe(false);
    const actual = nth(ledger.entries, 1);
    expect(actual.t).toBe("actual");
    expect(actual.status).toBe(status);
    const payload = actual.payload as { digest: string; pointers: readonly string[]; at: number };
    expect(payload.digest).toBe(digest);
    expect(payload.pointers).toEqual(["file:ai/data/out.json", "git:deadbeef"]);
    expect(payload.at).toBe(1727000000000);
  });
});

/* ────────────── 3. 崩溃形状：炸了留缺口（T13/T35 输入） ────────────── */

describe("崩溃形状（执行器炸 → 账本留 expected 无 actual）", () => {
  it("port 抛异常：不写 actual、不发产物快照、不发死信；记录 crashed=true", async () => {
    const ledger = new MemoryLedger();
    const published: ArtifactSnapshot[] = [];
    const deadLetters: DeadLetterPayload[] = [];
    let engineRef: RunEngine | null = null;
    const port = new MockPort(ledger, () => {
      if (engineRef === null) throw new Error("not constructed");
      return engineRef;
    });
    engineRef = new RunEngine({
      ledger,
      sessionPort: port,
      now: () => 1727000000000,
      artifactSink: { publish: (s) => void published.push(s) },
      deadLetterSink: { emit: (p) => void deadLetters.push(p) },
    });

    const res = await engineRef.dispatch(dispatchInput());
    port.blow(0, new Error("process killed"));
    const rec = await finish(res); // completion 恒 resolve（崩溃也是数据不是异常）

    expect(rec.crashed).toBe(true);
    expect(rec.error).toContain("process killed");
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected"]); // 缺口形状
    expect(ledger.gaps()).toEqual([res.row.run_id]);
    expect(engineRef.gaps()).toEqual([res.row.run_id]);
    expect(published).toHaveLength(0);
    expect(deadLetters).toHaveLength(0);
  });
});

/* ────────────── 4. 全新会话零残留（D19，真实 port + fake model） ────────────── */

describe("全新会话零残留（createSideSessionPort 双 run）", () => {
  function convergeTurn(args: Record<string, unknown>): FakeAssistantResponse {
    return {
      content: [
        { type: "text", text: "正文：本轮结论。" },
        { type: "toolCall", name: "converge", arguments: args },
      ],
    };
  }

  it("第二次 run 的首个 LLM context 不含第一次 run 的任何消息", async () => {
    const model = createFakeModel([
      convergeTurn({
        status: "done",
        runId: "ignored-by-ledger-model-self-report",
        workflow: "nightly-audit",
        attempt: 1,
        digest: "done：第一批完成",
      }),
      convergeTurn({
        status: "done",
        runId: "x",
        workflow: "nightly-audit",
        attempt: 1,
        digest: "done：第二批完成",
      }),
    ]);
    const ledger = new MemoryLedger();
    const engine = new RunEngine({
      ledger,
      sessionPort: createSideSessionPort({ model }),
      now: () => 1727000000000,
    });

    const r1 = finish(await engine.dispatch(dispatchInput({ prompt: "第一批：只查网关" })));
    const rec1 = await r1;
    expect(rec1.state).toBe("done");

    const r2 = finish(await engine.dispatch(dispatchInput({ prompt: "第二批：只查磁盘" })));
    const rec2 = await r2;
    expect(rec2.state).toBe("done");

    const calls = model.getCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // 第二次 run 的第一次 LLM call 的 context：只有本次 prompt，绝无上次残留
    const secondRunFirstCall = nth(calls, 1);
    const serialized = JSON.stringify(secondRunFirstCall);
    expect(serialized).toContain("第二批：只查磁盘");
    expect(serialized).not.toContain("第一批：只查网关");
    // 两 run 的 session_id 互不相同（全新会话的 id 面）
    expect(rec1.row.session_id).not.toBe(rec2.row.session_id);
  });

  it("真实端口下未收束（纯文本空转）→ 强制收束 failed + 死信形状 + forceReason", async () => {
    const model = createFakeModel(
      Array.from({ length: 8 }, (_, i) => ({ content: [{ type: "text" as const, text: `空转${i}` }] })),
    );
    const limits: Limits = { ...DEFAULT_LIMITS };
    const ledger = new MemoryLedger();
    const deadLetters: DeadLetterPayload[] = [];
    const engine = new RunEngine({
      ledger,
      sessionPort: createSideSessionPort({ model, limits }),
      deadLetterSink: { emit: (p) => void deadLetters.push(p) },
      now: () => 1727000000000,
    });

    const rec = await finish(await engine.dispatch(dispatchInput({ prompt: "干活" })));
    expect(rec.state).toBe("failed");
    expect(rec.crashed).toBe(false); // 强制收束是**合法终态**，不是崩溃缺口
    expect(rec.terminal?.forceReason).toBe("nudge-limit");
    const actual = nth(ledger.entries, 1);
    expect(actual.status).toBe("failed");
    expect(deadLetters).toHaveLength(1);
    const dl = nth(deadLetters, 0);
    expect(dl.kind).toBe("dead-letter");
    expect(dl.run_id).toBe(rec.row.run_id);
    expect(dl.forceReason).toBe("nudge-limit");
  });
});

/* ────────────── 5. 状态机观察点 ────────────── */

describe("状态机 queued→admitted→running→终态", () => {
  it("admission 被调用时记录已存在且 state=queued；expected 写后、执行进前已是 running", async () => {
    const ledger = new MemoryLedger();
    let engineRef: RunEngine | null = null;
    let stateAtAdmit: string | undefined;
    const port = new MockPort(ledger, () => {
      if (engineRef === null) throw new Error("not constructed");
      return engineRef;
    });
    engineRef = new RunEngine({
      ledger,
      sessionPort: port,
      now: () => 0,
      admission: {
        admit: (row) => {
          stateAtAdmit = engineRef?.get(row.run_id)?.state;
          return { kind: "admit" };
        },
      },
    });

    const res = await engineRef.dispatch(dispatchInput());
    expect(stateAtAdmit).toBe("queued");
    expect(nth(port.observations, 0).stateAtEnter).toBe("running");
    port.settle(0, okResult());
    expect((await finish(res)).state).toBe("done");
  });
});

/* ────────────── 6. 准入钩子（T17 接缝）：paused → 账本零痕迹 ────────────── */

describe("准入钩子（T17 暂停开关点）", () => {
  it("paused：不写 expected、不登记、不开火；返回行形状与原因", async () => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger, {
      admission: { admit: () => ({ kind: "paused", reason: "workflow paused: nightly-audit" }) },
    });

    const res = await engine.dispatch(dispatchInput());
    expect(res.kind).toBe("paused");
    if (res.kind === "paused") {
      expect(res.reason).toContain("nightly-audit");
    }
    expect(ledger.entries).toHaveLength(0); // 账本零痕迹
    expect(engine.get(res.row.run_id)).toBeUndefined();
    expect(port.observations).toHaveLength(0); // 执行器从未被触碰
  });

  it("expected 落盘失败 = 绝不开火（port 不进、记录不留痕）", async () => {
    const brokenLedger: LedgerPort = {
      expected() {
        throw new Error("disk full");
      },
      actual() {
        throw new Error("unreachable");
      },
    };
    let engineRef: RunEngine | null = null;
    const port = new MockPort(new MemoryLedger(), () => {
      if (engineRef === null) throw new Error("nc");
      return engineRef;
    });
    engineRef = new RunEngine({ ledger: brokenLedger, sessionPort: port, now: () => 0 });
    await expect(engineRef.dispatch(dispatchInput())).rejects.toThrow(/expected write failed/);
    expect(port.observations).toHaveLength(0);
    expect(engineRef.listRuns()).toHaveLength(0);
  });
});

/* ────────────── 7. 产物快照 / 死信 / 旁路容错 ────────────── */

describe("产物快照 + 死信形状 + 旁路容错", () => {
  it("done 终态：ArtifactSink 收到回执声明的产物路径列表；failed 才发死信", async () => {
    const ledger = new MemoryLedger();
    const published: ArtifactSnapshot[] = [];
    const deadLetters: DeadLetterPayload[] = [];
    const sinks = {
      artifactSink: { publish: (s: ArtifactSnapshot) => void published.push(s) },
      deadLetterSink: { emit: (p: DeadLetterPayload) => void deadLetters.push(p) },
    };
    let engineRef: RunEngine | null = null;
    const port = new MockPort(ledger, () => {
      if (engineRef === null) throw new Error("nc");
      return engineRef;
    });
    engineRef = new RunEngine({ ledger, sessionPort: port, now: () => 5, ...sinks });

    const doneRes = await engineRef.dispatch(dispatchInput());
    port.settle(0, okResult());
    await finish(doneRes);
    const doneSnap = nth(published, 0);
    expect(doneSnap.artifacts).toEqual(["file:ai/data/out.json", "git:deadbeef"]);
    expect(doneSnap.status).toBe("done");
    expect(deadLetters).toHaveLength(0);

    const failRes = await engineRef.dispatch(dispatchInput({ workflow: "billing-check" }));
    port.settle(1, okResult({ status: "failed", digest: "failed：数据源缺失", blockers: ["缺 9 月账单"] }));
    await finish(failRes);
    expect(published).toHaveLength(2); // failed 的产物声明也如实快照
    const dl = nth(deadLetters, 0);
    expect(dl.workflow).toBe("billing-check");
    expect(dl.blockers).toEqual(["缺 9 月账单"]);
    expect(dl.trigger).toBe("manual");
    expect(dl.at).toBe(5);
  });

  it("sink 抛错不回滚账本终态（盖棺之后旁路失败只是旁路失败）", async () => {
    const ledger = new MemoryLedger();
    let engineRef: RunEngine | null = null;
    const port = new MockPort(ledger, () => {
      if (engineRef === null) throw new Error("nc");
      return engineRef;
    });
    engineRef = new RunEngine({
      ledger,
      sessionPort: port,
      now: () => 0,
      artifactSink: {
        publish() {
          throw new Error("sink down");
        },
      },
    });
    const launched = await engineRef.dispatch(dispatchInput());
    port.settle(0, okResult());
    const rec = await finish(launched);
    expect(rec.state).toBe("done");
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected", "actual"]);
  });

  it("同 run_id 撞号 = 拒（引擎登记面幂等保护）", async () => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger);
    const res = await engine.dispatch(dispatchInput({ runId: "run_aaaaaaaaaaaaaaaa" }));
    port.settle(0, okResult());
    await finish(res);
    await expect(engine.dispatch(dispatchInput({ runId: "run_aaaaaaaaaaaaaaaa" }))).rejects.toThrow(
      /already known/,
    );
  });

  it("cancel 在途 run：signal 传入端口、记录 cancelRequested；对非在途 run 返回 false", async () => {
    const ledger = new MemoryLedger();
    const { engine, port } = makeEngine(ledger);
    const res = await engine.dispatch(dispatchInput());
    if (res.kind !== "launched") throw new Error("expected launched");
    const ctx = nth(port.observations, 0).ctx;
    expect(ctx.signal.aborted).toBe(false);
    expect(engine.cancel(res.row.run_id, "operator abort")).toBe(true);
    expect(ctx.signal.aborted).toBe(true);
    expect(engine.get(res.row.run_id)?.cancelRequested).toBe("operator abort");

    port.settle(0, okResult({ status: "failed", digest: "failed：已取消" }));
    const rec = await res.completion;
    expect(rec.state).toBe("failed");
    expect(engine.cancel(res.row.run_id)).toBe(false); // 已终态，不再命中
  });
});
