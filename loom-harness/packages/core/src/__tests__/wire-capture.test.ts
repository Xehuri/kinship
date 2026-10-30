/**
 * W17-A 发线面捕获内核测试 —— AgentSession 的内存态真·wire 请求捕获。
 *
 * 钉死两路捕获通道：
 *   A1 装配口快照（lastWireRequest）：所有变换（pipe systemPrompt / pipe messages /
 *      pipe tools / strip harness-only 字段 / resolveLlmOptions 摊平）之后、
 *      stream() 调用之前逐字节捕获（canonical 键字典序序列化，捕获时刻同步完成，
 *      防 pi-ai provider 事后改对象）。
 *   A2 provider 载荷口（lastProviderPayload）：stream options 的 onPayload 闭包捕获
 *      provider 发送前的最终 payload；fake 通道不经 pi-ai provider → 不触发 →
 *      如实缺席（null），这是给 server W17-B 的 providerPayloadAbsentReason 契约面。
 *
 * 纯只读捕获纪律（W15-B）：绝不改 context / options / onPayload 返回值语义，
 * 前缀字节不许漂移 —— boot-assembly.test.ts / context-full.test.ts 是外部哨兵。
 */

import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import { canonicalJson } from "../wire-capture.js";
import { Type } from "../index.js";
import type { HarnessTool, Hook, Message } from "../index.js";

/* ────────────── 公共测试材料 ────────────── */

function quietSink(): void {
  /* 吞掉默认 console 输出，保持测试输出干净 */
}

const wireEchoTool: HarnessTool = {
  name: "wire-echo",
  description: "回声工具（测试用）",
  parameters: Type.Object({ msg: Type.String({ description: "要回显的文本" }) }),
  async execute(args) {
    return {
      content: [{ type: "text", text: `echo:${String(args["msg"] ?? "")}` }],
    };
  },
};

const textTurn = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const toolTurn = (msg: string) => ({
  content: [{ type: "toolCall" as const, name: "wire-echo", arguments: { msg } }],
});

function messageTextOf(messages: ReadonlyArray<Message>): string {
  return messages
    .map((m) => {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((b) =>
            typeof b === "object" && b !== null && "text" in b
              ? String((b as { text: unknown }).text)
              : "",
          )
          .join("");
      }
      return "";
    })
    .join("\n");
}

/* ────────────── A2 正门测试 provider ────────────── */

interface PayloadEmitterHandle {
  readonly model: Model<Api>;
  /** 记录 provider 侧收到的每次 onPayload 调用返回值（undefined = 未替换载荷）。 */
  onPayloadReturns(): readonly unknown[];
  teardown(): void;
}

let emitterSeq = 0;

/**
 * 最小"真 provider"测试替身：忠实复刻 pi-ai 真实 provider 的发线口
 * （openai-completions.js:78 / anthropic.js:325：SDK 发送前逐 attempt 调
 * `options?.onPayload?.(params, model)`，收非 undefined 返回就替换载荷）。
 * createFakeModel 的通道不读 options，无法验证 A2 正捕获，故需要本替身。
 */
function createPayloadEmitterModel(payloads: readonly unknown[]): PayloadEmitterHandle {
  const id = ++emitterSeq;
  const api = `harness-pi-wireemit-${id}` as Api;
  const sourceId = `@axeuh/loom-core:wire-capture.test#${id}`;
  const returns: unknown[] = [];

  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "emitted" }],
    api,
    provider: `wireemit-${id}`,
    model: `wireemit-model-${id}`,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  registerApiProvider(
    {
      api,
      stream: (
        model: Model<Api>,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        // 发线口逐 attempt 调 onPayload（与真实 provider 同位）。
        for (const payload of payloads) {
          returns.push(options?.onPayload?.(payload, model));
        }
        const s = createAssistantMessageEventStream();
        s.push({ type: "done", reason: "stop", message: assistant });
        s.end();
        return s;
      },
      streamSimple: (): AssistantMessageEventStream => {
        throw new Error("wireemit 测试 provider：streamSimple 未实现");
      },
    },
    sourceId,
  );

  const model: Model<Api> = {
    id: `wireemit-model-${id}`,
    name: `WireEmit Model #${id} (testing)`,
    api,
    provider: `wireemit-${id}`,
    baseUrl: "https://emit.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };

  return {
    model,
    onPayloadReturns: () => returns,
    teardown: () => unregisterApiProviders(sourceId),
  };
}

/* ────────────── canonicalJson 序列化纪律 ────────────── */

describe("canonicalJson（发线面捕获的序列化口）", () => {
  it("键字典序逐层排序；数组顺序保持；undefined 字段省略", () => {
    const s = canonicalJson({
      zeta: 1,
      alpha: { y: 2, b: [3, { q: 4, a: 5 }] },
      mid: undefined,
    });
    // 对象键按字典序：alpha 在 zeta 前；嵌套对象里 a 在 q 前；数组顺序原样保留。
    expect(s).toBe('{"alpha":{"b":[3,{"a":5,"q":4}],"y":2},"zeta":1}');
  });

  it("序列化定点：对已 canonical 的文本 parse 后再序列化逐字节不动", () => {
    const once = canonicalJson([
      { role: "user", content: "hi", timestamp: 1 },
      { b: [1, 2, { z: null, a: true }], role: "assistant" },
    ]);
    const twice = canonicalJson(JSON.parse(once) as unknown);
    expect(twice).toBe(once);
  });
});

/* ────────────── A1 装配口快照 ────────────── */

describe("A1 lastWireRequest —— 装配口 post-pipe 逐字节捕获", () => {
  it("首轮 LLM call 之前 getter 全 null", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({
      model: fake,
      tools: [wireEchoTool],
      consoleSink: quietSink,
    });
    expect(session.lastWireRequest).toBeNull();
    expect(session.lastProviderPayload).toBeNull();
    expect(session.providerPayloadCapturedAt).toBeNull();
    fake.teardown();
  });

  it("systemPrompt 是 pipe 后真值：含 hook 追加标记，session.systemPrompt 本体不动", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const pipeHook: Hook = {
      name: "wire-sys-pipe",
      transformSystemPromptBeforeLlm: (s) => `${s}\n[SYS-PIPE-MARK]`,
    };
    const session = new AgentSession({
      model: fake,
      tools: [],
      systemPrompt: "base-prompt",
      hooks: [pipeHook],
      consoleSink: quietSink,
    });
    await session.run("go");

    const snap = session.lastWireRequest;
    expect(snap).not.toBeNull();
    // 捕获点在 firePipeSystemPrompt 之后 → 拿到含标记（及 skills catalog 类追加）的真值。
    expect(snap!.systemPrompt).toBe("base-prompt\n[SYS-PIPE-MARK]");
    // 只读捕获：session.systemPrompt 字段本身不变。
    expect(session.systemPrompt).toBe("base-prompt");
    fake.teardown();
  });

  it("messagesText 含 transient 附件内容而 session.messages 不含；wire 口已剥 _meta；与 provider 收到的消息序列化逐字节相等", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const attachHook: Hook = {
      name: "wire-transient-attach",
      onTurnStart: () => ({ additionalContext: "TRANSIENT-WIRE-MARK" }),
    };
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [attachHook],
      consoleSink: quietSink,
    });
    const t0 = Date.now();
    await session.run("go");
    const t1 = Date.now();

    const snap = session.lastWireRequest;
    expect(snap).not.toBeNull();
    // 捕获点在 _pendingAttachments 清空之前 → 附件内容进 messagesText。
    expect(snap!.messagesText).toContain("TRANSIENT-WIRE-MARK");
    // 捕获点是 stripHarnessOnlyFields 之后 → wire 真值不含 harness-only 字段。
    expect(snap!.messagesText).not.toContain("hook_additional_context");
    expect(snap!.messagesText).not.toContain("_meta");
    // durable 转录里没有 transient 附件（W12 语义）。
    expect(messageTextOf(session.messages)).not.toContain("TRANSIENT-WIRE-MARK");
    // 逐字节真值：与 provider（fake 通道）实际收到的 context.messages 的 canonical 序列化相等。
    const received = fake.getCalls()[0]?.messages;
    expect(received).toBeDefined();
    expect(snap!.messagesText).toBe(canonicalJson(received));
    // capturedAt 落在 run 窗口内、turnIdx 为捕获时刻的当前轮次。
    expect(snap!.capturedAt).toBeGreaterThanOrEqual(t0);
    expect(snap!.capturedAt).toBeLessThanOrEqual(t1);
    expect(snap!.turnIdx).toBe(0);
    // model 三元组如实（绝不含任何 api key 字段——Model 上本就没有 key）。
    expect(snap!.model.id).toBe(fake.id);
    expect(snap!.model.api).toBe(fake.api);
    expect(snap!.model.baseUrl).toBe("https://fake.local");
    fake.teardown();
  });

  it("tools 逐项捕获 name/description/schemaText（键字典序 canonical JSON）", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({
      model: fake,
      tools: [wireEchoTool],
      consoleSink: quietSink,
    });
    await session.run("go");

    const snap = session.lastWireRequest;
    const tool = snap?.tools[0];
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("wire-echo");
    expect(tool!.description).toBe("回声工具（测试用）");
    // schemaText 是 parameters 的 canonical JSON：顶层键按字典序（properties < required < type）。
    expect(tool!.schemaText).toBe(canonicalJson(wireEchoTool.parameters));
    // 顶层键序钉死（嵌套 msg 的 "type":"string" 在 properties 体内，不干扰首尾断言）。
    expect(tool!.schemaText.startsWith('{"properties":')).toBe(true);
    expect(tool!.schemaText.endsWith(',"type":"object"}')).toBe(true);
    fake.teardown();
  });

  it("optionsText = resolveLlmOptions 原始摊平（含 apiKey 明文、无 signal；脱敏归 server W17-B）", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmOptions: { apiKey: "sk-wire-secret", temperature: 0.25 },
      consoleSink: quietSink,
    });
    await session.run("go");

    const snap = session.lastWireRequest;
    expect(snap).not.toBeNull();
    const parsed = JSON.parse(snap!.optionsText) as Record<string, unknown>;
    expect(parsed["temperature"]).toBe(0.25);
    // 原始捕获：apiKey 明文在场（server 侧 v2 出口负责脱敏，见字段注释）。
    expect(parsed["apiKey"]).toBe("sk-wire-secret");
    // signal 是 kernel 注入的调用现场值，不在装配口 options 摊平里。
    expect("signal" in parsed).toBe(false);
    fake.teardown();
  });

  it("单槽覆盖：两轮 turn 后只剩末次快照，turnIdx 如实推进", async () => {
    const fake = createFakeModel([toolTurn("MARK-T0"), textTurn("done")]);
    const session = new AgentSession({
      model: fake,
      tools: [wireEchoTool],
      consoleSink: quietSink,
    });
    await session.run("go");

    const snap = session.lastWireRequest;
    expect(snap).not.toBeNull();
    expect(snap!.turnIdx).toBe(1);
    // 末次快照的 wire messages 里含首轮 assistant 文本（转录已推进）。
    expect(snap!.messagesText).toContain("MARK-T0");
    // 单槽：getters 只暴露最后一份，无历史数组。
    expect(snap!.capturedAt).toBeGreaterThanOrEqual(0);
    fake.teardown();
  });
});

/* ────────────── A2 onPayload 捕获 ────────────── */

describe("A2 lastProviderPayload —— provider 发线口捕获", () => {
  it("fake 通道（不经 pi-ai provider）如实缺席：payload 与时间戳都 null", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      consoleSink: quietSink,
    });
    await session.run("go");

    // A1 在场而 A2 缺席 —— server W17-B 据此填 providerPayloadAbsentReason。
    expect(session.lastWireRequest).not.toBeNull();
    expect(session.lastProviderPayload).toBeNull();
    expect(session.providerPayloadCapturedAt).toBeNull();
    fake.teardown();
  });

  it("真 provider 口逐 attempt last-write：canonical JSON 捕获、闭包返回 undefined（零替换）", async () => {
    const p1 = { model: "m", zeta: 1, alpha: { y: 2, x: [1, { b: 3, a: 4 }] } };
    const p2 = { seq: 2, attempt: "retry-1" };
    const emitter = createPayloadEmitterModel([p1, p2]);
    const session = new AgentSession({
      model: emitter.model,
      tools: [],
      systemPrompt: "emit-sys",
      consoleSink: quietSink,
    });
    const t0 = Date.now();
    await session.run("go");

    // pi-ai 契约：onPayload 返回非 undefined 会**替换**出向载荷。捕获闭包必须逐次返回
    // undefined —— provider 侧记录的返回值全 undefined，且最终发线载荷未被替换。
    const rets = emitter.onPayloadReturns();
    expect(rets.length).toBe(2);
    for (const r of rets) expect(r).toBeUndefined();

    // last-write-wins：只留末次 attempt 的载荷。
    expect(session.lastProviderPayload).toBe(canonicalJson(p2));
    expect(session.lastProviderPayload).not.toContain("zeta");
    const at = session.providerPayloadCapturedAt;
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(t0);
    emitter.teardown();
  });
});

/* ────────────── W17-B transientCount 尾标 + model.provider ────────────── */

describe("W17-B transientCount —— 瞬态附件尾标（B 侧 transient:true 映射的数据源）", () => {
  it("无附件轮：transientCount=0；messagesText 里条数与计数无关照常全量", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      consoleSink: quietSink,
    });
    await session.run("go");

    const snap = session.lastWireRequest;
    expect(snap).not.toBeNull();
    expect(snap!.transientCount).toBe(0);
    // 转录面照常（user + assistant 之外的请求面消息 = 本轮注入前的 durable + 用户消息）。
    expect(snap!.messagesText).toContain("go");
    fake.teardown();
  });

  it("单附件轮：transientCount=1（清空前取数，附件此刻在 messagesText 尾部）", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const attachHook: Hook = {
      name: "w17b-transient-1",
      onTurnStart: () => ({ additionalContext: "W17B-TAIL-MARK" }),
    };
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [attachHook],
      consoleSink: quietSink,
    });
    await session.run("go");

    const snap = session.lastWireRequest;
    expect(snap!.transientCount).toBe(1);
    // 尾段性核对：messagesText 解析后末条即附件（投影数组的连续尾段申明）。
    const arr = JSON.parse(snap!.messagesText) as ReadonlyArray<Record<string, unknown>>;
    expect(arr.length).toBeGreaterThan(0);
    expect(JSON.stringify(arr[arr.length - 1])).toContain("W17B-TAIL-MARK");
    // durable 转录不含附件（W12 语义 —— B 侧只能靠本计数标尾，不能靠转录比对）。
    expect(messageTextOf(session.messages)).not.toContain("W17B-TAIL-MARK");
    fake.teardown();
  });

  it("单槽覆盖：末次调用无新附件时 transientCount 如实归零（turn1 快照）", async () => {
    const fake = createFakeModel([toolTurn("MARK-T0"), textTurn("done")]);
    const hookA: Hook = {
      name: "w17b-transient-a",
      // 仅首轮注一条（ctx.turnIdx 判别），第二轮不注 → 末次快照 transientCount=0 如实。
      onTurnStart: (_input, ctx) =>
        ctx.turnIdx === 0 ? { additionalContext: "ATTACH-A" } : undefined,
    };
    const session = new AgentSession({
      model: fake,
      tools: [wireEchoTool],
      hooks: [hookA],
      consoleSink: quietSink,
    });
    await session.run("go");

    // run 后单槽 = 末次（turn1）快照：本轮无新附件。
    const snap = session.lastWireRequest;
    expect(snap!.turnIdx).toBe(1);
    expect(snap!.transientCount).toBe(0);
    // Then：首轮附件不进 turn1 请求面（附件只随注入它的当轮随发，W12 语义）。
    expect(snap!.messagesText).not.toContain("ATTACH-A");
    fake.teardown();
  });

  it("model.provider 如实带出 pi-ai Model.provider 逻辑名（fake 通道 = fake-<id> 串）", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({ model: fake, tools: [], consoleSink: quietSink });
    await session.run("go");

    const snap = session.lastWireRequest;
    expect(typeof snap!.model.provider).toBe("string");
    expect(snap!.model.provider.length).toBeGreaterThan(0);
    // 四元组无 key 字段（Model 上本无 apiKey；脱敏面在 server W17-B 出口）。
    expect(Object.keys(snap!.model).sort()).toEqual(["api", "baseUrl", "id", "provider"]);
    fake.teardown();
  });
});

/* ────────────── W23-A onWireSnapshot 持久回调 ────────────── */

describe("W23-A onWireSnapshot —— 每 LLM call 解析完成后恰好一次", () => {
  it("fake 通道：每 call 一回调，payload 恒 null（诚实缺席），snapshot = 当次 A1 槽", async () => {
    const fake = createFakeModel([toolTurn("T0"), textTurn("done")]);
    const seen: Array<{ turnIdx: number; payload: string | null }> = [];
    const session = new AgentSession({
      model: fake,
      tools: [wireEchoTool],
      consoleSink: quietSink,
      onWireSnapshot: (snapshot, providerPayload) => {
        seen.push({ turnIdx: snapshot.turnIdx, payload: providerPayload });
      },
    });
    await session.run("go");
    // 两轮 LLM call（toolUse → 续）→ 恰两次回调，turnIdx 递增；fake 无 provider 载荷。
    expect(seen.map((s) => s.turnIdx)).toEqual([0, 1]);
    expect(seen.every((s) => s.payload === null)).toBe(true);
    // 回调时刻 A1 槽已设：末次回调的 snapshot 与 getter 同槽（capturedAt 一致）。
    expect(session.lastWireRequest).not.toBeNull();
    fake.teardown();
  });

  it("真 provider 替身通道：回调时刻 A2 载荷已落位（last-write 文本在场）", async () => {
    const emitter = createPayloadEmitterModel([{ messages: ["emit-a"], seed: 1 }]);
    const seen: Array<string | null> = [];
    const session = new AgentSession({
      model: emitter.model,
      tools: [],
      consoleSink: quietSink,
      onWireSnapshot: (_snapshot, providerPayload) => {
        seen.push(providerPayload);
      },
    });
    await session.run("go");
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("emit-a");
    emitter.teardown();
  });

  it("回调抛错 fail-soft：吞断不反噬回合（run 照常 done，槽位不损）", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    let fired = 0;
    const session = new AgentSession({
      model: fake,
      tools: [],
      consoleSink: quietSink,
      onWireSnapshot: () => {
        fired += 1;
        throw new Error("wire-cache 写盘炸了（测试注入）");
      },
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
    expect(fired).toBe(1);
    expect(session.lastWireRequest).not.toBeNull();
    fake.teardown();
  });

  it("未注入回调 = 键缺席旧行为（构造零扰动，前一轮测试已证 getter 面不变）", async () => {
    const fake = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({ model: fake, tools: [], consoleSink: quietSink });
    await session.run("go");
    expect(session.lastWireRequest).not.toBeNull();
    fake.teardown();
  });
});
