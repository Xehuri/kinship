/**
 * T27 验收：会话域 API（发送 / 语音中止再发 / 历史游标分页 / 中止 / 状态）。
 *
 * 逐条转 docs/02 §T27 验收标准：
 *   - send →（假模型）SSE deltas → idle（idle 带 sessionID + id）；
 *   - history 分页返回 x-next-cursor，游标可翻更早页；
 *   - abort 停当前轮（busy→idle）；
 *   - status 迁移 idle→busy→idle / error→busy→idle；
 *   - 语音「先中止再发送」语义端点；
 *   - id 无连字符（前端硬口径）。
 *
 * 端口纪律：listen(0) ephemeral；假模型离线（createFakeModelFromConfig）；无真网络。
 * SSE 订阅端点由 T29 的 sseStreamHandler 在测试内接线（T31 生产装配；本模块不实现它）。
 */

import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import {
  MemorySessionStore,
  type HarnessTool,
  type Message,
  type SessionEntry,
  type SessionStore,
  type StoredEntry,
  type WorkerOutcome,
} from "@axeuh/loom-core";
import { JsonlSessionStore } from "@axeuh/loom-adapters";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import { Router } from "../http/router.js";
import { HttpError } from "../http/index.js";
import { SSE_EVENT_LINE_RE, sseStreamHandler, type LoomFrame } from "../events/index.js";
import { SessionRegistry, registerSessionRoutes } from "./index.js";
import type { PendingItemView, SkillsSniff } from "./types.js";

const GOOD_TOKEN = "tok-session-api";
const FRAME_TIMEOUT_MS = 20_000;

const FAKE_YAML = [
  "server:",
  "  port: 5097",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-session-api-workspace",
  "models:",
  "  - id: fake-session-api",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    vision: false",
  "    timeout: 60000",
].join("\n");

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：会话域验收",
  body: "会话域验收通过。",
};

function convergeTurn(text: string, deltas: readonly string[]): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
    ],
    textDeltas: [...deltas],
  };
}

function makeRegistry(
  script: readonly FakeAssistantResponse[],
  opts: { interruptOnSend?: boolean } = {},
): {
  registry: SessionRegistry;
  teardown: () => void;
} {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [...script]);
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    ...(opts.interruptOnSend === undefined ? {} : { interruptOnSend: opts.interruptOnSend }),
  });
  return { registry, teardown: () => model.teardown() };
}

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";
let fetchTargets: string[] = [];

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-session-api-t27-"));
  fetchTargets = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    fetchTargets.push(String(input));
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
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

/** 离线佐证：全程 fetch 只打到本进程 ephemeral 端口（无任何外网 provider 调用）。 */
function expectOffline(): void {
  for (const target of fetchTargets) expect(target).toContain(baseUrl);
}

async function listen(registry: SessionRegistry): Promise<void> {
  const router = new Router({ tokens: [GOOD_TOKEN] });
  registerSessionRoutes(router, { registry, sessionList: true });
  // T29 订阅 handler 的测试内接线（生产由 T31 装配；session-api 源码不实现它）。
  router.add(
    "GET",
    "/sessions/:sessionId/events",
    sseStreamHandler((id) => {
      const hub = id === undefined ? undefined : registry.hubOf(id);
      if (hub === undefined) throw new HttpError(404, "session_not_found", `no session ${String(id)}`);
      return hub;
    }),
  );
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${GOOD_TOKEN}` };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: auth() });
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

async function waitForStatus(
  sessionID: string,
  want: StatusBody["status"],
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<StatusBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await statusOf(sessionID);
    if (body.status === want) return body;
    if (Date.now() > deadline) throw new Error(`timeout waiting for status ${want}, got ${body.status}`);
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

// ───────────────────────── 测试 ─────────────────────────

describe("T27 会话域 API", () => {
  it("send → SSE deltas → idle（idle 带 sessionID + id；帧无 event: 行；id 无连字符）", async () => {
    const { registry, teardown } = makeRegistry([convergeTurn("你好，世界", ["你好", "，世界"])]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      expect(created.status).toBe(201);
      const { sessionID } = (await created.json()) as { sessionID: string };
      expect(sessionID).not.toContain("-");
      expect(sessionID).toMatch(/^[a-zA-Z0-9_]+$/);

      const stream = await fetch(`${baseUrl}/sessions/${sessionID}/events`, { headers: auth() });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toBe("text/event-stream");

      const both = readUntil(stream, (frames) => frames.some((f) => f.payload.type === "session.idle"));
      const sent = await postJson(`/sessions/${sessionID}/messages`, { text: "在吗" });
      expect(sent.status).toBe(202);
      expect(((await sent.json()) as { status: string }).status).toBe("busy");

      const { raw, frames } = await both;
      expect(raw).not.toMatch(SSE_EVENT_LINE_RE);

      for (const f of frames) {
        expect(f.payload.properties).toBeDefined();
        expect(f.payload.properties.sessionID).toBe(sessionID);
        expect(f.payload.properties.sessionID).not.toContain("-");
      }

      const delta = frames.find((f) => f.payload.type === "message.part.delta");
      expect(delta).toBeDefined();
      expect(delta!.payload.properties["field"]).toBe("text");

      const idle = frames.find((f) => f.payload.type === "session.idle");
      expect(idle).toBeDefined();
      expect(idle!.payload.properties["id"]).toBe(sessionID);

      const status = await waitForStatus(sessionID, "idle");
      expect(status.turns).toBe(1);
      expectOffline();
    } finally {
      teardown();
    }
  }, 30_000);

  it("history 分页：limit 翻页经 x-next-cursor，最后一页无游标", async () => {
    const { registry, teardown } = makeRegistry([convergeTurn("收束", ["收"])]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      await postJson(`/sessions/${sessionID}/messages`, { text: "第一句" });
      await waitForStatus(sessionID, "idle");

      const page1 = await getJson(`/sessions/${sessionID}/history?limit=1`);
      expect(page1.status).toBe(200);
      const cursor1 = page1.headers.get("x-next-cursor");
      expect(cursor1).toBeTruthy();
      const body1 = (await page1.json()) as { messages: Message[]; nextCursor: string | null };
      expect(body1.messages.length).toBe(1);
      expect(body1.nextCursor).toBe(cursor1);

      const page2 = await getJson(
        `/sessions/${sessionID}/history?limit=1&before=${encodeURIComponent(cursor1!)}`,
      );
      expect(page2.status).toBe(200);
      const cursor2 = page2.headers.get("x-next-cursor");
      expect(cursor2).toBeTruthy();
      expect(cursor2).not.toBe(cursor1);

      // 一路翻到最早：最终页无游标，且能看到首句 user 消息
      const seen: string[] = [];
      let before: string | null = cursor2;
      for (let i = 0; i < 10 && before !== null; i++) {
        const p = await getJson(`/sessions/${sessionID}/history?limit=1&before=${encodeURIComponent(before)}`);
        const b = (await p.json()) as { messages: Message[]; nextCursor: string | null };
        seen.push(...b.messages.map(messageText));
        before = b.nextCursor;
      }
      expect(seen.join("\n")).toContain("第一句");

      const badCursor = await getJson(`/sessions/${sessionID}/history?before=@@not-base64@@`);
      // base64url 解码对非法串宽容，但指向不存在的 entry → 空页；此处仅保证不 500
      expect([200, 400]).toContain(badCursor.status);
    } finally {
      teardown();
    }
  }, 30_000);

  it("abort 停当前轮：busy→aborted→idle", async () => {
    const { registry, teardown } = makeRegistry([
      { content: [{ type: "text", text: "慢慢来" }], delayMs: 1500 },
    ]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      await postJson(`/sessions/${sessionID}/messages`, { text: "开始" });
      await waitForStatus(sessionID, "busy");

      const aborted = await postJson(`/sessions/${sessionID}/abort`, {});
      expect(aborted.status).toBe(200);
      expect(((await aborted.json()) as { aborted: boolean }).aborted).toBe(true);

      await waitForStatus(sessionID, "idle");
      const after = await statusOf(sessionID);
      expect(after.status).toBe("idle");
      expect(after.lastError).toBeNull();
    } finally {
      teardown();
    }
  }, 30_000);

  it("status 迁移：idle→busy→idle，error 后下一次 send 恢复 busy→idle", async () => {
    const { registry, teardown } = makeRegistry([
      { content: [{ type: "text", text: "boom" }], throwError: new Error("provider exploded") },
      convergeTurn("恢复", ["恢"]),
    ]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      expect((await statusOf(sessionID)).status).toBe("idle");

      await postJson(`/sessions/${sessionID}/messages`, { text: "触发错误" });
      const errored = await waitForStatus(sessionID, "error");
      expect(errored.lastError).toContain("provider exploded");

      await postJson(`/sessions/${sessionID}/messages`, { text: "再来" });
      await waitForStatus(sessionID, "idle");
      expect((await statusOf(sessionID)).turns).toBe(2);
    } finally {
      teardown();
    }
  }, 30_000);

  it("语音立接立回（W16-F2）：busy+voice 即刻 202（不等旧轮），旧轮 aborted 收尾，语音轮进转录", async () => {
    const { registry, teardown } = makeRegistry([
      { content: [{ type: "text", text: "第一轮慢跑" }], delayMs: 3000 },
      convergeTurn("第二轮收束", ["第二"]),
    ]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      await postJson(`/sessions/${sessionID}/messages`, { text: "第一句" });
      await waitForStatus(sessionID, "busy");

      // 旧语义回归哨兵：响应必须远早于旧轮 3000ms 收尾时刻（旧实现同步等收尾）。
      const t0 = Date.now();
      const voice = await postJson(`/sessions/${sessionID}/voice`, { text: "第二句" });
      const elapsedMs = Date.now() - t0;
      expect(voice.status).toBe(202);
      expect(((await voice.json()) as { accepted: boolean }).accepted).toBe(true);
      expect(elapsedMs, "立接立回：/voice 不得同步等旧轮").toBeLessThan(1000);

      // 后台链顺序保真：旧轮 aborted → 语音轮起轮跑完（turns=2），语音消息恰落转录一次。
      const idle = await waitForStatus(sessionID, "idle");
      expect(idle.turns).toBe(2);

      const page = await getJson(`/sessions/${sessionID}/history?limit=200`);
      const body = (await page.json()) as { messages: Message[] };
      const texts = body.messages.map(messageText);
      expect(texts.filter((t) => t.includes("第二句"))).toHaveLength(1);
    } finally {
      teardown();
    }
  }, 30_000);

  it("鉴权继承 Router（无 token 401）与未知会话 404", async () => {
    const { registry, teardown } = makeRegistry([]);
    await listen(registry);
    try {
      const unauth = await fetch(`${baseUrl}/sessions/ses_abc/status`);
      expect(unauth.status).toBe(401);
      const missing = await getJson("/sessions/ses_deadbeefdeadbeef/status");
      expect(missing.status).toBe(404);
    } finally {
      teardown();
    }
  }, 30_000);
});

describe("W12 queueReminder：主会话提醒滞留与可见性", () => {
  /** 直接轮询注册表状态（本组用例不走 HTTP，无 listen）。 */
  async function waitIdle(registry: SessionRegistry, sessionID: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (registry.get(sessionID)?.running === null) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`会话 ${sessionID} 未在预算内收尾`);
  }

  it("无会话时 orphan 滞留 → 首注册会话按序冲刷；未注册 sid 按 sid 滞留、ensure 时冲刷", () => {
    const { registry, teardown } = makeRegistry([]);
    try {
      registry.queueReminder(undefined, "[run-reminder] run=run_orphan01 status=done");
      registry.queueReminder(undefined, "[run-reminder] run=run_orphan02 status=partial");
      registry.queueReminder("ses_unregistered00001", "[run-reminder] run=run_detached status=done");
      // orphan 无落点（无在册会话、无缺省主会话）；detached 层按 sid 可见。
      expect(registry.defaultMainSessionId()).toBeUndefined();
      expect(registry.pendingReminderCount("ses_unregistered00001")).toBe(1);

      const rec = registry.create();
      // 首注册会话 = 缺省主会话；orphan 全部按入队序冲进入其边界队列（滞留可见 = loop.pendingReminders）。
      expect(registry.defaultMainSessionId()).toBe(rec.sessionID);
      expect(rec.loop.pendingReminders()).toBe(2);

      // detached sid 真正注册时冲刷进同一队列。
      const later = registry.ensure("ses_unregistered00001");
      expect(later.loop.pendingReminders()).toBe(1);
      expect(registry.pendingReminderCount("ses_unregistered00001")).toBe(1);
    } finally {
      teardown();
    }
  });

  it("在册 sid 直投边界队列 → 下轮消费清零，提醒不进 loop.messages（转录纪律）", async () => {
    const { registry, teardown } = makeRegistry([convergeTurn("收口", ["收"])]);
    try {
      const rec = registry.create();
      registry.queueReminder(rec.sessionID, "[run-reminder] run=run_direct001 status=done side_session=ses_side01");
      expect(registry.pendingReminderCount(rec.sessionID)).toBe(1);

      registry.send(rec.sessionID, "第二问");
      await waitIdle(registry, rec.sessionID);

      expect(rec.loop.pendingReminders()).toBe(0);
      expect(registry.pendingReminderCount(rec.sessionID)).toBe(0);
      // transient 注入：模型收得到（boot e2e 硬证），对话内存不含（本处 + core (3d) 双断言）。
      const allText = rec.loop.messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      expect(allText).not.toContain("[run-reminder]");
      // 消费时刻经 loop 事件记账（delivery 面同源）。
      const drained = rec.loop
        .events()
        .filter((e) => e.type === "reminder-drained");
      expect(drained).toHaveLength(1);
    } finally {
      teardown();
    }
  }, 30_000);
});

describe("W16-F1 busy 排队语义（对齐 opencode prompt_async）：202 queued / FIFO / 上限回压", () => {
  it("busy 时发 A、B → 各 202 queued:true；一个后续 run 合并消费，转录顺序 = 当前轮、A、B", async () => {
    const currentTurn: FakeAssistantResponse = {
      content: [
        { type: "text", text: "当前轮慢收束" },
        { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
      ],
      delayMs: 1200,
    };
    const { registry, teardown } = makeRegistry([
      currentTurn,
      convergeTurn("合并轮收束", ["A", "B"]),
    ]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };

      const direct = await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
      expect(direct.status).toBe(202);
      const directBody = (await direct.json()) as Record<string, unknown>;
      expect(directBody["accepted"]).toBe(true);
      expect(directBody["queued"]).toBeUndefined();

      const qa = await postJson(`/sessions/${sessionID}/messages`, { text: "排队A" });
      expect(qa.status).toBe(202);
      expect(await qa.json()).toEqual({ sessionID, status: "busy", accepted: true, queued: true });
      const qb = await postJson(`/sessions/${sessionID}/messages`, { text: "排队B" });
      expect(qb.status).toBe(202);
      expect(((await qb.json()) as Record<string, unknown>)["queued"]).toBe(true);

      const idle = await waitForStatus(sessionID, "idle");
      expect(idle.turns).toBe(2);

      const page = await getJson(`/sessions/${sessionID}/history?limit=200`);
      const body = (await page.json()) as { messages: Message[] };
      const userTexts = body.messages
        .filter((m) => m.role === "user")
        .map(messageText)
        .slice(0, 3);
      expect(userTexts).toEqual(["正文句", "排队A", "排队B"]);
    } finally {
      teardown();
    }
  }, 30_000);

  it("队列上限 10：第 11 条 409 session_busy 回压；abort 只掐当前轮，排队 10 条合并进一个后续 run", async () => {
    const script: FakeAssistantResponse[] = [
      { content: [{ type: "text", text: "慢跑中" }], delayMs: 2000 },
      convergeTurn("合并收束", ["x"]),
    ];
    const { registry, teardown } = makeRegistry(script);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      await postJson(`/sessions/${sessionID}/messages`, { text: "当前轮" });
      await waitForStatus(sessionID, "busy");

      for (let i = 0; i < 10; i++) {
        const r = await postJson(`/sessions/${sessionID}/messages`, { text: `队列${String(i)}` });
        expect(r.status).toBe(202);
        expect(((await r.json()) as Record<string, unknown>)["queued"]).toBe(true);
      }
      const overflow = await postJson(`/sessions/${sessionID}/messages`, { text: "队列第11条" });
      expect(overflow.status).toBe(409);
      const overflowBody = (await overflow.json()) as { error: { code: string } };
      expect(overflowBody.error.code).toBe("session_busy");

      const aborted = await postJson(`/sessions/${sessionID}/abort`, {});
      expect(((await aborted.json()) as { aborted: boolean }).aborted).toBe(true);

      // abort 不清队列：10 条排队合并进一个后续 run（当前轮 1 + 合并轮 1）。
      const idle = await waitForStatus(sessionID, "idle", 60_000);
      expect(idle.turns).toBe(2);
    } finally {
      teardown();
    }
  }, 60_000);

  // ───────────────────────── W42b（本组扩写 W16-F1 钉，不动上方既有用例） ─────────────────────────
  // 新口径：busy 消息只进内存 + sidecar，由内核 turn 边界按真实对话顺序 flush 落盘；
  // 受理时刻不写 store、不发 user echo；收尾 settle 用 store 证据摘队，sidecar 仅 {text,at} 耐重启。

  /** W42b 装配口：store/journal 与 registry 同引用暴露（重启/对账取证面）。 */
  function makeRegistryW42(
    script: readonly FakeAssistantResponse[],
    extra: { store?: SessionStore; skillsSniff?: SkillsSniff } = {},
  ): {
    registry: SessionRegistry;
    store: SessionStore;
    journal: Array<{ level: string; msg: string; fields: Record<string, unknown> }>;
    teardown: () => void;
  } {
    const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
    const model = createFakeModelFromConfig(cfg.models[0]!, [...script]);
    const store = extra.store ?? new MemorySessionStore();
    const journal: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const registry = new SessionRegistry({
      model,
      store,
      stateRoot,
      logSink: (level, msg, fields) => {
        journal.push({ level, msg, fields });
      },
      ...(extra.skillsSniff === undefined ? {} : { skillsSniff: extra.skillsSniff }),
    });
    return { registry, store, journal, teardown: () => model.teardown() };
  }

  /** 确定性双闸：Promise 解析代替 sleep（hold 工具进入 / 测试放行两端口）。 */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    const box: { resolve: (() => void) | null } = { resolve: null };
    const promise = new Promise<void>((resolve) => {
      box.resolve = resolve;
    });
    const resolve = box.resolve;
    if (resolve === null) throw new Error("deferred(): Promise executor must run synchronously");
    return { promise, resolve };
  }

  /** 可停放本轮的工具：execute 进入即发 entered，直到 release 放行才回 held。 */
  function makeHoldTool(): { tool: HarnessTool; entered: Promise<void>; release: () => void } {
    const entered = deferred();
    const released = deferred();
    const tool: HarnessTool = {
      name: "hold",
      description: "hold the running turn until the integration test releases it",
      parameters: Type.Object({}),
      isReadOnly: true,
      isConcurrencySafe: () => false,
      async execute() {
        entered.resolve();
        await released.promise;
        return { content: [{ type: "text", text: "held" }] };
      },
    };
    return { tool, entered: entered.promise, release: released.resolve };
  }

  /** 带工具装配口：fake/store/journal 同引用暴露（steering 取证 = fake.getCalls()）。 */
  function makeRegistryWithTools(
    script: readonly FakeAssistantResponse[],
    tools: readonly HarnessTool[],
    opts: {
      store?: SessionStore;
      logSink?: (level: string, msg: string, fields: Record<string, unknown>) => void;
      llmErrorRetries?: number;
      failedTurnReplayRetries?: number;
      failedTurnReplayBackoffMs?: number;
      now?: () => number;
    } = {},
  ): {
    registry: SessionRegistry;
    fake: ReturnType<typeof createFakeModelFromConfig>;
    store: SessionStore;
    journal: Array<{ level: string; msg: string; fields: Record<string, unknown> }>;
    teardown: () => void;
  } {
    const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
    const fake = createFakeModelFromConfig(cfg.models[0]!, [...script]);
    const store = opts.store ?? new MemorySessionStore();
    const journal: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const registry = new SessionRegistry({
      model: fake,
      store,
      stateRoot,
      tools,
      ...(opts.llmErrorRetries === undefined ? {} : { llmErrorRetries: opts.llmErrorRetries }),
      ...(opts.failedTurnReplayRetries === undefined
        ? {}
        : { failedTurnReplayRetries: opts.failedTurnReplayRetries }),
      ...(opts.failedTurnReplayBackoffMs === undefined
        ? {}
        : { failedTurnReplayBackoffMs: opts.failedTurnReplayBackoffMs }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      logSink: (level, msg, fields) => {
        journal.push({ level, msg, fields });
        opts.logSink?.(level, msg, fields);
      },
    });
    return { registry, fake, store, journal, teardown: () => fake.teardown() };
  }

  /**
   * 轮询 statusView 直到 status（可选 turns）与 queueLength=0 同时成立：
   * steering 会让队列在 run 仍 busy 时就归零，run 间瞬态 idle 不可当收尾。
   */
  async function waitForView(
    registry: SessionRegistry,
    sessionID: string,
    want: { status: StatusBody["status"]; turns?: number },
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<NonNullable<ReturnType<SessionRegistry["statusView"]>>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = registry.statusView(sessionID);
      if (
        view !== undefined &&
        view.status === want.status &&
        (want.turns === undefined || view.turns === want.turns) &&
        view.queueLength === 0
      ) {
        return view;
      }
      if (Date.now() > deadline) {
        throw new Error(`statusView 未在预算内满足 ${JSON.stringify(want)}（实际 ${JSON.stringify(view)}）`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** LLM 请求面取证：只序列化 messages（避开 system/tools 噪声）。 */
  function callText(call: { messages: readonly unknown[] }): string {
    return JSON.stringify(call.messages);
  }

  /** user echo 取证：帧堆 → message.updated(role=user) 组（配对同 messageID 的 text part）。 */
  function userEchoGroups(frames: readonly LoomFrame[]): Array<{
    messageID: string;
    info: Record<string, unknown>;
    part: Record<string, unknown> | null;
    props: Record<string, unknown>;
  }> {
    const bag = (f: LoomFrame): Record<string, unknown> => f.payload.properties as unknown as Record<string, unknown>;
    const infos = frames
      .filter((f) => f.payload.type === "message.updated")
      .map(bag)
      .filter((p) => {
        const info = p["info"];
        return typeof info === "object" && info !== null && (info as Record<string, unknown>)["role"] === "user";
      });
    const textParts = frames
      .filter((f) => f.payload.type === "message.part.updated")
      .map(bag)
      .filter((p) => {
        const part = p["part"];
        return typeof part === "object" && part !== null && (part as Record<string, unknown>)["type"] === "text";
      });
    return infos.map((info) => {
      const messageID = String(info["messageID"]);
      return {
        messageID,
        info: info["info"] as Record<string, unknown>,
        part: (textParts.find((p) => p["messageID"] === messageID)?.["part"] as Record<string, unknown>) ?? null,
        props: info,
      };
    });
  }

  /** 转录里 role=user 且正文全等 text 的条数（恰一份验收面）。 */
  async function userTextCount(registry: SessionRegistry, sessionID: string, text: string): Promise<number> {
    const page = await registry.history(sessionID, { limit: 200 });
    return page.messages.filter(
      (m) => m.role === "user" && (typeof m.content === "string" ? m.content : "") === text,
    ).length;
  }

  function pendingOf(frame: LoomFrame): readonly PendingItemView[] {
    const raw = frame.payload.properties["pending"];
    if (!Array.isArray(raw)) return [];
    const out: PendingItemView[] = [];
    for (const row of raw) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      const text = r["text"];
      const at = r["at"];
      const state = r["state"];
      if (typeof text !== "string" || typeof at !== "number") continue;
      if (state !== "queued" && state !== "running" && state !== "drained") continue;
      out.push({ text, at, state });
    }
    return out;
  }

  it("W42b busy 受理不直写：turn 边界前 history 不可见；边界后按 toolResult→user 顺序恰一份", async () => {
    const hold = makeHoldTool();
    const { registry, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
        convergeTurn("A轮收束", ["A"]),
      ],
      [hold.tool],
    );
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
      await hold.entered;

      const qa = await postJson(`/sessions/${sessionID}/messages`, { text: "排队A" });
      expect(qa.status).toBe(202);
      expect(await qa.json()).toEqual({ sessionID, status: "busy", accepted: true, queued: true });

      // turn 边界前：busy 消息只在内存 queue + sidecar，history 不可见（无受理直写）。
      const before = await getJson(`/sessions/${sessionID}/history?limit=200`);
      const beforeBody = (await before.json()) as { messages: Message[] };
      expect(beforeBody.messages.filter((m) => m.role === "user").map(messageText)).not.toContain("排队A");
      expect(beforeBody.messages.filter((m) => m.role === "user").map(messageText)).not.toContain("正文句");
      expect(registry.statusView(sessionID)?.queueLength).toBe(1);

      hold.release();
      const settled = await waitForView(registry, sessionID, { status: "idle", turns: 1 }, 30_000);
      expect(settled.queueLength).toBe(0);

      const page = await getJson(`/sessions/${sessionID}/history?limit=200`);
      const body = (await page.json()) as { messages: Message[] };
      const toolIdx = body.messages.findIndex((m) => m.role === "toolResult");
      const userIdx = body.messages.findIndex(
        (m) => m.role === "user" && messageText(m) === "排队A",
      );
      expect(toolIdx).toBeGreaterThanOrEqual(0);
      expect(userIdx).toBeGreaterThan(toolIdx);
      expect(body.messages.filter((m) => m.role === "user" && messageText(m) === "排队A")).toHaveLength(1);
    } finally {
      teardown();
    }
  }, 30_000);

  it("W42b busy steering 落盘恰一份：正文句/排队A/排队B 各恰一次（turn 边界 flush）", async () => {
    const { registry, teardown } = makeRegistryW42([
      {
        content: [
          { type: "text", text: "慢轮收束" },
          { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
        ],
        delayMs: 800,
      },
      convergeTurn("合并轮", ["A", "B"]),
    ]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
      await waitForStatus(sessionID, "busy");
      await postJson(`/sessions/${sessionID}/messages`, { text: "排队A" });
      await postJson(`/sessions/${sessionID}/messages`, { text: "排队B" });
      const idle = await waitForStatus(sessionID, "idle");
      expect(idle.turns).toBe(2);

      // 三条 user 消息各恰一份（无重复 append；W16-F1 FIFO 钉上方逐字保绿）。
      for (const text of ["正文句", "排队A", "排队B"]) {
        expect(await userTextCount(registry, sessionID, text), `${text} 应恰一份`).toBe(1);
      }
    } finally {
      teardown();
    }
  }, 30_000);

  it("W42b 受理不发 user echo：busy 消息只待内核 turn 边界落盘，不提前推 message.updated", async () => {
    const { registry, teardown } = makeRegistryW42([
      {
        content: [
          { type: "text", text: "慢轮" },
          { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
        ],
        delayMs: 1500,
      },
      convergeTurn("A轮", ["A"]),
    ]);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      const stream = await fetch(`${baseUrl}/sessions/${sessionID}/events`, { headers: auth() });
      expect(stream.status).toBe(200);
      const both = readUntil(stream, (frames) => frames.some((f) => f.payload.type === "session.idle"));

      await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
      await waitForStatus(sessionID, "busy");
      const qa = await postJson(`/sessions/${sessionID}/messages`, { text: "排队A" });
      expect(qa.status).toBe(202);

      const { frames } = await both;
      // 受理时刻零 user echo；user 消息只在落盘后由 history 面呈现。
      expect(userEchoGroups(frames)).toHaveLength(0);
      expectOffline();
    } finally {
      teardown();
    }
  }, 30_000);

  it("W42b 队列耐重启：sidecar 行与转录 exact match -> 丢弃且不起合成 run（legacy entryId 容忍）", async () => {
    const sessionFile = join(stateRoot, "loom-main.jsonl");
    const at = 1_730_000_000_000;
    const preStore = new JsonlSessionStore(sessionFile);
    const stored = await preStore.appendEntry("ses_rebootqueue000001", {
      kind: "message",
      message: { role: "user", content: "重启前排队", timestamp: at },
    });
    const qdir = join(stateRoot, "session", "queue");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(
      join(qdir, "ses_rebootqueue000001.json"),
      JSON.stringify([
        { text: "重启前排队", at, entryId: stored.id, legacyUnknownField: "ignored" },
      ]),
    );

    const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
    const model = createFakeModelFromConfig(cfg.models[0]!, []);
    const journal: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const registry = new SessionRegistry({
      model,
      store: new JsonlSessionStore(sessionFile),
      stateRoot,
      logSink: (level, msg, fields) => {
        journal.push({ level, msg, fields });
      },
    });
    try {
      expect(await registry.recoverSendQueues()).toBe(1);
      expect(
        journal.some(
          (j) =>
            j.level === "info" &&
            j.msg === "loom send queue recovered" &&
            j.fields["sessionID"] === "ses_rebootqueue000001" &&
            j.fields["count"] === 1,
        ),
        "恢复须落一行 journal（loom send queue recovered {sessionID,count}）",
      ).toBe(true);
      const rec = registry.get("ses_rebootqueue000001");
      expect(rec).toBeDefined();
      expect(rec?.queue.length).toBe(0);
      expect(rec?.turns).toBe(0);
      expect(rec?.running).toBeNull();
      expect(model.getCalls()).toHaveLength(0);
      expect(await userTextCount(registry, "ses_rebootqueue000001", "重启前排队")).toBe(1);
      expect(existsSync(join(qdir, "ses_rebootqueue000001.json"))).toBe(false);
      expect(journal.some((j) => j.level === "warn")).toBe(false);
    } finally {
      model.teardown();
    }
  }, 60_000);

  it("W42b recovery 幸存项：sidecar 有行、store 无 exact 证据 -> 重灌入队并 append 恰一次（legacy entryId 容忍）", async () => {
    const sessionFile = join(stateRoot, "loom-main.jsonl");
    const at = 1_730_000_000_500;
    // 崩溃现场：sidecar 记了队列行，但 store 里没有对应 user 消息（落盘前死亡）。
    const preStore = new JsonlSessionStore(sessionFile);
    await preStore.appendEntry("ses_tornqueue00000001", {
      kind: "message",
      message: { role: "user", content: "旧句", timestamp: at - 1000 },
    });
    const qdir = join(stateRoot, "session", "queue");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "ses_tornqueue00000001.json"), JSON.stringify([{ text: "被撕掉的句", at, entryId: "ghost_entry_id" }]));

    const model = (() => {
      const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
      return createFakeModelFromConfig(cfg.models[0]!, [convergeTurn("自愈执行", ["x"])]);
    })();
    const registry = new SessionRegistry({
      model,
      store: new JsonlSessionStore(sessionFile),
      stateRoot,
    });
    try {
      expect(await registry.recoverSendQueues()).toBe(1);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const rec = registry.get("ses_tornqueue00000001");
        if (rec !== undefined && rec.running === null && rec.queue.length === 0) break;
        if (Date.now() > deadline) throw new Error("torn 队列项未在预算内恢复执行");
        await new Promise((r) => setTimeout(r, 25));
      }
      const page = await registry.history("ses_tornqueue00000001", { limit: 200 });
      const texts = page.messages.map((m) => (m.role === "user" ? messageText(m) : "")).filter((t) => t.length > 0);
      expect(texts).toContain("被撕掉的句");
      expect(texts.filter((t) => t === "被撕掉的句")).toHaveLength(1);
      expect(existsSync(join(qdir, "ses_tornqueue00000001.json"))).toBe(false);
    } finally {
      model.teardown();
    }
  }, 60_000);

  it("W42b busy 受理：在途 history 不可见；收尾后恰一份、队列归零、sidecar 归零即删", async () => {
    const hold = makeHoldTool();
    const { registry, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
        convergeTurn("A轮", ["A"]),
      ],
      [hold.tool],
    );
    try {
      const rec = registry.create();
      registry.send(rec.sessionID, "正文句");
      await hold.entered;
      registry.send(rec.sessionID, "排队A");

      // 在途（run1 未到 turn 边界）：仅在内存 queue + sidecar；store/history 尚无该消息。
      const page = await registry.history(rec.sessionID, { limit: 200 });
      const userTexts = page.messages.filter((m) => m.role === "user").map(messageText);
      expect(userTexts).not.toContain("排队A");
      expect(userTexts).not.toContain("正文句");
      expect(existsSync(join(stateRoot, "session", "queue", `${rec.sessionID}.json`))).toBe(true);

      hold.release();
      const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 1 }, 30_000);
      expect(settled.queueLength).toBe(0);
      expect(await userTextCount(registry, rec.sessionID, "排队A")).toBe(1);
      expect(await userTextCount(registry, rec.sessionID, "正文句")).toBe(1);
      expect(existsSync(join(stateRoot, "session", "queue", `${rec.sessionID}.json`))).toBe(false);
    } finally {
      teardown();
    }
  }, 30_000);

  it("W42b 溢出 409 携带 queueCapacity/queueLength（code session_busy 不动）", async () => {
    const script: FakeAssistantResponse[] = [
      { content: [{ type: "text", text: "慢跑中" }], delayMs: 2000 },
      convergeTurn("收束", ["x"]),
    ];
    const { registry, teardown } = makeRegistryW42(script);
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      await postJson(`/sessions/${sessionID}/messages`, { text: "当前轮" });
      await waitForStatus(sessionID, "busy");
      for (let i = 0; i < 10; i++) {
        const r = await postJson(`/sessions/${sessionID}/messages`, { text: `队列${String(i)}` });
        expect(r.status).toBe(202);
      }
      expect(registry.statusView(sessionID)?.queueLength).toBe(10);
      const overflow = await postJson(`/sessions/${sessionID}/messages`, { text: "队列第11条" });
      expect(overflow.status).toBe(409);
      const body = (await overflow.json()) as {
        error: { code: string };
        queueCapacity: number;
        queueLength: number;
      };
      expect(body.error.code).toBe("session_busy");
      expect(body.queueCapacity).toBe(10);
      expect(body.queueLength).toBe(10);
      // 背压不蒸发：10 条排队合并进一个后续 run（abort 掐当前轮后接力）。
      const aborted = await postJson(`/sessions/${sessionID}/abort`, {});
      expect(((await aborted.json()) as { aborted: boolean }).aborted).toBe(true);
      const idle = await waitForStatus(sessionID, "idle", 60_000);
      expect(idle.turns).toBe(2);
    } finally {
      teardown();
    }
  }, 60_000);

  it("W42b statusView.queueLength 排 3 递减至 0", async () => {
    const { registry, teardown } = makeRegistryW42([
      {
        content: [
          { type: "text", text: "慢轮" },
          { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
        ],
        delayMs: 1500,
      },
      convergeTurn("1", ["x"]),
      convergeTurn("2", ["x"]),
      convergeTurn("3", ["x"]),
    ]);
    try {
      const rec = registry.create();
      expect(registry.statusView(rec.sessionID)?.queueLength).toBe(0);
      registry.send(rec.sessionID, "正文句");
      registry.send(rec.sessionID, "排队1");
      registry.send(rec.sessionID, "排队2");
      registry.send(rec.sessionID, "排队3");
      expect(registry.statusView(rec.sessionID)?.queueLength).toBe(3);
      const deadline = Date.now() + 30_000;
      while (registry.statusView(rec.sessionID)?.queueLength !== 0) {
        if (Date.now() > deadline) throw new Error("队列未在预算内排空");
        await new Promise((r) => setTimeout(r, 25));
      }
      // steering 可在 run 仍 busy 时摘空队列：归零后必须再等真正收尾，不能立即断言 idle。
      const settled = await waitForView(registry, rec.sessionID, { status: "idle" }, 30_000);
      expect(settled.status).toBe("idle");
      expect(settled.queueLength).toBe(0);
    } finally {
      teardown();
    }
  }, 30_000);

  it("W42b drain 加固：出队嗅探炸 → 项回插队头不蒸发 + session.error + WARN journal；下次 send 接力跑完", async () => {
    let rescanCalls = 0;
    const { registry, journal, teardown } = makeRegistryW42(
      [
        {
          content: [
            { type: "text", text: "慢轮" },
            { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
          ],
          delayMs: 800,
        },
        convergeTurn("第三轮", ["x"]),
        convergeTurn("排队轮补跑", ["x"]),
      ],
      {
        // 桩：第 2 次 rescan（= run1 收尾 drain 时刻的嗅探）炸——模拟上下文嗅探在 drain 链上抛。
        skillsSniff: {
          rescan(): void {
            rescanCalls += 1;
            if (rescanCalls === 2) throw new Error("sniff exploded (W42b drain 注入)");
          },
          snapshot: () => ({ text: "", generation: 0 }),
        },
      },
    );
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      const stream = await fetch(`${baseUrl}/sessions/${sessionID}/events`, { headers: auth() });
      const framesUntil = (want: (fs: readonly LoomFrame[]) => boolean, budgetMs = 30_000) =>
        readUntil(stream, want, budgetMs);

      await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
      await waitForStatus(sessionID, "busy");
      await postJson(`/sessions/${sessionID}/messages`, { text: "排队A" });

      // run1 收尾 → drain 出队嗅探炸 → session.error 帧（第 2 次 rescan 之后不再有新帧来源，窗口读到 idle 即够）。
      await framesUntil((fs) =>
        fs.some((f) => f.payload.type === "session.error") ||
        (fs.some((f) => f.payload.type === "session.idle") && rescanCalls >= 2),
      );
      // 回插队头：项没蒸发（queueLength 仍 1；turn 边界未到，store 尚无该 user 消息）。
      expect(registry.statusView(sessionID)?.queueLength).toBe(1);
      expect(await userTextCount(registry, sessionID, "排队A")).toBe(0);
      expect(
        journal.some((j) => j.level === "warn" && j.msg.includes("loom send queue drain failed")),
      ).toBe(true);

      // 下一次 send（rescan 正常）直启第三轮；其 finally drain 把回插的 排队A 接力跑完。
      await postJson(`/sessions/${sessionID}/messages`, { text: "第三句" });
      const idle = await waitForStatus(sessionID, "idle");
      expect(idle.turns).toBe(3);
      expect(registry.statusView(sessionID)?.queueLength).toBe(0);
      expect(await userTextCount(registry, sessionID, "排队A")).toBe(1);
      expect(await userTextCount(registry, sessionID, "第三句")).toBe(1);
    } finally {
      teardown();
    }
  }, 60_000);

  it("W42b 坏 sidecar 诚实丢弃：JSON 解析炸 → WARN journal（含 sid），不入队不假跑，绝不自愈式静默", async () => {
    const { registry, journal, teardown } = makeRegistryW42([]);
    const qdir = join(stateRoot, "session", "queue");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "ses_corruptqueue00001.json"), "{not json!!");
    try {
      expect(await registry.recoverSendQueues()).toBe(0);
      expect(
        journal.some(
          (j) =>
            j.level === "warn" &&
            j.msg === "loom send queue sidecar unreadable" &&
            j.fields["sessionID"] === "ses_corruptqueue00001",
        ),
      ).toBe(true);
      // 丢弃 = 不 ensure、不入队、不起轮（WARN 已响亮，静默是最坏结局）。
      expect(registry.get("ses_corruptqueue00001")).toBeUndefined();
    } finally {
      teardown();
    }
  });

  // ───────────────────── busy steering 集成（S1-S4：HTTP/statusView/fake.getCalls 三面取证） ─────────────────────

  it("S1 busy 文本 steering：插入句进当前 run 的下一次 LLM 请求（首次请求不含），转录恰一份", async () => {
    const hold = makeHoldTool();
    const { registry, fake, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
        convergeTurn("完成", ["完"]),
      ],
      [hold.tool],
    );
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      expect(created.status).toBe(201);
      const { sessionID } = (await created.json()) as { sessionID: string };

      const direct = await postJson(`/sessions/${sessionID}/messages`, { text: "正文" });
      expect(direct.status).toBe(202);
      await hold.entered;

      const steer = await postJson(`/sessions/${sessionID}/messages`, { text: "插入句" });
      expect(steer.status).toBe(202);
      expect(await steer.json()).toEqual({ sessionID, status: "busy", accepted: true, queued: true });

      hold.release();
      const idle = await waitForStatus(sessionID, "idle");
      // turns 恒 1 = 同 run 内消费；若被推迟成下一 run，turns 会是 2。
      expect(idle.turns).toBe(1);

      const calls = fake.getCalls();
      expect(calls).toHaveLength(2);
      const [firstCall, secondCall] = calls;
      expect(firstCall).toBeDefined();
      expect(secondCall).toBeDefined();
      if (firstCall === undefined || secondCall === undefined) return;
      expect(callText(firstCall)).not.toContain("插入句");
      expect(callText(secondCall)).toContain("插入句");

      expect(await userTextCount(registry, sessionID, "正文")).toBe(1);
      expect(await userTextCount(registry, sessionID, "插入句")).toBe(1);
      expect(registry.statusView(sessionID)?.queueLength).toBe(0);
    } finally {
      teardown();
    }
  }, 30_000);

  it("S2 abort 先于 turn 边界：park 的 steer 撤回，插入句作为下一 run prompt 恰一次（不丢不重）", async () => {
    const hold = makeHoldTool();
    const { registry, fake, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
        convergeTurn("完成", ["完"]),
      ],
      [hold.tool],
    );
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };

      await postJson(`/sessions/${sessionID}/messages`, { text: "正文" });
      await hold.entered;
      const steer = await postJson(`/sessions/${sessionID}/messages`, { text: "插入句" });
      expect(steer.status).toBe(202);
      expect(((await steer.json()) as Record<string, unknown>)["queued"]).toBe(true);

      const aborted = await postJson(`/sessions/${sessionID}/abort`, {});
      expect(aborted.status).toBe(200);
      expect(((await aborted.json()) as { aborted: boolean }).aborted).toBe(true);
      hold.release();

      // 等最终态（turns=2 + idle + 队列空）；不把 run 间的瞬态状态当收尾。
      const settled = await waitForView(registry, sessionID, { status: "idle", turns: 2 }, 30_000);
      expect(settled.queueLength).toBe(0);

      const calls = fake.getCalls();
      expect(calls).toHaveLength(2);
      const [firstCall, secondCall] = calls;
      expect(firstCall).toBeDefined();
      expect(secondCall).toBeDefined();
      if (firstCall === undefined || secondCall === undefined) return;
      expect(callText(firstCall)).not.toContain("插入句");
      expect(callText(secondCall)).toContain("插入句");

      expect(await userTextCount(registry, sessionID, "插入句")).toBe(1);
      expect(await userTextCount(registry, sessionID, "正文")).toBe(1);
    } finally {
      teardown();
    }
  }, 30_000);

  it("S3 settle drained+missing：store 无 exact 证据 -> 清 drained 留队，下一 run 补投且转录恰一份", async () => {
    class DropOnceStore extends MemorySessionStore {
      dropped = false;

      override async appendEntry(sessionId: string, entry: SessionEntry): Promise<StoredEntry> {
        if (
          !this.dropped &&
          entry.kind === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "插入句"
        ) {
          this.dropped = true;
          const leafId = await this.getLeafId(sessionId);
          return { id: "dropped_insert_entry", parentId: leafId, seq: -1, entry };
        }
        return super.appendEntry(sessionId, entry);
      }
    }

    const store = new DropOnceStore();
    const hold = makeHoldTool();
    const { registry, fake, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
        convergeTurn("run1 收束", ["1"]),
        convergeTurn("run2 收束", ["2"]),
      ],
      [hold.tool],
      { store },
    );
    try {
      const rec = registry.create();
      registry.send(rec.sessionID, "正文");
      await hold.entered;
      registry.send(rec.sessionID, "插入句");
      hold.release();

      const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 2 }, 60_000);
      expect(settled.queueLength).toBe(0);
      expect(store.dropped).toBe(true);
      // settle 看不到证据 -> 清 drained 留队 -> 下一 run 以 prompt 补投，store 恰一份。
      expect(await userTextCount(registry, rec.sessionID, "插入句")).toBe(1);
      expect(await userTextCount(registry, rec.sessionID, "正文")).toBe(1);

      const calls = fake.getCalls();
      expect(calls).toHaveLength(3);
      const lastCall = calls[2];
      expect(lastCall).toBeDefined();
      if (lastCall === undefined) return;
      expect(callText(lastCall)).toContain("插入句");
    } finally {
      teardown();
    }
  }, 60_000);

  it("S3b settle 读 store 炸：drained 项保留 + WARN journal，随后下一 run 补投", async () => {
    class ReadFailOnceStore extends MemorySessionStore {
      failNextRead = false;

      override async getPathToLeaf(sessionId: string, leafId?: string): Promise<StoredEntry[]> {
        if (this.failNextRead) {
          this.failNextRead = false;
          throw new Error("injected settle read failure");
        }
        return super.getPathToLeaf(sessionId, leafId);
      }
    }

    const store = new ReadFailOnceStore();
    const hold = makeHoldTool();
    const { registry, fake, journal, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
        convergeTurn("run1 收束", ["1"]),
        convergeTurn("run2 收束", ["2"]),
      ],
      [hold.tool],
      { store },
    );
    try {
      const rec = registry.create();
      registry.send(rec.sessionID, "正文");
      await hold.entered;
      registry.send(rec.sessionID, "插入句");
      store.failNextRead = true;
      hold.release();

      const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 2 }, 60_000);
      expect(settled.queueLength).toBe(0);
      expect(
        journal.some(
          (j) =>
            j.level === "warn" &&
            j.msg === "loom send queue settle store read failed (items kept)",
        ),
      ).toBe(true);
      // 读炸时项留在队里 -> #drainQueue 作为下一 run prompt 补投（run1 已落一份 + 补投一份）。
      expect(await userTextCount(registry, rec.sessionID, "插入句")).toBe(2);
      const calls = fake.getCalls();
      expect(calls).toHaveLength(3);
      const lastCall = calls[2];
      expect(lastCall).toBeDefined();
      if (lastCall === undefined) return;
      expect(callText(lastCall)).toContain("插入句");
    } finally {
      teardown();
    }
  }, 60_000);

  it("S4 同文两条：两次 ok 都被投递（末次 LLM 请求含两条 ok），转录恰两条、队列归零", async () => {
    const hold = makeHoldTool();
    const { registry, fake, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
        convergeTurn("turn1 收束", ["1"]),
        convergeTurn("run2 收束", ["2"]),
      ],
      [hold.tool],
    );
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };

      await postJson(`/sessions/${sessionID}/messages`, { text: "正文" });
      await hold.entered;

      const ok1 = await postJson(`/sessions/${sessionID}/messages`, { text: "ok" });
      expect(ok1.status).toBe(202);
      expect(((await ok1.json()) as Record<string, unknown>)["queued"]).toBe(true);
      const ok2 = await postJson(`/sessions/${sessionID}/messages`, { text: "ok" });
      expect(ok2.status).toBe(202);
      expect(((await ok2.json()) as Record<string, unknown>)["queued"]).toBe(true);

      hold.release();
      const settled = await waitForView(registry, sessionID, { status: "idle" }, 30_000);
      expect(settled.queueLength).toBe(0);

      expect(await userTextCount(registry, sessionID, "ok")).toBe(2);

      const calls = fake.getCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      if (lastCall === undefined) return;
      const lastOkTexts = lastCall.messages
        .filter((m) => m.role === "user")
        .map(messageText)
        .filter((t) => t === "ok");
      expect(lastOkTexts).toHaveLength(2);
    } finally {
      teardown();
    }
  }, 30_000);

  it("S4b 同文 prompt 独立追加：hydrate 尾条同文也照常 push（请求面/转录各两份）", async () => {
    const store = new MemorySessionStore();
    const sid = "ses_sametext000000001";
    const firstAt = 1_730_000_100_000;
    await store.appendEntry(sid, {
      kind: "message",
      message: { role: "user", content: "ok", timestamp: firstAt },
    });

    const { registry, fake, teardown } = makeRegistryWithTools([convergeTurn("收束", ["x"])], [], { store });
    try {
      const rec = registry.ensure(sid);
      // 先完成重放：内存尾条 = ok@firstAt；随后新 prompt 同文但 timestamp 不同。
      await rec.loop.hydrate();
      registry.send(sid, "ok");

      const settled = await waitForView(registry, sid, { status: "idle", turns: 1 }, 30_000);
      expect(settled.queueLength).toBe(0);

      const calls = fake.getCalls();
      expect(calls).toHaveLength(1);
      const firstCall = calls[0];
      expect(firstCall).toBeDefined();
      if (firstCall === undefined) return;
      const requestOkTexts = firstCall.messages
        .filter((m) => m.role === "user")
        .map(messageText)
        .filter((t) => t === "ok");
      expect(requestOkTexts).toHaveLength(2);
      expect(await userTextCount(registry, sid, "ok")).toBe(2);
    } finally {
      teardown();
    }
  }, 30_000);

  // ───────────────────── W55 收尾出队合并（idle 终态一次消费全队列；error 终态逐条有界） ─────────────────────

  it("W55 合并：3 条排队 -> 恰一个后续 run，首次请求全含且 FIFO", async () => {
    const { registry, fake, teardown } = makeRegistryWithTools(
      [
        {
          content: [
            { type: "text", text: "当前轮慢收束" },
            { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
          ],
          delayMs: 1200,
        },
        convergeTurn("合并收束", ["合"]),
      ],
      [],
    );
    await listen(registry);
    try {
      const created = await postJson("/sessions", {});
      const { sessionID } = (await created.json()) as { sessionID: string };
      const direct = await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
      expect(direct.status).toBe(202);
      await waitForStatus(sessionID, "busy");

      for (const text of ["排队1", "排队2", "排队3"]) {
        const r = await postJson(`/sessions/${sessionID}/messages`, { text });
        expect(r.status).toBe(202);
        expect(((await r.json()) as Record<string, unknown>)["queued"]).toBe(true);
      }

      const settled = await waitForView(registry, sessionID, { status: "idle", turns: 2 }, 30_000);
      expect(settled.queueLength).toBe(0);

      const calls = fake.getCalls();
      expect(calls).toHaveLength(2);
      const [firstCall, secondCall] = calls;
      expect(firstCall).toBeDefined();
      expect(secondCall).toBeDefined();
      if (firstCall === undefined || secondCall === undefined) return;
      for (const text of ["排队1", "排队2", "排队3"]) {
        expect(callText(firstCall)).not.toContain(text);
      }
      const secondUserTexts = secondCall.messages.filter((m) => m.role === "user").map(messageText);
      expect(secondUserTexts).toEqual(["正文句", "排队1", "排队2", "排队3"]);

      for (const text of ["正文句", "排队1", "排队2", "排队3"]) {
        expect(await userTextCount(registry, sessionID, text), `${text} 应恰一份`).toBe(1);
      }
      expect(existsSync(join(stateRoot, "session", "queue", `${sessionID}.json`))).toBe(false);
    } finally {
      teardown();
    }
  }, 30_000);

  it("W55 error 终态不合并、逐条出队有界", async () => {
    const { registry, fake, teardown } = makeRegistryWithTools(
      [
        { content: [{ type: "text", text: "boom" }], delayMs: 400, throwError: new Error("boom") },
        convergeTurn("A 收束", ["a"]),
        convergeTurn("B 收束", ["b"]),
      ],
      [],
      { llmErrorRetries: 0 },
    );
    try {
      const rec = registry.create();
      registry.send(rec.sessionID, "正文句");
      // 首次 LLM 请求已发出 ⇒ turn 0 steering 边界已过；此刻排队的消息只能 park 到收尾。
      const callDeadline = Date.now() + 5_000;
      while (fake.getCalls().length === 0) {
        if (Date.now() > callDeadline) throw new Error("首个 LLM 请求未在预算内发出");
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(registry.send(rec.sessionID, "排队A")).toMatchObject({ accepted: true, queued: true });
      expect(registry.send(rec.sessionID, "排队B")).toMatchObject({ accepted: true, queued: true });

      // error 终态 => 不合并：error run + A + B 各一轮；若合并则 turns 只有 2 且队列一次清空。
      const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 3 }, 30_000);
      expect(settled.queueLength).toBe(0);
      expect(settled.lastError).toBeNull();

      const calls = fake.getCalls();
      expect(calls).toHaveLength(3);
      const [errorCall, aCall, bCall] = calls;
      expect(errorCall).toBeDefined();
      expect(aCall).toBeDefined();
      expect(bCall).toBeDefined();
      if (errorCall === undefined || aCall === undefined || bCall === undefined) return;
      expect(callText(errorCall)).not.toContain("排队A");
      expect(callText(errorCall)).not.toContain("排队B");
      expect(callText(aCall)).toContain("排队A");
      expect(callText(aCall)).not.toContain("排队B");
      expect(callText(bCall)).toContain("排队A");
      expect(callText(bCall)).toContain("排队B");

      expect(await userTextCount(registry, rec.sessionID, "正文句")).toBe(1);
      expect(await userTextCount(registry, rec.sessionID, "排队A")).toBe(1);
      expect(await userTextCount(registry, rec.sessionID, "排队B")).toBe(1);
    } finally {
      teardown();
    }
  }, 30_000);

  /** 首次 LLM 请求里的 user 正文序列（请求面取证；store 计数不足以暴露重复注入）。 */
  function firstCallUserTexts(
    fake: ReturnType<typeof createFakeModelFromConfig>,
  ): { calls: number; texts: readonly string[] } {
    const calls = fake.getCalls();
    const first = calls[0];
    return {
      calls: calls.length,
      texts: first === undefined
        ? []
        : first.messages.filter((m) => m.role === "user").map(messageText),
    };
  }

  it("W55 recovery 合并：3 条 sidecar -> 一个 run 消费全部，首次请求恰为 3 条一次", async () => {
    const { registry, fake, teardown } = makeRegistryWithTools(
      [convergeTurn("恢复合并收束", ["x"])],
      [],
    );
    const sid = "ses_w55recover0000001";
    const qdir = join(stateRoot, "session", "queue");
    mkdirSync(qdir, { recursive: true });
    const at = 1_730_000_200_000;
    writeFileSync(
      join(qdir, `${sid}.json`),
      JSON.stringify([
        { text: "恢复1", at, entryId: null },
        { text: "恢复2", at: at + 1, entryId: null },
        { text: "恢复3", at: at + 2, entryId: null },
      ]),
    );
    try {
      expect(await registry.recoverSendQueues()).toBe(3);
      const settled = await waitForView(registry, sid, { status: "idle", turns: 1 }, 30_000);
      expect(settled.queueLength).toBe(0);
      const face = firstCallUserTexts(fake);
      expect(face.calls).toBe(1);
      expect(face.texts).toEqual(["恢复1", "恢复2", "恢复3"]);
      for (const text of ["恢复1", "恢复2", "恢复3"]) {
        expect(await userTextCount(registry, sid, text), `${text} 应恰一份`).toBe(1);
      }
      expect(existsSync(join(qdir, `${sid}.json`))).toBe(false);
    } finally {
      teardown();
    }
  }, 30_000);

  it("W55 recovery 全已落盘：hydrate 载入 3 条 -> 全部丢弃，不起合成 run", async () => {
    const { registry, fake, store, teardown } = makeRegistryWithTools(
      [convergeTurn("预落盘收束", ["y"])],
      [],
    );
    const sid = "ses_w55recover0000002";
    const qdir = join(stateRoot, "session", "queue");
    mkdirSync(qdir, { recursive: true });
    const at = 1_730_000_300_000;
    const texts = ["预落1", "预落2", "预落3"];
    for (const [i, text] of texts.entries()) {
      await store.appendEntry(sid, {
        kind: "message",
        message: { role: "user", content: text, timestamp: at + i },
      });
    }
    writeFileSync(
      join(qdir, `${sid}.json`),
      JSON.stringify(texts.map((text, i) => ({ text, at: at + i, entryId: null }))),
    );
    try {
      expect(await registry.recoverSendQueues()).toBe(3);
      const rec = registry.get(sid);
      expect(rec).toBeDefined();
      expect(rec?.queue.length).toBe(0);
      expect(rec?.turns).toBe(0);
      expect(rec?.running).toBeNull();
      expect(fake.getCalls()).toHaveLength(0);
      for (const text of texts) {
        expect(await userTextCount(registry, sid, text), `${text} 应恰一份`).toBe(1);
      }
      expect(existsSync(join(qdir, `${sid}.json`))).toBe(false);
    } finally {
      teardown();
    }
  }, 30_000);

  it("W55 recovery 混合：已载入 2 条 + sidecar 第 3 条 -> 第 3 条作 prompt，首次请求 FIFO 恰一次", async () => {
    const { registry, fake, store, teardown } = makeRegistryWithTools(
      [convergeTurn("混合收束", ["z"])],
      [],
    );
    const sid = "ses_w55recover0000003";
    const qdir = join(stateRoot, "session", "queue");
    mkdirSync(qdir, { recursive: true });
    const at = 1_730_000_400_000;
    const texts = ["混合1", "混合2", "混合3"];
    for (const [i, text] of texts.entries()) {
      if (i === 2) continue; // 第 3 条只在 sidecar：hydrate 后由 reconcile 补写
      await store.appendEntry(sid, {
        kind: "message",
        message: { role: "user", content: text, timestamp: at + i },
      });
    }
    writeFileSync(
      join(qdir, `${sid}.json`),
      JSON.stringify(texts.map((text, i) => ({ text, at: at + i, entryId: null }))),
    );
    try {
      expect(await registry.recoverSendQueues()).toBe(3);
      const settled = await waitForView(registry, sid, { status: "idle", turns: 1 }, 30_000);
      expect(settled.queueLength).toBe(0);
      const face = firstCallUserTexts(fake);
      expect(face.calls).toBe(1);
      expect(face.texts).toEqual(texts);
      for (const text of texts) {
        expect(await userTextCount(registry, sid, text), `${text} 应恰一份`).toBe(1);
      }
      expect(existsSync(join(qdir, `${sid}.json`))).toBe(false);
    } finally {
      teardown();
    }
  }, 30_000);

  // ───────────────────── W55 pending 可见性状态机（session.queue + pendingView） ─────────────────────

  describe("W55 pending 可见性状态机", () => {
    it("busy send 立刻发 session.queue(queued)，pendingView 与帧同形且 FIFO", async () => {
      const hold = makeHoldTool();
      const { registry, teardown } = makeRegistryWithTools(
        [
          { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
          convergeTurn("收束", ["x"]),
        ],
        [hold.tool],
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        const stream = await fetch(`${baseUrl}/sessions/${sessionID}/events`, { headers: auth() });
        expect(stream.status).toBe(200);
        const queueFrame = readUntil(stream, (frames) =>
          frames.some(
            (f) =>
              f.payload.type === "session.queue" &&
              pendingOf(f).some((p) => p.text === "排队A" && p.state === "queued"),
          ),
        );

        await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
        await hold.entered;
        const sent = await postJson(`/sessions/${sessionID}/messages`, { text: "排队A" });
        expect(sent.status).toBe(202);

        const { frames } = await queueFrame;
        const frame = frames.find(
          (f) =>
            f.payload.type === "session.queue" &&
            pendingOf(f).some((p) => p.text === "排队A" && p.state === "queued"),
        );
        expect(frame).toBeDefined();
        if (frame === undefined) return;
        const pending = pendingOf(frame);
        expect(pending.map((p) => p.text)).toEqual(["正文句", "排队A"]);
        expect(pending.map((p) => p.state)).toEqual(["running", "queued"]);
        expect(frame.payload.properties["sessionID"]).toBe(sessionID);
        expect(registry.pendingView(sessionID)?.pending).toEqual(pending);

        hold.release();
        await waitForView(registry, sessionID, { status: "idle", turns: 1 }, 30_000);
        expect(registry.pendingView(sessionID)?.pending).toEqual([]);
      } finally {
        teardown();
      }
    }, 30_000);

    it("held busy 连发两条：pendingView 严格 FIFO（running -> queued -> queued）", async () => {
      const hold = makeHoldTool();
      const { registry, teardown } = makeRegistryWithTools(
        [
          { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
          convergeTurn("收束", ["x"]),
        ],
        [hold.tool],
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "正文句");
        await hold.entered;
        registry.send(rec.sessionID, "排队A");
        registry.send(rec.sessionID, "排队B");

        expect(registry.pendingView(rec.sessionID)?.pending.map((p) => [p.text, p.state])).toEqual([
          ["正文句", "running"],
          ["排队A", "queued"],
          ["排队B", "queued"],
        ]);
        expect(registry.statusView(rec.sessionID)?.queueLength).toBe(2);

        hold.release();
        await waitForView(registry, rec.sessionID, { status: "idle", turns: 1 }, 30_000);
        expect(registry.pendingView(rec.sessionID)?.pending).toEqual([]);
      } finally {
        teardown();
      }
    }, 30_000);

    it("release 后 settle 摘除两条：转录顺序 toolResult -> A -> B，各恰一份", async () => {
      const hold = makeHoldTool();
      const { registry, teardown } = makeRegistryWithTools(
        [
          { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
          convergeTurn("收束", ["x"]),
        ],
        [hold.tool],
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "正文句");
        await hold.entered;
        registry.send(rec.sessionID, "排队A");
        registry.send(rec.sessionID, "排队B");

        hold.release();
        const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 1 }, 30_000);
        expect(settled.queueLength).toBe(0);
        expect(registry.pendingView(rec.sessionID)?.pending).toEqual([]);

        const page = await registry.history(rec.sessionID, { limit: 200 });
        const toolIdx = page.messages.findIndex((m) => m.role === "toolResult");
        const aIdx = page.messages.findIndex((m) => m.role === "user" && messageText(m) === "排队A");
        const bIdx = page.messages.findIndex((m) => m.role === "user" && messageText(m) === "排队B");
        expect(toolIdx).toBeGreaterThanOrEqual(0);
        expect(aIdx).toBeGreaterThan(toolIdx);
        expect(bIdx).toBeGreaterThan(aIdx);
        expect(await userTextCount(registry, rec.sessionID, "排队A")).toBe(1);
        expect(await userTextCount(registry, rec.sessionID, "排队B")).toBe(1);
      } finally {
        teardown();
      }
    }, 30_000);

    it("settle 缺证据：drained -> queued 复位并重投，下一次 run 落盘恰一份", async () => {
      class DropOnceStore extends MemorySessionStore {
        dropped = false;

        override async appendEntry(sessionId: string, entry: SessionEntry): Promise<StoredEntry> {
          if (
            !this.dropped &&
            entry.kind === "message" &&
            entry.message.role === "user" &&
            entry.message.content === "插入句"
          ) {
            this.dropped = true;
            const leafId = await this.getLeafId(sessionId);
            return { id: "w55_dropped_insert_entry", parentId: leafId, seq: -1, entry };
          }
          return super.appendEntry(sessionId, entry);
        }
      }

      const store = new DropOnceStore();
      const hold = makeHoldTool();
      const { registry, teardown } = makeRegistryWithTools(
        [
          { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
          convergeTurn("run1 收束", ["1"]),
          convergeTurn("run2 收束", ["2"]),
        ],
        [hold.tool],
        { store },
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        const stream = await fetch(`${baseUrl}/sessions/${sessionID}/events`, { headers: auth() });
        expect(stream.status).toBe(200);
        const twoIdles = readUntil(
          stream,
          (frames) => frames.filter((f) => f.payload.type === "session.idle").length >= 2,
          30_000,
        );

        await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
        await hold.entered;
        await postJson(`/sessions/${sessionID}/messages`, { text: "插入句" });
        hold.release();

        const settled = await waitForView(registry, sessionID, { status: "idle", turns: 2 }, 30_000);
        expect(settled.queueLength).toBe(0);
        expect(store.dropped).toBe(true);
        expect(await userTextCount(registry, sessionID, "插入句")).toBe(1);
        expect(registry.pendingView(sessionID)?.pending).toEqual([]);

        const { frames } = await twoIdles;
        const states = frames
          .filter((f) => f.payload.type === "session.queue")
          .map((f) => pendingOf(f).find((p) => p.text === "插入句")?.state)
          .filter((s): s is PendingItemView["state"] => s !== undefined);
        const drainedIdx = states.indexOf("drained");
        expect(drainedIdx).toBeGreaterThanOrEqual(0);
        const requeuedIdx = states.indexOf("queued", drainedIdx + 1);
        expect(requeuedIdx, "settle 缺证据须复位为 queued 再重投").toBeGreaterThan(drainedIdx);
        expect(states.indexOf("running", requeuedIdx + 1)).toBeGreaterThan(requeuedIdx);
      } finally {
        teardown();
      }
    }, 60_000);

    it("idle send：pendingView(running) -> 收尾清空；store 的 (text, at) 精确等于受理时刻", async () => {
      const at = 1_730_000_500_000;
      const { registry, store, teardown } = makeRegistryWithTools(
        [convergeTurn("收束", ["x"])],
        [],
        { now: () => at },
      );
      try {
        const rec = registry.create();
        const outcome = registry.send(rec.sessionID, "直接句");
        expect(outcome).toEqual({ accepted: true, sessionID: rec.sessionID });
        expect(registry.pendingView(rec.sessionID)?.pending).toEqual([
          { text: "直接句", at, state: "running" },
        ]);

        const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 1 }, 30_000);
        expect(settled.queueLength).toBe(0);
        expect(registry.pendingView(rec.sessionID)?.pending).toEqual([]);

        const path = await store.getPathToLeaf(rec.sessionID);
        const users = path.filter(
          (stored) => stored.entry.kind === "message" && stored.entry.message.role === "user",
        );
        expect(users).toHaveLength(1);
        const only = users[0];
        expect(only).toBeDefined();
        if (only === undefined || only.entry.kind !== "message") return;
        expect(only.entry.message.content).toBe("直接句");
        expect(only.entry.message.timestamp).toBe(at);
      } finally {
        teardown();
      }
    }, 30_000);

    it("recovery：exact 已落盘项丢弃不起 run；缺席项重灌入队并起 run", async () => {
      const sessionFile = join(stateRoot, "loom-main.jsonl");
      const atExact = 1_730_000_600_000;
      const atAbsent = 1_730_000_600_100;
      const preStore = new JsonlSessionStore(sessionFile);
      await preStore.appendEntry("ses_recoverexact00001", {
        kind: "message",
        message: { role: "user", content: "已落盘", timestamp: atExact },
      });

      const qdir = join(stateRoot, "session", "queue");
      mkdirSync(qdir, { recursive: true });
      writeFileSync(
        join(qdir, "ses_recoverexact00001.json"),
        JSON.stringify([{ text: "已落盘", at: atExact }]),
      );
      writeFileSync(
        join(qdir, "ses_recoverabsent000001.json"),
        JSON.stringify([{ text: "未落盘", at: atAbsent }]),
      );

      const { registry, fake, teardown } = makeRegistryWithTools(
        [{ ...convergeTurn("恢复收束", ["x"]), delayMs: 500 }],
        [],
        { store: new JsonlSessionStore(sessionFile) },
      );
      try {
        expect(await registry.recoverSendQueues()).toBe(2);

        const exact = registry.get("ses_recoverexact00001");
        expect(exact?.turns).toBe(0);
        expect(exact?.running).toBeNull();
        expect(exact?.queue.length).toBe(0);
        expect(registry.pendingView("ses_recoverexact00001")?.pending).toEqual([]);

        expect(registry.pendingView("ses_recoverabsent000001")?.pending).toEqual([
          { text: "未落盘", at: atAbsent, state: "running" },
        ]);
        await waitForView(registry, "ses_recoverabsent000001", { status: "idle", turns: 1 }, 30_000);
        expect(await userTextCount(registry, "ses_recoverabsent000001", "未落盘")).toBe(1);
        expect(await userTextCount(registry, "ses_recoverexact00001", "已落盘")).toBe(1);
        expect(fake.getCalls()).toHaveLength(1);
      } finally {
        teardown();
      }
    }, 60_000);

    it("cap：10 条未消费 -> 第 11 条 409 queueLength 10；turn 边界 drained 后不占容量", async () => {
      const { registry, teardown } = makeRegistryWithTools(
        [
          {
            content: [
              { type: "text", text: "慢轮" },
              { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
            ],
            delayMs: 1500,
          },
          { ...convergeTurn("合并轮", ["x"]), delayMs: 800 },
        ],
        [],
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
        await waitForStatus(sessionID, "busy");

        for (let i = 0; i < 10; i++) {
          const r = await postJson(`/sessions/${sessionID}/messages`, { text: `队列${String(i)}` });
          expect(r.status).toBe(202);
        }
        expect(registry.statusView(sessionID)?.queueLength).toBe(10);

        const overflow = await postJson(`/sessions/${sessionID}/messages`, { text: "队列第11条" });
        expect(overflow.status).toBe(409);
        const body = (await overflow.json()) as {
          error: { code: string };
          queueCapacity: number;
          queueLength: number;
        };
        expect(body.error.code).toBe("session_busy");
        expect(body.queueCapacity).toBe(10);
        expect(body.queueLength).toBe(10);

        const drainDeadline = Date.now() + 30_000;
        for (;;) {
          const pending = registry.pendingView(sessionID)?.pending ?? [];
          const drained = pending.filter((p) => p.state === "drained").length;
          if (drained === 9 && pending.length === 10) break;
          if (Date.now() > drainDeadline) {
            throw new Error(`steering 未在预算内 drain：${JSON.stringify(pending)}`);
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(registry.statusView(sessionID)?.queueLength).toBe(0);

        const settled = await waitForView(registry, sessionID, { status: "idle", turns: 2 }, 30_000);
        expect(settled.queueLength).toBe(0);
        expect(registry.pendingView(sessionID)?.pending).toEqual([]);
        for (const text of ["正文句", ...Array.from({ length: 10 }, (_, i) => `队列${String(i)}`)]) {
          expect(await userTextCount(registry, sessionID, text), `${text} 应恰一份`).toBe(1);
        }
      } finally {
        teardown();
      }
    }, 60_000);

    it("drain 抛错：队首保持未消费、followers 句柄撤回、error 帧；恢复后不丢不重", async () => {
      const { registry, fake, teardown } = makeRegistryWithTools(
        [
          {
            content: [
              { type: "text", text: "慢轮" },
              { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
            ],
            delayMs: 1500,
          },
          convergeTurn("恢复收束", ["r"]),
          convergeTurn("补跑收束", ["c"]),
        ],
        [],
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        const stream = await fetch(`${baseUrl}/sessions/${sessionID}/events`, { headers: auth() });
        expect(stream.status).toBe(200);

        await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
        await waitForStatus(sessionID, "busy");
        for (const text of ["排队A", "排队B", "排队C"]) {
          const r = await postJson(`/sessions/${sessionID}/messages`, { text });
          expect(r.status).toBe(202);
        }

        const rec = registry.get(sessionID);
        if (rec === undefined) throw new Error("session record missing");
        const originalSteer = rec.loop.steer.bind(rec.loop);
        let armed = false;
        let drainSteers = 0;
        rec.loop.steer = (message, opts) => {
          if (armed) {
            drainSteers += 1;
            if (drainSteers === 2) throw new Error("steer exploded (W55 drain 注入)");
          }
          return originalSteer(message, opts);
        };
        armed = true;

        const { frames } = await readUntil(
          stream,
          (fs) => fs.some((f) => f.payload.type === "session.error"),
          30_000,
        );
        armed = false;
        const errorFrame = frames.find((f) => f.payload.type === "session.error");
        expect(errorFrame).toBeDefined();
        expect(JSON.stringify(errorFrame?.payload.properties)).toContain("steer exploded");
        expect(registry.statusView(sessionID)?.status).toBe("error");
        expect(registry.statusView(sessionID)?.queueLength).toBe(3);
        expect(registry.pendingView(sessionID)?.pending.map((p) => [p.text, p.state])).toEqual([
          ["排队A", "queued"],
          ["排队B", "queued"],
          ["排队C", "queued"],
        ]);
        expect(await userTextCount(registry, sessionID, "排队A")).toBe(0);

        await postJson(`/sessions/${sessionID}/messages`, { text: "恢复句" });
        const settled = await waitForView(registry, sessionID, { status: "idle", turns: 3 }, 30_000);
        expect(settled.queueLength).toBe(0);
        expect(registry.pendingView(sessionID)?.pending).toEqual([]);
        for (const text of ["正文句", "排队A", "排队B", "排队C", "恢复句"]) {
          expect(await userTextCount(registry, sessionID, text), `${text} 应恰一份`).toBe(1);
        }
        expect(fake.getCalls()).toHaveLength(3);
      } finally {
        teardown();
      }
    }, 60_000);

    it("settle 进行中的 idle send：新项 consumed 不被上一轮清掉，恰一个 run", async () => {
      class SettleGateStore extends MemorySessionStore {
        gate: { entered: () => void; wait: Promise<void> } | null = null;

        override async getPathToLeaf(sessionId: string, leafId?: string): Promise<StoredEntry[]> {
          const path = await super.getPathToLeaf(sessionId, leafId);
          const gate = this.gate;
          if (gate !== null) {
            this.gate = null;
            gate.entered();
            await gate.wait;
          }
          return path;
        }
      }

      const store = new SettleGateStore();
      const hold = makeHoldTool();
      const { registry, teardown } = makeRegistryWithTools(
        [
          { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
          convergeTurn("第一轮收束", ["1"]),
          { ...convergeTurn("第二轮收束", ["2"]), delayMs: 600 },
        ],
        [hold.tool],
        { store },
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "第一句");
        await hold.entered;

        const readEntered = deferred();
        const readRelease = deferred();
        store.gate = { entered: readEntered.resolve, wait: readRelease.promise };

        hold.release();
        await readEntered.promise;

        registry.send(rec.sessionID, "第二句");
        expect(registry.pendingView(rec.sessionID)?.pending.map((p) => [p.text, p.state])).toEqual([
          ["第一句", "running"],
          ["第二句", "running"],
        ]);

        readRelease.resolve();
        const shrinkDeadline = Date.now() + 5_000;
        while ((registry.pendingView(rec.sessionID)?.pending.length ?? 0) !== 1) {
          if (Date.now() > shrinkDeadline) throw new Error("上一轮 settle 未在预算内摘队");
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(registry.pendingView(rec.sessionID)?.pending[0]).toMatchObject({
          text: "第二句",
          state: "running",
        });
        expect(registry.statusView(rec.sessionID)?.turns).toBe(2);

        const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 2 }, 30_000);
        expect(settled.queueLength).toBe(0);
        expect(registry.pendingView(rec.sessionID)?.pending).toEqual([]);
        expect(await userTextCount(registry, rec.sessionID, "第一句")).toBe(1);
        expect(await userTextCount(registry, rec.sessionID, "第二句")).toBe(1);
      } finally {
        teardown();
      }
    }, 30_000);

    it("W55 coalesce：3 条 queued -> 恰一个新 run，首次请求三条独立消息按序", async () => {
      const { registry, fake, teardown } = makeRegistryWithTools(
        [
          {
            content: [
              { type: "text", text: "当前轮慢收束" },
              { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
            ],
            delayMs: 1200,
          },
          convergeTurn("合并收束", ["m"]),
        ],
        [],
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "正文句");
        const callDeadline = Date.now() + 5_000;
        while (fake.getCalls().length === 0) {
          if (Date.now() > callDeadline) throw new Error("首轮 LLM 请求未在预算内发出");
          await new Promise((r) => setTimeout(r, 5));
        }
        for (const text of ["排队1", "排队2", "排队3"]) registry.send(rec.sessionID, text);
        expect(registry.pendingView(rec.sessionID)?.pending.map((p) => p.state)).toEqual([
          "running",
          "queued",
          "queued",
          "queued",
        ]);

        const settled = await waitForView(registry, rec.sessionID, { status: "idle", turns: 2 }, 15_000);
        expect(settled.queueLength).toBe(0);
        expect(registry.pendingView(rec.sessionID)?.pending).toEqual([]);

        const calls = fake.getCalls();
        expect(calls).toHaveLength(2);
        const second = calls[1];
        expect(second).toBeDefined();
        if (second === undefined) return;
        expect(second.messages.filter((m) => m.role === "user").map(messageText)).toEqual([
          "正文句",
          "排队1",
          "排队2",
          "排队3",
        ]);
        for (const text of ["正文句", "排队1", "排队2", "排队3"]) {
          expect(await userTextCount(registry, rec.sessionID, text), `${text} 应恰一份`).toBe(1);
        }
      } finally {
        teardown();
      }
    }, 30_000);
  });

  describe("W55 GET /sessions/:sessionID/pending 路由", () => {
    interface PendingBody {
      readonly sessionID: string;
      readonly pending: readonly PendingItemView[];
    }

    it("已知空闲会话 -> 200 {sessionID, pending: []}", async () => {
      const { registry, teardown } = makeRegistryWithTools([convergeTurn("收束", ["x"])], []);
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };

        const res = await getJson(`/sessions/${sessionID}/pending`);
        expect(res.status).toBe(200);
        expect((await res.json()) as PendingBody).toEqual({ sessionID, pending: [] });
      } finally {
        teardown();
      }
    }, 30_000);

    it("busy send -> 200 pending 含排队项且 state=queued", async () => {
      const hold = makeHoldTool();
      const { registry, teardown } = makeRegistryWithTools(
        [
          { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
          convergeTurn("收束", ["x"]),
        ],
        [hold.tool],
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        await postJson(`/sessions/${sessionID}/messages`, { text: "正文句" });
        await hold.entered;
        const sent = await postJson(`/sessions/${sessionID}/messages`, { text: "排队A" });
        expect(sent.status).toBe(202);

        const res = await getJson(`/sessions/${sessionID}/pending`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as PendingBody;
        expect(body.sessionID).toBe(sessionID);
        expect(body.pending.map((p) => [p.text, p.state])).toEqual([
          ["正文句", "running"],
          ["排队A", "queued"],
        ]);

        hold.release();
        await waitForView(registry, sessionID, { status: "idle", turns: 1 }, 30_000);
      } finally {
        teardown();
      }
    }, 30_000);

    it("idle send -> flush 前 200 pending 含该项且 state=running", async () => {
      const hold = makeHoldTool();
      const { registry, teardown } = makeRegistryWithTools(
        [
          { content: [{ type: "toolCall", name: "hold", arguments: {} }] },
          convergeTurn("收束", ["x"]),
        ],
        [hold.tool],
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        await postJson(`/sessions/${sessionID}/messages`, { text: "直接句" });
        await hold.entered;

        const res = await getJson(`/sessions/${sessionID}/pending`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as PendingBody;
        expect(body.sessionID).toBe(sessionID);
        expect(body.pending).toHaveLength(1);
        const only = body.pending[0];
        expect(only?.text).toBe("直接句");
        expect(only?.state).toBe("running");
        expect(typeof only?.at).toBe("number");

        hold.release();
        await waitForView(registry, sessionID, { status: "idle", turns: 1 }, 30_000);
      } finally {
        teardown();
      }
    }, 30_000);

    it("未知 sid -> 404 session_not_found", async () => {
      const { registry, teardown } = makeRegistryWithTools([], []);
      await listen(registry);
      try {
        const res = await getJson("/sessions/ses_missing_pending/pending");
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("session_not_found");
      } finally {
        teardown();
      }
    });

    it("非法 sid -> 400 bad_session_id", async () => {
      const { registry, teardown } = makeRegistryWithTools([], []);
      await listen(registry);
      try {
        const res = await getJson("/sessions/bad!sid/pending");
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("bad_session_id");
      } finally {
        teardown();
      }
    });
  });

  // ───────────────────── T5 失败回合重放（continueRun，不重复 user 消息） ─────────────────────

  describe("T5 failed-turn replay", () => {
    const TRANSIENT: FakeAssistantResponse = {
      content: [],
      stopReason: "error",
      errorMessage: "503 system cpu overloaded",
    };

    it("transient error then success: one replay via continueRun, one user message, idle", async () => {
      const { registry, fake, teardown } = makeRegistryWithTools(
        [TRANSIENT, convergeTurn("重放收束", ["重放"])],
        [],
        { llmErrorRetries: 0, failedTurnReplayRetries: 2, failedTurnReplayBackoffMs: 5 },
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "原始问题");
        const settled = await waitForView(
          registry,
          rec.sessionID,
          { status: "idle", turns: 2 },
          30_000,
        );
        expect(settled.queueLength).toBe(0);

        const calls = fake.getCalls();
        expect(calls).toHaveLength(2);
        expect(calls[1]!.messages.filter((m) => m.role === "user").map(messageText)).toEqual([
          "原始问题",
        ]);
        expect(await userTextCount(registry, rec.sessionID, "原始问题")).toBe(1);
        expect(
          existsSync(join(stateRoot, "session", "queue", `${rec.sessionID}.json`)),
        ).toBe(false);
      } finally {
        teardown();
      }
    }, 30_000);

    it("replay cap reached: initial + one replay then honest error, queue empty", async () => {
      const { registry, fake, teardown } = makeRegistryWithTools(
        [TRANSIENT, TRANSIENT],
        [],
        { llmErrorRetries: 0, failedTurnReplayRetries: 1, failedTurnReplayBackoffMs: 5 },
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "必失败");
        const settled = await waitForView(
          registry,
          rec.sessionID,
          { status: "error", turns: 2 },
          30_000,
        );
        expect(settled.queueLength).toBe(0);
        expect(settled.lastError).toBe("503 system cpu overloaded");
        expect(fake.getCalls()).toHaveLength(2);
        expect(await userTextCount(registry, rec.sessionID, "必失败")).toBe(1);
      } finally {
        teardown();
      }
    }, 30_000);

    it("sync provider throw is not replayed (no failed assistant message)", async () => {
      const { registry, fake, teardown } = makeRegistryWithTools(
        [
          {
            content: [{ type: "text", text: "boom" }],
            streamThrows: new Error("provider exploded"),
          },
        ],
        [],
        { llmErrorRetries: 0, failedTurnReplayRetries: 2, failedTurnReplayBackoffMs: 5 },
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "同步抛");
        const settled = await waitForView(
          registry,
          rec.sessionID,
          { status: "error", turns: 1 },
          30_000,
        );
        expect(settled.queueLength).toBe(0);
        expect(fake.getCalls()).toHaveLength(1);
        expect(
          existsSync(join(stateRoot, "session", "queue", `${rec.sessionID}.json`)),
        ).toBe(false);
      } finally {
        teardown();
      }
    }, 30_000);

    it("sidecar recovery keeps a replay row when its prompt is already persisted", async () => {
      const sessionFile = join(stateRoot, "loom-main.jsonl");
      const sid = "ses_t5replayrecovery01";
      const at = 1_730_000_400_000;
      const preStore = new JsonlSessionStore(sessionFile);
      await preStore.appendEntry(sid, {
        kind: "message",
        message: { role: "user", content: "恢复重放", timestamp: at },
      });
      const qdir = join(stateRoot, "session", "queue");
      mkdirSync(qdir, { recursive: true });
      writeFileSync(
        join(qdir, `${sid}.json`),
        JSON.stringify([
          { text: "恢复重放", at, mode: "replay", attempts: 1, nextAt: 0 },
        ]),
      );

      const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
      const model = createFakeModelFromConfig(cfg.models[0]!, [
        convergeTurn("恢复续跑收束", ["x"]),
      ]);
      const registry = new SessionRegistry({
        model,
        store: new JsonlSessionStore(sessionFile),
        stateRoot,
        failedTurnReplayRetries: 2,
        failedTurnReplayBackoffMs: 5,
      });
      try {
        expect(await registry.recoverSendQueues()).toBe(1);
        const settled = await waitForView(registry, sid, { status: "idle", turns: 1 }, 30_000);
        expect(settled.queueLength).toBe(0);

        expect(model.getCalls()).toHaveLength(1);
        expect(
          model.getCalls()[0]!.messages
            .filter((m) => m.role === "user")
            .map(messageText),
        ).toEqual(["恢复重放"]);
        expect(await userTextCount(registry, sid, "恢复重放")).toBe(1);
        expect(existsSync(join(qdir, `${sid}.json`))).toBe(false);
      } finally {
        model.teardown();
      }
    }, 30_000);

    it("new idle send cancels a pending replay timer and runs only the new prompt", async () => {
      const { registry, fake, teardown } = makeRegistryWithTools(
        [TRANSIENT, convergeTurn("新句收束", ["新"])],
        [],
        { llmErrorRetries: 0, failedTurnReplayRetries: 2, failedTurnReplayBackoffMs: 300 },
      );
      try {
        const rec = registry.create();
        registry.send(rec.sessionID, "第一句");
        const deadline = Date.now() + 30_000;
        for (;;) {
          const view = registry.statusView(rec.sessionID);
          if (
            view?.status === "error" &&
            view.queueLength === 1 &&
            rec.replayTimer !== null
          ) {
            break;
          }
          if (Date.now() > deadline) throw new Error("replay 未在预算内挂起");
          await new Promise((r) => setTimeout(r, 25));
        }

        registry.send(rec.sessionID, "新句");
        expect(rec.replayTimer).toBeNull();
        expect(rec.queue.some((item) => item.mode === "replay")).toBe(false);

        const settled = await waitForView(
          registry,
          rec.sessionID,
          { status: "idle", turns: 2 },
          30_000,
        );
        expect(settled.queueLength).toBe(0);
        expect(fake.getCalls()).toHaveLength(2);
        expect(await userTextCount(registry, rec.sessionID, "第一句")).toBe(1);
        expect(await userTextCount(registry, rec.sessionID, "新句")).toBe(1);

        await new Promise((r) => setTimeout(r, 400));
        expect(fake.getCalls()).toHaveLength(2);
        expect(registry.statusView(rec.sessionID)?.queueLength).toBe(0);
      } finally {
        teardown();
      }
    }, 30_000);
  });

  // W56 忙时发送抢占：busy + interruptOnSend=true → 新消息 unshift 队首 + abort 当前轮；
  // 当前轮 finally 的 #drainQueue 取其为下一轮 prompt，既有排队项原序作 followers
  // （绝不丢弃/重排），HTTP 受理面返回 interrupted:true 而非 queued:true。
  describe("W56 interruptOnSend 忙时抢占当前轮", () => {
    it("busy 新消息即刻 202 interrupted：abort 当前轮，下一轮 prompt 即新消息，转录恰一份", async () => {
      const { registry, teardown } = makeRegistry(
        [
          { content: [{ type: "text", text: "第一轮慢跑" }], delayMs: 3000 },
          convergeTurn("第二句收束", ["第二句"]),
        ],
        { interruptOnSend: true },
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        await postJson(`/sessions/${sessionID}/messages`, { text: "第一句" });
        await waitForStatus(sessionID, "busy");

        const startedAt = Date.now();
        const interrupted = await postJson(`/sessions/${sessionID}/messages`, { text: "第二句" });
        const elapsedMs = Date.now() - startedAt;
        expect(interrupted.status).toBe(202);
        expect(await interrupted.json()).toEqual({
          sessionID,
          status: "busy",
          accepted: true,
          interrupted: true,
        });
        expect(elapsedMs).toBeLessThan(1000);

        // run 间瞬态 idle 不可当收尾：等 turns=2 且队列归零（waitForView 同 W42b 口径）。
        const idle = await waitForView(registry, sessionID, { status: "idle", turns: 2 }, 30_000);
        expect(idle.turns).toBe(2);
        expect(await userTextCount(registry, sessionID, "第二句")).toBe(1);
      } finally {
        teardown();
      }
    }, 30_000);

    it("既有排队项保留：新消息插队首，旧排队项作为 follower 合并进下一轮且恰一份", async () => {
      const { registry, teardown } = makeRegistry(
        [
          { content: [{ type: "text", text: "第一轮慢跑" }], delayMs: 3000 },
          convergeTurn("下一轮收束", ["打断", "排队"]),
        ],
        { interruptOnSend: true },
      );
      await listen(registry);
      try {
        const created = await postJson("/sessions", {});
        const { sessionID } = (await created.json()) as { sessionID: string };
        await postJson(`/sessions/${sessionID}/messages`, { text: "第一句" });
        await waitForStatus(sessionID, "busy");

        // 同开关下任何 busy send 都会抢占，无法经 HTTP 造出"排队A 已 queued"前提；
        // 直接向公共 SessionRecord.queue 注入既有排队项（等价于抢占启用前/恢复留下的
        // follower），用于验证抢占路径不丢、不重排既有项。
        const rec = registry.ensure(sessionID);
        rec.queue.push({ text: "排队A", at: Date.now() });

        const interrupted = await postJson(`/sessions/${sessionID}/messages`, { text: "打断B" });
        expect(interrupted.status).toBe(202);
        expect(await interrupted.json()).toEqual({
          sessionID,
          status: "busy",
          accepted: true,
          interrupted: true,
        });

        await waitForView(registry, sessionID, { status: "idle", turns: 2 }, 30_000);
        for (const text of ["排队A", "打断B"]) {
          expect(await userTextCount(registry, sessionID, text), `${text} 应恰一份`).toBe(1);
        }
      } finally {
        teardown();
      }
    }, 30_000);
  });
});

describe("POST /sessions/:sessionID/compact —— 重启会话先 hydrate 再取压缩快照", () => {
  it("盘上有转录但内核未 hydrate：POST /compact 先 hydrate，startCompaction 看到非空快照", async () => {
    const sessionFile = join(stateRoot, "loom-main.jsonl");
    const sessionID = "ses_compactrestart0001";
    const at = 1_730_000_200_000;
    const preStore = new JsonlSessionStore(sessionFile);
    await preStore.appendEntry(sessionID, {
      kind: "message",
      message: { role: "user", content: "重启前的第一句", timestamp: at },
    });
    await preStore.appendEntry(sessionID, {
      kind: "message",
      message: { role: "user", content: "重启前的第二句", timestamp: at + 1 },
    });

    const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
    const model = createFakeModelFromConfig(cfg.models[0]!, []);
    const registry = new SessionRegistry({
      model,
      store: new JsonlSessionStore(sessionFile),
      stateRoot,
    });
    await listen(registry);
    try {
      // 重启后的内核记录：盘上有转录，但 loop 内存尚未装载（#ensure 不 hydrate）。
      const rec = registry.ensure(sessionID);
      expect(rec.loop.messages).toHaveLength(0);

      const calls: string[] = [];
      const realHydrate = rec.loop.hydrate.bind(rec.loop);
      const hydrateSpy = vi.spyOn(rec.loop, "hydrate").mockImplementation(async () => {
        calls.push("hydrate");
        return realHydrate();
      });
      const snapshotAtStart: number[] = [];
      vi.spyOn(rec.loop.session, "startCompaction").mockImplementation((reason) => {
        calls.push("startCompaction");
        snapshotAtStart.push(rec.loop.messages.length);
        return {
          attemptId: "attempt_compact_restart",
          done: Promise.resolve({
            ok: true,
            kind: "noop",
            attemptId: "attempt_compact_restart",
            reason: reason ?? "manual",
            coveredCount: 0,
          } satisfies WorkerOutcome),
        };
      });

      const res = await postJson(`/sessions/${sessionID}/compact`, {});
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        sessionID,
        status: "compacting",
        accepted: true,
        attemptId: "attempt_compact_restart",
      });
      expect(hydrateSpy).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["hydrate", "startCompaction"]);
      expect(snapshotAtStart).toEqual([2]);
    } finally {
      model.teardown();
    }
  }, 30_000);
});
