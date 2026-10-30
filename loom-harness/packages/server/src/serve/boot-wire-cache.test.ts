/**
 * W23-A 发线面持久缓存 —— boot 级 e2e（三段回落全钉 + 重启后缓存独立于内存槽）。
 *
 * Given: 临时 workspace + fake provider + 同一 stateRoot 两次 createLoomApp。
 *        首 boot：POST /sessions → converge 收束轮（wire 回调落 wire/{sid}.json）→ 拆树；
 *        再向 loom-sessions.jsonl 直写一个子 sid 转录 + 向 wire/ 目录直写该子 sid 缓存
 *        （模拟"子会话跑完、主面从未入册"的现网残影）。
 * When:  二次 boot（内存单槽全空）→ GET /sessions/<sid>/context/full 三面各打一次。
 * Then:  决策表逐格钉死——
 *        ① live loop + live 槽（首 boot 轮后现读）= basis "live" + wire.source "live"；
 *        ② live loop（重水化）+ 槽空 + 缓存在场 = basis "live" + wire.source "cache"
 *           （providerPayload null + 逐字缺席理由：fake 通道从未有载荷，缓存如实）；
 *        ③ 无 loop + 缓存在场 = basis "cache" 200（v1 十四键全在场；systemPrompt/发线面
 *           = 缓存；messages = durable 转录；segments 恒空；capturedAt = 缓存落盘时刻）；
 *        ④ 无 loop 无缓存 = 404 原纪律（context_full_not_found 稳定码不动）。
 *        钉外一：首 boot 轮后盘上缓存文件在场且无 "sk-" 明文痕（fake 通道本无 key，
 *        seed-key 硬闸面在 wire-cache.test.ts 单测钉死）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlSessionStore } from "@axeuh/loom-adapters";
import type { WireRequestSnapshot } from "@axeuh/loom-core";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { CONTEXT_FULL_NOTE } from "../session-api/context-full.js";
import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";
import { WIRE_CACHE_VERSION, WireCacheStore, wireCacheFileName } from "./wire-cache.js";

// 加载纪律（同 boot-rehydrate）：boot 图必须动态 import，避免 core 桶经 server 环先实例化。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const TOKEN = "tok-w23-wirecache";
const TURN_TEXT = "W23-A 发线面重启取证轮";
/** 预置"无 loop 纯缓存"面的子会话 sid（转录 + 缓存文件都由测试直写）。 */
const CHILD_SID = "w23child0001";

const FAKE_YAML = [
  "server:",
  "  port: 5111",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w23",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

function config(): LoomConfig {
  return parseLoomConfig(FAKE_YAML.replace("WS_ROOT", ws), "<test>", { env: {} });
}

function mainConverge(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

async function bootApp(): Promise<LoomApp> {
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config: config(),
    store,
    stateRoot,
    tokens: [TOKEN],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return app;
}

async function disposeApp(app: LoomApp): Promise<void> {
  await app.closeExtras();
  await new Promise<void>((resolve) => {
    app.server.closeAllConnections();
    app.server.close(() => resolve());
  });
  app.model.teardown();
}

function baseUrlOf(app: LoomApp): string {
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
  return `http://127.0.0.1:${String(addr.port)}`;
}

async function api(app: LoomApp, path: string, init?: RequestInit): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrlOf(app)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, text, json };
}

async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

/** 无 loop 缓存面预置：一条子 sid 的脱敏快照（systemPrompt 带哨兵供响应比对）。 */
function childSnapshotFixture(): WireRequestSnapshot {
  return {
    capturedAt: 12345,
    turnIdx: 0,
    model: { id: "fake-child-model", api: "fake", baseUrl: "https://child.local", provider: "child-provider" },
    systemPrompt: "W23-A 子会话缓存基面哨兵",
    messagesText: '[{"content":"派发正文","role":"user","timestamp":1}]',
    tools: [],
    optionsText: '{"temperature":0.2}',
    transientCount: 0,
  };
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w23-wirecache-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W23-A 发线面持久底座\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("W23-A 发线面持久缓存 boot e2e：三段回落决策表逐格钉", () => {
  it(
    "首 boot live 面 → 拆树 → 二次 boot 缓存面：source/basis 三段 + 404 纪律 + 盘上无明文",
    async () => {
      const wireDir = join(stateRoot, "session", "wire");

      // ── 第一次 boot：收束轮 → live 槽现读（case ①）+ 缓存文件落盘面。
      const app1 = await bootApp();
      let mainSid = "";
      try {
        const created = await api(app1, "/sessions", { method: "POST" });
        expect(created.status).toBe(201);
        mainSid = String(created.json.sessionID);

        (app1.model.model as unknown as { push(...r: FakeAssistantResponse[]): void }).push(mainConverge(TURN_TEXT));
        const sent = await api(app1, `/sessions/${mainSid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "发线面持久取证" }),
        });
        expect(sent.status).toBe(202);
        expect(await waitFor(() => app1.registry.get(mainSid)?.running === null)).toBe(true);

        const liveView = await api(app1, `/sessions/${mainSid}/context/full`);
        expect(liveView.status).toBe(200);
        // ① live loop + live 槽：basis "live" + wire.source "live"。
        expect(liveView.json.basis).toBe("live");
        const liveWire = liveView.json.wire as Record<string, unknown>;
        expect(liveWire).not.toBeNull();
        expect(liveWire.source).toBe("live");

        // 缓存文件落盘 + 无 "sk-" 明文痕（fake 通道本无 key，此面是"缓存诚实"底线钉）。
        const cachePath = join(wireDir, wireCacheFileName(mainSid));
        expect(existsSync(cachePath)).toBe(true);
        const rawCache = readFileSync(cachePath, "utf8");
        expect(rawCache).not.toContain("sk-");
        expect(JSON.parse(rawCache).version).toBe(WIRE_CACHE_VERSION);
      } finally {
        await disposeApp(app1);
      }

      // ── 预置"无 loop 纯缓存"的现网残影：子 sid 转录（loom-sessions.jsonl）+ 缓存文件。
      const sideStore = new JsonlSessionStore(join(stateRoot, "session", "loom-sessions.jsonl"));
      await sideStore.appendEntry(CHILD_SID, {
        kind: "message",
        message: { role: "user", content: "子会话 durable 正文（缓存基面重建源）", timestamp: 0 },
      });
      await sideStore.appendEntry(CHILD_SID, {
        kind: "terminal",
        result: { turns: 1, continuations: 0, reason: "done", usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } },
      });
      const seedCache = new WireCacheStore({ dir: wireDir });
      seedCache.save(CHILD_SID, childSnapshotFixture(), null);

      // ── 第二次 boot：内存槽全空。
      const app2 = await bootApp();
      try {
        // ② live loop（重水化）+ 槽空 + 缓存在场 → basis "live" + wire.source "cache"。
        expect(app2.registry.has(mainSid)).toBe(true);
        const slot = app2.registry.loopOf(mainSid)?.session.lastWireRequest;
        expect(slot).toBeNull(); // 内存槽确实空了（缓存独立于 registry 成员资格的实证面）
        const cachedView = await api(app2, `/sessions/${mainSid}/context/full`);
        expect(cachedView.status).toBe(200);
        expect(cachedView.json.basis).toBe("live");
        const wire = cachedView.json.wire as Record<string, unknown>;
        expect(wire).not.toBeNull();
        expect(wire.source).toBe("cache");
        expect(wire.providerPayload).toBeNull();
        expect(wire.providerPayloadAbsentReason).toBe("当前模型通道不触发 provider onPayload（如 fake api）");
        const request = wire.request as Record<string, unknown>;
        expect(typeof request.systemPrompt).toBe("string");
        expect((request.messages as unknown[]).length).toBeGreaterThan(0);

        // ③ 无 loop + 缓存在场 → basis "cache" 200（v1 十四键全在场）。
        expect(app2.registry.has(CHILD_SID)).toBe(false);
        const childView = await api(app2, `/sessions/${CHILD_SID}/context/full`);
        expect(childView.status).toBe(200);
        const view = childView.json;
        expect(view.basis).toBe("cache");
        const fourteen = [
          "sessionID", "capturedAt", "basis", "prefixHash", "systemPromptSha256", "systemPrompt",
          "prefixByteLength", "segments", "messages", "messagesByteLength", "totalPromptByteLength",
          "contextWindow", "transientExcluded", "note",
        ];
        for (const key of fourteen) expect(key in view).toBe(true);
        expect(view.sessionID).toBe(CHILD_SID);
        // systemPrompt = 缓存快照 post-pipe 值；capturedAt = 缓存落盘时刻（盘上真值比对）；
        // segments 恒空（装配对象不可恢复，绝不编造偏移）。
        const childCacheRaw = readFileSync(join(wireDir, wireCacheFileName(CHILD_SID)), "utf8");
        const childCache = JSON.parse(childCacheRaw) as { savedAt: number };
        expect(view.systemPrompt).toBe("W23-A 子会话缓存基面哨兵");
        const childWire = view.wire as Record<string, unknown>;
        expect(childWire.capturedAt).toBe(12345);
        expect(view.capturedAt).toBe(childCache.savedAt);
        expect(view.segments).toEqual([]);
        // messages = durable 转录原样序列化（含子正文）。
        expect(childView.text).toContain("子会话 durable 正文（缓存基面重建源）");
        expect(view.transientExcluded).toBe(true);
        // prefixHash 如实回退等式（装配缺席 → 同 systemPromptSha256）。
        expect(view.prefixHash).toBe(view.systemPromptSha256);
        // note：v1 逐字前缀 + v2 尾句 + 缓存面申明句全在场。
        expect((view.note as string).startsWith(CONTEXT_FULL_NOTE)).toBe(true);
        expect(view.note).toContain("basis=cache");
        // wire 块同形（source cache）+ providerPayload 缺席理由逐字。
        expect(childWire.source).toBe("cache");
        expect(childWire.providerPayloadAbsentReason).toBe("当前模型通道不触发 provider onPayload（如 fake api）");
        // manifest 面照常挂 boot 清单（与基面正交）。
        expect(view.manifest).not.toBeNull();

        // ④ 无 loop 无缓存 = 404 原纪律（稳定码逐字不变）。
        const missing = await api(app2, "/sessions/ghostsid0001/context/full");
        expect(missing.status).toBe(404);
        expect(JSON.stringify(missing.json)).toContain("context_full_not_found");
      } finally {
        await disposeApp(app2);
      }
    },
    90_000,
  );
});
