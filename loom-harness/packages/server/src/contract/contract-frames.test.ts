/**
 * T38 前端契约一致性验收（批次 1/3）—— 帧形状行。
 *
 * 验收表真源：docs/02 §T38 + §「Frontend hard contract」行（docs/02:32）。
 * 本文件覆盖行：R1 信封 / R2 properties 恒存在 / R3 每条带驼峰 sessionID /
 * R4 idle 带 id / R5 part.id / R6 delta field==='text' / R7 tokens 六字段 /
 * R8 children[].id / R9 id 无连字符 / R12 帧无 event: 行 / R13 seq 单调。
 * （R10/R11/R15/R16/R17 在 contract-api.test.ts；R14 在 contract-replay.test.ts。）
 *
 * 装配姿势：抄 golden/golden-chat.test.ts——MainSessionLoop + fake 模型全链、
 * 假订阅者（真 ServerResponse 无 socket + write 捕获）、recorded 轨经 extraHooks
 * 镜像 forwardRecorded。纯内存，无 HTTP、无网络、无落盘。
 *
 * 脏 id 证明通路：会话 id 故意含连字符（内核缺省 UUID 同形），投影层 sanitizeId
 * 归一后外发——R9 断言外发帧绝无连字符。
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySessionStore, Type, type Hook } from "@axeuh/loom-core";
import { MainSessionLoop } from "@axeuh/loom-core/main-loop";
import { createFakeModel, type FakeAssistantResponse, type FakeModel } from "@axeuh/loom-core/testing";
import { EventHub, LOOM_ID_RE, SSE_EVENT_LINE_RE, type LoomFrame } from "../events/index.js";

const SESSION_ID = "ses-contract-frames"; // 含连字符：验收 sanitize 后外发形状
const CLEAN_ID = "ses_contract_frames"; // sanitizeId(SESSION_ID) 的期望值

/** turn0：正文 + task 工具调用（结果带 <task_metadata> → children 帧）。 */
const taskTurn: FakeAssistantResponse = {
  content: [
    { type: "text", text: "派活" },
    { type: "toolCall", name: "task", arguments: { prompt: "子任务" } },
  ],
  textDeltas: ["派", "活"],
};

/** turn1：正文 + converge 收束（D25 唯一终止通道），带非零 usage 供 R7 断言实值。 */
const convergeTurn: FakeAssistantResponse = {
  content: [
    { type: "text", text: "完成" },
    {
      type: "toolCall",
      name: "converge",
      arguments: { status: "已完成", digest: "已完成：契约验收", body: "结论：形状全绿。" },
    },
  ],
  textDeltas: ["完", "成"],
  usage: { input: 100, output: 40, cached: 7 },
};

/** 干活工具：结果文本回灌 <task_metadata> 字面块（T11 契约，前端 children[].id 反解源）。 */
const taskTool = {
  name: "task",
  description: "派生子任务（契约测试用），结果回灌 task_metadata",
  parameters: Type.Object({ prompt: Type.String() }),
  async execute(): Promise<{ content: [{ type: "text"; text: string }] }> {
    const meta = [
      "<task_metadata>",
      "agent_type: general",
      "session_id: ses_0a1b2c3d4e5f6789",
      "reason: done",
      "turns: 1",
      "depth: 1",
      "</task_metadata>",
    ].join("\n");
    return { content: [{ type: "text", text: `子任务完成。\n${meta}` }] };
  },
};

function quietSink(): void {
  /* 吞掉内核 console/log，保持测试输出干净（抄 golden-chat） */
}

/** 假 SSE 订阅者：真 ServerResponse（不挂 socket），write 全量捕获为文本（抄 golden-chat）。 */
function fakeSubscriber(): { res: ServerResponse; text: () => string } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: string[] = [];
  res.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof res.write;
  return { res, text: () => chunks.join("") };
}

/** 解析 SSE 文本里所有 `data:` 帧（抄 golden-chat/sse.test.ts）。 */
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

const created: FakeModel[] = [];
afterEach(() => {
  for (const m of created.splice(0)) m.teardown();
});

interface ContractRun {
  readonly raw: string;
  readonly frames: LoomFrame[];
}

/** 跑一次全链（两 turn：task 工具 + converge 收束），返回捕获帧。每个验收行独立调用，互不耦合。 */
async function runContract(): Promise<ContractRun> {
  const model = createFakeModel([taskTurn, convergeTurn]);
  created.push(model);
  let hub: EventHub | null = null;
  // recorded 轨镜像 hook（抄 golden-chat 接线姿势）。
  const recorder: Hook = {
    name: "contract.record-forwarder",
    onSessionStart(input) {
      hub?.forwardRecorded({ type: "session-start", sessionId: SESSION_ID, source: input.source });
    },
    onTurnStart(input) {
      hub?.forwardRecorded({ type: "turn-start", turnIdx: input.turnIdx });
    },
    onLlmEnd(input) {
      hub?.forwardRecorded({ type: "llm-end", msg: input.msg, durationMs: input.durationMs });
    },
    onPostToolUse(input) {
      hub?.forwardRecorded({ type: "tool-end", call: input.call, result: input.result, durationMs: input.durationMs });
    },
  };
  const loop = MainSessionLoop.create({
    model,
    store: new MemorySessionStore(),
    sessionId: SESSION_ID,
    tools: [taskTool],
    extraHooks: [recorder],
    logSink: quietSink,
    consoleSink: quietSink,
  });
  hub = new EventHub({ session: loop.session });
  const sub = fakeSubscriber();
  const unsubscribe = hub.subscribe(sub.res);

  const result = await loop.start("契约验收跑一轮");
  hub.forwardRecorded({ type: "session-end", summary: result.summary });
  unsubscribe();
  hub.close();
  if (result.type === "error") throw new Error(`loop errored: ${String(result.summary.error?.message ?? "unknown")}`);
  const raw = sub.text();
  return { raw, frames: parseFrames(raw) };
}

/** 取指定类型帧（必存在，缺则测试明确失败）；多帧时取末一条。 */
function frameOf(frames: readonly LoomFrame[], type: string): LoomFrame {
  const hit = frames.filter((f) => f.payload.type === type).at(-1);
  if (hit === undefined) throw new Error(`no frame of type '${type}'; got ${JSON.stringify(frames.map((f) => f.payload.type))}`);
  return hit;
}

describe("T38 验收表 · 帧形状（contract-frames）", () => {
  it("R1 信封：每帧顶层为 {seq, payload:{type,properties}}，无缺件", async () => {
    const { frames } = await runContract();
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(typeof f.seq).toBe("number");
      expect(typeof f.payload).toBe("object");
      expect(typeof f.payload.type).toBe("string");
      expect(f.payload.properties).toBeDefined();
    }
  });

  it("R2 properties 恒存在：所有被消费事件族（delta/updated/idle/status/children）都带 properties", async () => {
    const { frames } = await runContract();
    const consumed = ["message.part.delta", "message.part.updated", "message.updated", "session.status", "session.idle", "session.children"];
    for (const f of frames) {
      if (!consumed.includes(f.payload.type)) continue;
      expect(typeof f.payload.properties).toBe("object");
      expect(Object.keys(f.payload.properties).length).toBeGreaterThan(0);
    }
    const seen = new Set(frames.map((f) => f.payload.type));
    for (const name of consumed) expect(seen.has(name), `事件族 '${name}' 未发出`).toBe(true);
  });

  it("R3 每条事件带驼峰 sessionID（全帧一致，且经 sanitize 无连字符）", async () => {
    const { frames } = await runContract();
    for (const f of frames) {
      expect(f.payload.properties.sessionID).toBe(CLEAN_ID);
    }
  });

  it("R4 session.idle 带 id（镜像 sessionID，缺则前端挂 120s）", async () => {
    const { frames } = await runContract();
    const idle = frameOf(frames, "session.idle");
    expect(idle.payload.properties.id).toBe(CLEAN_ID);
    expect((idle.payload.properties.status as { type: string }).type).toBe("idle");
  });

  it("R5 message.part.updated 必带 part.id 且匹配白名单", async () => {
    const { frames } = await runContract();
    const parts = frames.filter((f) => f.payload.type === "message.part.updated");
    expect(parts.length).toBeGreaterThan(0);
    for (const f of parts) {
      const part = f.payload.properties.part as Record<string, unknown>;
      expect(typeof part.id).toBe("string");
      expect(LOOM_ID_RE.test(String(part.id))).toBe(true);
    }
  });

  it("R6 message.part.delta 必带 field==='text' + partID + messageID（前端缺一即丢）", async () => {
    const { frames } = await runContract();
    const deltas = frames.filter((f) => f.payload.type === "message.part.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(4); // 两轮各两条 textDeltas
    for (const f of deltas) {
      expect(f.payload.properties.field).toBe("text");
      expect(LOOM_ID_RE.test(String(f.payload.properties.partID))).toBe(true);
      expect(LOOM_ID_RE.test(String(f.payload.properties.messageID))).toBe(true);
    }
    expect(deltas.map((f) => f.payload.properties.delta)).toEqual(["派", "活", "完", "成"]);
  });

  it("R7 message.updated 的 info.tokens 六字段形状（total/input/output/reasoning/cache.read/cache.write）", async () => {
    const { frames } = await runContract();
    const upd = frameOf(frames, "message.updated");
    const info = upd.payload.properties.info as Record<string, unknown>;
    expect(LOOM_ID_RE.test(String(info.id))).toBe(true);
    const tokens = info.tokens as Record<string, unknown>;
    expect(Object.keys(tokens).sort()).toEqual(["cache", "input", "output", "reasoning", "total"]);
    const cache = tokens.cache as Record<string, unknown>;
    expect(Object.keys(cache).sort()).toEqual(["read", "write"]);
    expect(tokens.total).toBe(140);
    expect(tokens.input).toBe(100);
    expect(tokens.output).toBe(40);
    expect(tokens.reasoning).toBe(0); // 内核 Usage 无 reasoning 段：形状字段必须在，如实给 0（docs/02 T38 定稿）
    expect(cache.read).toBe(7);
    expect(cache.write).toBe(0);
  });

  it("R8 children[].id 存在（<task_metadata> 反解进 session.children 帧）", async () => {
    const { frames } = await runContract();
    const kids = frameOf(frames, "session.children");
    const children = kids.payload.properties.children as Array<Record<string, unknown>>;
    expect(Array.isArray(children)).toBe(true);
    expect(children[0]!.id).toBe("ses_0a1b2c3d4e5f6789");
    expect(LOOM_ID_RE.test(String(children[0]!.id))).toBe(true);
  });

  it("R9 一切外发 id 匹配 [a-zA-Z0-9_]（连字符永久禁用；脏会话 id 已被归一）", async () => {
    const { frames } = await runContract();
    for (const f of frames) {
      const p = f.payload.properties;
      const idKeys = ["sessionID", "id", "messageID", "partID", "runID"];
      for (const k of idKeys) {
        const v = p[k];
        if (typeof v === "string") expect(v, `properties.${k}`).toMatch(LOOM_ID_RE);
      }
      const part = p["part"];
      if (typeof part === "object" && part !== null && "id" in part) {
        expect(String((part as { id: unknown }).id)).toMatch(LOOM_ID_RE);
      }
      const children = p["children"];
      if (Array.isArray(children)) {
        for (const c of children) expect(String((c as { id: unknown }).id)).toMatch(LOOM_ID_RE);
      }
      const info = p["info"];
      if (typeof info === "object" && info !== null && "id" in info) {
        expect(String((info as { id: unknown }).id)).toMatch(LOOM_ID_RE);
      }
    }
    // 归一确实发生（源 id 含连字符 → 外发为下划线形）
    expect(frames[0]!.payload.properties.sessionID).toBe(CLEAN_ID);
  });

  it("R12 SSE 帧文本绝无 event: 行（缺省 message 事件，前端 onmessage 才可收）", async () => {
    const { raw, frames } = await runContract();
    expect(raw).not.toMatch(SSE_EVENT_LINE_RE);
    for (const chunk of raw.split("\n\n")) {
      const trimmed = chunk.trim();
      if (trimmed === "" || trimmed.startsWith(":")) continue;
      expect(trimmed.startsWith("data:"), `非 data: 帧: ${trimmed.slice(0, 40)}`).toBe(true);
    }
    expect(frames.length).toBeGreaterThan(0);
  });

  it("R13 seq 订阅者流内从 0 连续 +1 单调", async () => {
    const { frames } = await runContract();
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
  });
});
