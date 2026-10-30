/**
 * W42a — provider 瞬时错误的内核诚实终态化 + call 内带退避重试。
 *
 * 事故链（2026-10-15 数据检查班）：data_checker 子会话先后死于 provider "terminated"
 * （pi-ai 把 provider 运行时错误表达成 error 流事件 → `stream().result()` **resolve** 出
 * stopReason="error"/异常"aborted"终态，不 reject）。探针实证三条缝隙的真假：
 *   - 缝隙②（默认 overflow 启发式误中瞬时文案）为**假**："terminated"/"socket hang up"/
 *     "fetch failed" 均不命中 defaultIsContextOverflow——用例 2 把该发现钉死；
 *   - 缝隙①（"aborted" 无本地 abort 信号被当正常 done）为**真**——用例 1 红测先复现；
 *   - 猝死主通道 = 消费层丢 provider 文本（task-llm-error.test.ts 承接）。
 * 本文件钉内核面：error/aborted-无信号 终态诚实化为 reason="error"（summary.error 携
 * provider errorMessage）；放弃前对同一 LLM call 重发 ≤llmErrorRetries 次（缺省 2，
 * 退避 base×2ⁿ=1s/2s；重试不消耗回合数）；真用户 abort 与 overflow 语义逐字节不动。
 */

import { describe, expect, it } from "vitest";
import { AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import { defaultIsContextOverflow } from "../context-overflow.js";
import type { Hook, ContextOverflowInput } from "../hook.js";

describe("W42a 终态诚实化（resolved error/aborted 空文本 assistant）", () => {
  it("provider 无本地 abort 信号解出 stopReason='aborted'（socket 侧中断）→ 如实终态化 reason='error'，summary.error 携 provider 文本【红测：修复前该形状被判 done】", async () => {
    const fake = createFakeModel([
      { content: [], stopReason: "aborted", errorMessage: "socket hang up" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmErrorRetries: 0,
      llmErrorRetryBackoffMs: 5,
      consoleSink: () => {},
    });
    const summary = await session.run("hi");

    expect(summary.reason).toBe("error"); // 修复前猝死形状：done
    expect(summary.error?.message).toContain("socket hang up");
    // lastMessage 仍如实是那条 aborted 终态 assistant（判失败看 reason/error/stopReason）
    expect(summary.lastMessage?.stopReason).toBe("aborted");
    expect(summary.stopReason).toBe("aborted");
    expect(fake.getCalls()).toHaveLength(1);
    fake.teardown();
  });

  it("事故文案 'terminated' 实证不命中默认 overflow 启发式（缝隙②排除）；error-stop 诚实终态化 reason='error' 且 summary.error 携原文", async () => {
    expect(defaultIsContextOverflow("terminated")).toBe(false); // 缝隙②=假，钉死发现
    expect(defaultIsContextOverflow("socket hang up")).toBe(false);
    expect(defaultIsContextOverflow("fetch failed")).toBe(false);

    const fake = createFakeModel([
      { content: [], throwError: new Error("terminated") },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmErrorRetries: 0,
      consoleSink: () => {},
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("error");
    expect(summary.error?.message).toBe("terminated");
    expect(summary.lastMessage?.errorMessage).toBe("terminated");
    fake.teardown();
  });

  it("真用户 abort（本地信号在飞）时 provider 解出 aborted → reason 保持 'aborted'，不升 error、不重发", async () => {
    const fake = createFakeModel([
      { content: [], stopReason: "aborted", errorMessage: "stream closed" },
    ]);
    const hook: Hook = {
      name: "abort-at-turn-start",
      onTurnStart: (_input, ctx) => {
        ctx.abort("user: stop now");
      },
    };
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [hook],
      // 重试在位也不得把真 abort 误判成瞬时错误
      llmErrorRetryBackoffMs: 5,
      consoleSink: () => {},
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toBe("user: stop now");
    expect(summary.error).toBeUndefined();
    expect(fake.getCalls()).toHaveLength(1); // 本地信号在飞 = 用户意志，不重发
    fake.teardown();
  });

  it("llmErrorRetries 非法值（负数/小数/退避负值）构造期 fail-loud", () => {
    const fake = createFakeModel([]);
    expect(() => new AgentSession({ model: fake, tools: [], llmErrorRetries: -1 })).toThrow(/llmErrorRetries/);
    expect(() => new AgentSession({ model: fake, tools: [], llmErrorRetries: 1.5 })).toThrow(/llmErrorRetries/);
    expect(() => new AgentSession({ model: fake, tools: [], llmErrorRetryBackoffMs: -5 })).toThrow(/llmErrorRetryBackoffMs/);
    expect(() => new AgentSession({ model: fake, tools: [], llmErrorRetries: 0 })).not.toThrow();
    fake.teardown();
  });
});

describe("W42a llmErrorRetries 带退避重试（同一 LLM call 重发，不消耗回合数）", () => {
  it("瞬时错误自愈：第 1 次 error-stop，退避后重发同一 call 拿到下一条脚本 → reason='done'，turns=1（重试不耗回合）", async () => {
    const fake = createFakeModel([
      { content: [], throwError: new Error("503 Service Unavailable"), advanceOnRetry: true },
      { content: [{ type: "text", text: "after retry" }] },
    ]);
    const logs: string[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmErrorRetryBackoffMs: 5, // 生产缺省 1000（1s/2s），测试注小值
      consoleSink: (m) => logs.push(m),
    });
    const summary = await session.run("hi");

    expect(summary.reason).toBe("done");
    expect(fake.getCalls()).toHaveLength(2); // 首发 + 1 次重发
    expect(summary.turns).toBe(1); // 一个 turn 内含两次发送
    const assistants = session.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1); // 失败 attempt 的残骸不进转录，只有终态入 messages
    expect(logs.some((m) => m.startsWith("[llm-retry]"))).toBe(true); // 决策点留痕
    fake.teardown();
  });

  it("重试耗尽：llmErrorRetries=2 → 同一请求共 3 次发送（provider 持续失败重放）→ 诚实 reason='error' 携末次 errorMessage", async () => {
    const fake = createFakeModel([
      { content: [], stopReason: "aborted", errorMessage: "socket hang up" },
    ]); // 无 advanceOnRetry = 该请求恒得同一失败（持续故障的脚本表达）
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmErrorRetries: 2,
      llmErrorRetryBackoffMs: 5,
      consoleSink: () => {},
    });
    const summary = await session.run("hi");
    expect(fake.getCalls()).toHaveLength(3); // 1 + 2 重试
    expect(summary.reason).toBe("error");
    expect(summary.error?.message).toBe("socket hang up");
    fake.teardown();
  });

  it("llmErrorRetries=0 禁用重试：error-stop 一发即诚实终态化，不重发", async () => {
    const fake = createFakeModel([
      { content: [], throwError: new Error("boom"), advanceOnRetry: true },
      { content: [{ type: "text", text: "never reached" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmErrorRetries: 0,
      llmErrorRetryBackoffMs: 5,
      consoleSink: () => {},
    });
    const summary = await session.run("hi");
    expect(fake.getCalls()).toHaveLength(1); // 禁用了就不发第二次
    expect(summary.reason).toBe("error");
    expect(summary.error?.message).toBe("boom");
    fake.teardown();
  });

  it("中间失败 attempt 只配对 message_start/end、不 fire onLlmEnd；终态 assistant 恰一次入 messages、llm-end 恰一次；发线回调逐 attempt 各一次", async () => {
    const fake = createFakeModel([
      { content: [], throwError: new Error("transient"), advanceOnRetry: true },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let llmEnds = 0;
    const hook: Hook = {
      name: "llm-end-count",
      onLlmEnd: () => {
        llmEnds++;
      },
    };
    const wireSnaps: unknown[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [hook],
      llmErrorRetryBackoffMs: 5,
      consoleSink: () => {},
      onWireSnapshot: (s) => wireSnaps.push(s),
    });
    const starts: number[] = [];
    const ends: number[] = [];
    session.on("message_start", () => starts.push(1));
    session.on("message_end", () => ends.push(1));
    const summary = await session.run("hi");

    expect(summary.reason).toBe("done");
    expect(starts).toHaveLength(2); // 每次发送各自成对
    expect(ends).toHaveLength(2);
    expect(llmEnds).toBe(1); // onLlmEnd 只对终态 fire 一次
    expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(wireSnaps).toHaveLength(2); // 发线面逐 attempt 落位（槽 last-write-wins）
    fake.teardown();
  });

  it("overflow 语义逐字节不动：overflow 文案 error-stop 单次发送、fire onContextOverflow、不退避重试、不升 error（reason 仍 done）", async () => {
    const fake = createFakeModel([
      {
        content: [],
        throwError: new Error(
          "This model's maximum context length is 8192 tokens, however you requested 9001",
        ),
        advanceOnRetry: true,
      },
      { content: [{ type: "text", text: "should never be fetched" }] },
    ]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmErrorRetryBackoffMs: 5,
      consoleSink: () => {},
      hooks: [
        {
          name: "overflow-watch",
          onContextOverflow: (input) => {
            seen.push(input);
          },
        },
      ],
    });
    const summary = await session.run("hi");
    expect(seen).toHaveLength(1); // overflow 通道原样
    expect(seen[0]?.stopReason).toBe("error");
    expect(fake.getCalls()).toHaveLength(1); // overflow 不消耗重试（重发只会同样超长）
    expect(summary.reason).toBe("done"); // 无策略 abort 的既载契约（session.ts:1590 注释）
    fake.teardown();
  });

  it("MainSessionLoop 创建路径透传 llmErrorRetries=0：error-stop 单发即终态，主循环如实报 type='error'", async () => {
    const { MainSessionLoop } = await import("../main-loop/index.js");
    const fake = createFakeModel([
      { content: [], throwError: new Error("boom"), advanceOnRetry: true },
      { content: [{ type: "text", text: "must not be reached" }] },
    ]);
    const loop = MainSessionLoop.create({
      model: fake,
      tools: [],
      llmErrorRetries: 0,
      consoleSink: () => {},
    });
    const result = await loop.start("hi");
    expect(result.type).toBe("error");
    expect(result.summary.reason).toBe("error");
    expect(result.summary.error?.message).toBe("boom");
    expect(fake.getCalls()).toHaveLength(1); // 透传生效：内核层单发
    fake.teardown();
  });

  it("T4 MainSessionLoop 创建路径透传 llmErrorRetryBackoffMs：内核私有退避基数 = 声明值，缺席 = 缺省 1000", async () => {
    const { MainSessionLoop } = await import("../main-loop/index.js");
    type KernelProbe = { _session: { _llmErrorRetryBackoffMs: number } };
    const fake = createFakeModel([]);
    const declared = MainSessionLoop.create({
      model: fake,
      tools: [],
      llmErrorRetryBackoffMs: 7,
      consoleSink: () => {},
    });
    const absent = MainSessionLoop.create({ model: fake, tools: [], consoleSink: () => {} });
    expect((declared as unknown as KernelProbe)._session._llmErrorRetryBackoffMs).toBe(7);
    expect((absent as unknown as KernelProbe)._session._llmErrorRetryBackoffMs).toBe(1000);
    fake.teardown();
  });
});
