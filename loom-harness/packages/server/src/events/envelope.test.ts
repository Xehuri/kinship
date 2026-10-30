/**
 * T29 验收（单元层）—— 前端硬契约逐条转断言（docs/02 前端消费审计 / docs/04 §3.1）。
 *
 * 覆盖条目：
 *   - 信封 `{payload:{type,properties}}`，properties 恒存在；
 *   - session.idle 带 sessionID + 镜像 id；
 *   - message.part.delta：field==='text' + partID + messageID；
 *   - message.part.updated：part.id 存在；message.updated：info.tokens.* 六字段；
 *   - children[].id 存在且无连字符（<task_metadata> 反解）；
 *   - 一切 id ∈ [a-zA-Z0-9_]（脏 id 经 sanitizeId 归一后外发）；
 *   - 三态收束字段随 session.idle 带出；
 *   - vendor→loom 映射表完整覆盖 kernel 事件名，null 项不发帧；
 *   - unknown-event tolerance：未知事件不发帧、不抛错；
 *   - 同一事件多订阅者投影出相同 id（WeakMap 记忆化）。
 */

import { describe, it, expect } from "vitest";
import type { AssistantMessage, LiveEvent, SessionEvent, ToolExecResult } from "@axeuh/loom-core";
import {
  LOOM_ID_RE,
  VENDOR_TO_LOOM_EVENT,
  eventPayload,
  newProjectionState,
  projectEnvelope,
  projectEvent,
  projectTraceRecord,
  sanitizeId,
} from "./index.js";
import type { FrameDraft } from "./index.js";

// ────────────── 测试夹具 ──────────────

/** 最小 assistant 消息（只带投影器读取的字段）。 */
function assistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "fake",
    provider: "fake-x",
    model: "fake-model-1",
    usage: {
      input: 100,
      output: 40,
      cacheRead: 7,
      cacheWrite: 3,
      totalTokens: 140,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

/** 收集属性（不包信封）：投一条事件并返回草案序列。 */
function drafts(
  state: ReturnType<typeof newProjectionState>,
  events: Array<LiveEvent | SessionEvent>,
  sessionId = "ses_test_01",
): FrameDraft[] {
  const out: FrameDraft[] = [];
  for (const e of events) out.push(...projectEvent(state, sessionId, e));
  return out;
}

function findFrame(list: readonly FrameDraft[], type: string): FrameDraft {
  const hit = list.find((d) => d.type === type);
  if (hit === undefined) throw new Error(`no frame of type ${type} in ${JSON.stringify(list.map((d) => d.type))}`);
  return hit;
}

// ────────────── 信封构造点 ──────────────

describe("envelope 信封（payload.properties 恒存在）", () => {
  it("eventPayload always yields {type,properties} with sanitized sessionID", () => {
    const p = eventPayload("session.idle", "ses-ab-cd", { foo: 1 });
    expect(p.type).toBe("session.idle");
    expect(p.properties.sessionID).toBe("ses_ab_cd"); // 连字符 → 下划线
    expect(p.properties.foo).toBe(1);
    expect(LOOM_ID_RE.test(p.properties.sessionID)).toBe(true);
  });

  it("extra cannot smuggle a dirty sessionID over the sanitized one", () => {
    const p = eventPayload("x", "good_id", { sessionID: "bad-id" });
    expect(p.properties.sessionID).toBe("good_id");
  });

  it("sanitizeId is idempotent and dash-free", () => {
    const once = sanitizeId("a-b-c");
    expect(sanitizeId(once)).toBe(once);
    expect(once).toBe("a_b_c");
  });
});

// ────────────── 会话/消息族逐条契约 ──────────────

describe("message.part.delta（field==='text' + partID + messageID）", () => {
  it("text_delta projects to exactly one delta frame with contract fields", () => {
    const state = newProjectionState();
    const list = drafts(state, [{ type: "text_delta", contentIndex: 0, delta: "he" }]);
    expect(list).toHaveLength(1);
    const f = list[0]!;
    expect(f.type).toBe("message.part.delta");
    expect(f.properties.field).toBe("text");
    expect(typeof f.properties.partID).toBe("string");
    expect(typeof f.properties.messageID).toBe("string");
    expect(f.properties.delta).toBe("he");
    expect(f.properties.sessionID).toBe("ses_test_01");
  });

  it("ids embedded in delta frames are all dash-free", () => {
    const state = newProjectionState();
    const f = findFrame(drafts(state, [{ type: "text_delta", contentIndex: 1, delta: "x" }], "dashy-session-id"), "message.part.delta");
    expect(f.sessionID).toBe("dashy_session_id");
    expect(LOOM_ID_RE.test(f.sessionID)).toBe(true);
    expect(LOOM_ID_RE.test(String(f.properties.partID))).toBe(true);
    expect(LOOM_ID_RE.test(String(f.properties.messageID))).toBe(true);
  });
});

describe("message.updated / message.part.updated（part.id 存在 + tokens 六字段）", () => {
  it("llm-end projects message.updated with info.tokens.{total,input,output,reasoning,cache.read,cache.write}", () => {
    const state = newProjectionState();
    const list = drafts(state, [{ type: "llm-end", msg: assistant(), durationMs: 5 }]);
    const upd = findFrame(list, "message.updated");
    const info = upd.properties.info as Record<string, unknown>;
    expect(info.id).toBe(String(upd.properties.messageID));
    expect(LOOM_ID_RE.test(String(info.id))).toBe(true);
    const tokens = info.tokens as Record<string, unknown>;
    expect(Object.keys(tokens).sort()).toEqual(["cache", "input", "output", "reasoning", "total"]);
    const cache = tokens.cache as Record<string, unknown>;
    expect(Object.keys(cache).sort()).toEqual(["read", "write"]);
    expect(tokens.total).toBe(140);
    expect(tokens.input).toBe(100);
    expect(tokens.output).toBe(40);
    expect(tokens.reasoning).toBe(0); // 内核 Usage 无 reasoning 段（TODO(T38)），形状字段必须在
    expect(cache.read).toBe(7);
    expect(cache.write).toBe(3);
  });

  it("each text block projects message.part.updated carrying part.id", () => {
    const state = newProjectionState();
    const msg = assistant({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    const parts = drafts(state, [{ type: "llm-end", msg, durationMs: 1 }]).filter((d) => d.type === "message.part.updated");
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      const part = p.properties.part as Record<string, unknown>;
      expect(typeof part.id).toBe("string");
      expect(LOOM_ID_RE.test(String(part.id))).toBe(true);
      expect(part.type).toBe("text");
    }
  });

  it("snapshot part id for a text block matches the live delta part id coordinate (splice-replace, no ghost)", () => {
    const state = newProjectionState();
    const delta = findFrame(drafts(state, [{ type: "text_delta", contentIndex: 0, delta: "a" }]), "message.part.delta");
    const snap = findFrame(
      drafts(state, [{ type: "llm-end", msg: assistant(), durationMs: 1 }]),
      "message.part.updated",
    );
    expect((snap.properties.part as Record<string, unknown>).id).toBe(delta.properties.partID);
  });
});

describe("session.idle（必须带 id，否则 UI 挂 120s）", () => {
  it("idle frame carries sessionID AND mirrored id", () => {
    const state = newProjectionState();
    const summary = { turns: 1, continuations: 0, reason: "done", usage: assistant().usage } as never;
    const idle = findFrame(drafts(state, [{ type: "session-end", summary }]), "session.idle");
    expect(idle.properties.sessionID).toBe("ses_test_01");
    expect(idle.properties.id).toBe("ses_test_01");
    const status = idle.properties.status as Record<string, unknown>;
    expect(status.type).toBe("idle");
  });

  it("dashy session id is sanitized in both sessionID and id", () => {
    const state = newProjectionState();
    const summary = { turns: 0, continuations: 0, reason: "done", usage: assistant().usage } as never;
    const idle = findFrame(drafts(state, [{ type: "session-end", summary }], "ses-bad-id"), "session.idle");
    expect(idle.properties.id).toBe("ses_bad_id");
    expect(LOOM_ID_RE.test(String(idle.properties.id))).toBe(true);
  });

  it("three-state convergence rides the idle frame when a converge call was accepted", () => {
    const state = newProjectionState();
    const result: ToolExecResult = {
      content: [{ type: "text", text: "收束已受理，本轮到此结束。" }],
      details: {
        __convergence: {
          converged: true,
          receipt: { status: "待用户回应", digest: "d", body: "b", pointers: [], blockers: "" },
          outcome: { type: "converged", status: "待用户回应" },
        },
      },
    };
    const call = { type: "toolCall", id: "tc_1", name: "converge", arguments: {} } as never;
    const summary = { turns: 2, continuations: 0, reason: "done", usage: assistant().usage } as never;
    const list = drafts(state, [
      { type: "tool-end", call, result, durationMs: 1 },
      { type: "session-end", summary },
    ]);
    // 收束调用本身不发 part（不是 UI 可渲染块）
    expect(list.find((d) => d.type === "message.part.updated")).toBeUndefined();
    const idle = findFrame(list, "session.idle");
    const conv = idle.properties.convergence as Record<string, unknown>;
    expect(conv.status).toBe("待用户回应");
    expect(conv.converged).toBe(true);
  });

  it("no convergence field when nothing converged", () => {
    const state = newProjectionState();
    const summary = { turns: 1, continuations: 0, reason: "aborted", usage: assistant().usage } as never;
    const idle = findFrame(drafts(state, [{ type: "session-end", summary }]), "session.idle");
    expect(idle.properties.convergence).toBeUndefined();
  });
});

describe("children[].id（<task_metadata> 反解进 session.children 帧）", () => {
  const metadataText =
    "done.\n<task_metadata>\nagent_type: general\nsession_id: ses_0a1b2c3d4e5f6789\nreason: done\nturns: 1\ndepth: 1\n</task_metadata>";

  it("tool result with task_metadata emits a children frame with clean ids", () => {
    const state = newProjectionState();
    const result: ToolExecResult = { content: [{ type: "text", text: metadataText }] };
    const call = { type: "toolCall", id: "tc_meta", name: "task", arguments: {} } as never;
    const kids = findFrame(drafts(state, [{ type: "tool-end", call, result, durationMs: 2 }]), "session.children");
    const children = kids.properties.children as Array<Record<string, unknown>>;
    expect(Array.isArray(children)).toBe(true);
    expect(children[0]!.id).toBe("ses_0a1b2c3d4e5f6789");
    expect(LOOM_ID_RE.test(String(children[0]!.id))).toBe(true);
  });

  it("dirty (dashed) child session_id is sanitized, never smuggled raw", () => {
    const state = newProjectionState();
    const dirty = "<task_metadata>\nagent_type: explore\nsession_id: ses-bad-child-id\nreason: done\nturns: 1\ndepth: 1\n</task_metadata>";
    const result: ToolExecResult = { content: [{ type: "text", text: dirty }] };
    const call = { type: "toolCall", id: "tc_dirty", name: "task", arguments: {} } as never;
    const kids = findFrame(drafts(state, [{ type: "tool-end", call, result, durationMs: 1 }]), "session.children");
    const children = kids.properties.children as Array<Record<string, unknown>>;
    expect(LOOM_ID_RE.test(String(children[0]!.id))).toBe(true);
    expect(children[0]!.id).toBe("ses_bad_child_id");
  });

  it("plain tool result emits tool part frame (id present, dash-free) and no children frame", () => {
    const state = newProjectionState();
    const result: ToolExecResult = { content: [{ type: "text", text: "echoed: hi" }] };
    const call = { type: "toolCall", id: "tc-9", name: "echo", arguments: { msg: "hi" } } as never;
    const list = drafts(state, [{ type: "tool-end", call, result, durationMs: 1 }]);
    expect(list.find((d) => d.type === "session.children")).toBeUndefined(); // 无 metadata → 不发 children 帧
    const part = findFrame(list, "message.part.updated");
    const p = part.properties.part as Record<string, unknown>;
    expect(LOOM_ID_RE.test(String(p.id))).toBe(true); // 连字符 call id 已归一
    expect(p.tool).toBe("echo");
    expect((p.state as Record<string, unknown>).output).toBe("echoed: hi");
  });
});

// ────────────── 映射表 ──────────────

describe("VENDOR_TO_LOOM_EVENT 映射表（vendor→loom，缺项 TODO(T38)）", () => {
  const kernelNames = [
    // LiveEvent arms
    "message_start", "text_delta", "thinking_delta", "toolcall_delta", "message_update", "message_end",
    // SessionEvent arms
    "session-start", "turn-start", "llm-end", "tool-end", "turn-end", "continuation-check", "session-end", "error",
  ] as const;

  it("covers every kernel event name (LiveEvent + SessionEvent arms)", () => {
    for (const n of kernelNames) {
      expect(VENDOR_TO_LOOM_EVENT, `kernel name '${n}' missing from mapping`).toHaveProperty(n);
    }
  });

  it("every mapped name is a loom event family name or null (never an unmapped string)", () => {
    for (const [kernel, loom] of Object.entries(VENDOR_TO_LOOM_EVENT)) {
      if (loom === null) continue;
      expect(typeof loom, kernel).toBe("string");
      expect(loom).toMatch(/^(message|session|run|delivery|watchdog)\./);
    }
  });

  it("null-mapped live events emit no frames and never throw", () => {
    const state = newProjectionState();
    const list = drafts(state, [
      { type: "message_start" },
      { type: "thinking_delta", contentIndex: 0, delta: "t" },
      { type: "toolcall_delta", contentIndex: 0, delta: "{" },
      { type: "message_update", message: assistant() },
      { type: "message_end", message: assistant() },
      { type: "turn-end", turnIdx: 0, toolResultsCount: 0, stopReason: "stop" },
      { type: "continuation-check", turns: 1, continuations: 0 },
    ] as Array<LiveEvent | SessionEvent>);
    expect(list).toHaveLength(0);
  });

  it("session.error maps to a frame carrying sessionID + message", () => {
    const state = newProjectionState();
    const err = findFrame(drafts(state, [{ type: "error", phase: "llm", message: "boom" }]), "session.error");
    expect((err.properties.error as Record<string, unknown>).message).toBe("boom");
  });
});

// ────────────── unknown-event tolerance + 订阅者一致性 ──────────────

describe("unknown-event tolerance / 多订阅者一致性", () => {
  it("unrecognized kernel event type is tolerated (no frame, no throw)", () => {
    const state = newProjectionState();
    const bogus = { type: "brand_new_kernel_event", payload: {} } as unknown as LiveEvent;
    expect(projectEvent(state, "ses_1", bogus)).toEqual([]);
  });

  it("same event object projected twice yields identical drafts (WeakMap memoization)", () => {
    const state = newProjectionState();
    const msg = assistant({ content: [{ type: "text", text: "hi" }], usage: assistant().usage });
    const event: SessionEvent = { type: "llm-end", msg, durationMs: 1 };
    const env = { sessionId: "ses_x", track: "recorded", seq: 0, event } as never;
    const a = projectEnvelope(state, env);
    const b = projectEnvelope(state, env); // 第二个订阅者的 pump 投同一对象
    expect(b).toBe(a); // 同一份草案数组：id 一致、序号不重复推进
  });

  it("W32 身份 tick：message_start 单调推进 msg 序号（turn-start 不再对齐），跨 call 不复用", () => {
    const state = newProjectionState();
    // turn-start 投出后序号**不动**（旧方案对齐 run-local turnIdx = 跨回合复用事故的根）
    const status = findFrame(drafts(state, [{ type: "turn-start", turnIdx: 0 }]), "session.status");
    void status;
    const d0 = findFrame(
      drafts(state, [{ type: "message_start" }, { type: "text_delta", contentIndex: 0, delta: "a" }]),
      "message.part.delta",
    );
    const d1 = findFrame(
      drafts(state, [{ type: "message_start" }, { type: "text_delta", contentIndex: 0, delta: "b" }]),
      "message.part.delta",
    );
    expect(d0.properties.messageID).toBe("msg_1");
    expect(d1.properties.messageID).toBe("msg_2");
    expect(d0.properties.messageID).not.toBe(d1.properties.messageID);
    // 同 call 内 part 序号跟随消息：跨 call 的 part id 亦不复用
    expect(d0.properties.partID).toBe("part_1_0");
    expect(d1.properties.partID).toBe("part_2_0");
  });
});

// ────────────── trace replay 投影 ──────────────

describe("projectTraceRecord（Last-Event-ID 补发帧）", () => {
  it("run_end projects a terminal run.status frame with sessionID", () => {
    const list = projectTraceRecord({
      kind: "run_end",
      runId: "run_aaaaaaaaaaaaaaaa",
      sessionId: "ses-b-1",
      status: "ok",
      startedAt: 0,
      endedAt: 10,
      durationMs: 10,
      totals: { input: 1, output: 2, cacheRead: 3, spans: 1 },
    });
    const f = findFrame(list, "run.status");
    expect(f.properties.sessionID).toBe("ses_b_1");
    expect(f.properties.terminal).toBe(true);
    expect(f.properties.status).toBe("ok");
    expect(LOOM_ID_RE.test(String(f.properties.runID))).toBe(true);
  });

  it("span projects run.status with stage; nudge projects watchdog.alarm", () => {
    const span = findFrame(
      projectTraceRecord({
        kind: "span",
        runId: "run_bbbbbbbbbbbbbbbb",
        sessionId: "ses_r",
        spanId: "spn_cccccccccccccccc",
        stage: "turn",
        start: 0,
        end: 5,
        durationMs: 5,
      }),
      "run.status",
    );
    expect(span.properties.stage).toBe("turn");
    const nudge = findFrame(
      projectTraceRecord({ kind: "nudge", runId: "run_dddddddddddddddd", event: "nudge:idle", at: 9 }),
      "watchdog.alarm",
    );
    expect(nudge.properties.event).toBe("nudge:idle");
  });
});
