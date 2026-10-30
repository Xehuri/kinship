/**
 * W23-C /tasks 历史合流 —— boot 级 S-RESTART 钉（子任务账重启不丢）。
 *
 * Given: 首 boot 全树（fake 模型）：主会话派 background 子 → 子盖棺（actual 落账本）→ 拆树。
 * When:  二次 boot 同 stateRoot（内核在飞册=纯内存，重启即空）。
 * Then:  ① GET /tasks 仍含该 task：in_memory 键缺席（账本-only 来源标）、status=盖棺 actual
 *           （done）、dispatched_at/terminal_at/agent_type/workflow/parent_session/session_id
 *           全从 durable 行如实重建；
 *        ② GET /tasks/:id 不再 404：200 账本回落详情（task/depth/terminal=null 诚实申明、
 *           ledger join 双时刻在场）；
 *        ③ 合流去重：首 boot 在飞时同 run_id 列表长度恒 1（live 优先面在本测试由
 *           ②的"二次 boot 仅历史一条"承担对偶钉，task-api.test.ts 钉并集去重主格）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const TOKEN = "tok-w23c-ledger";
const TASK_TEXT = "重启后仍在账上的后台任务";

const FAKE_YAML = [
  "server:",
  "  port: 5113",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w23c",
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

async function waitFor(predicate: () => boolean, budgetMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w23c-ledger-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W23-C 账本合流底座\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("W23-C S-RESTART：后台子任务账跨两次 boot 存活于 GET /tasks", () => {
  it(
    "首 boot 派发+盖棺 → 拆树 → 二次 boot：/tasks 列表含历史行（in_memory 缺席）+ /tasks/:id 200 账本详情",
    async () => {
      // ── 首 boot：主会话后台派发（同 w9s3 编排：#0 主 turn1 task(bg) → #1 子调用 → #2 主 turn2 converge）。
      const app1 = await bootApp();
      let taskId = "";
      let childSid = "";
      try {
        const created = await api(app1, "/sessions", { method: "POST" });
        const sid = String(created.json.sessionID);
        (app1.model.model as unknown as { push(...r: FakeAssistantResponse[]): void }).push(
          {
            content: [
              {
                type: "toolCall",
                id: "w23c-bg",
                name: "task",
                arguments: { agent_type: "general", task: TASK_TEXT, background: true },
              },
            ],
          },
          { content: [{ type: "text", text: "W23C-子正文" }] },
          mainConverge("已后台派发。"),
        );
        const sent = await api(app1, `/sessions/${sid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "后台派一个任务" }),
        });
        expect(sent.status).toBe(202);
        const done = await waitFor(() => {
          const subs = app1.kernel.listSubRuns();
          return subs.length === 1 && (subs[0]!.state === "done" || subs[0]!.state === "failed");
        });
        expect(done, "后台任务应在预算内盖棺（actual 落盘）").toBe(true);
        const tasksView = await api(app1, "/tasks");
        const list = tasksView.json.tasks as Array<Record<string, unknown>>;
        expect(list).toHaveLength(1);
        taskId = String(list[0]!.task_id);
        childSid = String(list[0]!.session_id);
        expect(list[0]!.in_memory).toBe(true); // 首 boot 在飞册格：来源标在场
        expect(list[0]!.status).toBe("done");
      } finally {
        await disposeApp(app1);
      }
      // ── 二次 boot：内核在飞册=纯内存（重启即空），账本面独立存活。
      const app2 = await bootApp();
      try {
        expect(app2.kernel.listSubRuns()).toHaveLength(0); // 内存面清空（命门实证：不靠它）

        const tasksView = await api(app2, "/tasks");
        expect(tasksView.status).toBe(200);
        const list = tasksView.json.tasks as Array<Record<string, unknown>>;
        const hist = list.find((t) => t.task_id === taskId);
        expect(hist, "S-RESTART：子任务账重启不丢").toBeDefined();
        expect("in_memory" in (hist ?? {})).toBe(false); // 账本-only：来源标键缺席
        expect(hist!.status).toBe("done"); // 状态真源=盖棺 actual
        expect(hist!.agent_type).toBe("general");
        expect(hist!.workflow).toBe("subagent.general");
        expect(hist!.parent_session).toBeDefined();
        expect(hist!.session_id).toBe(childSid);
        expect(typeof hist!.dispatched_at).toBe("number");
        expect(typeof hist!.terminal_at).toBe("number");
        expect(hist!.crashed).toBeNull(); // 不可导出字段 = null 诚实

        // 详情回落：不再 404；task/depth/terminal 不可导出 = null；ledger join 双时刻在场。
        const detail = await api(app2, `/tasks/${taskId}`);
        expect(detail.status).toBe(200);
        expect(detail.json.task).toBeNull();
        expect(detail.json.depth).toBeNull();
        expect(detail.json.terminal).toBeNull();
        expect("in_memory" in detail.json).toBe(false);
        const ledgerJoin = detail.json.ledger as Record<string, unknown>;
        expect(typeof ledgerJoin.expected_at).toBe("number");
        expect(ledgerJoin.actual).not.toBeNull();
        expect((ledgerJoin.actual as Record<string, unknown>).status).toBe("done");

        // 未知 id 404 原纪律（合流不给编造面）。
        expect((await api(app2, "/tasks/run_deadbeefdeadbeef")).status).toBe(404);
      } finally {
        await disposeApp(app2);
      }
    },
    120_000,
  );
});
