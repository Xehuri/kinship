/**
 * W9 切片0 —— 转录持久化先行（boot 第二 store 实例接线端到端，fake-model 离线起真树走 HTTP）。
 * Given: 临时 workspace + fake provider + LOOM_FAKE_MODEL=1（state/session/ 下两文件：
 *        loom-main.jsonl 主会话专用、loom-sessions.jsonl 子/副会话专用）
 * When:  主会话 send 一轮 → 主会话 task 派子 → POST /runs 副会话（converge 收束）
 * Then:  a) GET /sessions/<子sid>/history 返回子会话真实转录（user=任务正文、assistant=摘要）；
 *        b) GET /sessions/<副sid>/history 返回副会话转录（sid=账本 session_id）；
 *        c) 主转录仍写 loom-main.jsonl（append-only 前缀恒等、路径不变），
 *           loom-main 只含主 sid 行、loom-sessions 只含子/副 sid 行（文件面互不污染）；
 *        d) 未知 sid 空页旧语义不破坏。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDateKey, type Message } from "@axeuh/loom-core";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

// 加载纪律（同 boot-tools）：boot 图必须动态 import，避免 core 桶经 server 环先实例化。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";
let app: LoomApp;
let baseUrl = "";

const TOKEN = "tok-transcript-w9";
const MAIN_TURN = "W9-主会话第一轮正文";
const CHILD_MARK = "W9-子会话摘要正文";
const SIDE_MARK = "W9-副会话收束";

const FAKE_YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w9",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

function fake(): {
  push(...resp: FakeAssistantResponse[]): void;
  getCalls(): Array<{ systemPrompt?: string; messages: Array<{ role: string; content: unknown }> }>;
} {
  return app.model.model as unknown as {
    push(...resp: FakeAssistantResponse[]): void;
    getCalls(): Array<{ systemPrompt?: string; messages: Array<{ role: string; content: unknown }> }>;
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
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

/** 会话 store 文件 → 该行覆盖的 sid 集合 + 原始全文（纯度/前缀断言两用）。 */
function storeFileState(path: string): { raw: string; sids: Set<string> } {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sids = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const rec = JSON.parse(line) as { sid?: string };
    if (typeof rec.sid === "string") sids.add(rec.sid);
  }
  return { raw, sids };
}

function messageText(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** history 端点响应 → {status, messages(roles/text), nextCursor}。 */
async function historyOf(sid: string): Promise<{ status: number; roles: string[]; body: string; nextCursor: unknown }> {
  const r = await api(`/sessions/${sid}/history?limit=100`);
  const messages = (r.json["messages"] ?? []) as Message[];
  return {
    status: r.status,
    roles: messages.map((m) => m.role),
    body: messages.map(messageText).join("\n"),
    nextCursor: r.json["nextCursor"],
  };
}

/** trace 现读：主会话 sid 名下 task.subagent start 行的 agentId（子会话 id 取证面）。 */
function childSidFromTrace(mainSid: string): string {
  const traceFile = join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`);
  const rows = readFileSync(traceFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, any>);
  const start = rows.find(
    (r) => r["name"] === "task.subagent" && r["sessionId"] === mainSid && r["attrs"]?.["phase"] === "start",
  );
  const agentId = String(start?.["attrs"]?.["agentId"] ?? "");
  expect(agentId).toMatch(/^ses_[0-9a-f]{16}$/);
  return agentId;
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w9-transcript-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W9 转录测试底座\n");

  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [TOKEN],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await app?.closeExtras();
  await new Promise<void>((resolve) => {
    app?.server.closeAllConnections();
    app?.server.close(() => resolve());
  });
  app?.model.teardown();
  rmSync(work, { recursive: true, force: true });
});

const MAIN_FILE = () => join(stateRoot, "session", "loom-main.jsonl");
const SIDE_FILE = () => join(stateRoot, "session", "loom-sessions.jsonl");

describe("W9 切片0：主会话历史面冻结 + 转录仍写 loom-main", () => {
  it("send 一轮：GET /sessions/<主>/history 返回主转录，且 loom-main.jsonl 只含主 sid", async () => {
    // 主会话收束 = 唯一正常终局通道（D25；纯文本收尾会进 nudge 循环到强制上限）。
    fake().push({
      content: [
        { type: "text", text: MAIN_TURN },
        {
          type: "toolCall",
          id: "w9-main-conv",
          name: "converge",
          arguments: { status: "已完成", digest: "已完成：主会话第一轮", body: "本轮结论：转录落主文件。" },
        },
      ],
    });
    const rec = app.registry.create();
    app.registry.send(rec.sessionID, `回一句话：${MAIN_TURN}`);
    expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);

    const h = await historyOf(rec.sessionID);
    expect(h.status).toBe(200);
    expect(h.roles).toEqual(["user", "assistant", "toolResult"]);
    expect(h.body).toContain(MAIN_TURN);

    const main = storeFileState(MAIN_FILE());
    expect([...main.sids]).toEqual([rec.sessionID]);

    // W16-F5 文件面：主转录该 sid 无零内容 assistant 脏行、terminal 恰一封（seq16/17 脏对回归钉）。
    let emptyAssistants = 0;
    let terminals = 0;
    for (const line of main.raw.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as {
        sid: string;
        e: { entry: { kind: string; message?: { role?: string; content?: unknown } } };
      };
      if (parsed.sid !== rec.sessionID) continue;
      const entry = parsed.e.entry;
      if (entry.kind === "terminal") terminals += 1;
      if (
        entry.kind === "message" &&
        entry.message?.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.length === 0
      ) {
        emptyAssistants += 1;
      }
    }
    expect(emptyAssistants, "W16-F5：零内容 assistant 绝不进主转录").toBe(0);
    expect(terminals, "一轮一封").toBe(1);
  }, 30_000);
});

describe("W9 切片0：主会话 task 派子 → 子转录可读", () => {
  it(
    "派子跑完：GET /sessions/<子sid>/history 含 user(任务正文)+assistant(摘要)；子 sid 不进 loom-main，主转录仍进 loom-main（前缀恒等）",
    async () => {
      const mainSid = app.registry.create().sessionID;
      const mainBefore = storeFileState(MAIN_FILE()).raw; // 派子前的主文件快照（append-only 前缀基线）

      fake().push(
        {
          content: [
            {
              type: "toolCall",
              id: "w9-task",
              name: "task",
              arguments: { agent_type: "general", task: `只回一句话：${CHILD_MARK}` },
            },
          ],
        },
        { content: [{ type: "text", text: CHILD_MARK }] }, // 子会话单轮文本收尾
        {
          content: [
            { type: "text", text: "已收到子摘要，主会话收口。" },
            {
              type: "toolCall",
              id: "w9-parent-conv",
              name: "converge",
              arguments: { status: "已完成", digest: "已完成：已回收子会话摘要", body: "收口。" },
            },
          ],
        },
      );
      app.registry.send(mainSid, "用 task 派一个子智能体拿结论");
      expect(await waitFor(() => app.registry.get(mainSid)?.running === null)).toBe(true);

      const childSid = childSidFromTrace(mainSid);
      const h = await historyOf(childSid);
      expect(h.status, "history 端点不要求 registry 记录，直读注入 store").toBe(200);
      expect(h.roles).toEqual(["user", "assistant"]);
      expect(h.body).toContain("只回一句话：" + CHILD_MARK); // user = 任务正文
      expect(h.body).toContain(CHILD_MARK); // assistant = 子会话产出

      const main = storeFileState(MAIN_FILE());
      const side = storeFileState(SIDE_FILE());
      expect(main.raw.startsWith(mainBefore), "主转录文件 append-only：既有字节零改动").toBe(true);
      expect(main.sids.has(childSid), "子转录绝不进 loom-main.jsonl").toBe(false);
      expect(main.sids.has(mainSid), "主会话本轮转录仍写原文件").toBe(true);
      expect(side.sids.has(childSid)).toBe(true);
      expect(side.sids.has(mainSid), "主 sid 绝不进 loom-sessions.jsonl").toBe(false);
    },
    40_000,
  );
});

describe("W9 切片0：POST /runs 副会话 → 同端点读得到", () => {
  it(
    "converge 收束后：GET /sessions/<账本 session_id>/history 含 user/assistant/toolResult；副 sid 只进 loom-sessions",
    async () => {
      fake().push({
        content: [
          { type: "text", text: "副会话正文，收束。" },
          {
            type: "toolCall",
            id: "w9-conv",
            name: "converge",
            arguments: {
              status: "done",
              runId: "run_w9selfreport001",
              workflow: "w9-side",
              attempt: 1,
              digest: `done：${SIDE_MARK}`,
              pointers: [],
              blockers: [],
            },
          },
        ],
      });
      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w9-side", prompt: `干活并收束：${SIDE_MARK}` }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);
      expect(await waitFor(() => ["done", "failed", "partial"].includes(String(app.engine.get(runId)?.state ?? "unknown")))).toBe(true);

      const detail = await api(`/runs/${runId}`);
      expect(detail.json["status"]).toBe("done");
      const sideSid = String(detail.json["session_id"]);
      expect(sideSid).toMatch(/^ses_[0-9a-f]{16}$/);

      const h = await historyOf(sideSid);
      expect(h.status).toBe(200);
      expect(h.roles).toEqual(["user", "assistant", "toolResult"]);
      expect(h.body).toContain(SIDE_MARK);

      const main = storeFileState(MAIN_FILE());
      const side = storeFileState(SIDE_FILE());
      expect(main.sids.has(sideSid), "副转录绝不进 loom-main.jsonl").toBe(false);
      expect(side.sids.has(sideSid)).toBe(true);
    },
    40_000,
  );

  it("未知 sid 空页旧语义不破坏：messages=[] 且无游标", async () => {
    const h = await historyOf("ses_w9_nosuchsid00");
    expect(h.status).toBe(200);
    expect(h.roles).toEqual([]);
    expect(h.nextCursor).toBeNull();
  });
});
