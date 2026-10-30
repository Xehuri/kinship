/**
 * W11a —— 工具执行期事件流单测：帧形断言（对齐 EVENT_API_DOC.md）+ 150ms coalesce
 * 节流语义（假时钟/假调度器，确定性）+ file.edited + tee 透传纪律。
 *
 * 驱动方式 = 手搭 hook 调用序（onPreToolUse → wrapToolExec(next 内喂 chunk) →
 * forwardRecorded(tool-end) 终态），与内核 tool-executor 的真实时序同构；
 * 真 bash 端到端见 serve/w11-live-events.test.ts。
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSession,
  type Hook,
  type HookContext,
  type ToolCall,
  type ToolExecResult,
} from "@axeuh/loom-core";
import { createFakeModel, type FakeModel } from "@axeuh/loom-core/testing";
import type { BashExecOptions, BashOperations } from "@axeuh/loom-tools";

import { EventHub, type LoomFrame } from "./index.js";
import { createToolOutputStream, currentToolExecSite, teeBashOperations, type ToolOutputStream } from "./tool-stream.js";

const SESSION = "ses_stream_unit";
const OK_RESULT: ToolExecResult = { content: [{ type: "text", text: "ok" }] };

let teardowns: FakeModel[] = [];
afterEach(() => {
  for (const m of teardowns.splice(0)) m.teardown();
});

function fakeSubscriber(): { res: ServerResponse; frames: () => LoomFrame[]; raw: () => string } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: string[] = [];
  res.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof res.write;
  return {
    res,
    raw: () => chunks.join(""),
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

/** 假时钟 + 假调度器：节流语义完全确定（不依赖真实 setTimeout 竞速）。 */
function makeClock(startMs = 1_000) {
  let t = startMs;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    advance(ms: number): void {
      t += ms;
      const due = [...pending.entries()].filter(([, job]) => job.at <= t).sort((a, b) => a[1].at - b[1].at);
      for (const [id, job] of due) {
        pending.delete(id);
        job.fn();
      }
    },
    schedule: (fn: () => void, ms: number): (() => void) => {
      const id = ++seq;
      pending.set(id, { at: t + ms, fn });
      return () => {
        pending.delete(id);
      };
    },
    pendingCount: () => pending.size,
  };
}

function ctxOf(sessionId: string = SESSION): HookContext {
  return { sessionId } as unknown as HookContext;
}

/** id 含连字符：sanitize 后 part id 必须无连字符（D31 纪律顺带验收）。 */
function callOf(name: string, args: Record<string, unknown>, id = "call-9"): ToolCall {
  return { id, name, arguments: args } as unknown as ToolCall;
}

interface Harness {
  hub: EventHub;
  stream: ToolOutputStream;
  sub: ReturnType<typeof fakeSubscriber>;
  clock: ReturnType<typeof makeClock>;
  hook: Hook;
}

function harness(opts?: { workspaceRoot?: string; tailChars?: number }): Harness {
  const model = createFakeModel([]);
  teardowns.push(model);
  const session = new AgentSession({ model, tools: [], sessionId: SESSION });
  const hub = new EventHub({ session, heartbeatMs: 0 });
  const sub = fakeSubscriber();
  hub.subscribe(sub.res);
  const clock = makeClock();
  const stream = createToolOutputStream({
    resolveHub: (sid) => (sid === SESSION ? hub : undefined),
    now: clock.now,
    schedule: clock.schedule,
    ...(opts?.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
    ...(opts?.tailChars === undefined ? {} : { tailChars: opts.tailChars }),
  });
  return { hub, stream, sub, clock, hook: stream.hook };
}

/** 同一工具卡的帧序列（按 part.id 匹配——pending/running 新帧与 tool-end 终态帧同 id）。 */
function cardFrames(sub: ReturnType<typeof fakeSubscriber>, callId: string): LoomFrame[] {
  const clean = callId.replace(/-/g, "_");
  const partId = `part_0_tool_${clean}`;
  return sub.frames().filter((f) => {
    if (f.payload.type !== "message.part.updated") return false;
    const part = f.payload.properties["part"] as Record<string, unknown> | undefined;
    return part?.["id"] === partId;
  });
}

function stateOf(frame: LoomFrame): Record<string, unknown> {
  const part = frame.payload.properties["part"] as Record<string, unknown>;
  return part["state"] as Record<string, unknown>;
}

function outputs(frames: readonly LoomFrame[]): string[] {
  return frames
    .map((f) => stateOf(f)["output"])
    .filter((o): o is string => typeof o === "string" && o.length > 0);
}

describe("W11a P1 —— pending→running→completed 三段跃迁（同 part id）", () => {
  it("三段齐发、id 同坐标系、sanitize 生效、slot 收尾归零", async () => {
    const h = harness();
    const call = callOf("bash", { command: "echo hi" }, "call-hy-1");
    h.hook.onPreToolUse!({ call, tool: call as never }, ctxOf());

    let frames = cardFrames(h.sub, call.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.type).toBe("message.part.updated");
    expect(frames[0]!.payload.properties.sessionID).toBe(SESSION);
    const pendingPart = frames[0]!.payload.properties["part"] as Record<string, unknown>;
    expect(pendingPart.type).toBe("tool");
    expect(pendingPart.tool).toBe("bash");
    expect(pendingPart.id).toBe("part_0_tool_call_hy_1"); // messageSeq 坐标系 + sanitizeId(callID)
    expect(pendingPart.callID).toBe("call_hy_1");
    expect(pendingPart.sessionID).toBe(SESSION);
    expect(pendingPart.messageID).toBe("msg_0");
    expect(stateOf(frames[0]!).status).toBe("pending");
    expect(stateOf(frames[0]!).input).toEqual({ command: "echo hi" });

    await h.hook.wrapToolExec!(call, ctxOf(), async () => {
      const site = currentToolExecSite()!;
      expect(site.callID).toBe(call.id);
      expect(site.tool).toBe("bash");
      h.stream.onOutput(site, Buffer.from("hi\n"));
      return OK_RESULT;
    });
    h.hub.forwardRecorded({ type: "tool-end", call, result: OK_RESULT, durationMs: 1 });

    frames = cardFrames(h.sub, call.id);
    expect(frames.map((f) => stateOf(f).status)).toEqual(["pending", "running", "running", "completed"]);
    expect(outputs(frames)).toEqual(["hi\n", "ok"]); // 尾帧 running + 终态 completed（既有 tool-end 投影形状不动）
    const runningFrame = stateOf(frames[1]!);
    expect(typeof (runningFrame.time as { start: number }).start).toBe("number");
    expect(runningFrame.input).toEqual({ command: "echo hi" });
    expect(h.stream.activeSlots()).toBe(0);
  });

  it("converge 调用不发任何 part 帧（与 project.ts 同口径）", async () => {
    const h = harness();
    const call = callOf("converge", { status: "已完成" });
    h.hook.onPreToolUse!({ call, tool: call as never }, ctxOf());
    await h.hook.wrapToolExec!(call, ctxOf(), async () => OK_RESULT);
    expect(h.sub.frames().filter((f) => f.payload.type === "message.part.updated")).toHaveLength(0);
  });

  it("未知会话（子/副会话 resolveHub=undefined）不发帧不炸", async () => {
    const h = harness();
    const call = callOf("bash", { command: "x" });
    h.hook.onPreToolUse!({ call, tool: call as never }, ctxOf("ses_ghost"));
    await h.hook.wrapToolExec!(call, ctxOf("ses_ghost"), async () => OK_RESULT);
    expect(h.sub.frames().some((f) => f.payload.type === "message.part.updated")).toBe(false);
  });
});

describe("W11a P0 —— 输出增量 150ms coalesce（假时钟确定性）", () => {
  it("节流窗内突发 5 chunk = 1 个 output 帧（帧爆防线成立）", async () => {
    const h = harness();
    const call = callOf("bash", { command: "burst" });
    await h.hook.wrapToolExec!(call, ctxOf(), async () => {
      const site = currentToolExecSite()!;
      for (const line of ["a\n", "b\n", "c\n", "d\n", "e\n"]) {
        h.stream.onOutput(site, Buffer.from(line));
        h.clock.advance(20); // 5×20=100ms < 150ms 节流窗
      }
      expect(h.clock.pendingCount()).toBe(1); // 只挂一个尾帧定时器（重复 chunk 不加挂）
      h.clock.advance(150); // 到点尾帧
      return OK_RESULT;
    });
    const frames = cardFrames(h.sub, call.id);
    expect(frames).toHaveLength(2); // 开卡 running + 合并 output 帧（无 pending：未调 onPreToolUse）
    expect(outputs(frames)).toEqual(["a\nb\nc\nd\ne\n"]); // 合并 = 全量顺序累积
    expect(stateOf(frames[1]!).status).toBe("running");
  });

  it("跨窗 chunk 逐窗出帧且 output 单调增长（每帧间隔 = 节流窗）", async () => {
    const h = harness();
    const call = callOf("bash", { command: "slow" });
    await h.hook.wrapToolExec!(call, ctxOf(), async () => {
      const site = currentToolExecSite()!;
      for (const line of ["1\n", "2\n", "3\n"]) {
        h.stream.onOutput(site, Buffer.from(line));
        h.clock.advance(150); // elapsed=0 挂表 → advance 到点 flush
      }
      return OK_RESULT;
    });
    const frames = cardFrames(h.sub, call.id);
    expect(frames).toHaveLength(4); // 开卡 + 3 个 output 帧，收尾无脏不留尾帧
    expect(outputs(frames)).toEqual(["1\n", "1\n2\n", "1\n2\n3\n"]);
    expect(h.clock.pendingCount()).toBe(0);
  });

  it("tail 截断：超上限只留尾部（帧体有界）", async () => {
    const h = harness({ tailChars: 10 });
    const call = callOf("bash", { command: "flood" });
    await h.hook.wrapToolExec!(call, ctxOf(), async () => {
      const site = currentToolExecSite()!;
      h.stream.onOutput(site, Buffer.from("0123456789abcdefghij"));
      h.clock.advance(150);
      return OK_RESULT;
    });
    expect(outputs(cardFrames(h.sub, call.id))).toEqual(["abcdefghij"]);
  });

  it("跨 chunk 撕裂多字节字符不吐乱码（流式解码）", async () => {
    const h = harness();
    const call = callOf("bash", { command: "utf8" });
    const bytes = Buffer.from("好\n", "utf8"); // 3 字节汉字 + 换行
    await h.hook.wrapToolExec!(call, ctxOf(), async () => {
      const site = currentToolExecSite()!;
      h.stream.onOutput(site, bytes.subarray(0, 2)); // 撕裂半个汉字：无文本增量，不发废帧
      h.clock.advance(160);
      expect(outputs(cardFrames(h.sub, call.id))).toEqual([]);
      h.stream.onOutput(site, bytes.subarray(2));
      h.clock.advance(160);
      return OK_RESULT;
    });
    expect(outputs(cardFrames(h.sub, call.id))).toEqual(["好\n"]);
  });

  it("执行抛错也收尾清 slot + 补尾帧（异常路径不悬挂定时器）", async () => {
    const h = harness();
    const call = callOf("bash", { command: "boom" });
    await expect(
      h.hook.wrapToolExec!(call, ctxOf(), async () => {
        const site = currentToolExecSite()!;
        h.stream.onOutput(site, Buffer.from("partial\n"));
        throw new Error("cmd failed");
      }),
    ).rejects.toThrow("cmd failed");
    expect(h.stream.activeSlots()).toBe(0);
    expect(h.clock.pendingCount()).toBe(0);
    expect(outputs(cardFrames(h.sub, call.id))).toEqual(["partial\n"]); // 尾帧已补
  });
});

describe("W11a P2 —— file.edited（write/edit 完成旁路帧）", () => {
  it("write 成功 → properties.file = workspace 基准绝对路径（文档 L511-527）", async () => {
    const h = harness({ workspaceRoot: "/work/root" });
    const call = callOf("write", { path: "sub/note.txt", content: "x" });
    await h.hook.wrapToolExec!(call, ctxOf(), async () => OK_RESULT);
    const edited = h.sub.frames().filter((f) => f.payload.type === "file.edited");
    expect(edited).toHaveLength(1);
    expect(edited[0]!.payload.properties.file).toBe("/work/root/sub/note.txt");
    expect(edited[0]!.payload.properties.sessionID).toBe(SESSION);
  });

  it("edit 发；bash / 失败 / 无 filePath 不发", async () => {
    const h = harness({ workspaceRoot: "/work" });
    await h.hook.wrapToolExec!(callOf("edit", { path: "a.ts" }), ctxOf(), async () => OK_RESULT);
    await h.hook.wrapToolExec!(callOf("bash", { command: "ls" }), ctxOf(), async () => OK_RESULT);
    await h.hook.wrapToolExec!(callOf("write", { path: "b.ts" }), ctxOf(), async () => ({ ...OK_RESULT, isError: true }));
    await h.hook.wrapToolExec!(callOf("write", {}), ctxOf(), async () => OK_RESULT);
    const edited = h.sub.frames().filter((f) => f.payload.type === "file.edited");
    expect(edited).toHaveLength(1);
    expect(edited[0]!.payload.properties.file).toBe("/work/a.ts");
  });
});

describe("W11a P0 —— teeBashOperations 旁路纪律", () => {
  const quietExec = (chunks: readonly string[]): BashOperations => ({
    exec: async (_c: string, _w: string, options: BashExecOptions) => {
      for (const piece of chunks) options.onData(Buffer.from(piece));
      return { exitCode: 0 };
    },
  });

  it("站点=主会话 bash：onData 双通道（vendor 缓冲 + sink）一字不缺", async () => {
    const h = harness();
    const sinkCalls: Array<{ tool: string; text: string }> = [];
    const teed = teeBashOperations(quietExec(["chunk-a\n", "chunk-b\n"]), (site, chunk) =>
      sinkCalls.push({ tool: site.tool, text: chunk.toString("utf8") }),
    );
    const call = callOf("bash", { command: "x" });
    let vendorGot = "";
    await h.hook.wrapToolExec!(call, ctxOf(), async () => {
      const r = await teed.exec("x", "/tmp", { onData: (d: Buffer) => { vendorGot += d.toString("utf8"); } });
      expect(r.exitCode).toBe(0);
      return OK_RESULT;
    });
    expect(sinkCalls).toHaveLength(2);
    expect(sinkCalls.map((c) => c.text)).toEqual(["chunk-a\n", "chunk-b\n"]);
    expect(vendorGot).toBe("chunk-a\nchunk-b\n"); // vendor 滚动缓冲口径一字不动
    expect(sinkCalls[0]!.tool).toBe("bash");
  });

  it("无站点（子/副会话）：sink 不叫，onData 照达", async () => {
    let sinks = 0;
    const teed = teeBashOperations(quietExec(["q\n"]), () => {
      sinks += 1;
    });
    let got = "";
    await teed.exec("q", "/tmp", { onData: (d: Buffer) => { got += d.toString("utf8"); } });
    expect(sinks).toBe(0);
    expect(got).toBe("q\n");
  });

  it("非 bash 站点（task 派发内子跑 bash）不转发（归属错帧防线）", async () => {
    const h = harness();
    let sinks = 0;
    const teed = teeBashOperations(quietExec(["sub-out\n"]), () => {
      sinks += 1;
    });
    await h.hook.wrapToolExec!(callOf("task", { prompt: "p" }), ctxOf(), async () => {
      await teed.exec("x", "/tmp", { onData: () => {} });
      return OK_RESULT;
    });
    expect(sinks).toBe(0);
  });

  it("sink 抛错不反噬 exec 路径（观测面 fail-soft）", async () => {
    const h = harness();
    const teed = teeBashOperations(quietExec(["z\n"]), () => {
      throw new Error("sink exploded");
    });
    let got = "";
    await h.hook.wrapToolExec!(callOf("bash", { command: "z" }), ctxOf(), async () => {
      const r = await teed.exec("z", "/tmp", { onData: (d: Buffer) => { got += d.toString("utf8"); } });
      expect(r.exitCode).toBe(0);
      return OK_RESULT;
    });
    expect(got).toBe("z\n");
  });
});

describe("W11a P3 —— server.connected / server.heartbeat", () => {
  it("订阅即 connected 首帧（seq 0、properties 空袋仅信封纪律补 sessionID、无 event: 行）", () => {
    const model = createFakeModel([]);
    teardowns.push(model);
    const session = new AgentSession({ model, tools: [], sessionId: "ses_conn_unit" });
    const hub = new EventHub({ session, heartbeatMs: 0 });
    const sub = fakeSubscriber();
    hub.subscribe(sub.res);
    expect(sub.frames()).toHaveLength(1);
    const frame = sub.frames()[0]!;
    expect(frame.seq).toBe(0);
    expect(frame.payload.type).toBe("server.connected");
    expect(frame.payload.properties.sessionID).toBe("ses_conn_unit");
    expect(frame.payload.properties.info).toBeUndefined();
    expect(sub.raw()).not.toMatch(/^event:/m);
    hub.close();
  });

  it("heartbeatMs=40：注释帧保留 + server.heartbeat data 帧到点即发（真计时）", async () => {
    const model = createFakeModel([]);
    teardowns.push(model);
    const session = new AgentSession({ model, tools: [], sessionId: "ses_hb_unit" });
    const hub = new EventHub({ session, heartbeatMs: 40 });
    const sub = fakeSubscriber();
    hub.subscribe(sub.res);
    await new Promise((resolve) => setTimeout(resolve, 160));
    const raw = sub.raw();
    expect(raw).toContain(": keepalive"); // 注释帧保留
    const beats = sub.frames().filter((f) => f.payload.type === "server.heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    for (const b of beats) expect(b.payload.properties.sessionID).toBe("ses_hb_unit");
    // data 帧走 #emit：seq 仍从 0 连续（connected=0，其后 1,2,...）
    expect(sub.frames().map((f) => f.seq)).toEqual(sub.frames().map((_, i) => i));
    hub.close();
  }, 20_000);

  it("断连摘除即关心跳（无悬挂定时器写坏连接）", async () => {
    const model = createFakeModel([]);
    teardowns.push(model);
    const session = new AgentSession({ model, tools: [], sessionId: "ses_hb_drop" });
    const hub = new EventHub({ session, heartbeatMs: 30 });
    const sub = fakeSubscriber();
    const unsubscribe = hub.subscribe(sub.res);
    unsubscribe();
    const n = sub.frames().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sub.frames().length).toBe(n); // 摘除后不再有任何新帧
    expect(hub.subscriberCount).toBe(0);
  }, 20_000);
});
