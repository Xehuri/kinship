/**
 * T33 黄金路径 —— 聊天 turn 端到端（docs/02 §T33；docs/01 D25/D28 冻结语义）。
 *
 * 场景链：用户消息 → T18 装配（默认空段配置）→ fake LLM 正文+delta → converge
 * 收束（D25：收束工具成功调用是唯一终止通道）→ T29 EventHub SSE 信封帧 →
 * JsonlSessionStore 落盘、重启读回。
 *
 * 四条硬断言（验收标准）：
 *   (1) 帧序数组严格比对：start → deltas → 收束族 → idle（idle 带驼峰 sessionID + 镜像 id）；
 *   (2) 收束成功才停：单次 LLM 调用、无第二回合、账本终态 terminal-converged；
 *   (3) 持久化：JsonlSessionStore 落盘 → 新实例读回 leaf path 全等（重启语义）；
 *   (4) 全程零网络：globalThis.fetch 桩一触即抛，黄金路径照常收束。
 *
 * 接线姿势：recorded 轨经 extraHooks 镜像转 hub.forwardRecorded（等价于内核
 * runStreaming 内部 forwarder；MainSessionLoop 内部用 run()，与 runStreaming 互斥）；
 * 假订阅者用真 ServerResponse（无 socket）+ write 捕获，事件模式抄 sse.test.ts。
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hook, Message, StoredEntry } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse, type FakeModel } from "@axeuh/loom-core/testing";
import { MainSessionLoop, type LoopEvent } from "@axeuh/loom-core/main-loop";
import { JsonlSessionStore } from "@axeuh/loom-adapters";
import { EventHub, SSE_EVENT_LINE_RE, type LoomFrame } from "../events/index.js";

const SESSION_ID = "golden_chat_turn";
const GOLDEN_TIMEOUT_MS = 30_000; // NTFS 慢盘余量

/** 黄金脚本：正文与 converge 同一条回复（零额外往返），带流式 text delta。 */
const goldenTurn: FakeAssistantResponse = {
  content: [
    { type: "text", text: "正文完成" },
    {
      type: "toolCall",
      name: "converge",
      arguments: { status: "已完成", digest: "已完成：黄金路径巡检通过", body: "本轮结论：系统健康。" },
    },
  ],
  textDeltas: ["正文", "完成"],
};

function quietSink(): void {
  /* 吞掉内核 console/log，保持测试输出干净 */
}

/** 假 SSE 订阅者：真 ServerResponse（不挂 socket），write 全量捕获为文本。 */
function fakeSubscriber(): { res: ServerResponse; text: () => string } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: string[] = [];
  res.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof res.write;
  return { res, text: () => chunks.join("") };
}

/** 解析 SSE 文本里所有 `data:` 帧（`\n\n` 分帧，注释行忽略）——同 sse.test.ts。 */
function parseFrames(text: string): LoomFrame[] {
  const out: LoomFrame[] = [];
  for (const chunk of text.split("\n\n")) {
    const trimmed = chunk.trim();
    if (trimmed === "" || trimmed.startsWith(":")) continue;
    if (!trimmed.startsWith("data:")) continue;
    out.push(JSON.parse(trimmed.slice("data:".length)) as LoomFrame);
  }
  return out;
}

interface GoldenRun {
  readonly loop: MainSessionLoop;
  readonly model: FakeModel;
  readonly store: JsonlSessionStore;
  readonly filePath: string;
  readonly frames: LoomFrame[];
  readonly raw: string;
  readonly result: Awaited<ReturnType<MainSessionLoop["start"]>>;
}

/** 跑一次完整黄金路径：装配空段 → loop.start 收束 → 帧序捕获 → store 落盘。 */
async function runGolden(stateRoot: string): Promise<GoldenRun> {
  const model = createFakeModel([goldenTurn]);
  created.push(model);
  const filePath = join(stateRoot, "sessions", `${SESSION_ID}.jsonl`);
  const store = new JsonlSessionStore(filePath);

  // recorded 轨镜像 hook：把内核生命周期事件转成 SessionEvent 灌给 hub（扇出投影）。
  let hub: EventHub | null = null;
  const recorder: Hook = {
    name: "golden.record-forwarder",
    onSessionStart(input) {
      hub?.forwardRecorded({
        type: "session-start",
        sessionId: SESSION_ID,
        source: input.source,
        ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
      });
    },
    onTurnStart(input) {
      hub?.forwardRecorded({ type: "turn-start", turnIdx: input.turnIdx });
    },
    onLlmEnd(input) {
      hub?.forwardRecorded({ type: "llm-end", msg: input.msg, durationMs: input.durationMs });
    },
    onPostToolUse(input) {
      hub?.forwardRecorded({
        type: "tool-end",
        call: input.call,
        result: input.result,
        durationMs: input.durationMs,
      });
    },
  };

  const loop = MainSessionLoop.create({
    model,
    store,
    sessionId: SESSION_ID,
    extraHooks: [recorder],
    // T18 默认空段配置：不为本测试造额外装配脚手架。
    assembly: {
      plan: { systemPrompt: "你是 loom 主会话（黄金路径测试）。", memorySources: [], workflows: [] },
      reader: null,
    },
    logSink: quietSink,
    consoleSink: quietSink,
  });

  hub = new EventHub({ session: loop.session, stateRoot });
  const sub = fakeSubscriber();
  const unsubscribe = hub.subscribe(sub.res);

  const result = await loop.start("汇报系统状态");
  // 收束终态以真 RunSummary 走 recorded 轨出 idle（等价 T27 接线里 loop 收尾后的扇出）。
  hub.forwardRecorded({ type: "session-end", summary: result.summary });

  const raw = sub.text();
  const frames = parseFrames(raw);
  unsubscribe();
  hub.close();
  return { loop, model, store, filePath, frames, raw, result };
}

const created: FakeModel[] = [];
let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-golden-t33-"));
});

afterEach(() => {
  for (const m of created.splice(0)) m.teardown();
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("T33 黄金路径聊天 turn", () => {
  it("(1) 帧序数组严格比对：start → deltas → 收束族 → idle（idle 驼峰 sessionID + 镜像 id + 三态收束）", async () => {
    const run = await runGolden(stateRoot);

    expect(run.frames.map((f) => f.payload.type)).toEqual([
      "server.connected", // W11a P3：订阅建立即发首帧（文档 §1）
      "session.status", // recorded session-start（busy）
      "session.status", // recorded turn-start(0)（busy）
      "message.part.delta", // live text_delta「正文」
      "message.part.delta", // live text_delta「完成」
      "message.updated", // llm-end 终态快照（token 面）
      "message.part.updated", // text part 快照（与 delta 同 part 坐标，splice 原位替换）
      "session.idle", // session-end：收束盖棺后唯一 idle
    ]);
    // converge 的 tool-end 不发 part 帧（收束调用不是 UI 可渲染块）——上面 8 帧即全量。
    expect(run.frames.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    expect(run.frames.slice(3, 5).map((f) => f.payload.properties.delta)).toEqual(["正文", "完成"]);
    for (const f of run.frames.slice(1, 3)) {
      expect((f.payload.properties.status as { type: string }).type).toBe("busy");
    }

    const idle = run.frames.at(-1)!;
    expect(idle.payload.properties.sessionID).toBe(SESSION_ID); // 驼峰 sessionID
    expect(idle.payload.properties.id).toBe(SESSION_ID); // 镜像 id（缺则前端挂 120s）
    expect((idle.payload.properties.status as { type: string }).type).toBe("idle");
    const conv = idle.payload.properties.convergence as { status: string; converged: boolean };
    expect(conv).toEqual({ status: "已完成", converged: true });
    expect(run.result.type).toBe("converged");
  }, GOLDEN_TIMEOUT_MS);

  it("(2) 收束成功才停：单次 LLM 调用、无第二回合、装配一次、账本终态 terminal-converged", async () => {
    const run = await runGolden(stateRoot);

    // 唯一一次 LLM 往返：正文+converge 同条回复（零额外往返），没有任何后续回合。
    expect(run.model.getCalls()).toHaveLength(1);
    expect(run.frames.filter((f) => f.payload.type === "session.status")).toHaveLength(2); // 仅 start+turn0
    expect(run.frames.filter((f) => f.payload.type === "session.idle")).toHaveLength(1);

    const result = run.result;
    if (result.type !== "converged") throw new Error("unreachable: 收束应成功");
    expect(result.runs).toBe(1);
    expect(result.autoContinuationsUsed).toBe(0); // 没有触发跨请求自动续跑
    expect(result.summary.abortReason).toContain("convergence:converged");
    expect((result.receipt as { status: string }).status).toBe("已完成");

    // T18 装配在唯一 turn 边界恰好重装配一次（默认空段配置）。
    expect(run.loop.assemblies()).toHaveLength(1);

    // Outcome 账本最后一条 = converged / terminal-converged（D25 唯一完成通道）。
    const outcomes = run.loop
      .events()
      .filter((e): e is Extract<LoopEvent, { type: "outcome" }> => e.type === "outcome");
    expect(outcomes.at(-1)?.disposition).toBe("terminal-converged");
  }, GOLDEN_TIMEOUT_MS);

  it("(3) 持久化重启语义：JsonlSessionStore 落盘 → 新实例读回 leaf path 消息全等", async () => {
    const run = await runGolden(stateRoot);

    const first = await run.store.getPathToLeaf(SESSION_ID);
    // 重启：同一路径新建实例（纯从 JSONL 回放重建索引）。
    const reopened = new JsonlSessionStore(run.filePath);
    const second = await reopened.getPathToLeaf(SESSION_ID);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // 全等（含 id/parentId/seq）

    const kinds = first.map((e: StoredEntry) => e.entry.kind);
    expect(kinds).toEqual(["message", "message", "message", "terminal"]);

    const messages: Message[] = [];
    for (const node of first) {
      if (node.entry.kind === "message") messages.push(node.entry.message);
    }
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    const userText = (m: Message): string =>
      typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? String(b.text) : "")).join("");
    expect(userText(messages[0]!)).toBe("汇报系统状态");
    const assistant = messages[1]!;
    if (assistant.role !== "assistant") throw new Error("turn0 应答必为 assistant");
    expect(userText(assistant)).toContain("正文完成");
    expect(
      assistant.content.some((b) => b.type === "toolCall" && b.name === "converge"),
    ).toBe(true);
  }, GOLDEN_TIMEOUT_MS);

  it("(4) 全程零网络：globalThis.fetch 一触即抛桩下，黄金路径照常收束出 idle", async () => {
    let fetchTouched = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> => {
      fetchTouched += 1;
      throw new Error("golden path must not touch the network");
    };
    try {
      const run = await runGolden(stateRoot);
      expect(fetchTouched).toBe(0);
      expect(run.result.type).toBe("converged");
      expect(run.frames.at(-1)!.payload.type).toBe("session.idle");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, GOLDEN_TIMEOUT_MS);

  it("(5) 信封完整性：帧文本无 event: 行，每帧 properties 恒存在且 sessionID 全帧驼峰一致", async () => {
    const run = await runGolden(stateRoot);

    expect(run.raw).not.toMatch(SSE_EVENT_LINE_RE); // 默认 message 事件（前端 onmessage 可收）
    for (const f of run.frames) {
      expect(typeof f.payload.type).toBe("string");
      expect(f.payload.properties).toBeDefined();
      expect(f.payload.properties.sessionID).toBe(SESSION_ID);
    }
    // delta 帧前端硬约束：field==='text' + partID/messageID，且快照 part id 与 delta 同坐标。
    const delta = run.frames.find((f) => f.payload.type === "message.part.delta")!;
    expect(delta.payload.properties.field).toBe("text");
    const snapshot = run.frames.find((f) => f.payload.type === "message.part.updated")!;
    expect((snapshot.payload.properties.part as { id: string }).id).toBe(delta.payload.properties.partID);
    // W32：真 pump 路径首条 LLM 消息由 live message_start 单调 tick 出号（首 call = msg_1）
    expect(delta.payload.properties.messageID).toBe("msg_1");
  }, GOLDEN_TIMEOUT_MS);
});
