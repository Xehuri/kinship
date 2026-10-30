/**
 * T25 控制面 cancel/rerun + actor 审计验收
 * （docs/02 §T25 TDD：cancel/rerun/actor tests first）。
 *
 * 覆盖（冻结验收 + 计划补充形状）：
 *   1. cancel 转发 AbortSignal 到 run-engine 在途句柄（ctx.signal 在取消后 aborted）；
 *   2. cancel 未知/终态 run → accepted=false 且仍留审计（幂等安全，不抛）；
 *   3. rerun 开新行：parent_run=源、attempt+1、trigger=manual、新 session_id（D19 全新会话）；
 *   4. actor 标识（main/http/script）落审计行；
 *   5. side→side 谓词拒绝（spawnSide 与 rerun 皆拒）且拒绝也留痕；
 *   6. 控制审计与 run 账本分离：账本只含 expected/actual，控制动作不污染缺口。
 */

import { describe, expect, it } from "vitest";
import { RunEngine, type RunEngineOptions } from "../run-engine/engine.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import {
  type DispatchInput,
  type DispatchResult,
  type RunLaunchContext,
  type RunLaunchResult,
  type RunRow,
  type RunSessionPort,
} from "../run-engine/types.js";
import { ControlPlane } from "./plane.js";
import {
  ControlPlaneError,
  MemoryControlAudit,
  canSpawnSide,
  type ControlActor,
} from "./types.js";

/* ────────────── helpers ────────────── */

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

/** launched 窄化（DispatchResult 是判别联合，需显式收窄才能取 completion）。 */
type Launched = Extract<DispatchResult, { kind: "launched" }>;

function expectLaunched(res: DispatchResult): Launched {
  if (res.kind !== "launched") throw new Error(`expected launched, got ${res.kind}`);
  return res;
}

/** 派发并窄化到 launched。 */
async function launch(engine: RunEngine, input: DispatchInput = dispatchInput()): Promise<Launched> {
  return expectLaunched(await engine.dispatch(input));
}

const okResult = (over: Partial<RunLaunchResult> = {}): RunLaunchResult => ({
  status: "done",
  digest: "done：控制面测试批次完成",
  pointers: [],
  blockers: [],
  ...over,
});

/** 可编程 mock 端口：enter 抓 ctx（含 signal）；settle/blow 摆布终局。 */
class MockPort implements RunSessionPort {
  readonly contexts: RunLaunchContext[] = [];
  private readonly _gates: Array<{
    resolve: (r: RunLaunchResult) => void;
    reject: (e: Error) => void;
  }> = [];

  run(ctx: RunLaunchContext): Promise<RunLaunchResult> {
    this.contexts.push(ctx);
    return new Promise<RunLaunchResult>((resolve, reject) => {
      this._gates.push({ resolve, reject });
    });
  }

  settle(n: number, result: RunLaunchResult): void {
    nth(this._gates, n).resolve(result);
  }
}

const FIXED_NOW = 1727000000000;

function makeRig(over: Partial<RunEngineOptions> = {}) {
  const ledger = new MemoryLedger();
  const port = new MockPort();
  const engine = new RunEngine({
    ledger,
    sessionPort: port,
    now: () => FIXED_NOW,
    ...over,
  });
  const audit = new MemoryControlAudit();
  const plane = new ControlPlane({ engine, audit, now: () => FIXED_NOW });
  return { engine, plane, port, ledger, audit };
}

function dispatchInput(over: Partial<DispatchInput> = {}): DispatchInput {
  return { workflow: "nightly-audit", prompt: "巡检", trigger: "manual", ...over };
}

/* ────────────── 1. cancel 转发 AbortSignal ────────────── */

describe("cancel 转发 AbortSignal（T25 接缝）", () => {
  it("取消在途 run：ctx.signal 变 aborted、cancelRequested 记录、审计 actor=main accepted", async () => {
    const { engine, plane, port, audit } = makeRig();
    const res = await launch(engine);
    const ctx = nth(port.contexts, 0);
    expect(ctx.signal.aborted).toBe(false);

    const outcome = plane.cancel({ runId: res.row.run_id, actor: "main", reason: "operator abort" });

    expect(outcome.accepted).toBe(true);
    expect(ctx.signal.aborted).toBe(true);
    expect(engine.get(res.row.run_id)?.cancelRequested).toBe("operator abort");
    const entry = nth(audit.entries, 0);
    expect(entry).toMatchObject({
      kind: "control",
      action: "cancel",
      actor: "main",
      accepted: true,
      run_id: res.row.run_id,
      reason: "operator abort",
      at: FIXED_NOW,
    });

    port.settle(0, okResult({ status: "failed", digest: "failed：已取消" }));
    await res.completion;
  });

  it("取消未知/终态 run → accepted=false 且仍留审计（不抛）", async () => {
    const { engine, plane, port, audit } = makeRig();
    const res = await launch(engine);

    // 终态后取消：不命中
    port.settle(0, okResult());
    await res.completion;
    const late = plane.cancel({ runId: res.row.run_id, actor: "http" });
    expect(late.accepted).toBe(false);

    // 未知 run：不命中
    const unknown = plane.cancel({ runId: "run_0000000000000000", actor: "script" });
    expect(unknown.accepted).toBe(false);

    expect(audit.entries).toHaveLength(2);
    expect(nth(audit.entries, 0)).toMatchObject({ actor: "http", accepted: false });
    expect(nth(audit.entries, 1)).toMatchObject({ actor: "script", accepted: false });
  });

  it("取消原因缺省 = cancel requested", async () => {
    const { engine, plane, port, audit } = makeRig();
    const res = await launch(engine);
    plane.cancel({ runId: res.row.run_id, actor: "main" });
    expect(nth(audit.entries, 0).reason).toBe("cancel requested");
    port.settle(0, okResult({ status: "failed", digest: "failed：取消" }));
    await res.completion;
  });
});

/* ────────────── 2. rerun 新行形状 ────────────── */

describe("rerun 新行（D15 新会话 + attempt 递增 + trigger=manual）", () => {
  it("parent_run=源、attempt=源+1、trigger=manual、新 session_id；账本 expected 载荷即此新行", async () => {
    const { engine, plane, port, ledger } = makeRig();
    // 源 run：attempt=2 起步（模拟重试链），终态收口
    const src = await launch(engine, dispatchInput({ attempt: 2 }));
    port.settle(0, okResult());
    await src.completion;

    const outcome = expectLaunched(
      await plane.rerun({ parentRunId: src.row.run_id, prompt: "重跑巡检", actor: "main" }),
    );
    const newRow = outcome.row;

    expect(newRow.parent_run).toBe(src.row.run_id);
    expect(newRow.attempt).toBe(3);
    expect(newRow.trigger).toBe("manual");
    expect(newRow.workflow).toBe(src.row.workflow);
    expect(newRow.session_id).not.toBe(src.row.session_id);
    expect(newRow.run_id).not.toBe(src.row.run_id);

    // 新行的 expected 载荷（rerun 是全新会话，账本另立一行）
    const expectedEntries = ledger.entries.filter((e) => e.t === "expected");
    expect(expectedEntries).toHaveLength(2);
    const payload = nth(expectedEntries, 1).payload as RunRow;
    expect(payload.parent_run).toBe(src.row.run_id);
    expect(payload.attempt).toBe(3);
    expect(payload.trigger).toBe("manual");

    port.settle(1, okResult());
    await outcome.completion;
  });

  it("rerun 未知源 run → 抛 unknown-run 且留拒绝审计", async () => {
    const { plane, audit } = makeRig();
    await expect(
      plane.rerun({ parentRunId: "run_0000000000000000", prompt: "重跑", actor: "main" }),
    ).rejects.toThrow(ControlPlaneError);
    expect(nth(audit.entries, 0)).toMatchObject({
      action: "rerun",
      actor: "main",
      accepted: false,
      parent_run: null,
    });
  });

  it("rerun 空 prompt → 抛 input，且不产生审计行（未受理）", async () => {
    const { engine, plane, port, audit } = makeRig();
    const src = await launch(engine);
    port.settle(0, okResult());
    await src.completion;
    await expect(
      plane.rerun({ parentRunId: src.row.run_id, prompt: "   ", actor: "main" }),
    ).rejects.toThrow(ControlPlaneError);
    expect(audit.entries).toHaveLength(0);
  });

  it("rerun 支持显式 trigger 覆盖（如 catchup）", async () => {
    const { engine, plane, port } = makeRig();
    const src = await launch(engine);
    port.settle(0, okResult());
    await src.completion;
    const outcome = expectLaunched(
      await plane.rerun({ parentRunId: src.row.run_id, prompt: "补跑", actor: "script", trigger: "catchup" }),
    );
    expect(outcome.row.trigger).toBe("catchup");
    port.settle(1, okResult());
    await outcome.completion;
  });
});

/* ────────────── 3. actor 落账 ────────────── */

describe("actor 标识落审计（main/http/script）", () => {
  it.each(["main", "http", "script"] as const)("actor=%s 记录在 cancel 审计行", async (actor) => {
    const { engine, plane, port, audit } = makeRig();
    const res = await launch(engine);
    plane.cancel({ runId: res.row.run_id, actor });
    expect(nth(audit.entries, 0).actor).toBe(actor);
    port.settle(0, okResult({ status: "failed", digest: "failed：取消" }));
    await res.completion;
  });

  it("spawnSide 审计记录 actor=main 与 accepted=true", async () => {
    const { plane, audit, port } = makeRig();
    const outcome = expectLaunched(
      await plane.spawnSide({ workflow: "wf-a", prompt: "派发", actor: "main" }),
    );
    expect(nth(audit.entries, 0)).toMatchObject({
      action: "spawn",
      actor: "main",
      accepted: true,
      run_id: outcome.row.run_id,
      trigger: "manual",
    });
    port.settle(0, okResult());
    await outcome.completion;
  });

  it("非法 actor 抛 input", () => {
    const { plane } = makeRig();
    expect(() =>
      plane.cancel({ runId: "run_0000000000000000", actor: "robot" as ControlActor }),
    ).toThrow(ControlPlaneError);
  });
});

/* ────────────── 4. D22 side→side 谓词拒绝 ────────────── */

describe("D22 防环：side→side 拒绝", () => {
  it("谓词 canSpawnSide：side 拒、其余允", () => {
    expect(canSpawnSide("side")).toBe(false);
    expect(canSpawnSide("main")).toBe(true);
    expect(canSpawnSide("http")).toBe(true);
    expect(canSpawnSide("script")).toBe(true);
  });

  it("spawnSide actor=side → 抛 side-to-side-forbidden 且留拒绝审计", async () => {
    const { plane, audit, port } = makeRig();
    await expect(
      plane.spawnSide({ workflow: "wf-a", prompt: "派发", actor: "side" }),
    ).rejects.toThrow(ControlPlaneError);
    expect(nth(audit.entries, 0)).toMatchObject({
      action: "spawn",
      actor: "side",
      accepted: false,
      reason: "side-to-side forbidden (D22 anti-loop)",
    });
    // 拒绝未开火：端口未被触碰
    expect(port.contexts).toHaveLength(0);
  });

  it("rerun actor=side → 同样拒绝（rerun 也会开新 side run）", async () => {
    const { engine, plane, port, audit } = makeRig();
    const src = await launch(engine);
    port.settle(0, okResult());
    await src.completion;

    await expect(
      plane.rerun({ parentRunId: src.row.run_id, prompt: "重跑", actor: "side" }),
    ).rejects.toThrow(ControlPlaneError);
    expect(nth(audit.entries, 0)).toMatchObject({
      action: "rerun",
      actor: "side",
      accepted: false,
      run_id: src.row.run_id,
    });
  });
});

/* ────────────── 5. 审计与账本分离 ────────────── */

describe("控制审计不污染 run 账本（T13 缺口形状保护）", () => {
  it("cancel/rerun 只产生控制审计行；账本仍只有 expected/actual 两型", async () => {
    const { engine, plane, port, ledger, audit } = makeRig();
    const src = await launch(engine);
    plane.cancel({ runId: src.row.run_id, actor: "main" });
    port.settle(0, okResult({ status: "failed", digest: "failed：取消" }));
    await src.completion;

    const outcome = expectLaunched(
      await plane.rerun({ parentRunId: src.row.run_id, prompt: "重跑", actor: "main" }),
    );
    port.settle(1, okResult());
    await outcome.completion;

    // 账本：源 run 的 expected+actual，加新 run 的 expected+actual —— 无控制行混入
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected", "actual", "expected", "actual"]);
    expect(ledger.gaps()).toEqual([]);
    // 控制审计：cancel + rerun 各一行
    expect(audit.entries.map((e) => e.action)).toEqual(["cancel", "rerun"]);
  });
});
