/**
 * W13 思考流（reasoning）帧单测——逐条钉死前端契约与文档形状。
 *
 * 覆盖：
 *   - 首块注册帧恰好一条（part.updated `{id, sessionID, messageID, type:'reasoning'}`，
 *     形状逐字对齐 mybot-web/docs/EVENT_API_DOC.md §3 reasoning 样例：不带 text）；
 *   - 增量帧 part.delta（field='text' + partID + messageID + delta），首块与后续块
 *     的 part id 稳定（`part_${messageSeq}_reasoning_${contentIndex}`）；
 *   - 增量归序：拼接后的思考文本与事件序一致；
 *   - 终态快照（llm-end 的 thinking 块）与 delta 同 part id、全文可回看；
 *   - llm-end 后注册表清空：同 id 复用的下一回合首块重发注册帧；
 *   - WeakMap 记忆化：同一事件对象多订阅者投影出同一份草案；
 *   - 端到端（真内核 + EventHub pump）：假模型 thinkingDeltas → SSE 帧流可见注册/增量/快照。
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, type AssistantMessage } from "@axeuh/loom-core";
import { createFakeModel, type FakeModel } from "@axeuh/loom-core/testing";

import {
  EventHub,
  LOOM_ID_RE,
  newProjectionState,
  projectEnvelope,
  projectReasoningStream,
  type FrameDraft,
  type LoomFrame,
} from "./index.js";

function assistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "fake",
    provider: "fake-x",
    model: "fake-model-1",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

function thinkingDelta(contentIndex: number, delta: string): { type: "thinking_delta"; contentIndex: number; delta: string } {
  return { type: "thinking_delta", contentIndex, delta };
}

/** 通过 projectEnvelope（生产入口）收集草案。 */
function viaEnvelope(
  state: ReturnType<typeof newProjectionState>,
  events: Array<ReturnType<typeof thinkingDelta> | { type: "llm-end"; msg: AssistantMessage; durationMs: number }>,
  sessionId = "ses_reason_01",
): FrameDraft[] {
  const out: FrameDraft[] = [];
  let seq = 0;
  for (const event of events) {
    const env = { sessionId, track: "live", seq: seq++, event } as never;
    out.push(...projectEnvelope(state, env));
  }
  return out;
}

const partOf = (d: FrameDraft): Record<string, unknown> => d.properties["part"] as Record<string, unknown>;

describe("W13 reasoning 流：注册 + 增量 + 终态快照", () => {
  it("首块先注册后增量：注册帧一条（文档形状无 text），增量帧 field=text 且 part id 稳定", () => {
    const state = newProjectionState();
    const list = viaEnvelope(state, [
      thinkingDelta(0, "先想"),
      thinkingDelta(0, "再想"),
      thinkingDelta(0, "后想"),
    ]);
    expect(list).toHaveLength(4); // 1 注册 + 3 增量
    const register = list[0]!;
    expect(register.type).toBe("message.part.updated");
    const part = partOf(register);
    // 文档样例键集 {id, sessionID, messageID, type}（不带 text）
    expect(Object.keys(part).sort()).toEqual(["id", "messageID", "sessionID", "type"]);
    expect(part["type"]).toBe("reasoning");
    expect(part["id"]).toBe("part_0_reasoning_0");
    expect(part["messageID"]).toBe("msg_0");
    expect(LOOM_ID_RE.test(String(part["id"]))).toBe(true);

    const deltas = list.slice(1);
    for (const d of deltas) {
      expect(d.type).toBe("message.part.delta");
      expect(d.properties["field"]).toBe("text");
      expect(d.properties["partID"]).toBe("part_0_reasoning_0");
      expect(d.properties["messageID"]).toBe("msg_0");
    }
    // 增量归序：delta 文本按事件序
    expect(deltas.map((d) => d.properties["delta"])).toEqual(["先想", "再想", "后想"]);
    // 增量帧会话 id 归一（脏连字符 → 下划线）
    const dirty = viaEnvelope(newProjectionState(), [thinkingDelta(0, "x")], "dashy-sess-id");
    expect(dirty[1]!.sessionID).toBe("dashy_sess_id");
    expect(dirty[1]!.properties["sessionID"]).toBe("dashy_sess_id");
  });

  it("多块 thinking 按 contentIndex 各注册一次、id 互不相同（归位不乱序）", () => {
    const state = newProjectionState();
    const list = viaEnvelope(state, [
      thinkingDelta(0, "A"),
      thinkingDelta(1, "B"),
      thinkingDelta(0, "C"),
      thinkingDelta(1, "D"),
    ]);
    const registers = list.filter((d) => d.type === "message.part.updated");
    expect(registers.map((d) => partOf(d)["id"])).toEqual(["part_0_reasoning_0", "part_0_reasoning_1"]);
    const deltas = list.filter((d) => d.type === "message.part.delta");
    expect(deltas.map((d) => `${String(d.properties["partID"])}=${String(d.properties["delta"])}`)).toEqual([
      "part_0_reasoning_0=A",
      "part_0_reasoning_1=B",
      "part_0_reasoning_0=C",
      "part_0_reasoning_1=D",
    ]);
  });

  it("llm-end 的 thinking 块出全量快照：与 delta 同 part id、text 为全文；随后注册表清空可再注册", () => {
    const state = newProjectionState();
    const msg = assistant({
      content: [
        { type: "thinking", thinking: "全文思考" },
        { type: "text", text: "答案" },
      ],
    });
    const list = viaEnvelope(state, [thinkingDelta(0, "全文"), thinkingDelta(0, "思考"), { type: "llm-end", msg, durationMs: 1 }]);
    const snapshot = list.filter((d) => d.type === "message.part.updated" && partOf(d)["type"] === "reasoning").at(-1)!;
    const part = partOf(snapshot);
    expect(part["id"]).toBe("part_0_reasoning_0"); // 与 delta 注册同坐标系
    expect(part["type"]).toBe("reasoning");
    expect(part["text"]).toBe("全文思考");
    // 清空后同 id 首块重发注册帧。注意：本直投测试不喂 message_start，序号恒 0 才构成
    // "同 id 复用"场景；生产路径（见下方端到端与 message-identity 测试）中 W32 单调
    // 序号让新消息的 part id 天然全新，重注册由新 id 自动成立。
    const next = viaEnvelope(state, [thinkingDelta(0, "新一轮")]);
    expect(next).toHaveLength(2);
    expect(next[0]!.type).toBe("message.part.updated");
    expect(partOf(next[0]!)["id"]).toBe("part_0_reasoning_0");
    expect(next[1]!.properties["delta"]).toBe("新一轮");
  });

  it("part id 随 messageSeq（W32 会话级单调）递增，跨消息不复用", () => {
    const state = newProjectionState();
    expect(projectReasoningStream(state, "ses_t", thinkingDelta(0, "a"))[0]!.properties["part"]).toMatchObject({
      id: "part_0_reasoning_0",
    });
    // 模拟 message_start tick 后的推进（生产 tick 见 project.ts；端到端钉在下方与 message-identity）
    state.messageSeq = 1;
    const frames = projectReasoningStream(state, "ses_t", thinkingDelta(0, "b"));
    expect(partOf(frames[0]!)[ "id"]).toBe("part_1_reasoning_0");
  });

  it("同一事件对象多订阅者投影：WeakMap 记忆化返回同一份草案（id/序号不二次推进）", () => {
    const state = newProjectionState();
    const event = thinkingDelta(0, "共享");
    const env = { sessionId: "ses_memo", track: "live", seq: 0, event } as never;
    const a = projectEnvelope(state, env);
    const b = projectEnvelope(state, env);
    expect(b).toBe(a);
    expect(a).toHaveLength(2);
    // 二次投影不重复注册
    expect(a.filter((d) => d.type === "message.part.updated")).toHaveLength(1);
  });
});

// ───────────────────── 端到端：真内核 live 轨 → EventHub pump → SSE 帧 ─────────────────────

function fakeSubscriber(): { res: ServerResponse; text: () => string } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: string[] = [];
  res.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof res.write;
  return { res, text: () => chunks.join("") };
}

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

const madeModels: FakeModel[] = [];
afterEach(() => {
  for (const m of madeModels.splice(0)) m.teardown();
});

describe("W13 reasoning 流端到端：假模型 thinkingDeltas → SSE", () => {
  it("live 轨流出注册帧 + 递增增量帧，llm-end 快照带全文（真实 pump 路径）", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "答案" }],
        thinkingDeltas: ["反复", "推演"],
        textDeltas: ["答", "案"],
        stopReason: "stop",
      },
    ]);
    madeModels.push(fake);
    const session = new AgentSession({ model: fake, tools: [], sessionId: "ses_reason_live" });
    const hub = new EventHub({ session, heartbeatMs: 0 });
    const sub = fakeSubscriber();
    const unsubscribe = hub.subscribe(sub.res);

    const stream = session.runStreaming("go");
    for await (const ev of stream) hub.forwardRecorded(ev);
    unsubscribe();
    hub.close();

    const frames = parseFrames(sub.text());
    const registers = frames.filter(
      (f) =>
        f.payload.type === "message.part.updated" &&
        (f.payload.properties["part"] as Record<string, unknown>)["type"] === "reasoning" &&
        (f.payload.properties["part"] as Record<string, unknown>)["text"] === undefined,
    );
    expect(registers).toHaveLength(1);
    const registerProps = registers[0]!.payload.properties;
    // W32：真 pump 路径下 live message_start 先于思考增量到达 → 首条消息序号为 msg_1
    expect(registerProps["messageID"]).toBe("msg_1");
    const partID = (registerProps["part"] as Record<string, unknown>)["id"];
    expect(partID).toBe("part_1_reasoning_0");

    const deltas = frames.filter((f) => f.payload.type === "message.part.delta" && f.payload.properties["partID"] === partID);
    expect(deltas.map((f) => f.payload.properties["delta"])).toEqual(["反复", "推演"]);
    expect(deltas.every((f) => f.payload.properties["field"] === "text")).toBe(true);
    // 正文通道不受影响
    const textDeltas = frames.filter((f) => f.payload.type === "message.part.delta" && f.payload.properties["partID"] !== partID);
    expect(textDeltas.map((f) => f.payload.properties["delta"])).toEqual(["答", "案"]);
  }, 30_000);
});
