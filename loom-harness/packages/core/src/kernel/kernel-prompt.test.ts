/**
 * W9 事故补测（S05 金丝雀假绿盲区）—— prompt 传递保真内核单测。
 * Given: MemoryLedger + 抓 ctx 的捕获端口；构造含换行/引号/反斜杠/${}/CJK 的刁钻 prompt
 * When:  kernel.spawn(run policy) 直调 / RunEngine.dispatch(门面全链 parse→policy→_execute→端口)
 * Then:  端口收到的 ctx.prompt 与提交值**逐字节全等**（===，非 contains）；ctx.agent 归一透传；
 *        row 引用透传；并发两 run 各自 prompt 不错配（反串台钉）。
 * 决策：本文件专测"内核流转中 prompt 是否丢失/被替换/配错"，与 kernel.test.ts
 *      （生命周期面）正交——既有测试对 ctx.prompt 零断言是本次 fleet S05 假绿的盲区补位。
 */

import { describe, expect, it } from "vitest";

import { MemoryLedger } from "../run-engine/memory-ledger.js";
import { RunEngine } from "../run-engine/engine.js";
import type {
  RunLaunchContext,
  RunLaunchResult,
  RunRow,
  RunSessionPort,
} from "../run-engine/types.js";
import { SpawnKernel } from "./kernel.js";

/* ────────────── helpers ────────────── */

function row(over: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "run_promptfidelity1",
    workflow: "w-prompt",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: "ses_promptfidelity",
    ...over,
  };
}

const okResult: RunLaunchResult = {
  status: "done",
  digest: "done：prompt 保真",
  pointers: [],
  blockers: [],
};

/** 捕获端口：记下每次 run 的全量 ctx（prompt 保真断言的观测面）。 */
function capturePort(): { port: RunSessionPort; seen: RunLaunchContext[] } {
  const seen: RunLaunchContext[] = [];
  return {
    seen,
    port: {
      run: (ctx) => {
        seen.push(ctx);
        return Promise.resolve(okResult);
      },
    },
  };
}

/**
 * 刁钻 prompt 样本：多行 CJK + 制表 + 单双引号 + 反斜杠 + 模板占位字面量 + 尾随空格。
 * 任一环节 JSON 往返/字段替换/转义丢失都会破坏逐字节全等。
 */
function nastyPrompt(tag: string): string {
  const nl = "\n";
  const tab = "\t";
  return (
    `用 bash 工具执行命令：echo "${tag}" 。` +
    nl +
    `第二行：制表${tab}后接反斜杠 \\\\ 与单引号 'x' 。` +
    nl +
    "第三行：模板占位字面量 ${NOT_EXPANSION_%TAG%} 必须原样送达。" +
    "  "
  ).replace("%TAG%", tag);
}

/* ────────────── 1. 内核 spawn 层：policy.prompt 逐字节到端口 ────────────── */

describe("SpawnKernel run 面：prompt 逐字节保真", () => {
  it("spawn(run policy)：端口 ctx.prompt === policy.prompt（刁钻多行样本），row 引用透传", async () => {
    const { port, seen } = capturePort();
    const kernel = new SpawnKernel({ ledger: new MemoryLedger(), sessionPort: port });
    const p = nastyPrompt("KERNEL-1");
    const r = row({ run_id: "run_kernelprompt001", session_id: "ses_kernelprompt01" });
    const spawned = await kernel.spawn({ kind: "run", row: r, prompt: p });
    expect(spawned.kind).toBe("launched");
    if (spawned.kind === "launched") {
      await spawned.handle.completion;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe(p); // 逐字节全等（===）
    expect(seen[0]?.row).toBe(r); // row 引用透传（内核不重建行对象）
    expect(seen[0]?.agent).toBeUndefined();
  });

  it("agent 声明时：prompt 与 agent 同时保真送达（agent=去空白归一值）", async () => {
    const { port, seen } = capturePort();
    const kernel = new SpawnKernel({ ledger: new MemoryLedger(), sessionPort: port });
    const p = nastyPrompt("KERNEL-2");
    const spawned = await kernel.spawn({
      kind: "run",
      row: row({ run_id: "run_kernelprompt002", session_id: "ses_kernelprompt02" }),
      prompt: p,
      agent: "reviewer",
    });
    if (spawned.kind === "launched") {
      await spawned.handle.completion;
    }
    expect(seen[0]?.prompt).toBe(p);
    expect(seen[0]?.agent).toBe("reviewer");
  });

  it("并发两 run：各自 prompt 不错配（反串台钉——端口按 run_id 配对断言）", async () => {
    const { port, seen } = capturePort();
    const kernel = new SpawnKernel({ ledger: new MemoryLedger(), sessionPort: port });
    const pa = nastyPrompt("A");
    const pb = nastyPrompt("B");
    const rA = row({ run_id: "run_concprompt000a", session_id: "ses_concprompt00a" });
    const rB = row({ run_id: "run_concprompt000b", session_id: "ses_concprompt00b" });
    const [sa, sb] = await Promise.all([
      kernel.spawn({ kind: "run", row: rA, prompt: pa }),
      kernel.spawn({ kind: "run", row: rB, prompt: pb }),
    ]);
    if (sa.kind === "launched") await sa.handle.completion;
    if (sb.kind === "launched") await sb.handle.completion;
    expect(seen).toHaveLength(2);
    for (const ctx of seen) {
      if (ctx.row.run_id === rA.run_id) expect(ctx.prompt).toBe(pa);
      else expect(ctx.prompt).toBe(pb);
    }
  });
});

/* ────────────── 2. 门面全链：dispatch 提交值 == 端口收到值 ────────────── */

describe("RunEngine.dispatch → SpawnKernel → 端口：prompt 全链逐字节", () => {
  it("dispatch(input.prompt) 的原始字符串（含刁钻字符）逐字节出现在端口 ctx.prompt", async () => {
    const { port, seen } = capturePort();
    const engine = new RunEngine({ ledger: new MemoryLedger(), sessionPort: port });
    const p = nastyPrompt("FACADE");
    const out = await engine.dispatch({ workflow: "w-prompt", prompt: p, trigger: "manual" });
    expect(out.kind).toBe("launched");
    if (out.kind === "launched") {
      await out.completion;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe(p);
    expect(seen[0]?.row.workflow).toBe("w-prompt");
  });

  it("agent 带首尾空白：端口收到 trim 后值，prompt 不受牵连（两字段独立保真）", async () => {
    const { port, seen } = capturePort();
    const engine = new RunEngine({ ledger: new MemoryLedger(), sessionPort: port });
    const p = nastyPrompt("TRIM");
    const out = await engine.dispatch({
      workflow: "w-prompt",
      prompt: p,
      trigger: "manual",
      agent: "  reviewer  ",
    });
    if (out.kind === "launched") {
      await out.completion;
    }
    expect(seen[0]?.prompt).toBe(p);
    expect(seen[0]?.agent).toBe("reviewer");
  });

  it("连发两 run（同引擎复用）：第二个 prompt 不残留第一个（反旧值粘滞钉）", async () => {
    const { port, seen } = capturePort();
    const engine = new RunEngine({ ledger: new MemoryLedger(), sessionPort: port });
    const p1 = nastyPrompt("RUN-1");
    const p2 = nastyPrompt("RUN-2");
    const o1 = await engine.dispatch({ workflow: "w-prompt", prompt: p1, trigger: "manual" });
    if (o1.kind === "launched") await o1.completion;
    const o2 = await engine.dispatch({ workflow: "w-prompt", prompt: p2, trigger: "manual" });
    if (o2.kind === "launched") await o2.completion;
    expect(seen).toHaveLength(2);
    expect(seen[0]?.prompt).toBe(p1);
    expect(seen[1]?.prompt).toBe(p2);
  });
});
