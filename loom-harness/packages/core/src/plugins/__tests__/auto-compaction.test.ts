import { describe, it, expect } from "vitest";
import {
  AgentSession,
  createUserMessage,
  ACTIVE_BOUNDARY_KEY,
  MemorySessionStore,
} from "../../index.js";
import type { ActiveBoundary, HarnessTool, Hook } from "../../index.js";
import { createTestContext, createFakeModel } from "../../testing.js";
import type { Message, Tool } from "@earendil-works/pi-ai";
import {
  alignCoverBoundary,
  autoCompaction,
  chooseTailStart,
  estimateTailMessage,
  estimateTokensByChars,
  estimateRequestTokens,
  hybridTokenCounter,
} from "../auto-compaction.js";
import type { RequestTokenInput } from "../auto-compaction.js";

function textOf(m: Message): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b ? b.text : "")).join("");
}
const m = (t: string): Message => createUserMessage(t);
const grow = (n: number) => Array.from({ length: n }, (_, i) => m(String(i + 1)));

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake" as never,
  provider: "fake",
  model: "fake-model",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: 0,
});
const assistantToolCalls = (calls: ReadonlyArray<{ id: string; name: string }>): Message => ({
  role: "assistant",
  content: calls.map(({ id, name }) => ({ type: "toolCall" as const, id, name, arguments: {} })),
  api: "fake" as never,
  provider: "fake",
  model: "fake-model",
  usage: zeroUsage,
  stopReason: "toolUse",
  timestamp: 0,
});
const toolResultMsg = (toolCallId: string, toolName: string, text: string): Message => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});

describe("alignCoverBoundary", () => {
  it("returns a user or assistant boundary unchanged", () => {
    const messages = [m("u0"), assistantText("a1"), m("u2")];
    expect(alignCoverBoundary(messages, 0)).toBe(0);
    expect(alignCoverBoundary(messages, 1)).toBe(1);
    expect(alignCoverBoundary(messages, 2)).toBe(2);
  });

  it("snaps a toolResult boundary back to the nearest preceding user", () => {
    const messages = [
      m("u0"),
      assistantText("a1"),
      m("u2"),
      assistantToolCalls([{ id: "tc1", name: "echo" }]),
      toolResultMsg("tc1", "echo", "r1"),
    ];
    expect(alignCoverBoundary(messages, 4, 1)).toBe(2);
  });

  it("falls back to the nearest non-toolResult assistant when no user advances", () => {
    const messages = [
      m("u0"),
      assistantText("a1"),
      assistantToolCalls([{ id: "tc1", name: "echo" }]),
      toolResultMsg("tc1", "echo", "r1"),
    ];
    expect(alignCoverBoundary(messages, 3, 1)).toBe(2);
  });

  it("returns the floor when no safe boundary exists above it", () => {
    const messages = [
      m("u0"),
      toolResultMsg("tc1", "echo", "r1"),
      toolResultMsg("tc2", "echo", "r2"),
    ];
    expect(alignCoverBoundary(messages, 2, 1)).toBe(1);
  });

  it("returns the floor when desiredCover does not advance past it", () => {
    const messages = [m("u0"), assistantText("a1"), m("u2"), assistantText("a3")];
    expect(alignCoverBoundary(messages, 1, 3)).toBe(3);
    expect(alignCoverBoundary(messages, 3, 3)).toBe(3);
  });

  it("clamps a desiredCover beyond the array to the last index", () => {
    const messages = [m("u0"), assistantText("a1")];
    expect(alignCoverBoundary(messages, 99)).toBe(1);
  });
});

describe("autoCompaction", () => {
  it("compacts once estimated tokens exceed the threshold", async () => {
    let early: Message[] | null = null;
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5, // threshold = 50
      keepRecent: 2,
      tokenCounter: { estimate: ({ messages }) => messages.length * 20 }, // 5 msgs => 100 > 50
      summarize: (e) => {
        early = e;
        return `SUM:${e.length}`;
      },
    });
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!(grow(5), ctx);

    expect(view).toBeDefined();
    expect(view!.length).toBe(3); // summary + 2 tail
    expect(early!.length).toBe(3); // 5 - keepRecent(2)
    expect(textOf(view![0]!)).toContain("SUM:3");
    expect(view!.slice(1).map(textOf)).toEqual(["4", "5"]);
  });

  it("ctx.messages 空（退化/单元场景）触发压缩时不写 live boundary（回归 codex P2）", async () => {
    // raw fallback 到 messages 参数时 coveredCount 不基于 durable _messages；若仍写 boundary，
    // 内核下一 turn 会按错坐标 slice _messages、丢真实消息（fresh continue() 只带 transient
    // attachments 的退化场景）。故 ctx.messages 空时本 turn 投影生效但**不持久化 boundary**。
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5,
      keepRecent: 2,
      tokenCounter: { estimate: ({ messages }) => messages.length * 20 }, // 5 msgs => 100 > 50
      summarize: (e) => `SUM:${e.length}`,
    });
    const { ctx } = createTestContext(); // ctx.messages 为空
    const view = await compact.transformMessagesBeforeLlm!(grow(5), ctx);
    expect(view).toBeDefined(); // 本 turn 投影仍生效（view-only one-turn）
    expect(ctx.state.get(ACTIVE_BOUNDARY_KEY)).toBeUndefined(); // 但不写 boundary
  });

  it("does not compact below the token threshold (returns undefined, summarize not called)", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5, // threshold 50
      keepRecent: 2,
      tokenCounter: { estimate: () => 10 }, // < 50
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext();
    expect(await compact.transformMessagesBeforeLlm!(grow(8), ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("default estimator counts message text (chars/4) and triggers on big messages", async () => {
    const big = (n: number) => Array.from({ length: n }, () => m("x".repeat(100)));
    // 5 * 100 chars = 500 chars ~= 125 tokens; threshold = 100 * 0.8 = 80 -> triggers
    const compact = autoCompaction({
      maxContextTokens: 100,
      keepRecent: 2,
      summarize: (e) => `S${e.length}`,
    });
    const { ctx } = createTestContext();
    expect(estimateTokensByChars(big(5))).toBeGreaterThan(80);
    const view = await compact.transformMessagesBeforeLlm!(big(5), ctx);
    expect(view).toBeDefined();
    expect(view!.length).toBe(3);
  });

  it("default estimator counts CJK codepoints as ~1 token each (much higher than chars/4)", () => {
    // 50 个 CJK 字（无 ASCII）：新公式 ≈ 50 token；旧的 chars/4 只会给 ≈ 13，4× 低估（issue #14 的安全 bug）。
    const cjk = "你好世界，这是一段中文。".repeat(5); // 12 字/段 * 5 = 60 码点（含全角逗号/句号）
    const est = estimateTokensByChars([m(cjk)]);
    const charsOver4 = Math.ceil(cjk.length / 4);
    expect(est).toBe(cjk.length); // 每个 CJK 码点 ≈ 1 token
    expect(est).toBeGreaterThan(charsOver4 * 3); // 远高于 chars/4
  });

  it("default estimator counts an image block as a flat conservative estimate (not tiny ref nor huge base64)", () => {
    // 短 ref 风格的 image 块（data 很短）：按字符数会被严重低估；扁平估值兜底 ≈ 1000。
    const imageMsg: Message = {
      role: "user",
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      timestamp: 0,
    };
    const est = estimateTokensByChars([imageMsg]);
    expect(est).toBe(1000); // 扁平、保守

    // 内联 base64（data 极长）：若按 data 字符数会疯狂高估；仍是扁平 1000，不随 data 长度膨胀。
    const inlineMsg: Message = {
      role: "user",
      content: [{ type: "image", data: "A".repeat(50_000), mimeType: "image/png" }],
      timestamp: 0,
    };
    expect(estimateTokensByChars([inlineMsg])).toBe(1000);
  });

  it("counts astral (surrogate-pair) CJK as ~1 token/codepoint, not 2 ASCII chars", () => {
    // 𠀀 = U+20000 (CJK Ext B): .length === 2 (a surrogate pair). Iterating by code POINT must
    // count it as one CJK token; the pre-fix .length/regex path counted it as 2 ASCII → undercount.
    const astral = "\u{20000}".repeat(10);
    expect(astral.length).toBe(20); // 20 UTF-16 code units…
    expect([...astral].length).toBe(10); // …but 10 code points
    expect(estimateTokensByChars([m(astral)])).toBe(10); // 10 CJK code points ≈ 10 tokens
  });

  it("counts CJK + ASCII mixed in one text with consistent code-point units", () => {
    // 你好(2 CJK) + " hello "(7 non-CJK) + 世界(2 CJK) + " world"(6 non-CJK)
    // = 4 CJK + ceil(13/4)=4  → 8
    expect(estimateTokensByChars([m("你好 hello 世界 world")])).toBe(8);
  });

  it("adds an image block and a text block in the same message", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "caption" }, // 7 ASCII → ceil(7/4) = 2
      ],
      timestamp: 0,
    };
    expect(estimateTokensByChars([msg])).toBe(1002); // 1000 (image) + 2 (text)
  });

  it("counts multiple images per-image (not per-message)", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "image", data: "a", mimeType: "image/png" },
        { type: "image", data: "b", mimeType: "image/png" },
        { type: "image", data: "c", mimeType: "image/png" },
      ],
      timestamp: 0,
    };
    expect(estimateTokensByChars([msg])).toBe(3000); // 3 × IMAGE_TOKENS
  });

  it("counts non-text / non-image blocks (e.g. toolCall) via their JSON length", () => {
    const big = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "foo", arguments: { x: "y".repeat(40) } }],
      timestamp: 0,
    } as unknown as Message;
    const small = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "foo", arguments: { x: "y" } }],
      timestamp: 0,
    } as unknown as Message;
    // the block IS counted (not skipped) and scales with its serialized size
    expect(estimateTokensByChars([small])).toBeGreaterThan(0);
    expect(estimateTokensByChars([big])).toBeGreaterThan(estimateTokensByChars([small]));
  });

  it("handles empty / whitespace / empty-content messages deterministically (no throw)", () => {
    expect(estimateTokensByChars([m("")])).toBe(0);
    expect(estimateTokensByChars([m("   ")])).toBe(1); // ceil(3/4)
    const emptyContent: Message = { role: "user", content: [], timestamp: 0 };
    expect(estimateTokensByChars([emptyContent])).toBe(0);
  });

  it("does not compact when messages.length === keepRecent (nothing to compress, no summarize)", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 3,
      tokenCounter: { estimate: () => 999 }, // over threshold → would compact if it could
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext();
    // exactly keepRecent messages: the tail IS everything → nothing to summarize
    expect(await compact.transformMessagesBeforeLlm!(grow(3), ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("caches the summary by covered prefix until it grows by resummarizeEvery", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 2,
      resummarizeEvery: 2,
      tokenCounter: { estimate: () => 999 }, // always over threshold -> always evaluate
      summarize: (e) => {
        calls++;
        return `S${e.length}`;
      },
    });
    const { ctx } = createTestContext();

    const v1 = await compact.transformMessagesBeforeLlm!(grow(5), ctx); // cover 3 -> summarize
    expect(calls).toBe(1);
    expect(textOf(v1![0]!)).toContain("S3");

    await compact.transformMessagesBeforeLlm!(grow(6), ctx); // cover 4, 4-3=1 < 2 -> reuse
    expect(calls).toBe(1);

    const v3 = await compact.transformMessagesBeforeLlm!(grow(7), ctx); // cover 5, 5-3=2 >= 2 -> recompute
    expect(calls).toBe(2);
    expect(textOf(v3![0]!)).toContain("S5");
  });

  it("cache monotonicity: a smaller desired cover keeps the cached boundary and does not resummarize", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 2,
      resummarizeEvery: 1,
      tokenCounter: { estimate: () => 999 },
      summarize: (e) => {
        calls++;
        return `S${e.length}`;
      },
    });
    const { ctx } = createTestContext();

    const v1 = await compact.transformMessagesBeforeLlm!(grow(5), ctx);
    expect(calls).toBe(1);
    expect(textOf(v1![0]!)).toContain("S3");

    // Desired cover 2 is below the cached floor 3: alignCoverBoundary keeps 3, so the
    // zero growth is below resummarizeEvery and no second summarize happens.
    expect(await compact.transformMessagesBeforeLlm!(grow(4), ctx)).toBeUndefined();
    expect(calls).toBe(1);

    const v3 = await compact.transformMessagesBeforeLlm!(grow(6), ctx);
    expect(calls).toBe(2);
    expect(textOf(v3![0]!)).toContain("S4");
  });

  it("rejects invalid options at construction", () => {
    expect(() => autoCompaction({ maxContextTokens: 0, summarize: () => "" })).toThrow(/maxContextTokens/);
    expect(() => autoCompaction({ maxContextTokens: 100, triggerRatio: 0, summarize: () => "" })).toThrow(/triggerRatio/);
    expect(() => autoCompaction({ maxContextTokens: 100, triggerRatio: 1.5, summarize: () => "" })).toThrow(/triggerRatio/);
    expect(() => autoCompaction({ maxContextTokens: 100, keepRecent: 0, summarize: () => "" })).toThrow(/keepRecent/);
    expect(() => autoCompaction({ maxContextTokens: 100, resummarizeEvery: 0, summarize: () => "" })).toThrow(/resummarizeEvery/);
    expect(() => autoCompaction({ maxContextTokens: 100, keepRecentTokens: -1, summarize: () => "" })).toThrow(/keepRecentTokens/);
    expect(() => autoCompaction({ maxContextTokens: 100, keepRecentTokens: Number.NaN, summarize: () => "" })).toThrow(/keepRecentTokens/);
    expect(() => autoCompaction({ maxContextTokens: 100, keepRecentTokens: Number.POSITIVE_INFINITY, summarize: () => "" })).toThrow(/keepRecentTokens/);
    expect(() => autoCompaction({ maxContextTokens: 100, keepRecentTokens: 0, summarize: () => "" })).not.toThrow();
  });

  it("abortOnOverflow: aborts with a compaction: prefix only when enabled", () => {
    const off = autoCompaction({ maxContextTokens: 100, summarize: () => "" });
    const h1 = createTestContext();
    off.onContextOverflow!({ turnIdx: 1, stopReason: "length", messageCount: 50 }, h1.ctx);
    expect(h1.abortReasons).toEqual([]);

    const on = autoCompaction({ maxContextTokens: 100, summarize: () => "", abortOnOverflow: true });
    const h2 = createTestContext();
    on.onContextOverflow!({ turnIdx: 3, stopReason: "error", messageCount: 99 }, h2.ctx);
    expect(h2.abortReasons).toHaveLength(1);
    expect(h2.abortReasons[0]).toMatch(/^compaction:/);
  });

  it("end-to-end: the model sees the token-compacted view while full history persists", async () => {
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          maxContextTokens: 100,
          triggerRatio: 0.8, // threshold 80
          keepRecent: 2,
          tokenCounter: { estimate: ({ messages }) => messages.length * 50 }, // 7 msgs * 50 = 350 > 80
          summarize: () => "RECAP",
        }),
      ],
    });
    await session.run("go"); // view = 6 initial + "go" = 7 -> compact

    const view = fake.getCalls()[0]!.messages;
    expect(view.length).toBe(3); // [summary, "a3", "go"]
    expect(textOf(view[0]!)).toContain("RECAP");
    expect(textOf(view[2]!)).toBe("go");
    expect(session.messages.length).toBe(8); // full history intact (6 + "go" + assistant)
    fake.teardown();
  });

  it("end-to-end: a summarize() failure degrades to NO compaction (kernel pipe fail-open), run still completes", async () => {
    // #13: summarize 抛错 → transform 被内核 fail-open 吞掉 → 模型收到未压缩全量、run 不中断、history 不变。
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          maxContextTokens: 100,
          triggerRatio: 0.8, // threshold 80
          keepRecent: 2,
          tokenCounter: { estimate: ({ messages }) => messages.length * 50 }, // 7 msgs * 50 = 350 > 80 → 会尝试压缩
          summarize: () => {
            throw new Error("summary backend down");
          },
        }),
      ],
    });
    const summary = await session.run("go");

    expect(summary.reason).toBe("done"); // 压缩失败不杀 run（不是 "error"）
    // fail-open：模型收到未压缩全量（6 初始 + "go" = 7），而不是压缩后的视图。
    expect(fake.getCalls()[0]!.messages.length).toBe(7);
    expect(textOf(fake.getCalls()[0]!.messages[6]!)).toBe("go");
    // 完整历史未被破坏：6 初始 + "go" + assistant = 8。
    expect(session.messages.length).toBe(8);
    fake.teardown();
  });

  it("phase A: the projected tail never starts on a toolResult", async () => {
    // raw (9) = 8 initial + "go"; naive targetCover = 9 - keepRecent(4) = 5 lands on
    // raw[5] = toolResult tc2, whose assistant toolCall sits at raw[3] inside the summary prefix.
    // A boundary-unaware projection therefore leaks an orphan toolResult to the provider (400 on
    // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'").
    const initial: Message[] = [
      m("old-1"),
      assistantText("old-a"),
      m("turn-user"),
      assistantToolCalls([
        { id: "tc1", name: "echo" },
        { id: "tc2", name: "echo" },
      ]),
      toolResultMsg("tc1", "echo", "r1"),
      toolResultMsg("tc2", "echo", "r2"),
      m("u2"),
      assistantText("a2"),
    ];
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          maxContextTokens: 1,
          triggerRatio: 1,
          keepRecent: 4,
          tokenCounter: { estimate: () => 999 },
          summarize: () => "RECAP",
        }),
      ],
    });
    await session.run("go");

    const view = fake.getCalls()[0]!.messages;
    expect(view[0]!.role).toBe("user");
    expect(textOf(view[0]!)).toContain("RECAP");
    // Safe boundary snaps back to the user turn that owns the toolCall pair (raw[2]).
    expect(view[1]!.role).toBe("user");
    expect(textOf(view[1]!)).toContain("turn-user");

    // No toolResult in the tail may reference a toolCall that was folded into the summary.
    const declaredToolCallIds = new Set<string>();
    for (const msg of view) {
      if (msg.role !== "assistant") continue;
      for (const block of msg.content) {
        if (block.type === "toolCall") declaredToolCallIds.add(block.id);
      }
    }
    const tailToolResults = view.filter((msg) => msg.role === "toolResult");
    expect(tailToolResults.length).toBeGreaterThan(0);
    for (const toolResult of tailToolResults) {
      expect(declaredToolCallIds.has(toolResult.toolCallId)).toBe(true);
    }
    expect(session.compactionView?.coveredCount).toBe(2);
    fake.teardown();
  });

  it("X1: triggers earlier when tools are big (messages small but tool schema large)", async () => {
    // 仅 2 条小消息：messages-only 估算远低于阈值、绝不触发；但带上大 tool schema 的请求级估算越过阈值 → 触发。
    // 这正是 D0 53-vs-381 低估 7x 的修复方向：tool schema 每请求随发，必须计入。
    const messages = [m("hi"), m("ok"), m("more"), m("again")]; // 小
    const bigTool: Tool = {
      name: "submit_evidence",
      description: "Submit structured evidence. ".repeat(40),
      parameters: {
        type: "object",
        properties: {
          questionId: { type: "string", description: "the question id ".repeat(20) },
          evidence: { type: "string", description: "the evidence body ".repeat(20) },
        },
        required: ["questionId", "evidence"],
      },
    } as Tool;

    // 阈值卡在「messages-only 之上、含 tools 之下」之间。
    const messagesOnly = estimateTokensByChars(messages);
    const withTools = estimateRequestTokens({ messages, tools: [bigTool] });
    expect(withTools).toBeGreaterThan(messagesOnly); // sanity：tools 确实抬高了估值
    const threshold = (messagesOnly + withTools) / 2;

    let summarized = false;
    const compact = autoCompaction({
      maxContextTokens: threshold,
      triggerRatio: 1, // threshold = maxContextTokens
      keepRecent: 1,
      summarize: () => {
        summarized = true;
        return "RECAP";
      },
    });

    // ctx 暴露 bigTool：autoCompaction 经 ctx.config.tools 把它计入 → 触发。
    const { ctx } = createTestContext({ config: { tools: [bigTool] } });
    const view = await compact.transformMessagesBeforeLlm!(messages, ctx);
    expect(view).toBeDefined(); // 改进估算触发了
    expect(summarized).toBe(true);

    // 对照：同样 messages、同样阈值，但 ctx 没有 tools（messages-only 等价）→ 不触发。
    let summarized2 = false;
    const compact2 = autoCompaction({
      maxContextTokens: threshold,
      triggerRatio: 1,
      keepRecent: 1,
      summarize: () => {
        summarized2 = true;
        return "RECAP";
      },
    });
    const { ctx: ctxNoTools } = createTestContext(); // config.tools = []
    expect(await compact2.transformMessagesBeforeLlm!(messages, ctxNoTools)).toBeUndefined();
    expect(summarized2).toBe(false);
  });

  it("X1: a custom tokenCounter overrides the default", async () => {
    const calls: number[] = [];
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 1, // threshold 100
      keepRecent: 1,
      tokenCounter: {
        estimate: ({ messages }) => {
          calls.push(messages.length);
          return 200; // 永远超阈值 → 触发
        },
      },
      summarize: () => "RECAP",
    });
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!(grow(5), ctx);
    expect(view).toBeDefined();
    expect(calls.length).toBeGreaterThan(0); // 注入的 counter 真的被调用
  });

  // ───────────────── X2(#57): per-model 有效窗口 + 分层 buffer ─────────────────

  const modelCfg = (contextWindow: number, maxTokens: number) => ({
    model: { id: "m", provider: "p", contextWindow, maxTokens },
  });

  it("X2: window mode threshold = contextWindow − reserveForOutput − safetyBuffer", async () => {
    // contextWindow=10000, reserveForOutput=4096(默认 min(maxTokens,4096)), safetyBuffer=500 → 阈值 5404。
    let summarized = false;
    const compact = autoCompaction({
      // 不给 maxContextTokens → 走窗口路径
      keepRecent: 1,
      safetyBuffer: 500,
      tokenCounter: { estimate: () => 5405 }, // 5404 < 5405 → 越界 → 触发
      summarize: () => {
        summarized = true;
        return "RECAP";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 8000) }); // maxTokens=8000 → reserve=min(8000,4096)=4096
    const view = await compact.transformMessagesBeforeLlm!(grow(3), ctx);
    expect(view).toBeDefined();
    expect(summarized).toBe(true);
  });

  it("X2: window mode does NOT trigger at or below the effective window", async () => {
    // 阈值 = 10000 − 4096 − 0 = 5904。估算正好 = 5904（边界，<= 不触发）。
    let calls = 0;
    const compact = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 5904 },
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 4096) });
    expect(await compact.transformMessagesBeforeLlm!(grow(5), ctx)).toBeUndefined();
    expect(calls).toBe(0);

    // 阈值 + 1 → 触发。
    const compact2 = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 5905 },
      summarize: () => "S",
    });
    expect(await compact2.transformMessagesBeforeLlm!(grow(5), ctx)).toBeDefined();
  });

  it("X2: reserveForOutput / safetyBuffer overrides lower the effective window", async () => {
    // 显式 reserveForOutput=1000, safetyBuffer=2000 → 阈值 = 10000 − 1000 − 2000 = 7000。
    const compact = autoCompaction({
      keepRecent: 1,
      reserveForOutput: 1000,
      safetyBuffer: 2000,
      tokenCounter: { estimate: () => 7000 }, // == 阈值 → 不触发
      summarize: () => "S",
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 4096) });
    expect(await compact.transformMessagesBeforeLlm!(grow(5), ctx)).toBeUndefined();

    const compact2 = autoCompaction({
      keepRecent: 1,
      reserveForOutput: 1000,
      safetyBuffer: 2000,
      tokenCounter: { estimate: () => 7001 }, // 越界 1 → 触发
      summarize: () => "S",
    });
    expect(await compact2.transformMessagesBeforeLlm!(grow(5), ctx)).toBeDefined();
  });

  it("X2: reserveForOutput defaults to min(model.maxTokens, 4096)", async () => {
    // maxTokens=2000 < 4096 → reserve=2000 → 阈值 = 10000 − 2000 = 8000。
    const compactSmall = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 8001 },
      summarize: () => "S",
    });
    const { ctx: ctxSmall } = createTestContext({ config: modelCfg(10_000, 2000) });
    expect(await compactSmall.transformMessagesBeforeLlm!(grow(5), ctxSmall)).toBeDefined(); // 8001 > 8000

    const compactSmall2 = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 8000 },
      summarize: () => "S",
    });
    expect(await compactSmall2.transformMessagesBeforeLlm!(grow(5), ctxSmall)).toBeUndefined(); // 8000 == 阈值

    // maxTokens=100000 > 4096 → reserve 封顶 4096 → 阈值 = 10000 − 4096 = 5904。
    const compactBig = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 5905 },
      summarize: () => "S",
    });
    const { ctx: ctxBig } = createTestContext({ config: modelCfg(10_000, 100_000) });
    expect(await compactBig.transformMessagesBeforeLlm!(grow(5), ctxBig)).toBeDefined(); // 5905 > 5904
  });

  it("X2: explicit maxContextTokens takes priority over the window path (backward compat)", async () => {
    // 即便 ctx 暴露了 contextWindow，给了 maxContextTokens 就走百分比路径，窗口路径被忽略。
    // maxContextTokens=100, triggerRatio=1 → 阈值 100；窗口阈值会是 10000−4096=5904（若误用窗口路径则不触发）。
    let summarized = false;
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 1,
      keepRecent: 1,
      tokenCounter: { estimate: () => 200 }, // > 100(百分比) 但 < 5904(窗口) → 只有走百分比才触发
      summarize: () => {
        summarized = true;
        return "S";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 4096) });
    const view = await compact.transformMessagesBeforeLlm!(grow(5), ctx);
    expect(view).toBeDefined(); // 走了百分比路径
    expect(summarized).toBe(true);
  });

  it("X2: contextWindow unavailable (0) and no maxContextTokens → no compaction (no threshold)", async () => {
    let calls = 0;
    const compact = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 999_999 }, // 巨大，但算不出阈值
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(0, 0) }); // contextWindow=0
    expect(await compact.transformMessagesBeforeLlm!(grow(5), ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("X2: reserveForOutput+safetyBuffer >= contextWindow → 阈值≤0 视为算不出 → no-op(不每 turn 空压)", async () => {
    // footgun 防护:小窗口 + 大 reserve 让 effectiveWindow ≤ 0;若直接用,estimated(>=0) 永远 > 阈值 → 每 turn 压缩。
    let calls = 0;
    const compact = autoCompaction({
      keepRecent: 1,
      reserveForOutput: 200, // >= contextWindow(100) → w = 100 − 200 − 0 = −100 ≤ 0
      tokenCounter: { estimate: () => 999_999 }, // 巨大,但阈值算不出 → 不应触发
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(100, 50) });
    expect(await compact.transformMessagesBeforeLlm!(grow(5), ctx)).toBeUndefined();
    expect(calls).toBe(0); // 不每 turn 空压
  });

  it("X2: rejects negative reserveForOutput / safetyBuffer; allows omitting maxContextTokens", () => {
    expect(() =>
      autoCompaction({ reserveForOutput: -1, summarize: () => "" }),
    ).toThrow(/reserveForOutput/);
    expect(() =>
      autoCompaction({ safetyBuffer: -1, summarize: () => "" }),
    ).toThrow(/safetyBuffer/);
    // maxContextTokens 显式给 0 仍报错（区分「缺省」与「非法显式值」）。
    expect(() => autoCompaction({ maxContextTokens: 0, summarize: () => "" })).toThrow(
      /maxContextTokens/,
    );
    // 完全不给 maxContextTokens（窗口模式）→ 构造不报错。
    expect(() => autoCompaction({ summarize: () => "" })).not.toThrow();
  });

  it("X2 end-to-end: window mode from a real session's model.contextWindow", async () => {
    // fake model: contextWindow=200000, maxTokens=4096 → 阈值 = 200000 − 4096 = 195904。
    // 注入一个超大 estimate(走 tokenCounter)，让请求体积越过窗口阈值 → 真 session 触发压缩。
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          // 不给 maxContextTokens → 用 model.contextWindow
          keepRecent: 2,
          tokenCounter: { estimate: () => 200_000 }, // > 195904 → 触发
          summarize: () => "RECAP",
        }),
      ],
    });
    await session.run("go");

    const view = fake.getCalls()[0]!.messages;
    expect(view.length).toBe(3); // [summary, "a3", "go"]
    expect(textOf(view[0]!)).toContain("RECAP");
    expect(session.messages.length).toBe(8); // full history intact
    fake.teardown();
  });
});

describe("autoCompaction resume boundary floor", () => {
  const threshold = 50_000; // maxContextTokens 100_000 × triggerRatio 0.5
  const oversizedText = "x".repeat(300_000);

  const echoTool: HarnessTool = {
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: {} } as never,
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };

  function assistantWithUsage(text: string, input: number, output: number): Message {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "fake" as never,
      provider: "fake",
      model: "fake-model",
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
  }

  async function appendMessages(
    store: MemorySessionStore,
    sessionId: string,
    messages: Message[],
  ): Promise<void> {
    for (const message of messages) {
      await store.appendEntry(sessionId, { kind: "message", message });
    }
  }

  it("restored boundary: a stale tail assistant usage does not summarize on the first turn", async () => {
    const store = new MemorySessionStore();
    const sessionId = "restored-stale-usage";
    await appendMessages(
      store,
      sessionId,
      Array.from({ length: 20 }, (_, i) => m(`old-${i}`)),
    );
    await store.appendEntry(sessionId, {
      kind: "compaction_boundary",
      summary: m("OLD-SUMMARY"),
    });
    await appendMessages(
      store,
      sessionId,
      Array.from({ length: 6 }, (_, i) => m(`tail-${i}`)),
    );
    await store.appendEntry(sessionId, {
      kind: "message",
      message: assistantWithUsage("stale-tail", 500_000, 1_000),
    });

    let calls = 0;
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const resumed = await AgentSession.resume(store, sessionId, {
      model: fake,
      tools: [],
      hooks: [
        autoCompaction({
          maxContextTokens: 100_000,
          triggerRatio: 0.5,
          keepRecent: 3,
          resummarizeEvery: 1,
          summarize: () => {
            calls++;
            return "NEW-SUMMARY";
          },
        }),
      ],
    });

    expect(resumed.compactionView).toMatchObject({
      coveredCount: 1,
      restored: true,
      historicalCoveredCount: 20,
    });

    const result = await resumed.run("next");

    expect(result.reason).toBe("done");
    expect(calls).toBe(0);
    expect(resumed.compactionView?.coveredCount).toBe(1);
    expect(resumed.compactionView?.summaryText).toBe("OLD-SUMMARY");
    fake.teardown();
  });

  it("restored boundary: a genuinely oversized serialized view still summarizes", async () => {
    const store = new MemorySessionStore();
    const sessionId = "restored-oversized";
    await appendMessages(
      store,
      sessionId,
      Array.from({ length: 4 }, (_, i) => m(`old-${i}`)),
    );
    await store.appendEntry(sessionId, {
      kind: "compaction_boundary",
      summary: m("OLD-SUMMARY"),
    });
    await appendMessages(store, sessionId, [
      m("tail-small"),
      m(oversizedText),
      assistantWithUsage("stale-tail", 500_000, 1_000),
    ]);

    let calls = 0;
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const resumed = await AgentSession.resume(store, sessionId, {
      model: fake,
      tools: [],
      hooks: [
        autoCompaction({
          maxContextTokens: 100_000,
          triggerRatio: 0.5,
          keepRecent: 2,
          summarize: () => {
            calls++;
            return "NEW-SUMMARY";
          },
        }),
      ],
    });

    await resumed.run("next");

    expect(calls).toBe(1);
    const view = resumed.compactionView;
    expect(view).not.toBeNull();
    expect(view!.coveredCount).toBe(3);
    expect(view!.summaryText).toContain("NEW-SUMMARY");
    fake.teardown();
  });

  it("passes the remapped usage floor to the counter and prevents an immediate second summary", async () => {
    const store = new MemorySessionStore();
    const sessionId = "restored-floor-remap";
    await appendMessages(
      store,
      sessionId,
      Array.from({ length: 5 }, (_, i) => m(`old-${i}`)),
    );
    await store.appendEntry(sessionId, {
      kind: "compaction_boundary",
      summary: m("OLD-SUMMARY"),
    });

    const tail: Message[] = [m("tail-u0"), m(oversizedText)];
    for (let i = 2; i < 18; i++) tail.push(m(`tail-u${i}`));
    tail.push(assistantWithUsage("stale-tail", 500_000, 1_000));
    await appendMessages(store, sessionId, tail);

    const floors: Array<number | undefined> = [];
    let captured: RequestTokenInput | null = null;
    let summarizeCalls = 0;
    const fake = createFakeModel([
      {
        content: [{ type: "toolCall", id: "tc-echo", name: "echo", arguments: {} }],
        stopReason: "toolUse",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const resumed = await AgentSession.resume(store, sessionId, {
      model: fake,
      tools: [echoTool],
      hooks: [
        autoCompaction({
          maxContextTokens: 100_000,
          triggerRatio: 0.5,
          keepRecent: 8,
          resummarizeEvery: 1,
          tokenCounter: {
            estimate: (input) => {
              floors.push(input.usageFloorIndex);
              captured = input;
              return hybridTokenCounter.estimate(input);
            },
          },
          summarize: () => {
            summarizeCalls++;
            return "NEW-SUMMARY";
          },
        }),
      ],
    });

    const result = await resumed.run("next");

    expect(result.reason).toBe("done");
    expect(summarizeCalls).toBe(1);
    expect(floors).toEqual([8]);

    const view = resumed.compactionView;
    expect(view).not.toBeNull();
    expect(view!.coveredCount).toBe(13);
    expect(view!.summaryText).toContain("NEW-SUMMARY");

    const capturedInput = captured as RequestTokenInput | null;
    if (capturedInput === null) throw new Error("custom counter was not called");
    expect(hybridTokenCounter.estimate(capturedInput)).toBeLessThanOrEqual(threshold);
    expect(
      hybridTokenCounter.estimate({ ...capturedInput, usageFloorIndex: 0 }),
    ).toBeGreaterThan(threshold);
    fake.teardown();
  });
});

describe("autoCompaction 分块摘要（W52 死锁修复）", () => {
  const big = "x".repeat(40000); // ≈10000 tokens/条
  const heavy = (n: number) => Array.from({ length: n }, (_, i) => m(`${i}:${big}`));

  it("前缀按 summaryChunkTokens 分块，每块不超限，合并后覆盖全前缀", async () => {
    const sizes: number[] = [];
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5,
      keepRecent: 1,
      summaryChunkTokens: 25000,
      tokenCounter: { estimate: () => 1000 },
      summarize: (e) => {
        const text = e.length === 1 ? textOf(e[0]!) : "";
        if (text.includes("分段摘要")) return "MERGED";
        sizes.push(estimateTokensByChars(e));
        return `S${sizes.length}`;
      },
    });
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!(heavy(8), ctx);
    expect(view).toBeDefined();
    expect(sizes.length).toBeGreaterThan(1);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(25000);
    expect(textOf(view![0]!)).toContain("MERGED");
    expect(textOf(view![0]!)).toContain("of 7 earlier messages");
  });

  it("后块失败时不做部分推进：抛错、无 boundary、无缓存推进", async () => {
    let failing = true;
    let chunkCalls = 0;
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5,
      keepRecent: 1,
      summaryChunkTokens: 25000,
      tokenCounter: { estimate: () => 1000 },
      summarize: (e) => {
        const text = e.length === 1 ? textOf(e[0]!) : "";
        if (text.includes("分段摘要")) return "MERGED";
        chunkCalls++;
        if (failing && chunkCalls === 2) throw new Error("boom");
        return `S${chunkCalls}`;
      },
    });
    const { ctx } = createTestContext();
    await expect(compact.transformMessagesBeforeLlm!(heavy(8), ctx)).rejects.toThrow("boom");
    expect(ctx.state.get(ACTIVE_BOUNDARY_KEY)).toBeUndefined();

    // 无缓存/边界推进：下一 turn 从头重算全部 4 块，而不是从第 2 块继续。
    failing = false;
    chunkCalls = 0;
    const view = await compact.transformMessagesBeforeLlm!(heavy(8), ctx);
    expect(view).toBeDefined();
    expect(chunkCalls).toBe(4);
    expect(textOf(view![0]!)).toContain("MERGED");
    expect(textOf(view![0]!)).toContain("of 7 earlier messages");
  });

  it("第一块就失败时保持 fail-open：抛错且不写 boundary", async () => {
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5,
      keepRecent: 1,
      summaryChunkTokens: 25000,
      tokenCounter: { estimate: () => 1000 },
      summarize: () => {
        throw new Error("boom");
      },
    });
    const { ctx } = createTestContext();
    await expect(compact.transformMessagesBeforeLlm!(heavy(8), ctx)).rejects.toThrow("boom");
    expect(ctx.state.get(ACTIVE_BOUNDARY_KEY)).toBeUndefined();
  });

  it("单条超大消息被裁到块上限内（否则分块仍会超限）", async () => {
    const huge = m("y".repeat(400000)); // ≈100000 tokens
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5,
      keepRecent: 1,
      summaryChunkTokens: 10000,
      tokenCounter: { estimate: () => 1000 },
      summarize: () => "S",
    });
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!([huge, m("tail")], ctx);
    expect(view).toBeDefined();
    expect(textOf(view![0]!)).toContain("of 1 earlier messages");
  });
});

describe("chooseTailStart（Plan B T4：token tail + 完整 user turn）", () => {
  it("caps the tail by keepRecentTokens and starts on a user", () => {
    // 每条 64 个 ASCII 字符 ≈ 16 token + 4 framing = 20 token；预算 100 恰好容 5 条。
    const messages = Array.from({ length: 20 }, () => m("x".repeat(64)));
    const start = chooseTailStart(messages, {
      keepRecentTokens: 100,
      keepRecent: 2,
      floor: 0,
      hasPrevious: false,
    });
    const tail = messages.slice(start);
    expect(tail.length).toBe(5);
    expect(tail.reduce((sum, message) => sum + estimateTailMessage(message), 0)).toBeLessThanOrEqual(
      100,
    );
    expect(messages[start]?.role).toBe("user");
  });

  it("keeps the keepRecent count minimum when every tail message is oversized", () => {
    const messages = Array.from({ length: 8 }, () => m("x".repeat(400)));
    const start = chooseTailStart(messages, {
      keepRecentTokens: 10,
      keepRecent: 5,
      floor: 0,
      hasPrevious: false,
    });
    expect(messages.length - start).toBe(5);
    expect(messages[start]?.role).toBe("user");
  });

  it("snaps a toolResult tail start back to the owning user (no orphan toolResult)", () => {
    const messages: Message[] = [
      m("x".repeat(84)),
      assistantText("x".repeat(84)),
      m("x".repeat(84)),
      assistantToolCalls([{ id: "tc1", name: "echo" }]),
      toolResultMsg("tc1", "echo", "x".repeat(84)),
      assistantText("x".repeat(84)),
      m("x".repeat(84)),
      assistantText("x".repeat(84)),
    ];
    // 朴素起点 raw.length − keepRecent = 4 正落在 toolResult 上（其 toolCall 在 index 3）。
    expect(messages[4]?.role).toBe("toolResult");
    const start = chooseTailStart(messages, {
      keepRecentTokens: 100,
      keepRecent: 4,
      floor: 0,
      hasPrevious: false,
    });
    expect(start).toBe(2);
    expect(messages[start]?.role).toBe("user");

    const tail = messages.slice(start);
    const declaredToolCallIds = new Set<string>();
    for (const message of tail) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type === "toolCall") declaredToolCallIds.add(block.id);
      }
    }
    const toolResults = tail.filter((message) => message.role === "toolResult");
    expect(toolResults.length).toBeGreaterThan(0);
    for (const result of toolResults) {
      expect(declaredToolCallIds.has(result.toolCallId)).toBe(true);
    }
  });

  it("first compaction with no older exchange summarizes everything instead of dropping the tail", () => {
    const messages = [m("u0"), assistantText("a0")];
    const start = chooseTailStart(messages, {
      keepRecentTokens: 10_000,
      keepRecent: 10,
      floor: 0,
      hasPrevious: false,
    });
    expect(start).toBe(messages.length);
  });

  it("a seeded checkpoint with no user in the tail keeps the floor instead of losing messages", () => {
    const messages = [m("SUMMARY"), assistantText("tail-a"), toolResultMsg("tc9", "echo", "tail-r")];
    const start = chooseTailStart(messages, {
      keepRecentTokens: 10_000,
      keepRecent: 10,
      floor: 1,
      hasPrevious: true,
    });
    expect(start).toBe(1);
    expect(messages.slice(start)).toHaveLength(2);
  });
});

describe("autoCompaction resummarizeEvery（raw 坐标）", () => {
  it("does not resummarize when raw-prefix growth is below resummarizeEvery", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 1,
      resummarizeEvery: 16,
      tokenCounter: { estimate: () => 999 },
      summarize: () => {
        calls++;
        return "NEW-SUMMARY";
      },
    });
    const { ctx } = createTestContext();
    ctx.state.set(ACTIVE_BOUNDARY_KEY, { summary: m("SEED-SUMMARY"), coveredCount: 1 });

    // targetCover=7（raw 坐标）− coveredCount=1 = 6 < 16 → 本 turn 不重算。
    expect(await compact.transformMessagesBeforeLlm!(grow(8), ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("resummarizes once from coveredCount=1 to targetCover=7 and does not duplicate next turn", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 1,
      resummarizeEvery: 1,
      tokenCounter: { estimate: () => 999 },
      summarize: () => {
        calls++;
        return "NEW-SUMMARY";
      },
    });
    const { ctx } = createTestContext();
    ctx.state.set(ACTIVE_BOUNDARY_KEY, { summary: m("SEED-SUMMARY"), coveredCount: 1 });

    const first = await compact.transformMessagesBeforeLlm!(grow(8), ctx);
    expect(calls).toBe(1);
    // actualCover 保持 raw 坐标（7），不是增量 6。
    expect(textOf(first![0]!)).toContain("of 7 earlier messages");

    expect(await compact.transformMessagesBeforeLlm!(grow(8), ctx)).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("autoCompaction checkpoint metadata（Plan B T5 core 侧）", () => {
  it("a new summary writes checkpointId + anchorTimestampMs without restored", async () => {
    const initial: Message[] = [1, 2, 3, 4, 5, 6].map(
      (n): Message => ({ role: "user", content: `h${n}`, timestamp: n * 100 }),
    );
    let captured: ActiveBoundary | undefined;
    const observe: Hook = {
      name: "capture-active-boundary",
      transformMessagesBeforeLlm(_messages, ctx) {
        const boundary = ctx.state.get(ACTIVE_BOUNDARY_KEY);
        if (boundary !== undefined) captured = boundary;
      },
    };
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          maxContextTokens: 100,
          triggerRatio: 0.8,
          keepRecent: 2,
          tokenCounter: { estimate: ({ messages }) => messages.length * 50 },
          summarize: () => "RECAP",
        }),
        observe,
      ],
    });

    await session.run("go");

    const boundary = captured;
    if (boundary === undefined) throw new Error("new summary did not write a live boundary");
    expect(typeof boundary.checkpointId).toBe("string");
    expect((boundary.checkpointId ?? "").length).toBeGreaterThan(0);
    expect(Number.isFinite(boundary.anchorTimestampMs)).toBe(true);
    expect(boundary.anchorTimestampMs).toBe(600);
    expect(Object.prototype.hasOwnProperty.call(boundary, "restored")).toBe(false);
    fake.teardown();
  });
});

describe("autoCompaction keepRecentTokens 接线", () => {
  it("uses the option budget for the projected tail and summarizes the raw prefix", async () => {
    const messages = Array.from({ length: 20 }, () => m("x".repeat(64)));
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 2,
      keepRecentTokens: 100,
      tokenCounter: { estimate: () => 999 },
      summarize: (early) => `SUM:${early.length}`,
    });
    const { ctx } = createTestContext();

    const view = await compact.transformMessagesBeforeLlm!(messages, ctx);
    expect(view).toBeDefined();
    const tail = view!.slice(1);
    expect(tail).toHaveLength(5);
    expect(tail.reduce((sum, message) => sum + estimateTailMessage(message), 0)).toBeLessThanOrEqual(
      100,
    );
    expect(tail[0]?.role).toBe("user");
    expect(textOf(view![0]!)).toContain("SUM:15");
  });
});
