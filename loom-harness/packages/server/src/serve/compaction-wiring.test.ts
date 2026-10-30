/**
 * W49-C 主会话压缩接线的 per-session 工厂钉（W49.7 LOCK 清单逐条）。
 * Given: buildCompactionHooks({model, cfg})（模型句柄纯引用——本套件绝不触发 summarize，
 *        fake 零注册模型即可）+ 各类 compaction 配置形状。
 * When:  工厂逐会话调用 factory(sessionID)。
 * Then:  ①链序 [microcompact, autoCompaction]（microcompact.ts:12-18 裁剪先于总结；
 *         T3 互斥=链上绝不出现 compactSummarize）；
 *        ②T1：autoCompaction hook timeout === summaryTimeoutMs（缺席=wiring 物化 60000，
 *         pipe 缺省 500ms 静默杀 summarize 的坑绝不落地）；
 *        ③T4：跨会话/跨调用全异 hook 引用（auto-compaction.ts:256-258 一实例一 session
 *         闭包铁规，boot.ts 静态数组共享实例的串扰面由 per-session 工厂根除）；
 *        ④microcompact 子段缺席/显式禁用 = 不挂；
 *        ⑤C.2 flag：boundary 缺席/false = 两钩；true = 第三钩 compactionBoundary
 *         timeout 5000（T7：event 缺省 100ms，adapter 必须显式小超时）；
 *        ⑥adapter 发射规则：仅 coveredCount advance 时单发（同值重发禁止、再 advance 再发、
 *         无 active boundary 返回 nothing）；B 文本 = summary 全文 + 分隔线 +
 *         ctx.messages.slice(coveredCount) 逐字渲染（绝不截断、绝不用占位符视图）；
 *        ⑦Plan B T6：发射形状 = CompactionCheckpointPayload（summary + checkpoint 元数据），
 *         restored boundary 只采纳坐标绝不重复落库，之后新 summary 推进恰再发一次。
 * （主会话面端到端钉见 boot-assembly.test.ts W49-C describe；side/子会话零接线=构造性证明。）
 */

import { describe, expect, it } from "vitest";

import {
  ACTIVE_BOUNDARY_KEY,
  COMPACTION_CHECKPOINT_VERSION,
  COMPACTION_TAIL_SEPARATOR,
  buildChatSummaryMergePrompt,
  createUserMessage,
  isCompactionCheckpointPayload,
} from "@axeuh/loom-core";
import type {
  CompactionCheckpointPayload,
  Hook,
  HookContext,
  Message,
  Model,
  Api,
  LlmOptions,
} from "@axeuh/loom-core";
import { createFakeModel } from "@axeuh/loom-core/testing";
import type { FakeModel } from "@axeuh/loom-core/testing";
import type { CompactionConfig } from "../config/loom-config.js";

import {
  buildCompactionHooks,
  buildSessionCompactionOptions,
  buildSummaryLlmOptions,
  deriveSingleCallBudgetTokens,
  resolveSummaryPerspectives,
} from "./compaction-wiring.js";

/** 构建期零触模型的哑句柄（summarize 闭包只在压缩触发时消费，本套件不触发）。 */
const fakeHandle = {
  model: {} as unknown as Model<Api>,
  llmOptions: {} as LlmOptions,
};

const prodCfg: CompactionConfig = {
  enabled: true,
  maxContextTokens: 250000,
  triggerRatio: 0.8,
  keepRecent: 8,
  resummarizeEvery: 16,
  summaryTimeoutMs: 60000,
  microcompact: {
    enabled: true,
    triggerTokens: 150000,
    targetTokens: 60000,
    compactableTools: ["read", "bash"],
  },
};

function names(
  hooks: readonly Hook<Message | CompactionCheckpointPayload>[],
): string[] {
  return hooks.map((h) => h.name);
}

/** 最小 HookContext：adapter 只消费 ctx.state.get(ACTIVE_BOUNDARY_KEY) 与 ctx.messages。 */
function fakeCtx(state: Map<string, unknown>, messages: readonly Message[]): HookContext {
  return {
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
    messages,
  } as unknown as HookContext;
}

describe("buildCompactionHooks：W49.7 LOCK 链序与 T1/T4 钉", () => {
  it("生产全量声明：每会话钩序恰 [microcompact, autoCompaction]（裁剪先于总结；compactSummarize 绝不现形=T3 互斥）", () => {
    const factory = buildCompactionHooks({ model: fakeHandle, cfg: prodCfg });
    const hooks = factory("ses-prod");
    expect(names(hooks)).toEqual(["microcompact", "autoCompaction"]);
  });

  it("fallbackTokens 声明：构造 session options，旧 autoCompaction 不再挂链，boundary 仍在", () => {
    const cfg = {
      ...prodCfg,
      fallbackTokens: 750_000,
      requestTimeoutMs: 300_000,
      retryCount: 10,
      boundary: true,
      watermark: { levels: [300_000, 500_000, 600_000] },
    };
    const options = buildSessionCompactionOptions({
      model: fakeHandle,
      cfg,
      stateRoot: "/tmp/loom-compaction-wiring-test",
    });
    expect(options).toMatchObject({
      fallbackTokens: 750_000,
      keepRecent: 8,
      keepRecentTokens: 15_000,
      resummarizeEvery: 16,
      requestTimeoutMs: 300_000,
      retryCount: 10,
      watermarkLevels: [300_000, 500_000, 600_000],
    });
    const hooks = buildCompactionHooks({ model: fakeHandle, cfg })("ses-fallback");
    expect(names(hooks)).toEqual(["microcompact", "compactionBoundary"]);
  });

  it("fallbackTokens 缺席：不构造 session options，旧 autoCompaction 保持挂链", () => {
    expect(
      buildSessionCompactionOptions({
        model: fakeHandle,
        cfg: prodCfg,
        stateRoot: "/tmp/loom-compaction-wiring-test",
      }),
    ).toBeUndefined();
    const hooks = buildCompactionHooks({ model: fakeHandle, cfg: prodCfg })("ses-legacy");
    expect(names(hooks)).toEqual(["microcompact", "autoCompaction"]);
  });

  it("watermark.levels 透传到 SessionCompactionOptions.watermarkLevels（缺席不物化）", () => {
    const withWatermark = buildSessionCompactionOptions({
      model: fakeHandle,
      cfg: {
        enabled: true,
        fallbackTokens: 750_000,
        watermark: { levels: [300_000, 500_000, 600_000] },
      },
      stateRoot: "/tmp/loom-compaction-wiring-test",
    });
    expect(withWatermark?.watermarkLevels).toEqual([300_000, 500_000, 600_000]);

    const without = buildSessionCompactionOptions({
      model: fakeHandle,
      cfg: { enabled: true, fallbackTokens: 750_000 },
      stateRoot: "/tmp/loom-compaction-wiring-test",
    });
    expect(without).toBeDefined();
    expect(without !== undefined && "watermarkLevels" in without).toBe(false);
  });

  it("T1：autoCompaction hook.timeout === summaryTimeoutMs（声明 10000 逐值；缺席=wiring 物化 60000，pipe 缺省 500ms 绝不可见）", () => {
    const declared = buildCompactionHooks({
      model: fakeHandle,
      cfg: { enabled: true, summaryTimeoutMs: 10000 },
    })("ses-a");
    const auto = declared.find((h) => h.name === "autoCompaction");
    expect(auto?.timeout).toBe(10000);
    const absent = buildCompactionHooks({ model: fakeHandle, cfg: { enabled: true } })("ses-b");
    const autoB = absent.find((h) => h.name === "autoCompaction");
    expect(autoB?.timeout).toBe(60000);
  });

  it("T4：跨会话与重复调用皆全异引用（一实例一 session 闭包铁规，microcompact 同样逐会话新造保均匀）", () => {
    const factory = buildCompactionHooks({ model: fakeHandle, cfg: prodCfg });
    const a = factory("sesA");
    const b = factory("sesB");
    const a2 = factory("sesA");
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
    expect(a[0]).not.toBe(a2[0]);
    expect(a[1]).not.toBe(a2[1]);
  });

  it("microcompact 子段缺席 = 不挂（恰 [autoCompaction]）；enabled:false 在场 = 同不挂（显式禁用零注册）", () => {
    const bare = buildCompactionHooks({ model: fakeHandle, cfg: { enabled: true } })("ses-mc-absent");
    expect(names(bare)).toEqual(["autoCompaction"]);
    const off = buildCompactionHooks({
      model: fakeHandle,
      cfg: { enabled: true, microcompact: { enabled: false } },
    })("ses-mc-off");
    expect(names(off)).toEqual(["autoCompaction"]);
  });

  it("C.2 flag：boundary 缺席/false=两钩无 compactionBoundary；boundary:true=第三钩名 compactionBoundary 且 timeout 5000（T7）", () => {
    const off = buildCompactionHooks({ model: fakeHandle, cfg: prodCfg })("ses-b0");
    expect(names(off)).not.toContain("compactionBoundary");
    const offFalse = buildCompactionHooks({
      model: fakeHandle,
      cfg: { ...prodCfg, boundary: false },
    })("ses-b1");
    expect(names(offFalse)).not.toContain("compactionBoundary");
    const on = buildCompactionHooks({
      model: fakeHandle,
      cfg: { ...prodCfg, boundary: true },
    })("ses-b2");
    expect(names(on)).toEqual(["microcompact", "autoCompaction", "compactionBoundary"]);
    const adapter = on[2];
    expect(adapter?.timeout).toBe(5000);
    expect(typeof adapter?.onAfterFlush).toBe("function");
  });
});

describe("compactionBoundary adapter：W49.7 Q2 规格发射规则与 B 文本逐字面", () => {
  function adapter(): Hook<Message | CompactionCheckpointPayload> {
    const hooks = buildCompactionHooks({
      model: fakeHandle,
      cfg: { enabled: true, boundary: true },
    })("ses-adapter");
    const h = hooks.find((x) => x.name === "compactionBoundary");
    if (h === undefined) throw new Error("boundary flag ON 必须产出 adapter");
    return h;
  }

  const tail = (): Message[] => [
    createUserMessage("M0"),
    createUserMessage("M1"),
    createUserMessage("M2"),
    {
      role: "assistant",
      content: [{ type: "text", text: "M3" }],
      timestamp: 0,
      stopReason: "stop",
      error: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      model: "m",
      provider: "p",
      api: "openai-completions",
    } as unknown as Message,
    createUserMessage("M4"),
  ];

  function setText(m: Message | undefined): string {
    if (m === undefined) throw new Error("expected message");
    return typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("");
  }

  type BoundaryEnvelope = {
    compactionBoundary?: Message | CompactionCheckpointPayload;
  };

  function payloadOf(out: unknown): CompactionCheckpointPayload {
    if (typeof out !== "object" || out === null) {
      throw new Error("expected compaction checkpoint payload");
    }
    const b = (out as BoundaryEnvelope).compactionBoundary;
    if (b === undefined || !isCompactionCheckpointPayload(b)) {
      throw new Error("expected compaction checkpoint payload");
    }
    return b;
  }

  function summaryOf(out: unknown): Message | undefined {
    if (typeof out !== "object" || out === null) return undefined;
    const b = (out as BoundaryEnvelope).compactionBoundary;
    if (b === undefined) return undefined;
    return isCompactionCheckpointPayload(b) ? b.summary : b;
  }

  it("advance 单发：coveredCount=2 首发射一条；同 coveredCount 再 fire=零发射；advance 到 4 再发（频率=插件 resummarizeEvery 节流，adapter 零 LLM 调用）", async () => {
    const hook = adapter();
    const msgs = tail();
    const state = new Map<string, unknown>();
    state.set(ACTIVE_BOUNDARY_KEY, { summary: createUserMessage("SUM-TEXT"), coveredCount: 2 });
    const before = Date.now();
    const first = await hook.onAfterFlush!({ turnIdx: 0, persistedCount: msgs.length }, fakeCtx(state, msgs));
    const after = Date.now();
    const firstPayload = payloadOf(first);
    expect(firstPayload.checkpoint.version).toBe(COMPACTION_CHECKPOINT_VERSION);
    expect(firstPayload.checkpoint.coveredCount).toBe(2);
    expect(firstPayload.checkpoint.anchorTimestampMs).toBe(msgs[2]?.timestamp);
    expect(firstPayload.checkpoint.summaryId).toEqual(expect.any(String));
    expect(firstPayload.checkpoint.summaryId.length).toBeGreaterThan(0);
    expect(firstPayload.checkpoint.createdAt).toBeGreaterThanOrEqual(before);
    expect(firstPayload.checkpoint.createdAt).toBeLessThanOrEqual(after);
    expect(firstPayload.checkpoint.source).toBe("auto");
    expect(firstPayload.checkpoint.tailIncluded).toBe(true);
    expect(firstPayload.summary.role).toBe("user");
    const second = await hook.onAfterFlush!({ turnIdx: 1, persistedCount: msgs.length }, fakeCtx(state, msgs));
    expect(second).toBeUndefined();
    state.set(ACTIVE_BOUNDARY_KEY, { summary: createUserMessage("SUM-TEXT-V2"), coveredCount: 4 });
    const third = await hook.onAfterFlush!({ turnIdx: 2, persistedCount: msgs.length }, fakeCtx(state, msgs));
    const thirdPayload = payloadOf(third);
    expect(thirdPayload.checkpoint.coveredCount).toBe(4);
    expect(thirdPayload.checkpoint.anchorTimestampMs).toBe(msgs[4]?.timestamp);
    expect(setText(thirdPayload.summary)).toContain("SUM-TEXT-V2");
  });

  it("checkpoint 元数据优先取 boundary 的 anchorTimestampMs/checkpointId（插件写入值），不重算", async () => {
    const hook = adapter();
    const msgs = tail();
    const state = new Map<string, unknown>();
    state.set(ACTIVE_BOUNDARY_KEY, {
      summary: createUserMessage("SUM-ANCHOR"),
      coveredCount: 2,
      checkpointId: "ckpt-explicit",
      anchorTimestampMs: 777,
    });
    const payload = payloadOf(
      await hook.onAfterFlush!({ turnIdx: 0, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    );
    expect(payload.checkpoint.anchorTimestampMs).toBe(777);
    expect(payload.checkpoint.summaryId).toBe("ckpt-explicit");
  });

  it("restored boundary 采纳：首 fire 零发射（不重复已持久化 boundary），同坐标继续零发射；新 summary 推进 coveredCount 后恰发一次", async () => {
    const hook = adapter();
    const msgs = tail();
    const state = new Map<string, unknown>();
    state.set(ACTIVE_BOUNDARY_KEY, {
      summary: createUserMessage("RESTORED-SUM"),
      coveredCount: 3,
      restored: true,
      rehydratedCount: 4,
      checkpointId: "ckpt-restored",
      anchorTimestampMs: 111,
    });
    expect(
      await hook.onAfterFlush!({ turnIdx: 0, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    ).toBeUndefined();
    expect(
      await hook.onAfterFlush!({ turnIdx: 1, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    ).toBeUndefined();
    state.set(ACTIVE_BOUNDARY_KEY, { summary: createUserMessage("RESTORED-SUM"), coveredCount: 3 });
    expect(
      await hook.onAfterFlush!({ turnIdx: 2, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    ).toBeUndefined();
    state.set(ACTIVE_BOUNDARY_KEY, { summary: createUserMessage("NEW-SUM"), coveredCount: 4 });
    const advanced = payloadOf(
      await hook.onAfterFlush!({ turnIdx: 3, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    );
    expect(advanced.checkpoint.coveredCount).toBe(4);
    expect(setText(advanced.summary)).toContain("NEW-SUM");
    expect(
      await hook.onAfterFlush!({ turnIdx: 4, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    ).toBeUndefined();
  });

  it("persisted boundary 采纳：worker 已落 store，turn-end adapter 零发射；新 summary 推进后恰发一次", async () => {
    const hook = adapter();
    const msgs = tail();
    const state = new Map<string, unknown>();
    state.set(ACTIVE_BOUNDARY_KEY, {
      summary: createUserMessage("PERSISTED-SUM"),
      coveredCount: 3,
      persisted: true,
      checkpointId: "ckpt-persisted",
      anchorTimestampMs: 222,
    });
    expect(
      await hook.onAfterFlush!({ turnIdx: 0, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    ).toBeUndefined();
    state.set(ACTIVE_BOUNDARY_KEY, { summary: createUserMessage("NEW-SUM"), coveredCount: 4 });
    const advanced = payloadOf(
      await hook.onAfterFlush!({ turnIdx: 1, persistedCount: msgs.length }, fakeCtx(state, msgs)),
    );
    expect(advanced.checkpoint.coveredCount).toBe(4);
    expect(setText(advanced.summary)).toContain("NEW-SUM");
  });

  it("B 文本恰 = summary 全文 + 空行 + \"--- recent verbatim tail ---\" + 空行 + slice(coveredCount) 逐字渲染（summary-template renderMessage 同谱，绝不截断）", async () => {
    const hook = adapter();
    const msgs = tail();
    const state = new Map<string, unknown>();
    state.set(ACTIVE_BOUNDARY_KEY, { summary: createUserMessage("SUM-TEXT"), coveredCount: 2 });
    const out = await hook.onAfterFlush!({ turnIdx: 0, persistedCount: msgs.length }, fakeCtx(state, msgs));
    const summary = summaryOf(out);
    const text = setText(summary);
    expect(text.startsWith(`SUM-TEXT${COMPACTION_TAIL_SEPARATOR}`)).toBe(true);
    expect(text).toBe(
      [
        "SUM-TEXT",
        "",
        "--- recent verbatim tail ---",
        "user: M2",
        "assistant: M3",
        "user: M4",
      ].join("\n"),
    );
    // 发射形状 = create UserMessage 语义（role user，boundary entry 的单 message 形状）
    expect(summary?.role).toBe("user");
    expect(payloadOf(out).checkpoint.coveredCount).toBe(2);
  });

  it("无 active boundary（state 缺席=本 turn 没压）= 返回 nothing 且闭包状态不漂移；首发射后缺席再 fire 仍零发射", async () => {
    const hook = adapter();
    const msgs = tail();
    const empty = new Map<string, unknown>();
    expect(await hook.onAfterFlush!({ turnIdx: 0, persistedCount: 5 }, fakeCtx(empty, msgs))).toBeUndefined();
    const state = new Map<string, unknown>();
    state.set(ACTIVE_BOUNDARY_KEY, { summary: createUserMessage("S"), coveredCount: 3 });
    await hook.onAfterFlush!({ turnIdx: 1, persistedCount: 5 }, fakeCtx(state, msgs));
    expect(await hook.onAfterFlush!({ turnIdx: 2, persistedCount: 5 }, fakeCtx(empty, msgs))).toBeUndefined();
    expect(await hook.onAfterFlush!({ turnIdx: 3, persistedCount: 5 }, fakeCtx(state, msgs))).toBeUndefined();
  });
});

function promptOf(fake: FakeModel): string {
  const call = fake.getCalls()[0];
  if (call === undefined) throw new Error("fake provider 未被调用");
  return call.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
            .join(""),
    )
    .join("\n");
}

function fakeToolResult(toolName: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: `tc-${toolName}`,
    toolName,
    content: [{ type: "text", text }],
    timestamp: 0,
  } as unknown as Message;
}

describe("single-call/auto 摘要预算与模板接线", () => {
  const stateRoot = "/tmp/loom-compaction-wiring-test";

  it("deriveSingleCallBudgetTokens：1M/32768 => 813136；200K/4096 => 161808", () => {
    expect(deriveSingleCallBudgetTokens(1_000_000, 32_768)).toBe(813_136);
    expect(deriveSingleCallBudgetTokens(200_000, 4_096)).toBe(161_808);
  });

  it("deriveSingleCallBudgetTokens 拒绝非有限/非正输入", () => {
    for (const [contextWindow, maxOutput] of [
      [0, 4096],
      [-1, 4096],
      [Number.NaN, 4096],
      [200_000, 0],
      [200_000, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => deriveSingleCallBudgetTokens(contextWindow, maxOutput)).toThrow(RangeError);
    }
  });

  it("buildSummaryLlmOptions：覆盖 providerExtras.reasoningEffort，保留其他 extras/apiKey 且不改 base；undefined 原样返回", () => {
    const base: LlmOptions = {
      apiKey: "sk-base",
      temperature: 0.2,
      providerExtras: { custom: "keep", reasoningEffort: "low" },
    };
    const out = buildSummaryLlmOptions(base, "max");
    expect(out).not.toBe(base);
    expect(out.apiKey).toBe("sk-base");
    expect(out.temperature).toBe(0.2);
    expect(out.providerExtras).toEqual({ custom: "keep", reasoningEffort: "max" });
    expect(base.providerExtras).toEqual({ custom: "keep", reasoningEffort: "low" });

    const bare: LlmOptions = { apiKey: "sk-bare" };
    expect(buildSummaryLlmOptions(bare, "high").providerExtras).toEqual({ reasoningEffort: "high" });
    expect(buildSummaryLlmOptions(bare, undefined)).toBe(bare);
  });

  it("缺省 summaryMode=auto 且按 1M/32768 模型窗推导预算 813136，summaryMaxSplitDepth=2", () => {
    const fake = createFakeModel();
    try {
      const options = buildSessionCompactionOptions({
        model: { model: { ...fake, contextWindow: 1_000_000, maxTokens: 32_768 }, llmOptions: {} },
        cfg: { enabled: true, fallbackTokens: 750_000 },
        stateRoot,
      });
      expect(options?.summaryMode).toBe("auto");
      expect(options?.singleCallBudgetTokens).toBe(813_136);
      expect(options?.summaryMaxSplitDepth).toBe(2);
    } finally {
      fake.teardown();
    }
  });

  it("显式 singleCallBudgetTokens 覆盖推导值", () => {
    const fake = createFakeModel();
    try {
      const options = buildSessionCompactionOptions({
        model: { model: { ...fake, contextWindow: 1_000_000, maxTokens: 32_768 }, llmOptions: {} },
        cfg: { enabled: true, fallbackTokens: 750_000, singleCallBudgetTokens: 123_456 },
        stateRoot,
      });
      expect(options?.singleCallBudgetTokens).toBe(123_456);
      expect(options?.summaryMode).toBe("auto");
    } finally {
      fake.teardown();
    }
  });

  it("summaryMode=chunked 即使显式给预算也不物化 singleCallBudgetTokens（旧分块行为）", () => {
    const fake = createFakeModel();
    try {
      const options = buildSessionCompactionOptions({
        model: { model: { ...fake, contextWindow: 1_000_000, maxTokens: 32_768 }, llmOptions: {} },
        cfg: {
          enabled: true,
          fallbackTokens: 750_000,
          summaryMode: "chunked",
          singleCallBudgetTokens: 500_000,
        },
        stateRoot,
      });
      expect(options?.summaryMode).toBe("chunked");
      expect(options !== undefined && "singleCallBudgetTokens" in options).toBe(false);
    } finally {
      fake.teardown();
    }
  });

  it("模型窗/maxOutput 非有限非正：auto/single 无预算时降级 chunked，boot 不抛错", () => {
    const cfg = Object.freeze({ enabled: true, fallbackTokens: 750_000 });
    const options = buildSessionCompactionOptions({
      model: { model: {} as unknown as Model<Api>, llmOptions: Object.freeze({}) as LlmOptions },
      cfg,
      stateRoot,
    });
    expect(options?.summaryMode).toBe("chunked");
    expect(options !== undefined && "singleCallBudgetTokens" in options).toBe(false);
  });

  it("worker summarize 走 6 段 handoff 模板（无 All User Messages，含 Primary Request and Intent/Next Step）", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "SUMMARY-6" }], stopReason: "stop" },
    ]);
    try {
      const options = buildSessionCompactionOptions({
        model: { model: fake, llmOptions: {} },
        cfg: { enabled: true, fallbackTokens: 750_000, summaryMode: "chunked" },
        stateRoot,
      });
      if (options === undefined) throw new Error("fallbackTokens 声明必须产出 session options");
      const summary = await options.summarize(
        [createUserMessage("EARLY-CONTEXT")],
        {} as HookContext,
      );
      expect(summary).toBe("SUMMARY-6");
      const prompt = promptOf(fake);
      expect(prompt).toContain("Primary Request and Intent");
      expect(prompt).toContain("Next Step");
      expect(prompt).not.toContain("All User Messages");
    } finally {
      fake.teardown();
    }
  });

  it("projectSummaryInput 在 microcompact 启用且 compactableTools 非空时接线（旧工具输出投影为占位符）", () => {
    const options = buildSessionCompactionOptions({
      model: fakeHandle,
      cfg: {
        enabled: true,
        fallbackTokens: 750_000,
        summaryMode: "chunked",
        microcompact: { triggerTokens: 100, compactableTools: ["bash"], keepRecent: 0 },
      },
      stateRoot,
    });
    const project = options?.projectSummaryInput;
    if (project === undefined) throw new Error("microcompact 启用且有白名单时必须接线投影");
    const messages = [fakeToolResult("bash", "HUGE-OUTPUT"), createUserMessage("TAIL")];
    const projected = project(messages);
    expect(projected).toHaveLength(messages.length);
    const content = projected[0]?.content;
    const text = typeof content === "string" ? content : content?.map((b) => ("text" in b ? b.text : "")).join("");
    expect(text).toContain("[microcompact: bash output cleared");
  });

  it("projectSummaryInput 缺席：microcompact 未声明/显式禁用/白名单为空", () => {
    const base: CompactionConfig = { enabled: true, fallbackTokens: 750_000, summaryMode: "chunked" };
    const cases: readonly CompactionConfig[] = [
      base,
      { ...base, microcompact: { enabled: false, triggerTokens: 100, compactableTools: ["bash"] } },
      { ...base, microcompact: { enabled: true, triggerTokens: 100, compactableTools: [] } },
    ];
    for (const cfg of cases) {
      const options = buildSessionCompactionOptions({ model: fakeHandle, cfg, stateRoot });
      expect(options !== undefined && "projectSummaryInput" in options).toBe(false);
    }
  });

  it("legacy buildCompactionHooks（无 fallbackTokens）仍走 9 段模板：All User Messages 在场", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "LEGACY-SUMMARY" }], stopReason: "stop" },
    ]);
    const legacyCfg: CompactionConfig = {
      enabled: true,
      maxContextTokens: 1000,
      triggerRatio: 0.8,
      keepRecent: 1,
    };
    try {
      expect(
        buildSessionCompactionOptions({
          model: { model: fake, llmOptions: {} },
          cfg: legacyCfg,
          stateRoot,
        }),
      ).toBeUndefined();
      const auto = buildCompactionHooks({
        model: { model: fake, llmOptions: {} },
        cfg: legacyCfg,
      })("ses-legacy-template").find((h) => h.name === "autoCompaction");
      if (auto?.transformMessagesBeforeLlm === undefined) {
        throw new Error("legacy 链必须挂 autoCompaction transform");
      }
      const messages = [
        createUserMessage("A".repeat(4000)),
        createUserMessage("B".repeat(4000)),
        createUserMessage("C".repeat(4000)),
      ];
      const state = new Map<string, unknown>();
      const ctx = {
        state: {
          get: (key: string) => state.get(key),
          set: (key: string, value: unknown) => {
            state.set(key, value);
          },
        },
        messages,
        config: { model: fake, tools: [], systemPrompt: "" },
        turnIdx: 0,
      } as unknown as HookContext;
      await auto.transformMessagesBeforeLlm(messages, ctx);
      const prompt = promptOf(fake);
      expect(prompt).toContain("9 numbered sections");
      expect(prompt).toContain("All User Messages");
    } finally {
      fake.teardown();
    }
  });
});

describe("摘要视角装配：默认 ops+chat、显式 ops 回滚、chat 合并提示词", () => {
  const stateRoot = "/tmp/loom-compaction-wiring-test";

  function promptAt(fake: FakeModel, index: number): string {
    const call = fake.getCalls()[index];
    if (call === undefined) throw new Error(`fake provider 未被第 ${String(index + 1)} 次调用`);
    return call.messages
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content
              .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
              .join(""),
      )
      .join("\n");
  }

  it("缺省双视角：fallbackTokens 声明即附 chat 视角（key/title/合并提示词），ops 仍 6 段、chat 为准续写段", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "OPS-SUMMARY" }], stopReason: "stop" },
      { content: [{ type: "text", text: "CHAT-SUMMARY" }], stopReason: "stop" },
    ]);
    try {
      const options = buildSessionCompactionOptions({
        model: { model: fake, llmOptions: {} },
        cfg: { enabled: true, fallbackTokens: 750_000, summaryMode: "chunked" },
        stateRoot,
      });
      if (options === undefined) throw new Error("fallbackTokens 声明必须产出 session options");
      const perspectives = options.additionalSummaryPerspectives;
      expect(perspectives).toHaveLength(1);
      const chat = perspectives?.[0];
      expect(chat?.key).toBe("chat");
      expect(chat?.title).toBe("CHAT STATE");
      expect(chat?.buildMergePrompt).toBe(buildChatSummaryMergePrompt);

      expect(
        await options.summarize([createUserMessage("EARLY-CONTEXT")], {} as HookContext),
      ).toBe("OPS-SUMMARY");
      if (chat === undefined) throw new Error("缺省双视角必须含 chat");
      expect(
        await chat.summarize([createUserMessage("EARLY-CONTEXT")], {} as HookContext),
      ).toBe("CHAT-SUMMARY");

      const opsPrompt = promptAt(fake, 0);
      expect(opsPrompt).toContain("6 numbered sections");
      expect(opsPrompt).toContain("Confirmed Decisions and Constraints");
      expect(opsPrompt).not.toContain("All User Messages");

      const chatPrompt = promptAt(fake, 1);
      expect(chatPrompt).toContain("chat-continuity summary");
      expect(chatPrompt).toContain("Relationship and Tone");
      expect(chatPrompt).toContain("Voice Anchors");
      expect(chatPrompt).not.toContain("Next Step");
    } finally {
      fake.teardown();
    }
  });

  it("summaryPerspectives: [ops]：不附 additionalSummaryPerspectives（回滚单视角，键不出现）", () => {
    const options = buildSessionCompactionOptions({
      model: fakeHandle,
      cfg: {
        enabled: true,
        fallbackTokens: 750_000,
        summaryMode: "chunked",
        summaryPerspectives: ["ops"],
      },
      stateRoot,
    });
    expect(options).toBeDefined();
    expect(options !== undefined && "additionalSummaryPerspectives" in options).toBe(false);
  });

  it("summaryPerspectives 归一：缺省/[chat,ops]/[ops,chat] 皆 ops 主视角在前，[ops] 保持单视角", () => {
    expect(resolveSummaryPerspectives({ enabled: true, fallbackTokens: 750_000 })).toEqual([
      "ops",
      "chat",
    ]);
    expect(
      resolveSummaryPerspectives({
        enabled: true,
        fallbackTokens: 750_000,
        summaryPerspectives: ["chat", "ops"],
      }),
    ).toEqual(["ops", "chat"]);
    expect(
      resolveSummaryPerspectives({
        enabled: true,
        fallbackTokens: 750_000,
        summaryPerspectives: ["ops"],
      }),
    ).toEqual(["ops"]);

    const options = buildSessionCompactionOptions({
      model: fakeHandle,
      cfg: {
        enabled: true,
        fallbackTokens: 750_000,
        summaryMode: "chunked",
        summaryPerspectives: ["chat", "ops"],
      },
      stateRoot,
    });
    expect(options?.additionalSummaryPerspectives?.map((p) => p.key)).toEqual(["chat"]);
  });
});
