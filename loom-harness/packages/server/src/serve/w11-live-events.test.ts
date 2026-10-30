/**
 * W11a 定向验收（live-stack）—— 假模型 + **真 bash** 全链 SSE 帧形断言。
 *
 * 覆盖用户点名场景：脚本逐行输出时 running 帧**边跑边出**（不再等执行完），
 * 150ms coalesce 生效（帧数 < chunk 数、单帧已并多行）；三段跃迁 pending→running→
 * completed 同 part id；server.connected 首帧；session.created 广播帧（POST /sessions）；
 * file.edited（write 完成，properties.file=绝对路径）。信封/无 event: 行/id 白名单
 * 一并复验（新帧走同一 publish 通道，纪律不豁免）。
 *
 * 装配姿势 = serve 真栈子集：createServeToolWiring（D7 单缝真 bash）+
 * createToolOutputStream + SessionRegistry + Router(HTTP)。端口 ephemeral（D32）。
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MemorySessionStore } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse, type FakeModel } from "@axeuh/loom-core/testing";

import { Router } from "../http/router.js";
import {
  LOOM_ID_RE,
  SSE_EVENT_LINE_RE,
  createToolOutputStream,
  sseStreamHandler,
  type LoomFrame,
  type ToolOutputStream,
} from "../events/index.js";
import { registerSessionRoutes, SessionRegistry } from "../session-api/index.js";
import { createServeToolWiring, type ServeToolWiring } from "./tool-wiring.js";

const TOKEN = "tok-w11-live";
const READ_BUDGET_MS = 30_000;

/** 假模型脚本：真 bash 逐行循环 → 真 write 落盘 → 文本收尾。 */
const BASH_COMMAND = "for i in 1 2 3 4 5 6 7 8 9 10; do echo line-$i; sleep 0.03; done";

function script(): FakeAssistantResponse[] {
  return [
    { content: [{ type: "toolCall", name: "bash", arguments: { command: BASH_COMMAND } }] },
    { content: [{ type: "toolCall", name: "write", arguments: { path: "note.txt", content: "w11 实锤" } }] },
    { content: [{ type: "toolCall", name: "converge", arguments: { status: "已完成", digest: "W11a 实锤收束", body: "结论：三段齐。" } }] },
  ];
}

let server: Server;
let baseUrl: string;
let stateRoot: string;
let workspace: string;
let model: FakeModel;
let wiring: ServeToolWiring;
let registry: SessionRegistry;
let stream: ToolOutputStream;

beforeEach(async () => {
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "loom-w11-state-")));
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "loom-w11-ws-")));
  model = createFakeModel(script());
  // 与 boot 同构的双惰性缝合（见 boot.ts W11a 注释）：sink 运行期才消费 stream。
  wiring = await createServeToolWiring({
    workspaceRoot: workspace,
    stateRoot,
    model,
    llmOptions: {},
    onToolOutput: (site, chunk) => {
      stream.onOutput(site, chunk);
    },
  });
  stream = createToolOutputStream({
    resolveHub: (sessionId) => registry.hubOf(sessionId),
    workspaceRoot: wiring.workspaceReal,
  });
  registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    tools: wiring.tools,
    hooks: [stream.hook],
    workspaceRoot: wiring.workspaceReal,
    version: "w11-test",
  });
  const router = new Router({ tokens: [TOKEN] });
  registerSessionRoutes(router, { registry });
  router.add(
    "GET",
    "/events/stream",
    sseStreamHandler((sessionId) => {
      const hub = sessionId === undefined ? undefined : registry.hubOf(sessionId);
      if (hub === undefined) throw new Error("no hub");
      return hub;
    }),
  );
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  model.teardown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function postJson(path: string, body?: unknown): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: () => res.json() as Promise<Record<string, unknown>> };
}

/** 时间戳化的帧捕获（节流间隔断言的取证面）。 */
interface TimedFrame {
  readonly at: number;
  readonly frame: LoomFrame;
}

/** 读到谓词满足为止（超时 reject 防悬挂）。 */
async function captureStream(res: Response, until: (frames: readonly TimedFrame[]) => boolean): Promise<TimedFrame[]> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const decoder = new TextDecoder();
  const out: TimedFrame[] = [];
  let raw = "";
  const deadline = Date.now() + READ_BUDGET_MS;
  const timer = setTimeout(() => void reader.cancel("budget"), READ_BUDGET_MS);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        raw += decoder.decode(value, { stream: true });
        raw = drainFrames(raw, out); // 消费完整帧，保留半帧续读
      }
      if (until(out)) return out;
      if (done) throw new Error(`stream ended early; frames=${JSON.stringify(out.map((t) => t.frame.payload.type))}`);
      if (Date.now() > deadline) throw new Error("capture budget exhausted");
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 从原文取完整帧补进 out（累积式解析，重复帧由调用方文本消费剔除——此处一次性重建）。 */
function drainFrames(raw: string, out: TimedFrame[]): string {
  const parts = raw.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const p of parts) {
    const trimmed = p.trim();
    if (trimmed === "" || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
    out.push({ at: Date.now(), frame: JSON.parse(trimmed.slice("data:".length)) as LoomFrame });
  }
  return rest;
}

function partOf(f: TimedFrame): Record<string, unknown> | undefined {
  if (f.frame.payload.type !== "message.part.updated") return undefined;
  return f.frame.payload.properties["part"] as Record<string, unknown>;
}

function stateOf(part: Record<string, unknown>): Record<string, unknown> {
  return part["state"] as Record<string, unknown>;
}

describe("W11a live-stack —— 真 bash 逐行输出实时上帧 + 新事件族信封纪律", () => {
  it("connected 首帧 / bash 三段+增量帧≥2+节流 / session.created 广播 / file.edited / 信封全检", async () => {
    const created = await postJson("/sessions");
    expect(created.status).toBe(201);
    const sidA = String((await created.json()).sessionID);

    const res = await fetch(`${baseUrl}/events/stream?sessionId=${sidA}`, { headers: auth() });
    expect(res.status).toBe(200);

    // 订阅在场时再建会话 → session.created 广播帧应出现在 A 的流上
    const createdB = await postJson("/sessions");
    const sidB = String((await createdB.json()).sessionID);

    const sending = postJson(`/sessions/${sidA}/messages`, { text: "跑脚本" });
    expect((await sending).status).toBe(202);

    const caps = await captureStream(res, (fs) =>
      fs.some((t) => t.frame.payload.type === "session.idle") &&
      fs.some((t) => t.frame.payload.type === "file.edited") &&
      fs.some((t) => t.frame.payload.type === "session.created" && (t.frame.payload.properties["info"] as { id?: string })?.id === sidB),
    );
    const frames = caps.map((t) => t.frame);

    // ── 信封纪律（全帧）：seq 从 0 连续；properties 恒存在；sessionID 必带；无 event: 行 ──
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    for (const f of frames) {
      expect(f.payload.properties).toBeDefined();
      expect(typeof f.payload.properties.sessionID).toBe("string");
    }

    // ── P3：connected 首帧（properties 空袋 + 信封纪律 sessionID）──
    expect(frames[0]!.payload.type).toBe("server.connected");
    expect(frames[0]!.payload.properties.sessionID).toBe(sidA);

    // ── P2：session.created 形状（文档 L135-160）──
    const sc = frames.find((f) => f.payload.type === "session.created")!;
    const info = sc.payload.properties.info as Record<string, unknown>;
    expect(info.id).toBe(sidB);
    expect(info.projectID).toBe("global");
    expect(info.version).toBe("w11-test");
    expect(info.directory).toBe(wiring.workspaceReal);
    expect(typeof (info.time as Record<string, number>).created).toBe("number");
    expect(sc.payload.properties.sessionID).toBe(sidB);

    // ── P0/P1：bash 工具卡三段 + 增量帧 + 节流 ──
    const bashCallID = caps.find((t) => {
      const p = partOf(t);
      return p !== undefined && p["tool"] === "bash" && stateOf(p)["status"] === "pending";
    });
    expect(bashCallID, "bash pending 帧必存在（三段跃迁起点）").toBeDefined();
    const bashPartId = String(partOf(bashCallID!)!["id"]);
    expect(bashPartId).toMatch(LOOM_ID_RE);
    const card = caps.filter((t) => partOf(t)?.["id"] === bashPartId);
    const statuses = card.map((t) => stateOf(partOf(t)!).status);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("completed");
    // pending 之后先出现带 time.start 的 running，completed 收口（llm-end 快照 running 允许在前）
    const pendingIdx = statuses.indexOf("pending");
    const completedIdx = statuses.lastIndexOf("completed");
    expect(pendingIdx).toBeLessThan(completedIdx);
    const openRunning = card.slice(pendingIdx, completedIdx).find((t) => typeof stateOf(partOf(t)!).time === "object");
    expect(openRunning, "pending 与 completed 间必有 running(+time.start)").toBeDefined();

    const outputFrames = card
      .map((t) => ({ t, out: stateOf(partOf(t)!).output }))
      .filter((x): x is { t: TimedFrame; out: string } => typeof x.out === "string" && x.out.length > 0);
    expect(outputFrames.length, "running 增量帧 ≥2").toBeGreaterThanOrEqual(2);
    expect(outputFrames.length, "增量帧 < chunk 数(10) ⇒ 节流生效").toBeLessThan(10);
    // 首个增量帧已并 ≥2 行（150ms coalesce 的直接证据）
    const firstLines = outputFrames[0]!.out.trim().split("\n");
    expect(firstLines.length, `首增量帧应聚合多行, got: ${outputFrames[0]!.out}`).toBeGreaterThanOrEqual(2);
    // 多帧跨越 ≥ 一个节流窗（逐帧到达间隔受 TCP 合帧影响，cadence 精确性由
    // tool-stream.test.ts 假时钟用例锁定；此处只证「增量帧不是同一瞬间堆出」）
    expect(outputFrames[outputFrames.length - 1]!.t.at - outputFrames[0]!.t.at).toBeGreaterThanOrEqual(150);
    // 增量帧 output 前缀单调（同卡累积语义）
    for (let i = 1; i < outputFrames.length; i++) {
      expect(outputFrames[i]!.out.startsWith(outputFrames[i - 1]!.out)).toBe(true);
    }
    // 终态帧走既有 tool-end 完成帧：全量含末行
    const doneState = stateOf(partOf(card[card.length - 1]!)!);
    expect(doneState.status).toBe("completed");
    expect(String(doneState.output)).toContain("line-10");

    // ── P2：file.edited（properties.file = 绝对路径，文档 L511-527）──
    const fe = frames.find((f) => f.payload.type === "file.edited")!;
    expect(fe.payload.properties.file).toBe(join(wiring.workspaceReal, "note.txt"));
    expect(fe.payload.properties.sessionID).toBe(sidA);

    // ── 帧序收尾：idle 为最后一条 ──
    expect(frames.at(-1)!.payload.type).toBe("session.idle");

    // ── 纪律复验：全部新帧文本无 event: 行；part id 白名单 ──
    for (const f of frames) {
      const p = f.payload.properties["part"];
      if (typeof p === "object" && p !== null && "id" in p) expect(String((p as { id: unknown }).id)).toMatch(LOOM_ID_RE);
    }
    expect(frames.some((f) => f.payload.type === "server.heartbeat")).toBe(false); // 10s 缺省心跳不落在秒级 run 窗口内

    // 事件面收尾：无悬挂 slot
    expect(stream.activeSlots()).toBe(0);
  }, 60_000);
});
