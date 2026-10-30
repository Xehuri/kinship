/**
 * W53 T3 serve per-agent 模型路由（boot 级 e2e，fake provider 双实例）。
 *
 * Given: 临时 workspace（agents/plain.md 无 model；agents/local_compare.md 声明
 *        model: fake-local；agents/bad.md 声明 model: no-such-model）+ 双 fake 模型
 *        config（models[0]=fake-main，models[1]=fake-local）+ 临时 state 根。
 * When:  createLoomApp 起真装配树（零监听），主会话 fake 脚本发 task 派发；子会话
 *        响应脚本只推给对应 fake 实例的独立队列。
 * Then:  - 未声明 model 的 agent 子会话 wire model.id = fake-main（旧继承路径）；
 *        - local_compare 子会话 wire model.id = fake-local，主会话 wire 仍 fake-main；
 *        - 子会话脚本/转录来自 fake-local 实例，fake-main 队列零串用；
 *        - 未知 model id：boot 成功 + 恰一条 warn；派发得到含 agent/id/可用表的
 *          tool error，且不产生任何子会话 wire 文件（绝不静默回落主模型）；
 *        - teardownAll 幂等覆盖两个句柄，app.model.teardown 兼容不抛；
 *        - 单模型 config 回归：无 model 声明的子会话仍 wire fake-main。
 *
 * wire 证据 = boot 同款 WireCacheStore 读 `<stateRoot>/session/wire/<sid>.json`
 * （真落盘快照，非"文件存在"弱断言）；子 sid 从 task toolResult 的 <task_metadata>
 * 反解（前端契约通路）。
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JsonlSessionStore } from "@axeuh/loom-adapters";
import type { FakeAssistantResponse, FakeModel } from "@axeuh/loom-core/testing";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";
import { WireCacheStore, wireCacheFileName } from "./wire-cache.js";

// 加载纪律（同 boot-tools/boot-assembly）：boot 图必须动态 import，避免 core 桶经
// server 环先实例化（ConvergenceGate 绑定残缺）。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

const TOKEN = "tok-model-routing-test";
const CHILD_SID_RE = /session_id: (ses_[0-9a-f]{16})/;

interface BootLog {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

interface TestApp {
  readonly app: LoomApp;
  readonly work: string;
  readonly stateRoot: string;
  readonly logs: BootLog[];
}

let current: TestApp | undefined;

function yamlFor(ws: string, modelIds: readonly string[]): string {
  const modelBlocks = modelIds.flatMap((id) => [
    `  - id: ${id}`,
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
  ]);
  return [
    "server:",
    "  port: 5101",
    "  hostname: 127.0.0.1",
    `workspace: ${ws}`,
    "models:",
    ...modelBlocks,
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ].join("\n");
}

function writeWorkspace(ws: string): void {
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# model-routing 测试底座\n");
  writeFileSync(
    join(ws, "agents", "plain.md"),
    ["---", "name: plain", "description: 无 model 声明的普通子智能体", "---", "# plain 正文"].join("\n"),
  );
  writeFileSync(
    join(ws, "agents", "local_compare.md"),
    [
      "---",
      "name: local_compare",
      "description: 声明 fake-local 路由的对比子智能体",
      "model: fake-local",
      "---",
      "# local_compare 正文",
    ].join("\n"),
  );
  writeFileSync(
    join(ws, "agents", "bad.md"),
    [
      "---",
      "name: bad",
      "description: 声明不存在模型的坏 agent",
      "model: no-such-model",
      "---",
      "# bad 正文",
    ].join("\n"),
  );
}

async function boot(modelIds: readonly string[]): Promise<TestApp> {
  const work = mkdtempSync(join(tmpdir(), "loom-model-routing-"));
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeWorkspace(ws);

  const yaml = yamlFor(ws, modelIds);
  const config: LoomConfig = parseLoomConfig(yaml, "<test>", { env: {} });
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(stateRoot, "config")),
    env: {},
  });
  const applied = store.apply(yaml, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);

  const logs: BootLog[] = [];
  const app = await createLoomApp({
    config,
    store,
    stateRoot,
    tokens: [TOKEN],
    version: "test",
    env: {},
    log: (level, msg, fields) => {
      logs.push({ level, msg, fields });
    },
  });
  current = { app, work, stateRoot, logs };
  return current;
}

afterEach(async () => {
  const t = current;
  current = undefined;
  if (t === undefined) return;
  await t.app.closeExtras();
  t.app.models.teardownAll();
  rmSync(t.work, { recursive: true, force: true });
});

function fakeOf(app: LoomApp, id: string): FakeModel {
  const handle = app.models.byId.get(id);
  if (handle === undefined) throw new Error(`模型句柄缺失：${id}`);
  return handle.model as FakeModel;
}

function taskCall(id: string, agentType: string, task: string): FakeAssistantResponse {
  return {
    content: [{ type: "toolCall", id, name: "task", arguments: { agent_type: agentType, task } }],
  };
}

function text(t: string): FakeAssistantResponse {
  return { content: [{ type: "text", text: t }] };
}

function finalTurn(mark: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text: mark },
      {
        type: "toolCall",
        id: `mr-conv-${mark}`,
        name: "converge",
        arguments: { status: "已完成", digest: mark, body: "收口。" },
      },
    ],
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

interface TaskResultView {
  readonly text: string;
  readonly isError: boolean;
}

function taskResultsOf(app: LoomApp, sid: string): TaskResultView[] {
  const loop = app.registry.loopOf(sid);
  if (loop === undefined) throw new Error(`主会话 loop 缺失：${sid}`);
  return loop.session.messages
    .map((m) => m as unknown as { role: string; toolName?: string; content: unknown; isError?: boolean })
    .filter((m) => m.role === "toolResult" && m.toolName === "task")
    .map((m) => ({ text: JSON.stringify(m.content), isError: m.isError === true }));
}

function firstTaskResult(app: LoomApp, sid: string): TaskResultView {
  const first = taskResultsOf(app, sid)[0];
  if (first === undefined) throw new Error(`task toolResult 缺失：${sid}`);
  return first;
}

function childSidOf(taskText: string): string {
  const hit = CHILD_SID_RE.exec(taskText);
  if (hit === null || hit[1] === undefined) {
    throw new Error(`task toolResult 未见 <task_metadata> session_id：${taskText.slice(0, 300)}`);
  }
  return hit[1];
}

function wireOf(t: TestApp, sid: string): {
  readonly id: string;
  readonly provider: string;
} {
  const cache = new WireCacheStore({ dir: join(t.stateRoot, "session", "wire") });
  const rec = cache.read(sid);
  if (rec === null) throw new Error(`wire 快照缺失：${sid}`);
  return rec.snapshot.model;
}

async function sendAndSettle(app: LoomApp, prompt: string): Promise<string> {
  const rec = app.registry.create();
  app.registry.send(rec.sessionID, prompt);
  const settled = await waitFor(() => app.registry.get(rec.sessionID)?.running === null);
  expect(settled, "主会话轮应在预算内收尾").toBe(true);
  return rec.sessionID;
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
});

describe("W53 T3 serve 子会话按 agent 声明选模型", () => {
  it("a. agent 无 model: → 子会话继承主模型（child wire model.id=fake-main）", async () => {
    const t = await boot(["fake-main", "fake-local"]);
    const main = fakeOf(t.app, "fake-main");
    main.push(
      taskCall("mr-plain-task", "plain", "只回一句话"),
      text("PLAIN-CHILD-ANSWER"),
      finalTurn("主会话收口"),
    );

    const mainSid = await sendAndSettle(t.app, "派 plain 子智能体");
    const result = firstTaskResult(t.app, mainSid);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("PLAIN-CHILD-ANSWER");

    const childSid = childSidOf(result.text);
    expect(wireOf(t, childSid).id).toBe("fake-main");
    expect(wireOf(t, mainSid).id).toBe("fake-main");
  }, 40_000);

  it("b. local_compare 子会话走 fake-local（child wire=fake-local，主会话仍 fake-main）", async () => {
    const t = await boot(["fake-main", "fake-local"]);
    const main = fakeOf(t.app, "fake-main");
    const local = fakeOf(t.app, "fake-local");
    main.push(taskCall("mr-local-task", "local_compare", "对比一句话"), finalTurn("主会话收口"));
    local.push(text("LOCAL-CHILD-ANSWER"));

    const mainSid = await sendAndSettle(t.app, "派 local_compare 子智能体");
    const result = firstTaskResult(t.app, mainSid);
    expect(result.isError).toBe(false);

    const childSid = childSidOf(result.text);
    expect(wireOf(t, childSid).id).toBe("fake-local");
    expect(wireOf(t, mainSid).id).toBe("fake-main");
  }, 40_000);

  it("c. 路由到独立 fake 实例：子会话只吃 fake-local 脚本，主队列零串用", async () => {
    const t = await boot(["fake-main", "fake-local"]);
    const main = fakeOf(t.app, "fake-main");
    const local = fakeOf(t.app, "fake-local");
    main.push(taskCall("mr-instance-task", "local_compare", "只回一句脚本答案"), finalTurn("MAIN-FINAL-TEXT"));
    local.push(text("LOCAL-SCRIPT-ONLY"));

    const mainSid = await sendAndSettle(t.app, "派 local_compare 验实例隔离");
    const result = firstTaskResult(t.app, mainSid);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("LOCAL-SCRIPT-ONLY");

    const childSid = childSidOf(result.text);
    // 子转录（持久面）携带 fake-local 的唯一脚本答案。
    const childStore = new JsonlSessionStore(join(t.stateRoot, "session", "loom-sessions.jsonl"));
    const path = await childStore.getPathToLeaf(childSid);
    expect(JSON.stringify(path)).toContain("LOCAL-SCRIPT-ONLY");
    // 队列消费次数：主 fake 两轮（task 调用 + 收口），local fake 恰一轮（子会话）。
    expect(main.getCalls()).toHaveLength(2);
    expect(local.getCalls()).toHaveLength(1);
    // 主会话最终答不是"脚本耗尽"兜底语 = fake-local 没偷主队列。
    expect(JSON.stringify(t.app.registry.loopOf(mainSid)?.session.messages)).toContain("MAIN-FINAL-TEXT");
    expect(JSON.stringify(t.app.registry.loopOf(mainSid)?.session.messages)).not.toContain(
      "[fake: no more scripted responses]",
    );
  }, 40_000);

  it("d. 未知 model id：boot 成功 + 单条 warn；派发响亮 tool error 且零子会话落盘", async () => {
    const t = await boot(["fake-main", "fake-local"]);
    const main = fakeOf(t.app, "fake-main");
    main.push(taskCall("mr-bad-task", "bad", "这条派发必须被拒"), finalTurn("主会话在错误后收口"));

    const warns = t.logs.filter((l) => l.level === "warn" && l.msg === "loom agent model unresolved");
    expect(warns, "boot 应恰有一条 agent model unresolved warn").toHaveLength(1);
    const warn = warns[0];
    if (warn === undefined) throw new Error("agent model unresolved warn 缺失");
    expect(warn.fields).toMatchObject({
      agentType: "bad",
      model: "no-such-model",
      available: "fake-main,fake-local",
    });

    const mainSid = await sendAndSettle(t.app, "派 bad 子智能体");
    const result = firstTaskResult(t.app, mainSid);
    expect(result.isError, "未知模型派发必须是 tool error").toBe(true);
    const errorText = result.text;
    expect(errorText).toContain("bad");
    expect(errorText).toContain("no-such-model");
    expect(errorText).toContain("fake-main");
    expect(errorText).toContain("fake-local");

    // 无静默回落：子转录库零 sid，wire 目录只有主会话自己的一份快照。
    const childStore = new JsonlSessionStore(join(t.stateRoot, "session", "loom-sessions.jsonl"));
    expect(childStore.sessionIds()).toEqual([]);
    expect(readdirSync(join(t.stateRoot, "session", "wire"))).toEqual([
      wireCacheFileName(mainSid),
    ]);
    expect(main.getCalls()).toHaveLength(2);
  }, 40_000);

  it("e. teardownAll 幂等覆盖全部句柄；app.model.teardown 兼容不抛", async () => {
    const t = await boot(["fake-main", "fake-local"]);
    const mainHandle = t.app.models.byId.get("fake-main");
    const localHandle = t.app.models.byId.get("fake-local");
    if (mainHandle === undefined || localHandle === undefined) {
      throw new Error("双模型句柄缺失");
    }
    expect(t.app.model).toBe(mainHandle);

    const mainSpy = vi.spyOn(mainHandle, "teardown");
    const localSpy = vi.spyOn(localHandle, "teardown");

    expect(() => t.app.models.teardownAll()).not.toThrow();
    expect(() => t.app.models.teardownAll()).not.toThrow();
    expect(mainSpy).toHaveBeenCalledTimes(1);
    expect(localSpy).toHaveBeenCalledTimes(1);
    expect(() => t.app.model.teardown()).not.toThrow();
  }, 40_000);

  it("f. 单模型 config 回归：无 model 声明的子会话仍走 fake-main", async () => {
    const t = await boot(["fake-main"]);
    const main = fakeOf(t.app, "fake-main");
    main.push(
      taskCall("mr-single-task", "plain", "单模型只回一句话"),
      text("SINGLE-MODEL-CHILD"),
      finalTurn("主会话收口"),
    );

    const mainSid = await sendAndSettle(t.app, "单模型派 plain 子智能体");
    const result = firstTaskResult(t.app, mainSid);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("SINGLE-MODEL-CHILD");

    const childSid = childSidOf(result.text);
    expect(wireOf(t, childSid).id).toBe("fake-main");
    expect(wireOf(t, mainSid).id).toBe("fake-main");
  }, 40_000);
});
