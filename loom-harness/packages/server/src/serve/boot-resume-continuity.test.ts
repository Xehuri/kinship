/**
 * W17-G 重启对话连续性 —— boot 级 e2e（修「restart 后旧会话失忆」）。
 * Given: 同一 stateRoot 两次 createLoomApp；boot A 用 fake model 在 sid 上跑两轮
 *        （converge 收束、转录落 loom-main.jsonl）→ 拆树；boot B 重水化该 sid。
 * When:  B 上对同一 sid 发第三轮，另建新 sid 发首轮。
 * Then:  ① B 的第三轮请求（fake model getCalls 末次）messages 含 A 两轮的用户+助手行
 *           （role 序列逐条钉死，压缩边界语义由 resume 重放体负责）——证明 durable
 *           历史经 resume 重放入内核内存（缺陷原貌：重启后 messages 只有新 prompt 一条）；
 *        ② B 该请求 systemPrompt 与 A 捕获字节全等（W15-B boot 冻结前缀在 resume 路
 *           再钉：wireParts 共享装配 ⇒ 同 plan 同字节）；
 *        ③ B 上新 sid 的请求 messages 恰 1 条（新会话逐字节旧行为不变）；
 *        ④ GET history 面不变（store 级持久转录本就不受 loop 内存影响）；statusView
 *           turns 为本世计数（UI 展示语义：boot B 起 0，发一轮后 = 1，与历史深度无关）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

// 加载纪律（同 boot-rehydrate/boot-assembly）：boot 图必须动态 import，
// 避免 core 桶经 server 环先实例化。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const TOKEN = "tok-w17g-resume";

const Q1 = "W17G-旧会话第一问";
const A1 = "W17G-旧会话第一答";
const Q2 = "W17G-旧会话第二问";
const A2 = "W17G-旧会话第二答";
const Q3 = "W17G-重启后第三问";
const A3 = "W17G-重启后第三答";
const QF = "W17G-新会话第一问";
const AF = "W17G-新会话第一答";

const FAKE_YAML = [
  "server:",
  "  port: 5109",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w17g",
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

/** 主会话收束轮（kind=main 回执形状，同 boot-rehydrate）。 */
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

async function api(app: LoomApp, path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
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
  return { status: res.status, json };
}

async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// ───────────────────── fake model 发线面观测（context-change-boot 同款 FakeHandle 口径） ─────────────────────

interface FakeHandle {
  push(...r: FakeAssistantResponse[]): void;
  getCalls(): readonly { systemPrompt?: string; messages: readonly MsgLike[] }[];
}

interface MsgLike {
  readonly role: string;
  readonly content: unknown;
}

/** user-role 字符串正文行（本测试无 notice/transient，用户行 = 历史 prompt 本身）。 */
function userTexts(msgs: readonly MsgLike[]): string[] {
  return msgs
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string);
}

/** assistant 行的 text 块正文拼接（content 为块数组；非对象块忽略）。 */
function assistantTexts(msgs: readonly MsgLike[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const parts: string[] = [];
    for (const block of m.content) {
      const rec: Record<string, unknown> | null =
        typeof block === "object" && block !== null ? (block as Record<string, unknown>) : null;
      if (rec?.["type"] === "text" && typeof rec["text"] === "string") parts.push(rec["text"]);
    }
    out.push(parts.join(""));
  }
  return out;
}

/** 发一轮并等收尾（假模型每轮恰好一次 converge LLM call）。 */
async function sendTurn(app: LoomApp, fake: FakeHandle, sessionID: string, prompt: string, reply: string): Promise<void> {
  fake.push(mainConverge(reply));
  const outcome = app.registry.send(sessionID, prompt);
  expect(outcome.accepted, `send "${prompt}" 应被受理`).toBe(true);
  expect(await waitFor(() => app.registry.get(sessionID)?.running === null), `轮 "${prompt}" 应收尾`).toBe(true);
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w17g-resume-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W17G 连续性底座\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("W17-G 重启连续性：有转录 sid 首跑前 resume 重放（历史进请求面、前缀字节全等）", () => {
  it(
    "boot A 两轮 → boot B 同 sid 第三轮请求含既有历史；新 sid 单行；history 面不变",
    async () => {
      // ── boot A：旧会话两轮（每轮 converge 收束：[user, assistant, toolResult] × 2 落盘）。
      const app1 = await bootApp();
      const fake1 = app1.model.model as unknown as FakeHandle;
      let bootMainID = "";
      let sid = "";
      let sysA: string | undefined;
      try {
        const resolved = app1.registry.defaultMainSessionId();
        if (resolved === undefined) throw new Error("boot 主会话未解析");
        bootMainID = resolved;
        sid = app1.registry.create().sessionID;
        await sendTurn(app1, fake1, sid, Q1, A1);
        await sendTurn(app1, fake1, sid, Q2, A2);

        const callsA = fake1.getCalls();
        expect(callsA).toHaveLength(2);
        sysA = callsA[0]?.systemPrompt;
        if (sysA === undefined) throw new Error("装配接线请求必须携 systemPrompt");
        // 同世跨轮前缀恒定（W15-B 既有口径，此处作 resume 面对照基线）。
        expect(callsA[1]?.systemPrompt).toBe(sysA);
        // A 的次轮请求含首轮（内存本就有历史，钉重放对照的"应有形状"）。
        expect(userTexts(callsA[1]!.messages)).toEqual([Q1, Q2]);
        expect(assistantTexts(callsA[1]!.messages)).toEqual([A1]);
      } finally {
        await disposeApp(app1);
      }
      // 转录确实落盘（resume 的数据前提）。
      expect(readFileSync(join(stateRoot, "session", "loom-main.jsonl"), "utf8")).toContain(sid);

      // ── boot B：同 stateRoot；旧 sid 由 boot 重水化入册（W15），此刻内核内存=空（缺陷面）。
      const app2 = await bootApp();
      const fake2 = app2.model.model as unknown as FakeHandle;
      try {
        expect(app2.registry.has(sid)).toBe(true);
        // T2：缺省主会话 = boot 解析并跨重启持久的主会话（本用例的转录 sid 是此世的 create）。
        expect(app2.registry.defaultMainSessionId()).toBe(bootMainID);

        // ①+② 第三轮：请求面必须携既有历史（resume 重放），前缀字节与 A 全等。
        await sendTurn(app2, fake2, sid, Q3, A3);
        const callsB = fake2.getCalls();
        expect(callsB).toHaveLength(1); // B 世首条请求 = 第三轮
        const req3 = callsB[0]!;
        expect(req3.systemPrompt, "resume 路前缀字节必须与 create 路全等（W15-B）").toBe(sysA);
        expect(userTexts(req3.messages), "既有会话的请求必须含 A 两问 + 本问（重放缺失=失忆缺陷）").toEqual([Q1, Q2, Q3]);
        expect(assistantTexts(req3.messages)).toEqual([A1, A2]);
        // role 序列逐条钉死：重放体按 root→leaf 保序带回 toolResult，本问新行在尾。
        expect(req3.messages.map((m) => m.role)).toEqual([
          "user",
          "assistant",
          "toolResult",
          "user",
          "assistant",
          "toolResult",
          "user",
        ]);

        // ③ 新 sid 逐字节旧行为：首请求恰 1 条（无转录 ⇒ hydrate no-op）。
        const freshSid = app2.registry.create().sessionID;
        await sendTurn(app2, fake2, freshSid, QF, AF);
        const freshCall = fake2.getCalls().at(-1)!;
        expect(freshCall.messages).toHaveLength(1);
        expect(userTexts(freshCall.messages)).toEqual([QF]);
        expect(freshCall.systemPrompt).toBe(sysA); // 前缀跨会话恒定（装配面既有口径）

        // ④ 历史面不变：store 级持久转录（含第三轮新行）照常全量可读。
        const history = await api(app2, `/sessions/${sid}/history?limit=100`);
        expect(history.status).toBe(200);
        const dumped = JSON.stringify(history.json.messages ?? []);
        for (const probe of [Q1, A1, Q2, A2, Q3, A3]) expect(dumped).toContain(probe);

        // ⑤ 本世轮次展示语义：rec.turns 起 0、发一轮即 1（与历史深度无关，per-process）。
        expect(app2.registry.statusView(sid)?.turns).toBe(1);
      } finally {
        await disposeApp(app2);
      }
    },
    120_000,
  );
});
