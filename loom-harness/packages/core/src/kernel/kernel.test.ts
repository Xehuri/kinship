/**
 * W9 切片 1 —— SpawnKernel 内核单测（policy 路由/handle 生命周期/cancel 语义/completion 恒 resolve）。
 * Given: MemoryLedger + 可编程脚本端口（settle/blow/paused admission）+ 手造 RunRow（parse 归门面）
 * When:  kernel.spawn(run policy) / spawn(sub policy, profile) / buildXxxSession 直调
 * Then:  run 面=登记 queued→running→盖棺全序与账本行一致、handle 身份对、status 实时快照、
 *        cancel 语义=原 engine（在途 true+signal abort+cancelRequested；终态/未知 false）；
 *        crash=completion 恒 resolve（crashed 记录+缺口留账）；
 *        sub 面=纯工厂返回 session（登记面零触碰、MemoryLedger 零行）；
 *        terminalProfileOf 映射恒 run→converge-receipt / sub→raw-summary。
 */

import { describe, expect, it } from "vitest";
import type { Context, Message } from "@earendil-works/pi-ai";

import { createFakeModel } from "../testing.js";
import { SessionContextWatcher } from "../assembly/index.js";
import { Type, type HarnessTool } from "../index.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import type {
  LedgerPort,
  RunLaunchContext,
  RunLaunchResult,
  RunRecord,
  RunRow,
  RunSessionPort,
} from "../run-engine/types.js";
import { SpawnKernel, buildConvergeSession, buildSubSession } from "./kernel.js";
import { terminalProfileOf, type SpawnSubPolicy } from "./types.js";

/* ────────────── helpers ────────────── */

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function userTexts(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map(messageText);
}

function row(over: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "run_kernelfirst00001",
    workflow: "w-kernel",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: "ses_kernelfirst0001",
    ...over,
  };
}

const doneResult: RunLaunchResult = {
  status: "done",
  digest: "done：内核单测",
  pointers: [],
  blockers: [],
};

/** 一次性脚本端口：进 run 时记录 ctx 并异步 settle/blow（由测试摆布）。 */
function scriptedPort(behavior: (ctx: RunLaunchContext) => Promise<RunLaunchResult>): {
  port: RunSessionPort;
  seen: RunLaunchContext[];
} {
  const seen: RunLaunchContext[] = [];
  return {
    seen,
    port: {
      run: (ctx) => {
        seen.push(ctx);
        return behavior(ctx);
      },
    },
  };
}

/* ────────────── 1. run policy：生命周期全序 + handle ────────────── */

describe("SpawnKernel run 面：policy 路由 / handle 生命周期", () => {
  it("spawn(run policy)：queued→running→done 全序；expected 先行落账；handle 身份对 + status 实时 + completion 盖棺", async () => {
    const ledger = new MemoryLedger();
    const seen: RunLaunchContext[] = [];
    // 进入瞬间同步抓 state（= 原 run-engine 测试 MockPort 姿势；异步断言吃微任务序不稳）
    const stateAtEnter: Array<string | "none"> = [];
    const portRef: { kernel?: SpawnKernel } = {};
    const port: RunSessionPort = {
      run: (ctx) => {
        seen.push(ctx);
        stateAtEnter.push(portRef.kernel?.get(ctx.row.run_id)?.state ?? "none");
        return Promise.resolve(doneResult);
      },
    };
    const terminals: RunRecord[] = [];
    const kernel = new SpawnKernel({ ledger, sessionPort: port, now: () => 42, onRunTerminal: (r) => terminals.push(r) });
    portRef.kernel = kernel;

    const res = await kernel.spawn({ kind: "run", row: row(), prompt: "干活" });
    if (res.kind !== "launched") throw new Error("expected launched");

    // handle 身份对（run_id + 账本 session_id）
    expect(res.handle.id).toBe("run_kernelfirst00001");
    expect(res.handle.sessionId).toBe("ses_kernelfirst0001");
    // D15 时序铁律随内核平移：进入执行瞬间登记态=running（seen/快照抓于 run() 调用现场）。
    // spawn 返回瞬间 actual 可能尚未落（执行在 completion 链上异步推进），账本双行断言后置。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.row.run_id).toBe(res.handle.id);
    expect(stateAtEnter).toEqual(["running"]);

    const rec = await res.handle.completion;
    expect(rec.state).toBe("done");
    expect(rec.terminalAt).toBe(42);
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected", "actual"]);
    // status() 实时快照 = 终态记录；盖棺观察者恰一次
    expect(res.handle.status()?.state).toBe("done");
    expect(terminals).toHaveLength(1);
    // 查询面（门面 delegation 原料）
    expect(kernel.listRuns().map((r) => r.row.run_id)).toEqual([res.handle.id]);
    expect(kernel.activeCount()).toBe(0);
    expect(kernel.gaps()).toEqual([]);
  });

  it("agent 透传：policy.agent 进执行上下文；未给=键缺席（旧引擎逐字节语义）", async () => {
    const { port, seen } = scriptedPort(async () => Promise.resolve(doneResult));
    const kernel = new SpawnKernel({ ledger: new MemoryLedger(), sessionPort: port });
    const a = await kernel.spawn({ kind: "run", row: row({ run_id: "run_agentpass000001", session_id: "ses_agentpass00001" }), prompt: "p", agent: "reviewer" });
    if (a.kind === "launched") await a.handle.completion;
    expect(seen[0]!.agent).toBe("reviewer");
    const b = await kernel.spawn({ kind: "run", row: row({ run_id: "run_agentabsent001", session_id: "ses_agentabsent01" }), prompt: "p" });
    if (b.kind === "launched") await b.handle.completion;
    expect("agent" in seen[1]!).toBe(false);
  });

  it("paused：不写 expected、不登记、端口不碰；kernel.get=undefined", async () => {
    const ledger = new MemoryLedger();
    const { port, seen } = scriptedPort(async () => Promise.resolve(doneResult));
    const kernel = new SpawnKernel({
      ledger,
      sessionPort: port,
      admission: { admit: () => ({ kind: "paused", reason: "workflow paused: w-kernel" }) },
    });
    const res = await kernel.spawn({ kind: "run", row: row(), prompt: "干活" });
    expect(res.kind).toBe("paused");
    if (res.kind === "paused") expect(res.reason).toContain("w-kernel");
    expect(ledger.entries).toHaveLength(0);
    expect(kernel.get("run_kernelfirst00001")).toBeUndefined();
    expect(seen).toHaveLength(0);
  });
});

/* ────────────── 2. completion 恒 resolve（crash 形状零改动） ────────────── */

describe("SpawnKernel：completion 恒 resolve + 崩溃缺口形状", () => {
  it("端口抛炸：completion **不 reject**，resolve crashed 记录；账本停 expected（缺口）；死信/产物不发；盖棺观察者恰一次", async () => {
    const ledger = new MemoryLedger();
    const { port } = scriptedPort(async () => Promise.reject(new Error("executor blew up")));
    const terminals: RunRecord[] = [];
    let deadLetters = 0;
    const kernel = new SpawnKernel({
      ledger,
      sessionPort: port,
      now: () => 7,
      onRunTerminal: (r) => terminals.push(r),
      deadLetterSink: { emit: () => { deadLetters += 1; } },
    });
    const res = await kernel.spawn({ kind: "run", row: row(), prompt: "炸给我看" });
    if (res.kind !== "launched") throw new Error("expected launched");
    const rec = await res.handle.completion; // 若 reject 则本行 throw → 测试红
    expect(rec.state).toBe("failed");
    expect(rec.crashed).toBe(true);
    expect(rec.error).toContain("executor blew up");
    expect(rec.terminalAt).toBe(7);
    expect(ledger.entries.map((e) => e.t)).toEqual(["expected"]);
    expect(kernel.gaps()).toEqual(["run_kernelfirst00001"]);
    expect(terminals).toHaveLength(1);
    expect(deadLetters).toBe(0);
  });

  it("expected 落盘失败 = 绝不开火（撤登记 + 响亮抛 RunEngineError）", async () => {
    const broken: LedgerPort = {
      expected() { throw new Error("disk full"); },
      actual() { throw new Error("unreachable"); },
    };
    const { port, seen } = scriptedPort(async () => Promise.resolve(doneResult));
    const kernel = new SpawnKernel({ ledger: broken, sessionPort: port });
    await expect(kernel.spawn({ kind: "run", row: row(), prompt: "p" })).rejects.toThrow(/expected write failed/);
    expect(seen).toHaveLength(0);
    expect(kernel.listRuns()).toHaveLength(0);
  });

  it("同 run_id 二次 spawn：撞号响亮抛（登记面幂等保护照搬）", async () => {
    const { port } = scriptedPort(async () => new Promise<RunLaunchResult>(() => {}));
    const kernel = new SpawnKernel({ ledger: new MemoryLedger(), sessionPort: port });
    await kernel.spawn({ kind: "run", row: row(), prompt: "p" });
    await expect(kernel.spawn({ kind: "run", row: row(), prompt: "p" })).rejects.toThrow(/already known/);
  });
});

/* ────────────── 3. cancel 语义（照搬 engine.ts:169-183，不发明新幂等） ────────────── */

describe("SpawnKernel：cancel 在途/终态/未知三态", () => {
  it("在途命中：signal abort + cancelRequested 记录；handle.cancel 同语义；终态后不再命中；未知 id=false", async () => {
    let resolveRun: (r: RunLaunchResult) => void = () => {};
    const { port, seen } = scriptedPort(() => new Promise<RunLaunchResult>((res) => { resolveRun = res; }));
    const kernel = new SpawnKernel({ ledger: new MemoryLedger(), sessionPort: port });

    expect(kernel.cancel("run_unknown0000000")).toBe(false); // 未知 id

    const res = await kernel.spawn({ kind: "run", row: row(), prompt: "取消我" });
    if (res.kind !== "launched") throw new Error("expected launched");
    expect(res.handle.cancel("operator abort")).toBe(true); // handle 入口
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(kernel.get("run_kernelfirst00001")?.cancelRequested).toBe("operator abort");
    // 在途重复 cancel：仍命中 true、原因覆盖（=原引擎语义，切片 1 不发明幂等新行为）
    expect(kernel.cancel("run_kernelfirst00001", "second")).toBe(true);
    expect(kernel.get("run_kernelfirst00001")?.cancelRequested).toBe("second");

    resolveRun({ status: "failed", digest: "failed：已取消", pointers: [], blockers: [] });
    const rec = await res.handle.completion;
    expect(rec.state).toBe("failed");
    expect(kernel.cancel("run_kernelfirst00001")).toBe(false); // 终态不再命中
  });
});

/* ────────────── 4. sub policy：纯工厂（登记/账本零染指）+ 工厂形状 ───────────────── */

describe("SpawnKernel sub 面：policy 路由到唯一工厂", () => {
  const fake = () => createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);

  function subPolicy(over: Partial<SpawnSubPolicy> = {}): SpawnSubPolicy {
    return { kind: "sub", agentType: "general", task: "子任务", parentSessionId: "ses_parent0000000001", depth: 0, ...over };
  }

  it("spawn(sub policy, profile)：返回可跑 AgentSession；内核登记面零触碰（listRuns=[]，账本零行）", async () => {
    const ledger = new MemoryLedger();
    const { port } = scriptedPort(async () => Promise.resolve(doneResult));
    const kernel = new SpawnKernel({ ledger, sessionPort: port });

    const session = kernel.spawn(subPolicy(), {
      model: fake(),
      sessionId: "ses_subonly00000001",
      systemPrompt: "子会话提示",
      tools: [],
    });
    expect(session.id).toBe("ses_subonly00000001");
    expect(kernel.listRuns()).toHaveLength(0);
    expect(ledger.entries).toHaveLength(0);

    const summary = await session.run("跑一下");
    expect(summary.reason).toBe("done");
    expect(JSON.stringify(summary.lastMessage)).toContain("ok");
  });

  it("spawn(sub policy) 缺 profile = 响亮抛（工厂入参不许凭空造）", () => {
    const kernel = new SpawnKernel({ ledger: new MemoryLedger(), sessionPort: scriptedPort(async () => doneResult).port });
    expect(() => (kernel.spawn as unknown as (p: SpawnSubPolicy) => unknown)(subPolicy())).toThrow(/requires SubSessionProfile/);
  });

  it("buildSubSession 键展开语义=旧两工厂并集：hooks undefined/空=键缺席（session 可跑即证不炸）、maxTurns 透传生效", async () => {
    // maxTurns 生效证据：模型每 turn 回 toolCall（永不自终止）→ 轮数预算封顶 reason=max_turns。
    // （纯文本首 turn 即 done，测不出 maxTurns——终止词表语义，非本工厂行为。）
    const noopTool: HarnessTool = {
      name: "noop",
      description: "noop tool for turn-budget probing",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: "x" }] };
      },
    };
    const loopingModel = () =>
      createFakeModel(
        Array.from({ length: 4 }, () => ({
          content: [{ type: "toolCall" as const, id: `t${Math.random()}`, name: "noop", arguments: {} }],
        })),
      );
    const capped = buildSubSession({
      model: loopingModel(),
      sessionId: "ses_maxturns000001",
      systemPrompt: "",
      tools: [noopTool],
      maxTurns: 1,
    });
    const summary = await capped.run("多轮空转");
    expect(summary.reason).toBe("max_turns");

    const noHooks = buildSubSession({ model: fake(), sessionId: "ses_nohooks00000001", systemPrompt: "s", tools: [], hooks: [] });
    expect(noHooks.id).toBe("ses_nohooks00000001");
  });

  it("buildConvergeSession：gate 挂首工具 converge + session 身份/提示照旧（converge-receipt 档案）", () => {
    const { gate, session } = buildConvergeSession({
      model: fake(),
      sessionId: "ses_converge000001",
      tools: [],
      hooks: [],
    });
    expect(gate.tool.name).toBe("converge");
    expect(session.id).toBe("ses_converge000001");
  });

  it("buildSubSession passes the context watcher and checks each turn by default", async () => {
    let text = "V1: rule one\n";
    let mtime = 1;
    const watcher = new SessionContextWatcher({
      workspaceRoot: "/kernel-sub-context",
      sources: [{ relPath: "AGENTS.md", content: text }],
      statFile: () => ({ mtimeMs: mtime, size: Buffer.byteLength(text, "utf8") }),
      readTextFile: () => text,
    });
    const mutate: HarnessTool = {
      name: "mutate",
      description: "mutate the watched source",
      parameters: Type.Object({}),
      async execute() {
        text = "V1: rule one\nV2: rule two changed\n";
        mtime = 2;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "m1", name: "mutate", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = buildSubSession({
      model,
      sessionId: "ses_kernel_ctx_sub01",
      systemPrompt: "",
      tools: [mutate],
      contextWatcher: watcher,
    });

    const summary = await session.run("go");

    expect(summary.reason).toBe("done");
    const calls = model.getCalls();
    expect(calls).toHaveLength(2);
    expect(userTexts(calls[1]!)).toHaveLength(2);
    expect(userTexts(calls[1]!).at(-1)).toContain("+V2: rule two changed");
  });

  it("buildConvergeSession forwards contextCheckEachTurn=false but keeps the run-start check", async () => {
    let text = "V1: rule one\n";
    let mtime = 1;
    const watcher = new SessionContextWatcher({
      workspaceRoot: "/kernel-converge-context",
      sources: [{ relPath: "AGENTS.md", content: text }],
      statFile: () => ({ mtimeMs: mtime, size: Buffer.byteLength(text, "utf8") }),
      readTextFile: () => text,
    });
    const mutate: HarnessTool = {
      name: "mutate",
      description: "mutate the watched source",
      parameters: Type.Object({}),
      async execute() {
        text = "V1: rule one\nV3: rule three\n";
        mtime = 3;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "m1", name: "mutate", arguments: {} }] },
      {
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "converge",
            arguments: {
              status: "done",
              runId: "run_kernel_ctx_converge",
              workflow: "w-kernel",
              attempt: 1,
            },
          },
        ],
      },
    ]);
    const { session } = buildConvergeSession({
      model,
      sessionId: "ses_kernel_ctx_converge01",
      tools: [mutate],
      hooks: [],
      contextWatcher: watcher,
      contextCheckEachTurn: false,
    });

    text = "V1: rule one\nV2: rule two changed\n";
    mtime = 2;
    const summary = await session.run("go");

    expect(summary.abortReason).toContain("convergence:converged");
    const calls = model.getCalls();
    expect(calls).toHaveLength(2);
    expect(userTexts(calls[0]!)[0]).toContain("+V2: rule two changed");
    expect(userTexts(calls[0]!)[1]).toBe("go");
    expect(userTexts(calls[1]!)).toHaveLength(2);
    expect(userTexts(calls[1]!)[0]).toContain("+V2: rule two changed");
  });

  it("terminalProfileOf：run→converge-receipt、sub→raw-summary（词表映射恒函数）", () => {
    expect(terminalProfileOf({ kind: "run", row: row(), prompt: "p" })).toBe("converge-receipt");
    expect(terminalProfileOf(subPolicy())).toBe("raw-summary");
  });
});
