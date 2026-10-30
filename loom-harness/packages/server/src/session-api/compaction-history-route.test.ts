/**
 * C2 GET /sessions/:id/compactions 端点验收 —— 历史摘要面。
 *
 * 复用 W51 compaction-status.test.ts 的端到端 harness 形态（真 autoCompaction + fake model +
 * 真 HTTP Router）：404 纪律 / 已知空面 / run-end auto 事件 / seed-on-read 幂等 /
 * 两次推进双事件（旧摘要不被替换）。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore, autoCompaction, type Hook, type Message } from "@axeuh/loom-core";
import type { AssemblyPlan } from "@axeuh/loom-core/assembly";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import { Router } from "../http/router.js";
import { SessionRegistry, registerSessionRoutes, type SessionApiDeps } from "./index.js";
import { readCompactionEvents, type CompactionEvent } from "./compaction-events.js";
import type { SessionCompactionsResponse } from "./types.js";

const GOOD_TOKEN = "tok-c2-compactions";
const IDLE_TIMEOUT_MS = 20_000;

const FAKE_YAML = [
  "server:",
  "  port: 5105",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-c2-compactions-workspace",
  "models:",
  "  - id: fake-c2",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
].join("\n");

const PLAN: AssemblyPlan = {
  systemPrompt: "你是 loom 主会话。",
  memorySources: [{ source: "AGENTS.md", content: "# 工作区记忆\nC2 哨兵\n", degrade: null }],
  workflows: [],
};

const convergeTurn = (text: string): FakeAssistantResponse => ({
  content: [
    { type: "text", text },
    { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
  ],
});

/**
 * 真 autoCompaction（一实例一 session）：阈值 1 token 恒触发；keepRecent=1 使首 run
 * 压无可压、次 run 覆盖 3 条。resummarizeEvery 缺省 1000 封死后续重总结，传 1 时
 * 每轮推进（用于"两次推进"用例）。
 */
function compactionHooksFor(resummarizeEvery = 1000): (sessionID: string) => readonly Hook[] {
  return () => [
    autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.01,
      keepRecent: 1,
      resummarizeEvery,
      summarize: (early) => `SUM:${early.length}`,
    }),
  ];
}

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";

function makeRegistry(
  hooksFor: (sessionID: string) => readonly Hook[] = compactionHooksFor(),
): { registry: SessionRegistry; store: MemorySessionStore; teardown: () => void } {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [
    convergeTurn("回复一"),
    convergeTurn("回复二"),
    convergeTurn("回复三"),
  ]);
  const store = new MemorySessionStore();
  const registry = new SessionRegistry({
    model,
    store,
    stateRoot,
    assembly: { plan: PLAN, reader: null },
    hooksFor,
  });
  return { registry, store, teardown: () => model.teardown() };
}

async function listen(deps: SessionApiDeps): Promise<void> {
  const router = new Router({ tokens: [GOOD_TOKEN] });
  registerSessionRoutes(router, deps);
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${GOOD_TOKEN}`, ...(init?.headers ?? {}) },
  });
}

async function createSession(registry: SessionRegistry): Promise<string> {
  const created = await api("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(created.status).toBe(201);
  const { sessionID } = (await created.json()) as { sessionID: string };
  expect(registry.loopOf(sessionID)).toBeDefined();
  return sessionID;
}

async function sendAndWaitIdle(registry: SessionRegistry, sessionID: string, text: string): Promise<void> {
  const sent = await api(`/sessions/${encodeURIComponent(sessionID)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(sent.status).toBe(202);
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  for (;;) {
    if (registry.statusView(sessionID)?.status === "idle" && registry.get(sessionID)?.running === null) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting idle for ${sessionID}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function getCompactions(sessionID: string): Promise<SessionCompactionsResponse> {
  const res = await api(`/sessions/${encodeURIComponent(sessionID)}/compactions`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as SessionCompactionsResponse;
  expect(Object.keys(body).sort()).toEqual(["events", "sessionID"]);
  return body;
}

function eventLogPath(sessionID: string): string {
  return join(stateRoot, "session", "compaction", `${sessionID}.events.jsonl`);
}

function eventLogLineCount(sessionID: string): number {
  return readFileSync(eventLogPath(sessionID), "utf8").trim().split("\n").length;
}

const RESTORED_SUMMARY = "durable-boundary-summary";

/** 预置 durable 边界：2 条被覆盖前缀 + summary + 2 条尾巴（canonical coveredCount=2，重放视图=1）。 */
async function seedDurableBoundary(store: MemorySessionStore, sessionID: string): Promise<void> {
  const message = (content: string, timestamp: number): Message => ({
    role: "user",
    content,
    timestamp,
  });
  await store.appendEntry(sessionID, { kind: "message", message: message("covered-1", 1_001) });
  await store.appendEntry(sessionID, { kind: "message", message: message("covered-2", 1_002) });
  await store.appendEntry(sessionID, {
    kind: "compaction_boundary",
    summary: message(RESTORED_SUMMARY, 1_100),
  });
  await store.appendEntry(sessionID, { kind: "message", message: message("tail-1", 2_001) });
  await store.appendEntry(sessionID, { kind: "message", message: message("tail-2", 2_002) });
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-c2-compactions-"));
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

describe("C2 GET /sessions/:id/compactions", () => {
  it("未知 sid = 404 session_not_found（与 /compaction 同口径）", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const res = await api("/sessions/ses_c2_ghost/compactions");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session_not_found");
    } finally {
      teardown();
    }
  });

  it("已知 idle 会话无压缩史 = 200 {sessionID, events: []}", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const sessionID = await createSession(registry);
      expect(await getCompactions(sessionID)).toEqual({ sessionID, events: [] });
    } finally {
      teardown();
    }
  });

  it("首轮未压缩 + 次轮产生 live 境界：/compactions 返回该 auto 事件", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const sessionID = await createSession(registry);
      await sendAndWaitIdle(registry, sessionID, "历史取证一");
      expect((await getCompactions(sessionID)).events).toEqual([]);

      await sendAndWaitIdle(registry, sessionID, "历史取证二");
      const body = await getCompactions(sessionID);
      expect(body.events).toHaveLength(1);
      const event = body.events[0]!;
      const messages = registry.loopOf(sessionID)!.session.messages;
      expect(event).toMatchObject({
        kind: "auto",
        coveredCount: 3,
        summaryText: "[auto-compacted summary of 3 earlier messages]\nSUM:3",
        anchorMessageId: null,
        anchorTimestampMs: messages[3]!.timestamp,
      });
      expect(typeof event.recordedAt).toBe("number");
      expect(eventLogLineCount(sessionID)).toBe(1);
    } finally {
      teardown();
    }
  }, 20_000);

  it("seed-on-read：缓存摘要首次查询落盘，重复查询幂等不增长", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const sessionID = await createSession(registry);
      registry.saveCompactionCache(sessionID, {
        sessionID,
        status: "active",
        coveredCount: 2,
        summaryText: "cached-summary",
        anchorMessageId: null,
        anchorTimestampMs: 123,
        tailCount: 1,
        totalMessages: 3,
      });

      const first = await getCompactions(sessionID);
      expect(first.events).toHaveLength(1);
      expect(first.events[0]).toMatchObject({
        kind: "auto",
        coveredCount: 2,
        summaryText: "cached-summary",
        anchorTimestampMs: 123,
      });
      expect(eventLogLineCount(sessionID)).toBe(1);

      const second = await getCompactions(sessionID);
      expect(second.events).toHaveLength(1);
      expect(eventLogLineCount(sessionID)).toBe(1);
    } finally {
      teardown();
    }
  });

  it("两次推进各自落事件：旧摘要保留、新摘要追加（不替换）", async () => {
    const { registry, teardown } = makeRegistry(compactionHooksFor(1));
    await listen({ registry });
    try {
      const sessionID = await createSession(registry);
      await sendAndWaitIdle(registry, sessionID, "多段取证一");
      await sendAndWaitIdle(registry, sessionID, "多段取证二");
      await sendAndWaitIdle(registry, sessionID, "多段取证三");

      const body = await getCompactions(sessionID);
      expect(body.events.map((event: CompactionEvent) => event.coveredCount)).toEqual([3, 6]);
      expect(body.events.map((event: CompactionEvent) => event.summaryText)).toEqual([
        "[auto-compacted summary of 3 earlier messages]\nSUM:3",
        "[auto-compacted summary of 6 earlier messages]\nSUM:6",
      ]);
      expect(new Set(body.events.map((event: CompactionEvent) => event.id)).size).toBe(2);
      expect(eventLogLineCount(sessionID)).toBe(2);
    } finally {
      teardown();
    }
  }, 20_000);

  it("restored 边界：run-end 不追加重复 auto 事件，canonical coveredCount 保留", async () => {
    const { registry, store, teardown } = makeRegistry(() => []);
    await listen({ registry });
    try {
      const sessionID = await createSession(registry);
      await seedDurableBoundary(store, sessionID);

      await sendAndWaitIdle(registry, sessionID, "重放后继续");
      expect(readCompactionEvents(stateRoot, sessionID).events).toEqual([]);

      const body = await getCompactions(sessionID);
      expect(body.events).toHaveLength(1);
      expect(body.events[0]).toMatchObject({
        kind: "boundary",
        coveredCount: 2,
        summaryText: RESTORED_SUMMARY,
        anchorTimestampMs: 2_001,
      });
      expect(readCompactionEvents(stateRoot, sessionID).events).toEqual([]);
    } finally {
      teardown();
    }
  }, 20_000);
});
