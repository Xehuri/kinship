/**
 * converge 回执派生与可选自动唤醒（wake）验收。
 *
 *   - 主/副会话都不再要求模型提供 digest（由最后一条 assistant 正文派生）；
 *   - body 可省略、提供则原样回显（legacy 兼容）；
 *   - wake 仅主会话可用，解析失败/禁用/副会话一律走 fields 催办；
 *   - 回执 nextWakeAt 键的缺席 / null / number 三态可区分。
 */

import { describe, expect, it } from "vitest";
import {
  AgentSession,
  ConvergenceGate,
  ConvergenceTool,
  convergenceParameters,
  type HarnessTool,
  type MainReceipt,
  type Message,
  type SessionKind,
  type SideReceipt,
} from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

function quietSink(): void {
  /* 吞掉默认 console 输出 */
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
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
  return messages.map((m) => textOf((m as { content?: unknown }).content)).join("\n");
}

function convergeTurn(
  text: string,
  args: Record<string, unknown>,
): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: args },
    ],
  };
}

function receiptsOf(messages: ReadonlyArray<Message>): Array<MainReceipt | SideReceipt> {
  const out: Array<MainReceipt | SideReceipt> = [];
  for (const m of messages) {
    if (m.role !== "toolResult" || m.toolName !== "converge") continue;
    const details = (
      m as {
        details?: {
          __convergence?: {
            converged?: boolean;
            receipt?: MainReceipt | SideReceipt;
          };
        };
      }
    ).details;
    const result = details?.__convergence;
    if (result?.converged === true && result.receipt !== undefined) out.push(result.receipt);
  }
  return out;
}

function firstReceipt(messages: ReadonlyArray<Message>): MainReceipt | SideReceipt {
  const receipt = receiptsOf(messages)[0];
  if (receipt === undefined) throw new Error("expected a converged receipt");
  return receipt;
}

function makeSession(
  model: ReturnType<typeof createFakeModel>,
  kind: SessionKind,
  tool?: HarnessTool,
): { gate: ConvergenceGate; session: AgentSession } {
  const gate = new ConvergenceGate({ kind });
  const session = new AgentSession({
    model,
    tools: [tool ?? gate.tool],
    hooks: gate.buildHooks(),
    logSink: quietSink,
    consoleSink: quietSink,
  });
  return { gate, session };
}

function propertyKeys(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  return props === undefined ? [] : Object.keys(props);
}

describe("converge 回执 digest 派生", () => {
  it("主会话仅给 status：digest 从最后一条 assistant 正文派生，body 与 nextWakeAt 键缺席", async () => {
    const model = createFakeModel([convergeTurn("本轮巡检通过", { status: "已完成" })]);
    const { gate, session } = makeSession(model, "main");
    const summary = await session.run("巡检");

    expect(summary.abortReason).toContain("convergence:converged");
    const receipt = firstReceipt(session.messages);
    expect(receipt.digest).toBe("本轮巡检通过");
    expect(receipt).not.toHaveProperty("body");
    expect("nextWakeAt" in receipt).toBe(false);
    expect(gate.runOutcome().outcome?.type).toBe("converged");
  });

  it("副会话不带 digest：converged 且派生摘要非空，runId/workflow/attempt 原样落盘", async () => {
    const model = createFakeModel([
      convergeTurn("副会话产物已落盘", {
        status: "done",
        runId: "run-auto",
        workflow: "wf-auto",
        attempt: 1,
      }),
    ]);
    const { session } = makeSession(model, "side");
    await session.run("执行工作流");

    const receipt = firstReceipt(session.messages);
    expect(receipt.digest).toBe("副会话产物已落盘");
    expect(receipt.digest.trim().length).toBeGreaterThan(0);
    if (!("runId" in receipt)) throw new Error("expected a side receipt");
    expect(receipt.runId).toBe("run-auto");
    expect(receipt.workflow).toBe("wf-auto");
    expect(receipt.attempt).toBe(1);
  });

  it("deriveDigest 超过 120 码点：截断并追加省略号", async () => {
    const model = createFakeModel([
      convergeTurn("甲".repeat(130), { status: "已完成" }),
    ]);
    const { session } = makeSession(model, "main");
    await session.run("巡检");

    expect(firstReceipt(session.messages).digest).toBe(`${"甲".repeat(120)}…`);
  });

  it("deriveDigest 无正文：回退固定摘要，收束仍然合法", async () => {
    const model = createFakeModel([
      {
        content: [{ type: "toolCall", name: "converge", arguments: { status: "已完成" } }],
      },
    ]);
    const { session } = makeSession(model, "main");
    await session.run("巡检");

    expect(firstReceipt(session.messages).digest).toBe("（模型未提供摘要）");
  });

  it("legacy 兼容：显式 digest/body 原样回显", async () => {
    const model = createFakeModel([
      convergeTurn("正文不会覆盖显式回执", {
        status: "已完成",
        digest: "legacy",
        body: "legacy body",
      }),
    ]);
    const { session } = makeSession(model, "main");
    await session.run("巡检");

    const receipt = firstReceipt(session.messages);
    expect(receipt.digest).toBe("legacy");
    expect(receipt).toMatchObject({ body: "legacy body" });
  });
});

describe("converge wake 参数", () => {
  it("主会话 wake=10m：按注入 now 解析为 now + 600_000", async () => {
    const model = createFakeModel([convergeTurn("带唤醒的收束", { status: "已完成", wake: "10m" })]);
    const tool = ConvergenceTool("main", { now: () => NOW });
    const { session } = makeSession(model, "main", tool);
    await session.run("巡检");

    expect(firstReceipt(session.messages).nextWakeAt).toBe(NOW + 600_000);
  });

  it("主会话 wake=none：nextWakeAt 显式为 null（清除）", async () => {
    const model = createFakeModel([convergeTurn("清除唤醒", { status: "已完成", wake: "none" })]);
    const { session } = makeSession(model, "main");
    await session.run("巡检");

    expect(firstReceipt(session.messages).nextWakeAt).toBeNull();
  });

  it("主会话 wake=garbage：fields 催办；随后合法收束成功", async () => {
    const model = createFakeModel([
      convergeTurn("第一次", { status: "已完成", wake: "garbage" }),
      convergeTurn("第二次", { status: "已完成" }),
    ]);
    const { session } = makeSession(model, "main");
    await session.run("巡检");

    const text = allText(session.messages);
    expect(text).toContain("收束催办");
    expect(text).toContain("wake（无法识别的时间格式）");
    const receipts = receiptsOf(session.messages);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.digest).toBe("第二次");
  });

  it("副会话带 wake：fields 催办含「仅主会话」；随后合法收束成功", async () => {
    const sideArgs = { status: "done", runId: "run-w", workflow: "wf-w", attempt: 1 };
    const model = createFakeModel([
      convergeTurn("第一次", { ...sideArgs, wake: "10m" }),
      convergeTurn("第二次", sideArgs),
    ]);
    const { session } = makeSession(model, "side");
    await session.run("执行工作流");

    const text = allText(session.messages);
    expect(text).toContain("收束催办");
    expect(text).toContain("仅主会话");
    expect(receiptsOf(session.messages)).toHaveLength(1);
  });

  it("schema 面：wake 仅主会话且默认启用；side 既无 wake 也无 digest", () => {
    expect(propertyKeys(convergenceParameters("main"))).toContain("wake");
    expect(propertyKeys(convergenceParameters("main", { autoWakeEnabled: false }))).not.toContain(
      "wake",
    );
    const sideKeys = propertyKeys(convergenceParameters("side"));
    expect(sideKeys).not.toContain("wake");
    expect(sideKeys).not.toContain("digest");
  });

  it("自动唤醒禁用：带 wake 的 converge 被拒；不带 wake 的同一回执成功", async () => {
    const model = createFakeModel([
      convergeTurn("第一次", { status: "已完成", wake: "10m" }),
      convergeTurn("第二次", { status: "已完成" }),
    ]);
    const tool = ConvergenceTool("main", { autoWakeEnabled: false });
    const { session } = makeSession(model, "main", tool);
    await session.run("巡检");

    expect(allText(session.messages)).toContain("wake（自动唤醒已禁用）");
    const receipts = receiptsOf(session.messages);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.digest).toBe("第二次");
  });
});
