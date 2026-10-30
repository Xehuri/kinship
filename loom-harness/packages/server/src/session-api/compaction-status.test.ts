/**
 * W51 GET /sessions/:id/compaction 端点验收 —— live 压缩境界只读面。
 *
 * 三层钉（对照 context-full-v2.test.ts 端点面 harness）：
 *  1) 真实插件路径（工单口径 "prefer the real-plugin path"）：hooksFor 逐会话挂真
 *     autoCompaction（极小预算恒触发 + resummarizeEvery=1000 防重总结漂移），脚本面用
 *     converge 收束轮（plain-text 轮会被收束 gate 拖进 nudge 循环、轮数不可控）；
 *     两轮 send 生命周期钉 none(0/0) → none(3/3) → active 全字段（coveredCount=3、
 *     默认 wrapper 文案逐字、anchor 命中第二条 user echo）；
 *  2) 键集合逐字节钉：active/none 两态恰 8 键、无多余/缺失（hm 后端逐键消费合同）；
 *  3) 404/400 纪律：未知 sid = session_not_found；非法 id 字符 = bad_session_id
 *     （paramSessionID 既有口径，本端点零特化）。
 */

import { mkdtempSync, rmSync } from "node:fs";
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
import { readCompactionCache, writeCompactionCache } from "./compaction-cache.js";

const GOOD_TOKEN = "tok-w51-compaction";
const IDLE_TIMEOUT_MS = 20_000;

const FAKE_YAML = [
  "server:",
  "  port: 5104",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-w51-compaction-workspace",
  "models:",
  "  - id: fake-w51",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
].join("\n");

const PLAN: AssemblyPlan = {
  systemPrompt: "你是 loom 主会话。",
  memorySources: [{ source: "AGENTS.md", content: "# 工作区记忆\nW51 哨兵\n", degrade: null }],
  workflows: [],
};

/** 收束轮（同 session-api.test.ts/context-full-v2 姿势）：turn0 受理即终结 run，轮数确定。 */
const convergeTurn = (text: string): FakeAssistantResponse => ({
  content: [
    { type: "text", text },
    { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
  ],
});

/**
 * 真 autoCompaction 的确定性配置（一实例一 session → hooksFor 逐会话新构造，T4 铁规）：
 * maxContextTokens×triggerRatio=1 tok 恒触发体积判断，但 keepRecent=1 使首 run turn0
 * （raw=[u1]）走「压无可压」早退不写 boundary；次 run turn0 raw=[u1,a1,tr1,u2] →
 * targetCover=4−1=3 落边界；resummarizeEvery=1000 封死后续重总结，值域全程可精确预期。
 */
function compactionHooksFor(): (sessionID: string) => readonly Hook[] {
  return () => [
    autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.01,
      keepRecent: 1,
      resummarizeEvery: 1000,
      summarize: (early) => `SUM:${early.length}`,
    }),
  ];
}

const CONTRACT_KEYS = [
  "anchorMessageId",
  "anchorTimestampMs",
  "coveredCount",
  "sessionID",
  "status",
  "summaryText",
  "tailCount",
  "totalMessages",
];

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";

function makeRegistry(): { registry: SessionRegistry; store: MemorySessionStore; teardown: () => void } {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [
    convergeTurn("回复一"),
    convergeTurn("回复二"),
  ]);
  const store = new MemorySessionStore();
  const registry = new SessionRegistry({
    model,
    store,
    stateRoot,
    assembly: { plan: PLAN, reader: null },
    hooksFor: compactionHooksFor(),
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

/** 拉取 /compaction 200 体（JSON 边界收口为 Record，键集闸先于值闸）。 */
async function getCompaction(sessionID: string): Promise<Record<string, unknown>> {
  const res = await api(`/sessions/${encodeURIComponent(sessionID)}/compaction`);
  expect(res.status).toBe(200);
  const raw = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(raw).sort()).toEqual(CONTRACT_KEYS);
  return raw;
}

const RESTORED_SUMMARY = "durable-boundary-summary";

/** 预置 durable 边界：2 条被覆盖前缀 + summary + 2 条尾巴（重放后 total=3、覆盖=1）。 */
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
  stateRoot = mkdtempSync(join(tmpdir(), "loom-w51-compaction-"));
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

describe("W51 GET /sessions/:id/compaction —— 真 autoCompaction 端到端（none→active 全生命周期）", () => {
  it("两轮 send：none(0/0) → none(3/3) → active 逐值全等（coveredCount=3、默认 wrapper 文案逐字、anchor=第二条 user echo）", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const sessionID = await createSession(registry);

      // ① 建会话未发轮：诚实 none，全键在位、四压缩键 null。
      expect(await getCompaction(sessionID)).toEqual({
        sessionID,
        status: "none",
        coveredCount: null,
        summaryText: null,
        anchorMessageId: null,
        anchorTimestampMs: null,
        tailCount: 0,
        totalMessages: 0,
      });

      // ② 首轮后：raw=[u1]<=keepRecent 未压（插件「压无可压」早退），仍 none；
      //    转录 = user echo + assistant(含 converge toolCall) + toolResult 三条。
      await sendAndWaitIdle(registry, sessionID, "压缩取证一");
      expect(await getCompaction(sessionID)).toEqual({
        sessionID,
        status: "none",
        coveredCount: null,
        summaryText: null,
        anchorMessageId: null,
        anchorTimestampMs: null,
        tailCount: 3,
        totalMessages: 3,
      });

      // ③ 次轮：真插件写 ACTIVE_BOUNDARY_KEY(coveredCount=3，raw=[u1,a1,tr1,u2]−keepRecent)、
      //    内核 turn 末拾取 → active 态八字段逐值钉（summaryText = auto-compaction.ts:291 默认包装逐字）。
      await sendAndWaitIdle(registry, sessionID, "压缩取证二");
      const body = await getCompaction(sessionID);
      const messages = registry.loopOf(sessionID)!.session.messages;
      expect(body).toEqual({
        sessionID,
        status: "active",
        coveredCount: 3,
        summaryText: "[auto-compacted summary of 3 earlier messages]\nSUM:3",
        anchorMessageId: null,
        anchorTimestampMs: messages[3]!.timestamp,
        tailCount: 3,
        totalMessages: 6,
      });
      // 索引自证：anchor 时刻对应的确是第二条 user echo（压缩覆盖后尾巴第一条），
      // 而非相邻消息（时间戳同为 Date.now 采样，仅靠等值抓不住错索引）。
      expect(messages[3]).toEqual(
        expect.objectContaining({ role: "user", content: "压缩取证二" }),
      );
    } finally {
      teardown();
    }
  });
});

describe("W51 /compaction —— T7b durable boundary hydration", () => {
  it("陈旧缓存 + durable 边界：首次 GET 先 hydrate，返回 coveredCount=1 并回写缓存", async () => {
    const { registry, store, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const sessionID = await createSession(registry);
      await seedDurableBoundary(store, sessionID);
      const stale = {
        sessionID,
        status: "active" as const,
        coveredCount: 7,
        summaryText: "stale-cache-summary",
        anchorMessageId: null,
        anchorTimestampMs: 12,
        tailCount: 12,
        totalMessages: 19,
      };
      writeCompactionCache(stateRoot, sessionID, stale);
      expect(readCompactionCache(stateRoot, sessionID)).toEqual(stale);

      const body = await getCompaction(sessionID);
      expect(body).toEqual({
        sessionID,
        status: "active",
        coveredCount: 1,
        summaryText: RESTORED_SUMMARY,
        anchorMessageId: null,
        anchorTimestampMs: 2_001,
        tailCount: 2,
        totalMessages: 3,
      });
      expect(readCompactionCache(stateRoot, sessionID)).toEqual(body);
    } finally {
      teardown();
    }
  });
});

describe("W51 /compaction —— 404/400 纪律与既有路由一致", () => {
  it("未知 sid = 404 session_not_found（与 /status 同口径，无缓存回落面）", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const res = await api("/sessions/ses_w51_ghost/compaction");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("session_not_found");
    } finally {
      teardown();
    }
  });

  it("非法 sessionID 字符 = 400 bad_session_id（paramSessionID 既有闸，零特化）", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const res = await api("/sessions/ses%24bad/compaction");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("bad_session_id");
    } finally {
      teardown();
    }
  });

  it("鉴权前置不变：无 Bearer 头 = 401（router 标准 preamble，本端点零特化）", async () => {
    const { registry, teardown } = makeRegistry();
    await listen({ registry });
    try {
      const res = await fetch(`${baseUrl}/sessions/ses_w51_any/compaction`);
      expect(res.status).toBe(401);
    } finally {
      teardown();
    }
  });
});
