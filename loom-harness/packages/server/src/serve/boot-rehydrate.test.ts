/**
 * W15 重启重水化 —— boot 级 e2e（修「restart 清空会话列表」）。
 * Given: 临时 workspace + fake provider + 同一 stateRoot 两次 createLoomApp；
 *        第一次 boot：POST /sessions 建会话 → 发一轮（converge 收束，转录落
 *        loom-main.jsonl）→ 拆树；再向 loom-sessions.jsonl 直写一个副/子 sid。
 * When:  第二次 boot 同 stateRoot → GET /sessions / GET /sessions/:sid/history。
 * Then:  ① 首 boot 造的 sid 在列（不再 restart 即空面板、孤儿旧转录）；
 *        ② 该 sid 历史非空（含首轮正文——JsonlSessionStore 构造回放即恢复）；
 *        ③ 重水化域=主 store：列表只含主 sid（W16-E 收拢，副/子 sid 不入列、不建
 *           loop/hub——防面板污染与 hm SSE 扇爆）；缺省主会话=真主会话（W12 提醒靶）。
 *        ④ loom-sessions.jsonl 里的副/子 sid 不在列，但其 GET history 仍 200 非空
 *           （registry.history 按归属查 historyStores 直读 store——读侧可达性=本收拢的安全网）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlSessionStore } from "@axeuh/loom-adapters";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

// 加载纪律（同 boot-assembly/boot-reminder）：boot 图必须动态 import，
// 避免 core 桶经 server 环先实例化。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const TOKEN = "tok-w15-rehydrate";
const TURN_TEXT = "W15-重水化取证轮正文";
/** 预置进副/子转录文件的 sid（loom-sessions.jsonl，模拟 task 子会话留下的历史）。 */
const SIDE_SID = "w15child0001";

const FAKE_YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "  sessionList: true",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w15",
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

/** 主会话收束轮（kind=main 回执形状，同 boot-reminder）。 */
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

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w15-rehydrate-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W15 重水化底座\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("W15 restart 重水化：第二次 boot 的 GET /sessions 找回旧会话与历史", () => {
  it(
    "双 boot 同 stateRoot：首 boot sid 在列、历史非空、主 store 先注册（缺省主会话=首 sid）",
    async () => {
      // ── 第一次 boot：建会话 → 发一轮 → 拆树（模拟服务重启前的正常现网态）。
      const app1 = await bootApp();
      let mainSid = "";
      let bootMainSid = "";
      try {
        const resolved = app1.registry.defaultMainSessionId();
        if (resolved === undefined) throw new Error("boot 主会话未解析");
        bootMainSid = resolved;
        const created = await api(app1, "/sessions", { method: "POST" });
        expect(created.status).toBe(201);
        mainSid = String(created.json.sessionID);

        (app1.model.model as unknown as { push(...r: FakeAssistantResponse[]): void }).push(mainConverge(TURN_TEXT));
        const sent = await api(app1, `/sessions/${mainSid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "第一问" }),
        });
        expect(sent.status).toBe(202);
        expect(await waitFor(() => app1.registry.get(mainSid)?.running === null)).toBe(true);
      } finally {
        await disposeApp(app1);
      }
      // 转录确实落盘（重水化的数据前提）。
      expect(readFileSync(join(stateRoot, "session", "loom-main.jsonl"), "utf8")).toContain(mainSid);

      // 副/子转录文件预置一个 sid 的行（现网形态：task 子会话写过 loom-sessions.jsonl）。
      const sideStore = new JsonlSessionStore(join(stateRoot, "session", "loom-sessions.jsonl"));
      await sideStore.appendEntry(SIDE_SID, {
        kind: "message",
        message: { role: "user", content: "子会话旧任务正文", timestamp: 0 },
      });

      // ── 第二次 boot：同一 stateRoot，验证重水化结局。
      const app2 = await bootApp();
      try {
        const list = await api(app2, "/sessions");
        expect(list.status).toBe(200);
        const sessions = list.json.sessions as Array<{ sessionID: string; status: string }>;
        const ids = sessions.map((s) => s.sessionID);
        expect(ids).toContain(mainSid); // ① 旧主会话找回
        // ③ W16-E 收拢：重水化域=主 store——副/子 sid 不入列、不建记录（防 160 条病态列表）。
        //    T2 后 boot 解析主会话也常驻：空库首启生成的主会话（bootMainSid）与服务期新建的
        //    mainSid 同时入列，二者都不是副/子 sid。
        expect(ids).toHaveLength(2);
        expect(ids).toEqual(expect.arrayContaining([mainSid, bootMainSid]));
        expect(app2.registry.has(SIDE_SID)).toBe(false);
        expect(sessions.find((s) => s.sessionID === mainSid)?.status).toBe("idle");
        // 缺省主会话靶=T2 解析并跨 boot 持久的主会话（不再依赖"首注册"）。
        expect(app2.registry.defaultMainSessionId()).toBe(bootMainSid);

        // ② 历史非空：JsonlSessionStore 构造回放 ⇒ 首轮正文可读出。
        const history = await api(app2, `/sessions/${mainSid}/history?limit=100`);
        expect(history.status).toBe(200);
        const messages = history.json.messages as unknown[];
        expect(messages.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(messages)).toContain(TURN_TEXT);

        // ④ 读侧可达性安全网：未入列的子 sid 的 history 经 historyStores 归属路由照旧 200 非空。
        const sideHistory = await api(app2, `/sessions/${SIDE_SID}/history?limit=100`);
        expect(sideHistory.status).toBe(200);
        expect(JSON.stringify(sideHistory.json.messages ?? [])).toContain("子会话旧任务正文");
      } finally {
        await disposeApp(app2);
      }
    },
    90_000,
  );
});
