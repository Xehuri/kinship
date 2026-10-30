/**
 * W32 消息身份验收 —— msg_/part_ id 的会话级单调纪律（生产覆盖事故的锁定测试）。
 *
 * 前端（mybot-web useStreamingMessage/partHandlers，不可改）按 (messageID, part.id)
 * 键控气泡与 part 并**原位替换**；id 跨消息复用 = 新一轮思考/正文覆盖旧轮气泡。
 * 本文件在真 pump 路径（AgentSession + EventHub + 假模型）上钉死：
 *   1. 逐 assistant LLM call 唯一 msg_ 序号（live message_start tick，非 run-local
 *      turnIdx 对齐）；
 *   2. 连续两个受理回合的 messageID 集合不相交（跨回合不复用）；
 *   3. 回合内多 call（工具分隔）：各 call 独立 id、call 的 delta/工具 part/终态
 *      快照同坐标系、每个带思考的消息都先到注册帧再到增量帧（前端丢未知 part 增量）；
 *   4. WeakMap 记忆化不变量：双订阅者对同一事件流收到逐字节相同的 payload。
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, Type } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse, type FakeModel } from "@axeuh/loom-core/testing";
import { EventHub, type LoomFrame } from "./index.js";

// ────────────── 夹具（形状抄 sse.test.ts / reasoning-stream.test.ts） ──────────────

function fakeSubscriber(): { res: ServerResponse; frames: () => LoomFrame[] } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: string[] = [];
  res.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof res.write;
  return {
    res,
    frames: () => {
      const out: LoomFrame[] = [];
      for (const piece of chunks.join("").split("\n\n")) {
        const trimmed = piece.trim();
        if (trimmed === "" || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        out.push(JSON.parse(trimmed.slice("data:".length)) as LoomFrame);
      }
      return out;
    },
  };
}

/** echo 工具：结果文本回灌（toolCall 消费面），与内核 tool-executor 真实时序同构。 */
const echoTool = {
  name: "echo",
  description: "回显参数（W32 身份测试用）",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args: { msg: string }): Promise<{ content: [{ type: "text"; text: string }] }> {
    return { content: [{ type: "text", text: `echoed: ${args.msg}` }] };
  },
};

const models: FakeModel[] = [];
afterEach(() => {
  for (const m of models.splice(0)) m.teardown();
});

function makeSession(script: FakeAssistantResponse[], sessionId: string): AgentSession {
  const model = createFakeModel(script);
  models.push(model);
  return new AgentSession({ model, tools: [echoTool], sessionId });
}

/** 跑一轮 runStreaming 并把 recorded 轨逐条灌给 hub（T27 接线姿势）。 */
async function drainRound(session: AgentSession, hub: EventHub, prompt: string): Promise<void> {
  const stream = session.runStreaming(prompt);
  for await (const ev of stream) hub.forwardRecorded(ev);
  await stream.finalSummary;
}

/** 帧 → messageID（仅消息族帧有；其余 undefined）。 */
function messageIdOf(f: LoomFrame): string | undefined {
  const v = f.payload.properties["messageID"];
  return typeof v === "string" ? v : undefined;
}

/** "msg_7" → 7（身份测试只处理本投影器生成的序号形态）。 */
function seqOf(messageID: string): number {
  const n = Number(messageID.slice("msg_".length));
  if (!Number.isInteger(n)) throw new Error(`not a projected messageID: ${messageID}`);
  return n;
}

/** 按 session.idle 切回合（每受理回合恰一条 idle 终帧，registry/kernel 双路径同形）。 */
function splitRounds(frames: readonly LoomFrame[]): LoomFrame[][] {
  const rounds: LoomFrame[][] = [[]];
  for (const f of frames) {
    rounds[rounds.length - 1]!.push(f);
    if (f.payload.type === "session.idle") rounds.push([]);
  }
  return rounds.filter((r) => r.length > 0);
}

// ────────────── (2) 跨受理回合：messageID 集合不相交 ──────────────

describe("W32 消息身份：跨回合不复用", () => {
  it("同一会话连续两个受理回合，各自产出严格递增且不相交的 messageID 集合", async () => {
    const session = makeSession(
      [
        { content: [{ type: "text", text: "第一轮" }], textDeltas: ["第一", "轮"] },
        { content: [{ type: "text", text: "第二轮" }], textDeltas: ["第二", "轮"] },
      ],
      "ses_w32_rounds",
    );
    const hub = new EventHub({ session, heartbeatMs: 0 });
    const sub = fakeSubscriber();
    const unsubscribe = hub.subscribe(sub.res);

    await drainRound(session, hub, "说一句");
    await drainRound(session, hub, "再说一句"); // 旧方案：本轮 turn-start turnIdx=0 把序号拉回 → 覆盖事故
    unsubscribe();
    hub.close();

    const rounds = splitRounds(sub.frames());
    expect(rounds).toHaveLength(2);
    const ids = rounds.map((r) =>
      new Set(r.map(messageIdOf).filter((x): x is string => x !== undefined)),
    );
    expect(ids[0]!.size).toBeGreaterThan(0);
    expect(ids[1]!.size).toBeGreaterThan(0);
    for (const id of ids[1]!) expect(ids[0]!.has(id), `跨回合复用: ${id}`).toBe(false);
    // 严格新：第二回合最小序号 > 第一回合最大序号（单调推进，不是碰巧换名）
    const seq1 = [...ids[0]!].map(seqOf);
    const seq2 = [...ids[1]!].map(seqOf);
    expect(Math.min(...seq2)).toBeGreaterThan(Math.max(...seq1));
  }, 30_000);
});

// ────────────── (1)+(3) 回合内多 call：逐 call 唯一 id + part 同坐标系 + 逐消息注册先行 ──────────────

describe("W32 消息身份：回合内多 LLM call（工具分隔）", () => {
  it("两次 call 各得独立 msg 序号；call1 的思考注册帧先于其增量、call2 同样先注册后增量；工具 part 归属发起消息", async () => {
    const session = makeSession(
      [
        {
          // call1：思考 + 正文 + 工具调用（turnIdx 都是 0——旧方案两条 call 无法区分？不：
          // 旧方案两条 call 同回合共享 turnIdx=0 的 msg_0，正是覆盖事故的形态）
          content: [{ type: "text", text: "派活" }, { type: "toolCall", name: "echo", arguments: { msg: "step1" } }],
          thinkingDeltas: ["甲思"],
          textDeltas: ["派", "活"],
        },
        {
          // call2：工具回灌后的终答（同回合第二个 LLM call，旧方案这里仍是 msg_0）
          content: [{ type: "text", text: "收尾" }],
          thinkingDeltas: ["乙思"],
          textDeltas: ["收", "尾"],
        },
      ],
      "ses_w32_multicall",
    );
    const hub = new EventHub({ session, heartbeatMs: 0 });
    const sub = fakeSubscriber();
    const unsubscribe = hub.subscribe(sub.res);
    await drainRound(session, hub, "先 echo step1 再收尾");
    unsubscribe();
    hub.close();

    const frames = sub.frames();
    const deltas = frames.filter((f) => f.payload.type === "message.part.delta");
    const idsA = new Set(deltas.map(messageIdOf)); // 思考+正文增量分属两次 call
    expect(idsA.size).toBeGreaterThanOrEqual(2);
    const seqs = [...idsA].map((x) => seqOf(x!));
    expect(new Set(seqs).size).toBe(seqs.length); // 逐 call 唯一

    // 逐消息：思考注册帧（part.type=reasoning 无 text）在该 part 首条增量**之前**
    const registers = frames.filter((f) => {
      if (f.payload.type !== "message.part.updated") return false;
      const part = f.payload.properties["part"] as Record<string, unknown>;
      return part["type"] === "reasoning" && part["text"] === undefined;
    });
    expect(registers.length).toBeGreaterThanOrEqual(2); // 每条带思考的消息各注册一次
    for (const reg of registers) {
      const partID = (reg.payload.properties["part"] as Record<string, unknown>)["id"];
      const idxReg = frames.indexOf(reg);
      const firstDeltaIdx = frames.findIndex(
        (f) => f.payload.type === "message.part.delta" && f.payload.properties["partID"] === partID,
      );
      expect(firstDeltaIdx, `注册帧须先于增量（part ${String(partID)}）`).toBeGreaterThan(idxReg);
    }

    // 工具 part 归属发起它的消息（call1），part id 含 call1 序号坐标系
    const toolParts = frames
      .filter((f) => f.payload.type === "message.part.updated")
      .filter((f) => (f.payload.properties["part"] as Record<string, unknown>)["type"] === "tool");
    expect(toolParts.length).toBeGreaterThan(0);
    for (const tp of toolParts) {
      const messageID = messageIdOf(tp)!;
      const part = tp.payload.properties["part"] as Record<string, unknown>;
      expect(String(part["id"]).startsWith(`part_${seqOf(messageID)}_tool_`)).toBe(true);
      expect(part["messageID"]).toBe(messageID); // 自洽：part 内嵌 messageID === 帧 messageID
    }

    // message.updated 的 info.id === messageID（前端按 info.id 归并），两条不撞
    const updated = frames.filter((f) => f.payload.type === "message.updated");
    expect(updated).toHaveLength(2); // 一 call 一条，跨 call 不复用
    expect(new Set(updated.map(messageIdOf)).size).toBe(2);
    for (const u of updated) {
      const info = u.payload.properties["info"] as Record<string, unknown>;
      expect(info["id"]).toBe(messageIdOf(u)!);
    }

    // 同 call 内快照与 live 增量同坐标系：call2 正文终态 part id == 其 delta partID（原位替换不重影）
    const lastMessageID = messageIdOf(updated.at(-1)!)!;
    const lastTextDelta = deltas.filter(
      (f) => messageIdOf(f) === lastMessageID && !String(f.payload.properties["partID"]).includes("_reasoning_"),
    );
    expect(lastTextDelta.length).toBeGreaterThan(0);
    const snapLast = frames
      .filter((f) => f.payload.type === "message.part.updated" && messageIdOf(f) === lastMessageID)
      .find((f) => (f.payload.properties["part"] as Record<string, unknown>)["type"] === "text");
    expect((snapLast!.payload.properties["part"] as Record<string, unknown>)["id"]).toBe(
      lastTextDelta[0]!.payload.properties["partID"],
    );
  }, 30_000);
});

// ────────────── (4) 双订阅者逐字节一致（WeakMap 记忆化不变量） ──────────────

describe("W32 消息身份：多订阅者 id 一致", () => {
  it("两个订阅者对同一事件流收到逐字节相同的 payload 序列（含 id 与 tick 只推进一次）", async () => {
    const session = makeSession(
      [
        { content: [{ type: "text", text: "共享" }], thinkingDeltas: ["同思"], textDeltas: ["共", "享"] },
        { content: [{ type: "text", text: "再来" }], textDeltas: ["再", "来"] },
      ],
      "ses_w32_dual",
    );
    const hub = new EventHub({ session, heartbeatMs: 0 });
    const subA = fakeSubscriber();
    const subB = fakeSubscriber();
    const unA = hub.subscribe(subA.res);
    const unB = hub.subscribe(subB.res);

    await drainRound(session, hub, "第一句");
    await drainRound(session, hub, "第二句"); // 双订阅者 + 跨回合：无记忆化则 A 见 msg_1/2、B 见 msg_3/4
    unA();
    unB();
    hub.close();

    const payloadA = subA.frames().map((f) => JSON.stringify(f.payload));
    const payloadB = subB.frames().map((f) => JSON.stringify(f.payload));
    expect(payloadA.length).toBeGreaterThan(0);
    expect(payloadB).toEqual(payloadA);
    // seq 每订阅者流内从 0 连续（形状不变量，顺带钉）
    expect(subA.frames().map((f) => f.seq)).toEqual(subA.frames().map((_, i) => i));
  }, 30_000);
});
