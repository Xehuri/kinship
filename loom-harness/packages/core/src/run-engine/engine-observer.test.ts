/**
 * RunEngine 观测缝验收（trace run_end 生产接线的 core 半边）：
 *   - onRunStarted：expected fsync 落盘后恰调一次、先于 sessionPort 触碰；
 *   - onRunTerminal：引擎记录进终态处恰调一次（正常盖棺 / 崩溃形状），
 *     actual 写失败 = 缺口形状不调；
 *   - 观察者抛错被吞（吞进 warn 通道），账本与 completion 不受反噬。
 */

import { describe, expect, it } from "vitest";
import { RunEngine } from "./engine.js";
import { MemoryLedger } from "./memory-ledger.js";
import type {
  DispatchInput,
  LedgerPort,
  RunLaunchResult,
  RunRecord,
  RunRow,
  RunSessionPort,
} from "./types.js";

function input(over: Partial<DispatchInput> = {}): DispatchInput {
  return { workflow: "w-obs", prompt: "观测", trigger: "manual", ...over };
}

function scriptedPort(behavior: (runId: string) => Promise<RunLaunchResult>): RunSessionPort {
  return { run: (ctx) => behavior(ctx.row.run_id) };
}

const doneResult: RunLaunchResult = {
  status: "done",
  digest: "done：ok",
  pointers: [],
  blockers: [],
};

async function settle(engine: RunEngine, over: Partial<DispatchInput> = {}): Promise<RunRecord> {
  const launched = await engine.dispatch(input(over));
  if (launched.kind !== "launched") throw new Error("expected launched");
  return launched.completion;
}

describe("RunEngine 观测缝 onRunStarted/onRunTerminal", () => {
  it("done 盖棺：started 恰一次（账本已含 expected）→ terminal 恰一次（state=done + terminal 快照）", async () => {
    const ledger = new MemoryLedger();
    const events: Array<{ kind: string; state?: string; ledgerTags?: string[] }> = [];
    let startedRows: RunRow[] = [];
    const engine = new RunEngine({
      ledger,
      sessionPort: scriptedPort(async () => doneResult),
      onRunStarted: (row) => {
        startedRows = [row];
        events.push({ kind: "started", ledgerTags: ledger.entries.map((r) => (r.t === "expected" ? "e" : "a")) });
      },
      onRunTerminal: (rec) => events.push({ kind: "terminal", state: rec.state }),
    });
    const rec = await settle(engine);

    expect(startedRows).toHaveLength(1);
    expect(startedRows[0]?.run_id).toBe(rec.row.run_id);
    expect(events.map((e) => e.kind)).toEqual(["started", "terminal"]);
    expect(events[0]?.ledgerTags).toEqual(["e"]);
    expect(events[1]?.state).toBe("done");
  });

  it("崩溃形状：terminal 恰一次且 crashed=true（账本留缺口）；partial 也盖棺调用", async () => {
    const ledger = new MemoryLedger();
    const terminals: RunRecord[] = [];
    const engine = new RunEngine({
      ledger,
      sessionPort: scriptedPort(async () => {
        throw new Error("port exploded");
      }),
      onRunTerminal: (rec) => terminals.push(rec),
    });
    const rec = await settle(engine);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.crashed).toBe(true);
    expect(terminals[0]?.state).toBe("failed");
    expect(rec.crashed).toBe(true);

    const partials: RunRecord[] = [];
    const engine2 = new RunEngine({
      ledger: new MemoryLedger(),
      sessionPort: scriptedPort(async () => ({ ...doneResult, status: "partial" })),
      onRunTerminal: (r) => partials.push(r),
    });
    await settle(engine2);
    expect(partials[0]?.state).toBe("partial");
  });

  it("取消形状：terminal 记录携带 cancelRequested（server 侧据此映射 cancelled）", async () => {
    const terminals: RunRecord[] = [];
    const port: RunSessionPort = {
      run: (ctx) =>
        new Promise<RunLaunchResult>((resolve) => {
          const finish = (): void =>
            resolve({ status: "failed", digest: "cancelled by control", pointers: [], blockers: [] });
          if (ctx.signal.aborted) finish();
          else ctx.signal.addEventListener("abort", finish, { once: true });
        }),
    };
    const engine = new RunEngine({
      ledger: new MemoryLedger(),
      sessionPort: port,
      onRunTerminal: (rec) => terminals.push(rec),
    });
    const started = await engine.dispatch(input());
    if (started.kind !== "launched") throw new Error("expected launched");
    const accepted = engine.cancel(started.row.run_id, "user stop");
    expect(accepted).toBe(true);
    const rec = await started.completion;
    expect(rec.cancelRequested).toBe("user stop");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.cancelRequested).toBe("user stop");
    expect(terminals[0]?.state).toBe("failed");
  });

  it("观察者抛错被吞：账本照常盖棺、completion 正常 resolve、started 抛错不拦执行", async () => {
    const ledger = new MemoryLedger();
    const warns: string[] = [];
    const engine = new RunEngine({
      ledger,
      sessionPort: scriptedPort(async () => doneResult),
      onRunStarted: () => {
        throw new Error("observer blew up (started)");
      },
      onRunTerminal: () => {
        throw new Error("observer blew up (terminal)");
      },
      log: (level, msg) => {
        if (level === "warn") warns.push(msg);
      },
    });
    const rec = await settle(engine);
    expect(rec.state).toBe("done");
    expect(ledger.entries.filter((r) => r.t === "actual")).toHaveLength(1);
    expect(warns.filter((w) => w.includes("side-effect-failed"))).toHaveLength(2);
  });

  it("actual 写失败 = 缺口形状：started 已调、terminal 不调（run_end 与账本一致性红线）", async () => {
    const gapLedger: LedgerPort = {
      expected: () => undefined,
      actual: () => {
        throw new Error("disk full");
      },
    };
    const started: string[] = [];
    const terminals: RunRecord[] = [];
    const engine = new RunEngine({
      ledger: gapLedger,
      sessionPort: scriptedPort(async () => doneResult),
      onRunStarted: (row) => started.push(row.run_id),
      onRunTerminal: (rec) => terminals.push(rec),
    });
    const launched = await engine.dispatch(input());
    if (launched.kind !== "launched") throw new Error("expected launched");
    await launched.completion;
    expect(started).toHaveLength(1);
    expect(terminals).toHaveLength(0);
  });
});
