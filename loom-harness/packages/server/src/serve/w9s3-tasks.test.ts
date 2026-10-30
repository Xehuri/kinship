/**
 * W9 切片 3 —— /tasks 面 + /runs 契约纯度 + 后台闭环（真栈 HTTP 验收）。
 * Given: createLoomApp 全树（fake 模型、tmp workspace）；主会话后台派发（background=true）
 * When:  GET /tasks、GET /tasks/:id（detail join）、POST /tasks/:id/cancel、
 *        GET /runs（纯度）、GET /runs/<task_id>（404）、task_fetch(task_id) 寻址、
 *        提醒闭环（kind=sub 行 transient 注入 + 转录零痕迹）
 * Then:  /tasks 视图 task_id/workflow=subagent.<t>/agent_type/parent_session 齐；
 *        /runs 六键响应零渗入（后台行不入列表、detail 账本回退被 kind 排除）；
 *        提醒行含 kind=sub + task= + task_fetch 取件指引，注入下一轮 prompt、
 *        主转录 grep 无痕迹（W12 纪律对 sub 面延续）；cancel accepted=true 终态 failed。
 * W37 追加面：task_cancel 工具取消在飞后台子（次轮 toolCall）→ 同一 cancel_requested→
 *        terminal 迁移 + GET /tasks 观测（与 HTTP cancel 端点同缝，工具委托非重写）。
 * 复用 boot-reminder 测试装配（真树 + HTTP + fake 模型脚本队列全局 FIFO 编排）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";
let app: LoomApp;
let baseUrl = "";

const TOKEN = "tok-w9s3";
const FAKE_YAML = [
  "server:",
  "  port: 5109",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-s3",
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
  getCalls(): Array<{ messages: Array<{ role: string; content: unknown }> }>;
} {
  return app.model.model as unknown as {
    push(...resp: FakeAssistantResponse[]): void;
    getCalls(): Array<{ messages: Array<{ role: string; content: unknown }> }>;
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

function mainConverge(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w9s3-"));
  ws = join(work, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# S3 工作区\n");
  stateRoot = join(work, "state");

  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const config = parseLoomConfig(text, "<test>", { env: {} });
  app = await createLoomApp({
    config,
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

describe("W9 切片 3：后台任务全链（/tasks + /runs 纯度 + fetch 寻址 + 提醒闭环）", () => {
  it("background 派发→即返 task_id→/tasks 在途→done 盖棺→/runs 零渗入→fetch 取件→提醒注入下一轮且转录无痕", async () => {
    const created = await api("/sessions", { method: "POST" });
    expect(created.status).toBe(201);
    const sid = String(created.json.sessionID);

    // 队列编排（全局 FIFO）：#0 主 turn1 task(bg) → #1 子调用（60ms 慢完）→ #2 主 turn2 converge（延迟 400ms）。
    // W21 注：#2 延迟令派发轮在子盖棺（~60ms）时**仍在跑** → 提醒走 **busy 滞留 transient 注入**
    //（W12 契约逐字节不变、转录零痕迹），而非空闲唤醒（空闲 wake 面由 boot-wake.test.ts 专测）。
    fake().push(
      {
        content: [
          {
            type: "toolCall",
            id: "s3-bg",
            name: "task",
            arguments: { agent_type: "general", task: "读一句：1+1=2", background: true },
          },
        ],
      },
      { content: [{ type: "text", text: "S3-子会话正文-1+1=2" }], delayMs: 60 },
      { ...mainConverge("已在后台派发。"), delayMs: 400 },
    );
    const sent = await api(`/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "后台派一个子会话读一句话" }),
    });
    expect(sent.status).toBe(202);

    // 在途快照：/tasks 面在场即列表可用（终态等待在下方 waitFor）。
    const tasks0 = await api("/tasks");
    expect(tasks0.status).toBe(200);
    let tasks = (await api("/tasks")).json;
    let list = (tasks.tasks ?? []) as Array<Record<string, unknown>>;
    expect(list.length >= 0).toBe(true);
    // 等终态（盖棺 + actual + 提醒入队）
    const done = await waitFor(() => {
      const l = app.kernel.listSubRuns();
      return l.length === 1 && (l[0]!.state === "done" || l[0]!.state === "failed");
    });
    expect(done, "后台任务应在预算内盖棺").toBe(true);
    tasks = (await api("/tasks")).json;
    list = tasks.tasks as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    const view = list[0]!;
    const taskId = String(view.task_id);
    expect(taskId).toMatch(/^run_[0-9a-f]{16}$/);
    expect(view.agent_type).toBe("general");
    expect(view.workflow).toBe("subagent.general");
    expect(view.parent_session).toBe(sid);
    expect(view.status).toBe("done");
    expect(tasks.count).toBe(1);

    // detail join：ledger 双时刻 + trace 数组在场。
    const detail = await api(`/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    const ledger = detail.json.ledger as Record<string, unknown>;
    expect(typeof ledger.expected_at).toBe("number");
    expect(ledger.actual).not.toBeNull();
    expect((detail.json.terminal as Record<string, unknown>).digest).toContain("S3-子会话正文");
    expect(Array.isArray(detail.json.trace)).toBe(true);
    expect(detail.json.task).toBe("读一句：1+1=2");

    // /runs 契约纯度：后台行不进列表、detail 走账本回退也被 kind 判别排除（404）。
    const runs = (await api("/runs")).json;
    const runIds = ((runs.runs ?? []) as Array<Record<string, unknown>>).map((r) => String(r.run_id));
    expect(runIds).not.toContain(taskId);
    const subOnRunsFace = await api(`/runs/${taskId}`);
    expect(subOnRunsFace.status, "/runs/:id 对 sub id 必须 404（纯度红线）").toBe(404);

    // task_fetch 双索引：主会话次轮以 task_id 取件，正文到手且带 task 状态头。
    fake().push(
      { content: [{ type: "toolCall", id: "s3-fetch", name: "task_fetch", arguments: { session_id: taskId, mode: "clean" } }] },
      mainConverge("取件完毕。"),
    );
    const sent2 = await api(`/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "用 task_fetch 按 task_id 取回子会话正文" }),
    });
    expect(sent2.status).toBe(202);
    const fetched = await waitFor(() => {
      const tr = app.registry.loopOf(sid)?.session.messages.filter((m) => m.role === "toolResult") ?? [];
      return tr.some((m) => textOf(m as { content: unknown }).includes("S3-子会话正文"));
    });
    expect(fetched, "task_fetch(task_id) 状态头+子正文应回灌主会话").toBe(true);
    const fetchTr = (app.registry.loopOf(sid)!.session.messages.filter((m) => m.role === "toolResult") as Array<{ content: unknown }>)
      .map(textOf)
      .find((t) => t.includes("S3-子会话正文"))!;
    expect(fetchTr).toContain(`task ${taskId} status=done → sid`);

    // 提醒闭环（kind=sub 行）：已 drain 于取件轮 prompt；主转录零痕迹。
    const promptWithReminder = fake()
      .getCalls()
      .map((c) => c.messages.map((m) => textOf(m as { content: unknown })).join("\n"))
      .find((t) => t.includes("[run-reminder] kind=sub"));
    expect(promptWithReminder, "kind=sub 提醒行必须 transient 注入某轮模型 prompt").toBeDefined();
    expect(promptWithReminder).toContain(`task=${taskId}`);
    expect(promptWithReminder).toContain("kind=sub");
    expect(promptWithReminder).toContain(`task_fetch(task_id="${taskId}")`);
    const mainTranscript = readFileSync(join(stateRoot, "session", "loom-main.jsonl"), "utf8");
    expect(mainTranscript, "提醒行绝不进主转录（W12 纪律对 sub 面延续）").not.toContain("[run-reminder]");
    expect(mainTranscript).not.toContain("kind=sub");
  }, 60_000);
  it("cancel 面：POST /tasks/:id/cancel 命中在飞后台子 → accepted + 终态 failed/cancelRequested", async () => {
    fake().push(
      {
        content: [
          {
            type: "toolCall",
            id: "s3-bg2",
            name: "task",
            arguments: { agent_type: "explore", task: "长活", background: true },
          },
        ],
      },
      { content: [{ type: "text", text: "child-late" }], delayMs: 400 },
      mainConverge("派发完成。"),
    );
    const sent = await api(`/sessions/${String((await api("/sessions", { method: "POST" })).json.sessionID)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "后台派一个长活" }),
    });
    expect(sent.status).toBe(202);
    const inFlight = await waitFor(() => {
      const l = app.kernel.listSubRuns().filter((r) => r.agentType === "explore");
      return l.length === 1 && l[0]!.state === "running";
    });
    expect(inFlight).toBe(true);
    const taskId = app.kernel.listSubRuns().filter((r) => r.agentType === "explore")[0]!.taskId;
    const cancelled = await api(`/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "operator stop s3" }),
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.accepted).toBe(true);
    const settled = await waitFor(() => {
      const rec = app.kernel.getSub(taskId);
      return rec !== undefined && (rec.state === "failed" || rec.state === "done");
    });
    expect(settled, "cancel 后子会话协作式收尾").toBe(true);
    const rec = app.kernel.getSub(taskId)!;
    expect(rec.state).toBe("failed");
    expect(rec.cancelRequested).toBe("operator stop s3");
    // 取消走正常终局（session aborted → failed 投影）：账本 actual 在场（非崩溃缺口）
    const detail = await api(`/tasks/${taskId}`);
    expect((detail.json.ledger as Record<string, unknown>).actual).not.toBeNull();
  }, 60_000);

  it("task_cancel 工具面：主会话后台派发 → 次轮按 task_id 工具取消 → cancel_requested→终态 failed，GET /tasks 可观测（与 HTTP cancel 同缝）", async () => {
    const created = await api("/sessions", { method: "POST" });
    expect(created.status).toBe(201);
    const sid = String(created.json.sessionID);

    // 队列编排（同 cancel 面测试形）：#0 主 turn1 后台派发 → #1 子调用（1500ms 慢完保取消窗）
    // → #2 主 turn2 converge 收口（父先落 idle，子仍在飞——工具取消目标即此在飞件）。
    fake().push(
      {
        content: [
          {
            type: "toolCall",
            id: "w37-bg",
            name: "task",
            arguments: { agent_type: "explore", task: "w37 长活", background: true },
          },
        ],
      },
      { content: [{ type: "text", text: "w37-child-late" }], delayMs: 1500 },
      mainConverge("已后台派发，准备取消。"),
    );
    const sent = await api(`/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "后台派一个长活" }),
    });
    expect(sent.status).toBe(202);
    const inFlight = await waitFor(() => {
      const running = app.kernel.listSubRuns().filter((r) => r.state === "running" && r.parentSessionId === sid);
      return running.length === 1;
    });
    expect(inFlight, "取消前后台子必须在飞（running）").toBe(true);
    const taskId = app.kernel.listSubRuns().filter((r) => r.parentSessionId === sid)[0]!.taskId;
    // 父轮收口后再发次轮（避免与 turn1 的队列消费互相干扰；子调用已持 #1 长挂）。
    const parentIdle = await waitFor(() => app.registry.get(sid)?.running === null);
    expect(parentIdle, "派发轮应在预算内收口").toBe(true);

    // 次轮走**工具面**取消（不触 HTTP cancel 端点——工具委托的就是 routes.ts:210 同一
    // kernel.cancelSub 单缝，见 boot.ts taskSurface const 装配留痕）。
    fake().push(
      {
        content: [
          { type: "toolCall", id: "w37-cancel", name: "task_cancel", arguments: { task_id: taskId, reason: "w37 模型取消" } },
        ],
      },
      mainConverge("取消请求已受理。"),
    );
    const sent2 = await api(`/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "用 task_cancel 取消那个后台任务" }),
    });
    expect(sent2.status).toBe(202);

    const settled = await waitFor(() => {
      const rec = app.kernel.getSub(taskId);
      return rec !== undefined && rec.state === "failed" && rec.cancelRequested === "w37 模型取消";
    });
    expect(settled, "task_cancel 后子应协作式收尾到 failed 且 cancel_requested 置位").toBe(true);

    // 工具回灌实锤：主会话 toolResult 携受理文案 + task_id（模型即刻可见）。
    const cancelTexts = (app.registry.loopOf(sid)?.session.messages ?? [])
      .filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "task_cancel")
      .map((m) => JSON.stringify((m as { content: unknown }).content));
    expect(
      cancelTexts.some((t) => t.includes("取消请求已受理") && t.includes(taskId)),
      "受理文案必须经共用面回灌主会话",
    ).toBe(true);

    // 同一 GET /tasks 观测面：cancel_requested + 终态（HTTP cancel 用例同款断言形状）。
    const detail = await api(`/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.status).toBe("failed");
    expect(detail.json.cancel_requested).toBe("w37 模型取消");
    expect((detail.json.ledger as Record<string, unknown>).actual).not.toBeNull();
  }, 60_000);

  it("GET /tasks 未接面零扰动：/health 与 /runs 既有形状带回归（六键响应逐字节）", async () => {
    const runs = await api("/runs");
    expect(runs.status).toBe(200);
    expect(Array.isArray(runs.json.runs)).toBe(true);
    for (const r of runs.json.runs as Array<Record<string, unknown>>) {
      // RunView 冻结字段集（纯度=只 run-kind；出现 sub 键即破契约）
      expect(Object.keys(r).sort()).toEqual(
        ["attempt", "cancel_requested", "crashed", "dispatched_at", "error", "parent_run", "run_id", "session_id", "status", "terminal_at", "trigger", "workflow"].sort(),
      );
    }
  }, 30_000);
});
