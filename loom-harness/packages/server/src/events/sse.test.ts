/**
 * T29 验收（集成层）—— 真 HTTP + 真内核会话 + 双订阅者的 SSE 扇出。
 *
 * 逐条转前端硬契约断言（docs/02 验收标准）：
 *   - 双订阅者**全量**收到同一事件集；
 *   - 每帧信封 `{seq, payload:{type,properties}}`，properties 恒存在；
 *   - 每条帧带 sessionID；`session.idle` 带 id；
 *   - 帧文本**绝无 `event:` 行**（默认 message 事件）；
 *   - seq 每订阅者流内单调（从 0 连续 +1）；
 *   - 断连无悬挂：订阅者掉线 → 计数回落、live 退订、再来订阅者拿全新 seq 空间；
 *   - Last-Event-ID 重连：先补发当日 trace jsonl 帧、再切 live；
 *   - 鉴权：无 token / 错 token 401（Router 前置，SSE 也不例外）。
 *
 * 端口纪律（D32）：listen(0) 内核分配 ephemeral，绝不占 5096/8768/8769/18888/5097。
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { AgentSession, localDateKey, type RunSummary } from "@axeuh/loom-core";
import { createFakeModel } from "@axeuh/loom-core/testing";
import type { TraceRecord } from "@axeuh/loom-core";

import { Router } from "../http/router.js";
import { EventHub, SSE_EVENT_LINE_RE, sseStreamHandler, type LoomFrame } from "./index.js";

const GOOD_TOKEN = "tok-events-test";
const FRAME_TIMEOUT_MS = 20_000; // NTFS + fake provider 慢盘余量

let server: Server;
let baseUrl: string;
let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-events-t29-"));
});

afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

async function listen(router: Router): Promise<void> {
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  expect(addr.port).toBeGreaterThanOrEqual(1024); // ephemeral，非特权口
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${GOOD_TOKEN}`, ...extra };
}

// ───────────────────────── SSE 帧读取（fetch body 手解） ─────────────────────────

/** 一条已解析帧 + 原始文本（用于 `event:` 行检查）。 */
interface Captured {
  readonly raw: string;
  readonly frames: LoomFrame[];
}

/** 解析 SSE 文本里所有 `data:` 帧（`\n\n` 分帧；注释行忽略）。 */
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

/**
 * 从流里读到「出现目标谓词满足的帧」为止；超时 reject（防悬挂死等）。
 * 每次读到的原文累计返回，供无 `event:` 行断言。
 */
async function readUntil(
  res: Response,
  done: (frames: readonly LoomFrame[]) => boolean,
  budgetMs = FRAME_TIMEOUT_MS,
): Promise<Captured> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no response body");
  const decoder = new TextDecoder();
  let raw = "";
  const timer = setTimeout(() => void reader.cancel("timeout"), budgetMs);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done: eof } = await reader.read();
      if (value !== undefined) raw += decoder.decode(value, { stream: true });
      const frames = parseFrames(raw);
      if (done(frames)) return { raw, frames };
      if (eof) throw new Error(`stream ended before predicate; got:\n${raw}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const lastType = (type: string) => (frames: readonly LoomFrame[]): boolean =>
  frames.at(-1)?.payload.type === type || frames.some((f) => f.payload.type === type);

// ───────────────────────── 会话夹具 ─────────────────────────

function scriptedSession(sessionId: string): { session: AgentSession; teardown: () => void } {
  const fake = createFakeModel([
    {
      content: [{ type: "text", text: "hello world" }],
      textDeltas: ["hello", " world"],
      stopReason: "stop",
    },
  ]);
  const session = new AgentSession({ model: fake, tools: [], sessionId });
  return { session, teardown: () => fake.teardown() };
}

/** 跑一次带 recorded 轨扇出的会话（模拟 T27 接线：循环里逐条 forwardRecorded）。 */
async function runFanOut(hub: EventHub, session: AgentSession, prompt: string): Promise<RunSummary> {
  const stream = session.runStreaming(prompt);
  for await (const ev of stream) hub.forwardRecorded(ev);
  return await stream.finalSummary;
}

// ───────────────────────── 测试 ─────────────────────────

describe("T29 SSE fan-out —— 双订阅者全量 / 信封 / seq / 无 event: 行 / 断连", () => {
  it("two subscribers both receive the full event set, envelope + sessionID + idle id intact, no event: line, seq monotonic from 0", async () => {
    const { session, teardown } = scriptedSession("ses_dual_01");
    const hub = new EventHub({ session, stateRoot });
    const router = new Router({ tokens: [GOOD_TOKEN] });
    router.add("GET", "/events/stream", sseStreamHandler(() => hub));
    await listen(router);

    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/events/stream`, { headers: authHeaders() }),
      fetch(`${baseUrl}/events/stream`, { headers: authHeaders() }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.headers.get("content-type")).toBe("text/event-stream");
    expect(hub.subscriberCount).toBe(2);

    const both = Promise.all([
      readUntil(resA, lastType("session.idle")),
      readUntil(resB, lastType("session.idle")),
    ]);
    const summary = await runFanOut(hub, session, "go");
    expect(summary.reason).toBe("done");
    const [capA, capB] = await both;

    for (const cap of [capA, capB]) {
      // 帧无 event: 行（前端 onmessage 只收缺省 message 事件）
      expect(cap.raw).not.toMatch(SSE_EVENT_LINE_RE);
      expect(cap.frames.length).toBeGreaterThan(0);
      // 信封 + properties 恒存在 + sessionID 每条必带
      for (const f of cap.frames) {
        expect(f.payload).toBeDefined();
        expect(typeof f.payload.type).toBe("string");
        expect(f.payload.properties).toBeDefined();
        expect(f.payload.properties.sessionID).toBe("ses_dual_01");
        expect(f.payload.properties.sessionID).not.toContain("-");
      }
      // seq 单调：每订阅者从 0 连续 +1
      expect(cap.frames.map((f) => f.seq)).toEqual(cap.frames.map((_, i) => i));
      // idle 带 id
      const idle = cap.frames.find((f) => f.payload.type === "session.idle");
      expect(idle).toBeDefined();
      expect(idle!.payload.properties["id"]).toBe("ses_dual_01");
    }

    // 双订阅者全量：事件类型多重集相等（同一事件集、同一顺序——seq 对齐逐帧同型）
    expect(capB.frames.map((f) => f.payload.type)).toEqual(capA.frames.map((f) => f.payload.type));
    // 跨订阅者 id 一致（WeakMap 记忆化投影）
    expect(capB.frames.map((f) => JSON.stringify(f.payload))).toEqual(
      capA.frames.map((f) => JSON.stringify(f.payload)),
    );
    // 消息增量与完成族都到了
    const types = new Set(capA.frames.map((f) => f.payload.type));
    expect(types.has("message.part.delta")).toBe(true);
    expect(types.has("message.updated")).toBe(true);
    expect(types.has("message.part.updated")).toBe(true);
    expect(types.has("session.status")).toBe(true);

    hub.close();
    expect(hub.subscriberCount).toBe(0);
    teardown();
  }, 30_000);

  it("client disconnect drops the subscriber without dangling; a later subscriber starts a fresh seq space and gets no stale frames", async () => {
    const { session, teardown } = scriptedSession("ses_disc_01");
    const drops: string[] = [];
    const hub = new EventHub({
      session,
      stateRoot,
      onSubscriberDrop: (reason) => drops.push(reason.kind),
    });
    const router = new Router({ tokens: [GOOD_TOKEN] });
    router.add("GET", "/events/stream", sseStreamHandler(() => hub));
    await listen(router);

    const resAborter = new AbortController();
    const doomed = await fetch(`${baseUrl}/events/stream`, {
      headers: authHeaders(),
      signal: resAborter.signal,
    });
    expect(hub.subscriberCount).toBe(1);
    resAborter.abort(); // 客户端硬断连

    await vi.waitFor(() => expect(hub.subscriberCount).toBe(0), { timeout: FRAME_TIMEOUT_MS });
    expect(drops).toContain("client-close");

    // 断连后照常跑一轮：不应因悬挂 pump 写已断连接而炸（写失败也被隔离）
    const summary = await runFanOut(hub, session, "still fine");
    expect(summary.reason).toBe("done");

    // 新订阅者：全新 seq（从 0 起），只收到**本轮之后**的事件（无 stale 重放）
    const res2 = await fetch(`${baseUrl}/events/stream`, { headers: authHeaders() });
    const both = Promise.all([readUntil(res2, lastType("session.idle")), runFanOut(hub, session, "again")]);
    const [cap2] = await both;
    expect(cap2.frames[0]!.seq).toBe(0);
    expect(cap2.frames.map((f) => f.seq)).toEqual(cap2.frames.map((_, i) => i));
    expect(cap2.frames.at(-1)!.payload.type).toBe("session.idle");
    void doomed;

    hub.close();
    expect(hub.subscriberCount).toBe(0);
    teardown();
  }, 30_000);

  it("SSE route keeps auth: no token / bad token => 401 JSON (no unauthenticated path)", async () => {
    const { session, teardown } = scriptedSession("ses_auth_01");
    const hub = new EventHub({ session, stateRoot });
    const router = new Router({ tokens: [GOOD_TOKEN] });
    router.add("GET", "/events/stream", sseStreamHandler(() => hub));
    await listen(router);

    const anon = await fetch(`${baseUrl}/events/stream`);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const bad = await fetch(`${baseUrl}/events/stream`, { headers: { Authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);

    hub.close();
    teardown();
  });
});

describe("T29 Last-Event-ID replay —— 当日 trace jsonl 补发后切 live", () => {
  it("subscribing with Last-Event-ID first replays today's run.status frames, then goes live", async () => {
    const sessionId = "ses_replay_01";

    const records: TraceRecord[] = [
      {
        kind: "span",
        runId: "run_replay_0000000000000001",
        sessionId,
        spanId: "spn_aaaaaaaaaaaaaaaa",
        stage: "assembly",
        start: 1,
        end: 2,
        durationMs: 1,
      },
      {
        kind: "run_end",
        runId: "run_replay_0000000000000001",
        sessionId,
        status: "ok",
        startedAt: 1,
        endedAt: 3,
        durationMs: 2,
        totals: { input: 5, output: 6, cacheRead: 0, spans: 1 },
      },
    ];
    mkdirSync(join(stateRoot, "trace"), { recursive: true });
    const dateKey = localDateKey(Date.now());
    const existingFile = join(stateRoot, "trace", `${dateKey}.jsonl`);
    writeFileSync(existingFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const { session, teardown } = scriptedSession(sessionId);
    const hub = new EventHub({ session, stateRoot });
    const router = new Router({ tokens: [GOOD_TOKEN] });
    router.add("GET", "/events/stream", sseStreamHandler(() => hub));
    await listen(router);

    const res = await fetch(`${baseUrl}/events/stream`, {
      headers: authHeaders({ "Last-Event-ID": "0" }),
    });

    const both = Promise.all([
      readUntil(res, lastType("session.idle")),
      runFanOut(hub, session, "live after replay"),
    ]);
    const [cap] = await both;
    const types = cap.frames.map((f) => f.payload.type);

    // W11a P3：connected 首帧恒先，补发随后：两条 run.status（span 一条 + 终态一条），且都归属本会话
    expect(types.slice(0, 3)).toEqual(["server.connected", "run.status", "run.status"]);
    expect(cap.frames[1]!.payload.properties["stage"]).toBe("assembly");
    expect(cap.frames[2]!.payload.properties["terminal"]).toBe(true);
    for (const f of cap.frames.slice(1, 3)) {
      expect(f.payload.properties.sessionID).toBe(sessionId);
    }
    // 补发后切 live：正常信封族继续到 idle
    expect(types).toContain("message.part.delta");
    expect(types.at(-1)).toBe("session.idle");
    // 全程 seq 连续单调（补发帧也占号）
    expect(cap.frames.map((f) => f.seq)).toEqual(cap.frames.map((_, i) => i));
    expect(cap.raw).not.toMatch(SSE_EVENT_LINE_RE);

    hub.close();
    teardown();
  }, 30_000);

  it("without Last-Event-ID: pure live subscription, no replay frames", async () => {
    const { session, teardown } = scriptedSession("ses_noreplay_1");
    const hub = new EventHub({ session, stateRoot });
    const router = new Router({ tokens: [GOOD_TOKEN] });
    router.add("GET", "/events/stream", sseStreamHandler(() => hub));
    await listen(router);

    const res = await fetch(`${baseUrl}/events/stream`, { headers: authHeaders() });
    const both = Promise.all([readUntil(res, lastType("session.idle")), runFanOut(hub, session, "x")]);
    const [cap] = await both;
    expect(cap.frames.some((f) => f.payload.type === "run.status")).toBe(false);
    expect(cap.frames[0]!.payload.type).not.toBe("run.status");
    hub.close();
    teardown();
  }, 30_000);
});
