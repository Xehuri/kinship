/**
 * W51 compactionView 只读快照单元测试（GET /sessions/:id/compaction 的 core 数据源）。
 *
 * boundary 由测试 hook 经 ACTIVE_BOUNDARY_KEY 写入 ctx.state、内核 turn 末拾取
 * （cache-safe-params.test.ts 同谱，即生产 autoCompaction 写 entry 的同一 key）；
 * 真实 autoCompaction 插件端到端钉在 server 侧 compaction-status.test.ts。
 *
 * 钉的语义：
 *  1. 无 boundary = null（诚实面，非零值假象）；
 *  2. anchor = _messages[coveredCount] **按索引精确取**（initialMessages 固定 timestamp
 *     100/200/300 逐值断言，取错索引必红）；
 *  3. pi-ai Message 无 id → anchorMessageId=null；消息对象真实携带非空 string id 时透传
 *     （探针面），id="" 视同缺席；
 *  4. coveredCount 越界（>= total，不该发生）→ anchors 双 null、coveredCount 如实可见；
 *  5. summaryText：string content 原样；content 块数组拼接全部 text 块（image 不贡献）。
 */

import { describe, expect, it } from "vitest";
import { ACTIVE_BOUNDARY_KEY, AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import type { CompactionView, Hook, Message } from "../index.js";

/** 固定 timestamp 的 user message（索引/时刻断言的确定性输入源）。 */
function fixedUser(text: string, timestamp: number): Message {
  return { role: "user", content: text, timestamp };
}

/** 带稳定 id 扩展的消息：Object.assign 附加（pi-ai 类型未声明 id，运行时探针透传）。 */
function fixedUserWithId(text: string, timestamp: number, id: string): Message {
  return Object.assign(fixedUser(text, timestamp), { id });
}

/** 块数组 summary：text + image + text（image 不贡献文本，钉 summaryText 拼接口径）。 */
const BLOCK_SUMMARY: Message = {
  role: "user",
  content: [
    { type: "text", text: "SUM-HEAD" },
    { type: "image", data: "zz", mimeType: "image/png" },
    { type: "text", text: "SUM-TAIL" },
  ],
  timestamp: 7,
};

/** 内核 turn0 后从 ctx.state 拾取 boundary（cache-safe-params.test.ts 同姿势）。 */
function boundaryHook(summary: Message, coveredCount: number): Hook {
  return {
    name: "w51-set-live-boundary",
    transformMessagesBeforeLlm(_messages, ctx) {
      if (ctx.turnIdx === 0) {
        ctx.state.set(ACTIVE_BOUNDARY_KEY, { summary, coveredCount });
      }
    },
  };
}

/** 真跑一轮（fake 模型单条 text 终答），返回 session 与其消息数组（确定性脚本）。 */
async function bootRun(opts: {
  initialMessages: Message[];
  hook?: Hook;
}): Promise<{ session: AgentSession; teardown: () => void }> {
  const fake = createFakeModel([{ content: [{ type: "text", text: "done" }] }]);
  const session = new AgentSession({
    model: fake,
    tools: [],
    hooks: opts.hook === undefined ? [] : [opts.hook],
    initialMessages: opts.initialMessages,
  });
  await session.run("go");
  return { session, teardown: () => fake.teardown() };
}

/** initialMessages 三条固定消息 + run("go") 注入 1 条 user + 1 条 assistant = 5 条。 */
const PRELUDE = [
  fixedUser("m0", 100),
  fixedUserWithId("m1", 200, "msg_anchor_w51"),
  fixedUser("m2", 300),
];

describe("AgentSession.compactionView（W51 只读快照）", () => {
  it("未设 boundary：run 前后皆 null（诚实缺席，非零值假象）", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "done" }] }]);
    const session = new AgentSession({ model: fake, tools: [], initialMessages: PRELUDE });
    expect(session.compactionView).toBeNull();
    await session.run("go");
    expect(session.compactionView).toBeNull();
    fake.teardown();
  });

  it("boundary(coveredCount=1)：anchor 按索引命中 _messages[1]，id 探针透传、块数组 summaryText 拼接、ts 逐值", async () => {
    const { session, teardown } = await bootRun({
      initialMessages: PRELUDE,
      hook: boundaryHook(BLOCK_SUMMARY, 1),
    });
    try {
      const view = session.compactionView;
      expect(view).not.toBeNull();
      expect(view).toEqual<CompactionView>({
        coveredCount: 1,
        summaryText: "SUM-HEADSUM-TAIL",
        anchorMessageId: "msg_anchor_w51",
        anchorTimestampMs: 200,
        totalMessages: 5,
      });
    } finally {
      teardown();
    }
  });

  it("boundary(coveredCount=0)：anchor=_messages[0]（无 id 的普通消息）→ anchorMessageId=null、ts=100", async () => {
    const { session, teardown } = await bootRun({
      initialMessages: PRELUDE,
      hook: boundaryHook(fixedUser("PLAIN-SUM", 42), 0),
    });
    try {
      expect(session.compactionView).toEqual<CompactionView>({
        coveredCount: 0,
        summaryText: "PLAIN-SUM",
        anchorMessageId: null,
        anchorTimestampMs: 100,
        totalMessages: 5,
      });
    } finally {
      teardown();
    }
  });

  it("coveredCount 越界（>=total，不该发生）：anchors 双 null，coveredCount/totalMessages 如实可见", async () => {
    const { session, teardown } = await bootRun({
      initialMessages: PRELUDE,
      hook: boundaryHook(fixedUser("OVER-SUM", 9), 99),
    });
    try {
      expect(session.compactionView).toEqual<CompactionView>({
        coveredCount: 99,
        summaryText: "OVER-SUM",
        anchorMessageId: null,
        anchorTimestampMs: null,
        totalMessages: 5,
      });
    } finally {
      teardown();
    }
  });

  it("id 探针负形：空串 id 视同缺席 → anchorMessageId=null", async () => {
    const initial = [
      fixedUserWithId("m0", 100, ""),
      fixedUser("m1", 200),
      fixedUser("m2", 300),
    ];
    const { session, teardown } = await bootRun({
      initialMessages: initial,
      hook: boundaryHook(fixedUser("S", 1), 0),
    });
    try {
      const view = session.compactionView;
      expect(view?.anchorMessageId).toBeNull();
      expect(view?.anchorTimestampMs).toBe(100);
    } finally {
      teardown();
    }
  });
});
