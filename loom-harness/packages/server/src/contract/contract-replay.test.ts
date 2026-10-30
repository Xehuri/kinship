/**
 * T38 前端契约一致性验收（批次 3/3）—— Last-Event-ID 重放行（R14）。
 *
 * 装配姿势：抄 events/sse.test.ts 的当日 trace jsonl 夹具写法（stateRoot/trace/{date}.jsonl）
 * + golden/golden-chat.test.ts 的假订阅者（真 ServerResponse 无 socket + write 捕获）。
 * 纯内存枢纽（EventHub.subscribe(res, lastEventId)），无 HTTP；补发语义与 T29 路由层同源。
 *
 * 契约点（docs/02 §T29 权衡 + replay.ts 头注）：
 *   - 带 Last-Event-ID → 先补发当日 trace 里**本会话**的 run.status 帧，再切 live；
 *   - 他会话记录不混入；nudge 行（无会话归属）不补发；
 *   - 补发帧与 live 帧共用同一 seq 计数器：全程从 0 连续单调；
 *   - 补发帧同样带驼峰 sessionID、id 全部 sanitize 无连字符；
 *   - 不带 Last-Event-ID → 纯 live，无 run.status 补发帧。
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, localDateKey, type TraceRecord } from "@axeuh/loom-core";
import { createFakeModel, type FakeModel } from "@axeuh/loom-core/testing";
import { EventHub, LOOM_ID_RE, SSE_EVENT_LINE_RE, type LoomFrame } from "../events/index.js";

const SESSION_ID = "ses_replay_contract";
const OTHER_SESSION_ID = "ses_other_session";

const ownRecords: TraceRecord[] = [
  {
    kind: "span",
    runId: "run_replay_0000000000000001",
    sessionId: SESSION_ID,
    spanId: "spn_aaaaaaaaaaaaaaaa",
    stage: "assembly",
    start: 1,
    end: 2,
    durationMs: 1,
  },
  {
    kind: "run_end",
    runId: "run_replay_0000000000000002",
    sessionId: SESSION_ID,
    status: "ok",
    startedAt: 1,
    endedAt: 3,
    durationMs: 2,
    totals: { input: 5, output: 6, cacheRead: 0, spans: 1 },
  },
];

const foreignRecords: TraceRecord[] = [
  {
    kind: "run_end",
    runId: "run_foreign_0000000000000003",
    sessionId: OTHER_SESSION_ID,
    status: "ok",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    totals: { input: 0, output: 0, cacheRead: 0, spans: 0 },
  },
  { kind: "nudge", runId: "run_nudge_0000000000000004", event: "nudge:idle", at: 9 },
];

function writeTodayTrace(stateRoot: string): void {
  mkdirSync(join(stateRoot, "trace"), { recursive: true });
  const lines = [...ownRecords, ...foreignRecords].map((r) => JSON.stringify(r));
  writeFileSync(join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`), lines.join("\n") + "\n", "utf8");
}

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

function scriptedSession(sessionId: string): { session: AgentSession; model: FakeModel } {
  const fake = createFakeModel([
    { content: [{ type: "text", text: "live after replay" }], textDeltas: ["live"], stopReason: "stop" },
  ]);
  return { session: new AgentSession({ model: fake, tools: [], sessionId }), model: fake };
}

let stateRoot = "";
const created: FakeModel[] = [];

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-contract-replay-"));
});

afterEach(() => {
  for (const m of created.splice(0)) m.teardown();
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("T38 验收表 · Last-Event-ID replay（contract-replay）", () => {
  it("R14a 带 Last-Event-ID：先补发本会话 trace 帧（run.status ×2，顺序=写入序），再切 live 到 idle", async () => {
    writeTodayTrace(stateRoot);
    const { session, model } = scriptedSession(SESSION_ID);
    created.push(model);
    const hub = new EventHub({ session, stateRoot });
    const sub = fakeSubscriber();
    const unsubscribe = hub.subscribe(sub.res, 0);

    const stream = session.runStreaming("go");
    for await (const ev of stream) hub.forwardRecorded(ev);
    const summary = await stream.finalSummary;
    hub.forwardRecorded({ type: "session-end", summary });
    unsubscribe();
    hub.close();

    const raw = sub.text();
    const frames = parseFrames(raw);
    const types = frames.map((f) => f.payload.type);

    // W11a P3：connected 首帧恒先，补发在前：本会话两条（span→run.status stage=assembly，run_end→terminal=true）
    expect(types.slice(0, 3)).toEqual(["server.connected", "run.status", "run.status"]);
    expect(frames[1]!.payload.properties.stage).toBe("assembly");
    expect(frames[2]!.payload.properties.terminal).toBe(true);
    // 他会话 run_end 与 nudge 不混入（本会话补发恰为 2 条 run.status）
    expect(types.filter((t) => t === "run.status")).toHaveLength(2);
    expect(types).not.toContain("watchdog.alarm");
    // 补发后切 live：正常信封族直到 idle 收尾
    expect(types).toContain("message.part.delta");
    expect(types.at(-1)).toBe("session.idle");
    // 全程 seq 从 0 连续（补发帧也占号），重连后仍单调
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    // 补发帧同样带驼峰 sessionID；runID 匹配白名单（读侧本就拒含连字符 id，脏 id 进不了补发）
    for (const f of frames.slice(1, 3)) {
      expect(f.payload.properties.sessionID).toBe(SESSION_ID);
      expect(LOOM_ID_RE.test(String(f.payload.properties.runID))).toBe(true);
    }
    expect(frames[2]!.payload.properties.runID).toBe("run_replay_0000000000000002");
    // 帧文本绝无 event: 行（补发与 live 同通道同纪律）
    expect(raw).not.toMatch(SSE_EVENT_LINE_RE);
  }, 30_000);

  it("R14b 不带 Last-Event-ID：纯 live 订阅，零补发帧", async () => {
    writeTodayTrace(stateRoot);
    const { session, model } = scriptedSession(SESSION_ID);
    created.push(model);
    const hub = new EventHub({ session, stateRoot });
    const sub = fakeSubscriber();
    const unsubscribe = hub.subscribe(sub.res); // lastEventId 缺省 = 不补发

    const stream = session.runStreaming("x");
    for await (const ev of stream) hub.forwardRecorded(ev);
    const summary = await stream.finalSummary;
    hub.forwardRecorded({ type: "session-end", summary });
    unsubscribe();
    hub.close();

    const frames = parseFrames(sub.text());
    expect(frames.some((f) => f.payload.type === "run.status")).toBe(false);
    expect(frames[0]!.seq).toBe(0);
    expect(frames.at(-1)!.payload.type).toBe("session.idle");
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
  }, 30_000);

  it("R14c 补发读取 I/O 异常：发一条 session.error 告知后 live 照常（缺文件则静默零补发）", async () => {
    // 当日路径写成目录 → readFileSync 抛 EISDIR → hub 契约：session.error 一帧后切 live。
    // （缺文件不属异常路径：readTraceFile 返回空数组，此处不测「error 帧」。）
    mkdirSync(join(stateRoot, "trace"), { recursive: true });
    mkdirSync(join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`), { recursive: true });
    const { session, model } = scriptedSession(SESSION_ID);
    created.push(model);
    const hub = new EventHub({ session, stateRoot });
    const sub = fakeSubscriber();
    const unsubscribe = hub.subscribe(sub.res, 0);

    const stream = session.runStreaming("go");
    for await (const ev of stream) hub.forwardRecorded(ev);
    const summary = await stream.finalSummary;
    hub.forwardRecorded({ type: "session-end", summary });
    unsubscribe();
    hub.close();

    const frames = parseFrames(sub.text());
    expect(frames[0]!.payload.type).toBe("server.connected"); // W11a P3：connected 恒为流首帧
    const errIndex = frames.findIndex((f) => f.payload.type === "session.error");
    expect(errIndex).toBe(1); // connected 之后、live 族之前
    expect(frames.slice(2).some((f) => f.payload.type === "message.part.delta")).toBe(true);
    expect(frames.at(-1)!.payload.type).toBe("session.idle");
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
  }, 30_000);
});
