/**
 * T38 前端契约一致性验收（批次 2/3）—— API 面 + 时序行。
 *
 * 验收表真源：docs/02 §T38 + §「Frontend hard contract」行（docs/02:32）。
 * 本文件覆盖行：R10 x-next-cursor 分页头 / R11 401 JSON 形状 /
 * R15 收束→idle 时序（idle 是本轮最后一帧，且在收束盖棺之后）/
 * R16 local_sessions 非空语义 / R17 真 serve 冒烟（health + SSE 订阅，
 * T29/T27 内存装配 + ephemeral 端口代表；真端口行由 T39 在 T31 serve 冒烟后补）。
 *
 * 装配姿势：抄 session-api/session-api.test.ts（真 HTTP ephemeral + token + 假模型）
 * 与 ops-api/ops-api.test.ts（registerOpsRoutes 的 /health）。
 * 端口纪律（D32）：listen(0) 内核分配 ephemeral，测毕 close，绝不占 5096/5097。
 */

import { IncomingMessage, ServerResponse, createServer, type Server } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MemorySessionStore, type Hook, type Message } from "@axeuh/loom-core";
import { MainSessionLoop } from "@axeuh/loom-core/main-loop";
import { createFakeModel, type FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import { Router } from "../http/router.js";
import { HttpError } from "../http/index.js";
import { registerOpsRoutes, type OpsDeps } from "../ops-api/index.js";
import { EventHub, SSE_EVENT_LINE_RE, sseStreamHandler, type LoomFrame } from "../events/index.js";
import { SessionRegistry, registerSessionRoutes } from "../session-api/index.js";

const GOOD_TOKEN = "tok-t38-contract";
const FRAME_TIMEOUT_MS = 20_000; // NTFS 慢盘余量
const VERSION = "0.0.0-t38";

const FAKE_YAML = [
  "server:",
  "  port: 5097",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-contract-workspace",
  "models:",
  "  - id: fake-contract",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    vision: false",
  "    timeout: 60000",
].join("\n");

const MAIN_OK = { status: "已完成" as const, digest: "已完成：契约验收", body: "契约验收通过。" };

function convergeTurn(text: string, deltas: readonly string[]): FakeAssistantResponse {
  return {
    content: [{ type: "text", text }, { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } }],
    textDeltas: [...deltas],
  };
}

function makeRegistry(script: readonly FakeAssistantResponse[]): { registry: SessionRegistry; teardown: () => void } {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [...script]);
  const registry = new SessionRegistry({ model, store: new MemorySessionStore(), stateRoot });
  return { registry, teardown: () => model.teardown() };
}

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";
/** 本会话新建的 registry（afterEach 统一 teardown，防 fake provider 注册泄漏）。 */
const registries: Array<{ teardown: () => void }> = [];

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-contract-t38-"));
});

afterEach(async () => {
  for (const r of registries.splice(0)) r.teardown();
  const s = server;
  server = null;
  if (s !== null) {
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

/** 装配 ops(T30) + session(T27) + SSE 订阅(T29) 三域到一个 Router（T31 生产装配的测试替身）。 */
async function serve(registry: SessionRegistry): Promise<void> {
  const router = new Router({ tokens: [GOOD_TOKEN] });
  const opsDeps: OpsDeps = {
    getConfig: () => parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} }),
    hotStore: null,
    startedAt: Date.now(),
    version: VERSION,
  };
  registerOpsRoutes(router, opsDeps);
  registerSessionRoutes(router, { registry, sessionList: true });
  router.add(
    "GET",
    "/sessions/:sessionId/events",
    sseStreamHandler((id) => {
      const hub = id === undefined ? undefined : registry.hubOf(id);
      if (hub === undefined) throw new HttpError(404, "session_not_found", `no session ${String(id)}`);
      return hub;
    }),
  );
  const s = createServer(router.toRequestHandler());
  server = s;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address() as AddressInfo;
  expect(addr.port).toBeGreaterThanOrEqual(1024); // ephemeral，非特权口
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function newRegistry(script: readonly FakeAssistantResponse[]): SessionRegistry {
  const made = makeRegistry(script);
  registries.push(made);
  return made.registry;
}

function auth(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${GOOD_TOKEN}`, ...extra };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function getJson(path: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: auth(headers) });
}

interface StatusBody {
  readonly sessionID: string;
  readonly status: "idle" | "busy" | "error";
  readonly lastError: string | null;
  readonly activeRuns: number;
  readonly turns: number;
}

async function statusOf(sessionID: string): Promise<StatusBody> {
  const res = await getJson(`/sessions/${sessionID}/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

async function waitForStatus(sessionID: string, want: StatusBody["status"], timeoutMs = FRAME_TIMEOUT_MS): Promise<StatusBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await statusOf(sessionID);
    if (body.status === want) return body;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${want}, got ${body.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function parseFrames(text: string): LoomFrame[] {
  const out: LoomFrame[] = [];
  for (const chunk of text.split("\n\n")) {
    const trimmed = chunk.trim();
    if (trimmed === "" || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
    out.push(JSON.parse(trimmed.slice("data:".length)) as LoomFrame);
  }
  return out;
}

async function readUntil(
  res: Response,
  done: (frames: readonly LoomFrame[]) => boolean,
  budgetMs = FRAME_TIMEOUT_MS,
): Promise<{ raw: string; frames: LoomFrame[] }> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no response body");
  const decoder = new TextDecoder();
  let raw = "";
  const timer = setTimeout(() => void reader.cancel("timeout"), budgetMs);
  try {
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (value !== undefined) raw += decoder.decode(value, { stream: true });
      const frames = parseFrames(raw);
      if (done(frames)) return { raw, frames };
      if (eof) throw new Error(`stream ended early; got:\n${raw}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

/** 建会话并回其 sessionID（顺带验 id 无连字符）。 */
async function createSession(): Promise<string> {
  const created = await postJson("/sessions", {});
  expect(created.status).toBe(201);
  const { sessionID } = (await created.json()) as { sessionID: string };
  expect(sessionID).toMatch(/^[a-zA-Z0-9_]+$/);
  return sessionID;
}

describe("T38 验收表 · API 面与时序（contract-api）", () => {
  it("R10 x-next-cursor 分页头：非末页响应头与 body.nextCursor 同值，翻到底无游标", async () => {
    // 两轮收束 turn = 6 条 message（user/assistant/toolResult ×2）；limit=2 → 恰三页，末页无游标
    const registry = newRegistry([convergeTurn("收束一", ["收"]), convergeTurn("收束二", ["束"])]);
    await serve(registry);
    const sessionID = await createSession();
    await postJson(`/sessions/${sessionID}/messages`, { text: "第一句" });
    await waitForStatus(sessionID, "idle");
    await postJson(`/sessions/${sessionID}/messages`, { text: "第二句" });
    await waitForStatus(sessionID, "idle");

    const page1 = await getJson(`/sessions/${sessionID}/history?limit=2`);
    expect(page1.status).toBe(200);
    const cursor1 = page1.headers.get("x-next-cursor");
    expect(cursor1).toBeTruthy();
    const body1 = (await page1.json()) as { messages: Message[]; nextCursor: string | null };
    expect(body1.nextCursor).toBe(cursor1); // 头 = body 游标（前端任取其一）
    expect(body1.messages.length).toBe(2);

    // 游标作 before 翻更早页，且游标严格前进（不重复同一页）
    const page2 = await getJson(`/sessions/${sessionID}/history?limit=2&before=${encodeURIComponent(cursor1!)}`);
    expect(page2.status).toBe(200);
    const cursor2 = page2.headers.get("x-next-cursor");
    expect(cursor2).toBeTruthy();
    expect(cursor2).not.toBe(cursor1);

    // 翻到最早：末页无游标头（header 与 body 同步为 null），且能看到首句
    const page3 = await getJson(`/sessions/${sessionID}/history?limit=2&before=${encodeURIComponent(cursor2!)}`);
    expect(page3.status).toBe(200);
    const body3 = (await page3.json()) as { messages: Message[]; nextCursor: string | null };
    expect(body3.nextCursor).toBeNull();
    expect(page3.headers.get("x-next-cursor")).toBeNull();
    expect(body3.messages.map(messageText)).toContain("第一句");
  }, 30_000);

  it("R11 401 JSON 形状：{error:{code,message}}，code='unauthorized'（缺头与错头同形）", async () => {
    const registry = newRegistry([]);
    await serve(registry);
    for (const path of ["/health", `/sessions`, `/sessions/ses_x/status`]) {
      const anon = await fetch(`${baseUrl}${path}`);
      expect(anon.status, path).toBe(401);
      expect(anon.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      const body = (await anon.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unauthorized");
      expect(typeof body.error.message).toBe("string");
    }
    const bad = await fetch(`${baseUrl}/health`, { headers: { Authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  }, 30_000);

  it("R15 收束→idle 时序：idle 是本轮最后一帧，且带三态收束字段（盖棺在 idle 之前）", async () => {
    // 时序真相源 = recorded session-end 投影（convergence 随 idle 带出）；
    // registry 的 publish 注入通道不带收束字段，故本行用 golden-chat 式内存全链。
    const sessionId = "ses_r15_timing";
    const model = createFakeModel([convergeTurn("正文完成", ["正文", "完成"])]);
    registries.push({ teardown: () => model.teardown() });
    let hub: EventHub | null = null;
    const recorder: Hook = {
      name: "contract.r15-forwarder",
      onTurnStart(input) {
        hub?.forwardRecorded({ type: "turn-start", turnIdx: input.turnIdx });
      },
      onLlmEnd(input) {
        hub?.forwardRecorded({ type: "llm-end", msg: input.msg, durationMs: input.durationMs });
      },
      onPostToolUse(input) {
        hub?.forwardRecorded({ type: "tool-end", call: input.call, result: input.result, durationMs: input.durationMs });
      },
    };
    const loop = MainSessionLoop.create({
      model,
      store: new MemorySessionStore(),
      sessionId,
      extraHooks: [recorder],
      logSink: () => {},
      consoleSink: () => {},
    });
    hub = new EventHub({ session: loop.session, stateRoot });
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    const chunks: string[] = [];
    res.write = ((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof res.write;
    const unsubscribe = hub.subscribe(res);

    const result = await loop.start("汇报状态");
    hub.forwardRecorded({ type: "session-end", summary: result.summary });
    const frames = parseFrames(chunks.join(""));
    unsubscribe();
    hub.close();

    expect(result.type).toBe("converged");
    // 收束盖棺先于 idle：idle 恒为最后一帧，其后绝无 delta/updated 补刀
    expect(frames.at(-1)!.payload.type).toBe("session.idle");
    const idleIndex = frames.findIndex((f) => f.payload.type === "session.idle");
    expect(frames.slice(idleIndex + 1)).toEqual([]);
    // busy（turn-start 投影）在 idle 之前，delta 流在 idle 之前
    expect(frames.slice(0, idleIndex).some((f) => f.payload.type === "session.status")).toBe(true);
    expect(frames.slice(0, idleIndex).some((f) => f.payload.type === "message.part.delta")).toBe(true);

    const idle = frames[idleIndex]!;
    expect(idle.payload.properties.sessionID).toBe(sessionId); // 驼峰 sessionID
    expect(idle.payload.properties.id).toBe(sessionId); // 镜像 id
    const conv = idle.payload.properties.convergence as { status: string; converged: boolean };
    expect(conv.status).toBe("已完成");
    expect(conv.converged).toBe(true);
  }, 30_000);

  it("R16 local_sessions 非空语义：新建后会话列表非空、含该 sessionID（驼峰）与状态词表", async () => {
    const registry = newRegistry([convergeTurn("收束", ["收"])]);
    await serve(registry);
    const empty = await getJson("/sessions");
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { sessions: Array<{ sessionID: string; status: string }>; count: number };
    expect(emptyBody.sessions).toEqual([]); // 空集法语义：count=0（前端非空判定据此）
    expect(emptyBody.count).toBe(0);

    const sessionID = await createSession();
    const listed = await getJson("/sessions");
    const body = (await listed.json()) as { sessions: Array<{ sessionID: string; status: string }>; count: number };
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.count).toBe(body.sessions.length);
    expect(body.sessions.map((s) => s.sessionID)).toContain(sessionID);
    expect(["idle", "busy", "error"]).toContain(body.sessions[0]!.status);
  }, 30_000);

  it("R17 真 serve 冒烟（内存装配替身）：/health 200 + SSE 订阅收帧，ephemeral 端口测毕 close", async () => {
    const registry = newRegistry([convergeTurn("冒烟", ["冒", "烟"])]);
    await serve(registry);

    const health = await getJson("/health");
    expect(health.status).toBe(200);
    const hb = (await health.json()) as { status: string; version: string; uptimeMs: number; startedAt: string };
    expect(hb.status).toBe("ok");
    expect(hb.version).toBe(VERSION);
    expect(new Date(hb.startedAt).getTime()).toBeLessThanOrEqual(Date.now());

    const sessionID = await createSession();
    const stream = await fetch(`${baseUrl}/sessions/${sessionID}/events`, { headers: auth() });
    expect(stream.status).toBe(200);
    const both = readUntil(stream, (frames) => frames.some((f) => f.payload.type === "session.idle"));
    await postJson(`/sessions/${sessionID}/messages`, { text: "冒烟一发" });
    const cap = await both;
    expect(cap.frames.length).toBeGreaterThan(0);
    expect(cap.raw).not.toMatch(SSE_EVENT_LINE_RE);
    expect(cap.frames.at(-1)!.payload.type).toBe("session.idle");
    expect(cap.frames.every((f) => f.payload.properties.sessionID === sessionID)).toBe(true);
    // afterEach 关 server：此处仅确认端口是本进程 ephemeral 分配（非 5096/5097）
    expect(Number(new URL(baseUrl).port)).not.toBe(5096);
    expect(Number(new URL(baseUrl).port)).not.toBe(5097);
  }, 30_000);
});
