/**
 * Task 4 验收：task 子会话的角色正文在 spawn 时现读，记忆源由 per-session watcher 逐 turn 监听。
 *
 * Given: 临时 workspace（AGENTS.md v1 + agents/01-data-check.md 声明 [AGENTS.md, memory/fact/**]
 *        + 88-broken 越界/缺失声明）+ createServeToolWiring 真装配
 * When:  装配后改文件再派发 / 子会话运行中经 write 工具改注入源
 * Then:  spawn 读到最新正文与记忆（无启动预载）；下一 turn 的 LLM 调用消息含 durable
 *        unified-diff notice；多文件声明均被监听；坏声明降级不抛。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { SessionRegistry, type SessionRecord } from "../session-api/index.js";
import { createServeToolWiring, type ServeToolWiring } from "./tool-wiring.js";

const READ = 30_000;

let work = "";
let ws = "";
let stateRoot = "";
let model: ReturnType<typeof createFakeModel>;
let wiring: ServeToolWiring;
let registry: SessionRegistry;
let warns: Array<Record<string, unknown>>;

interface MsgLike {
  readonly role: string;
  readonly content: unknown;
}

function taskCall(agentType: string): FakeAssistantResponse {
  return {
    content: [
      {
        type: "toolCall",
        id: `child-${agentType}`,
        name: "task",
        arguments: { agent_type: agentType, task: "执行子任务" },
      },
    ],
  };
}

function childWrite(path: string, content: string): FakeAssistantResponse {
  return {
    content: [{ type: "toolCall", id: `write-${path}`, name: "write", arguments: { path, content } }],
  };
}

function reply(value: string): FakeAssistantResponse {
  return { content: [{ type: "text", text: value }] };
}

function userText(m: MsgLike): string | null {
  return m.role === "user" && typeof m.content === "string" ? m.content : null;
}

function isNotice(m: MsgLike): boolean {
  return (userText(m) ?? "").startsWith("<system-reminder>");
}

function noticeTexts(messages: readonly MsgLike[]): string[] {
  return messages.filter(isNotice).map((m) => userText(m) ?? "");
}

beforeEach(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "loom-child-ctx-")));
  ws = join(work, "ws");
  mkdirSync(join(ws, "agents"), { recursive: true });
  mkdirSync(join(ws, "memory", "fact"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# 一级记忆\nCHILD-AGENTS-V1\n");
  writeFileSync(join(ws, "memory", "fact", "f1.md"), "CHILD-FACT-F1\n");
  writeFileSync(join(ws, "memory", "fact", "f2.md"), "CHILD-FACT-F2\n");
  writeFileSync(
    join(ws, "agents", "01-data-check.md"),
    "---\nmemory: [AGENTS.md, memory/fact/**]\n---\nCHILD-BODY-A\n",
  );
  writeFileSync(
    join(ws, "agents", "88-broken.md"),
    "---\nmemory: [AGENTS.md, ../leak/**, memory/fact/ghost.md]\n---\nCHILD-BODY-BROKEN\n",
  );
  stateRoot = join(work, "state");

  model = createFakeModel([]);
  warns = [];
  wiring = await createServeToolWiring({
    workspaceRoot: ws,
    stateRoot,
    model,
    llmOptions: {},
    log: (level, msg, fields) => {
      if (level === "warn") warns.push({ msg, ...fields });
    },
  });
  registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    tools: wiring.tools,
    workspaceRoot: wiring.workspaceReal,
    version: "session-context-child-test",
  });
});

afterEach(() => {
  model.teardown();
  rmSync(work, { recursive: true, force: true });
});

async function dispatch(script: FakeAssistantResponse[]): Promise<void> {
  model.push(...script);
  const rec = registry.create();
  registry.send(rec.sessionID, "派子");
  const settled = await waitForIdle(rec.sessionID);
  expect(settled, "派发应在预算内收尾").toBe(true);
}

async function waitForIdle(sessionID: string): Promise<boolean> {
  const until = Date.now() + READ;
  while (Date.now() < until) {
    const view = registry.statusView(sessionID);
    if (view !== undefined && view.status === "idle" && view.turns > 0) {
      const rec: SessionRecord | undefined = registry.get(sessionID);
      if (rec !== undefined && rec.running === null) return true;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function callAt(index: number): { systemPrompt?: string; messages: readonly MsgLike[] } {
  const call = model.getCalls()[index];
  expect(call, `calls[${index}] 在场`).toBeDefined();
  return call as { systemPrompt?: string; messages: readonly MsgLike[] };
}

describe("task 子会话：spawn 现读 + 逐 turn watcher diff", () => {
  it("spawn freshness：装配后改 AGENTS.md 与角色正文，子 systemPrompt 取新值（无启动预载）", async () => {
    writeFileSync(join(ws, "AGENTS.md"), "# 一级记忆\nCHILD-AGENTS-V2\n");
    writeFileSync(
      join(ws, "agents", "01-data-check.md"),
      "---\nmemory: [AGENTS.md, memory/fact/**]\n---\nCHILD-BODY-B\n",
    );

    await dispatch([taskCall("01_data_check"), reply("子结论"), reply("收尾")]);

    const sp = String(callAt(1).systemPrompt ?? "");
    expect(sp).toContain("CHILD-AGENTS-V2");
    expect(sp).toContain("CHILD-BODY-B");
    expect(sp).toContain("CHILD-FACT-F1");
    expect(sp).not.toContain("CHILD-AGENTS-V1");
    expect(sp).not.toContain("CHILD-BODY-A");
  }, 60_000);

  it("mid-run：子会话写 AGENTS.md 后，下一次 LLM 调用收到 durable diff notice，首次调用无 notice", async () => {
    await dispatch([
      taskCall("01_data_check"),
      childWrite("AGENTS.md", "# 一级记忆\nCHILD-AGENTS-V2-CHANGED\n"),
      reply("子完成"),
      reply("收尾"),
    ]);

    expect(noticeTexts(callAt(1).messages)).toHaveLength(0);
    const notices = noticeTexts(callAt(2).messages);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<system-reminder>");
    expect(notices[0]).toContain("Updated instructions from: AGENTS.md");
    expect(notices[0]).toContain("@@ -");
    expect(notices[0]).toContain("+CHILD-AGENTS-V2-CHANGED");
  }, 60_000);

  it("declared globs：声明覆盖多个文件，第二个文件 mid-run 变更同样触发 notice", async () => {
    await dispatch([
      taskCall("01_data_check"),
      childWrite("memory/fact/f2.md", "CHILD-FACT-F2-CHANGED\n"),
      reply("子完成"),
      reply("收尾"),
    ]);

    const sp = String(callAt(1).systemPrompt ?? "");
    expect(sp).toContain("CHILD-FACT-F1");
    expect(sp).toContain("CHILD-FACT-F2");

    const notices = noticeTexts(callAt(2).messages);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Updated instructions from: memory/fact/f2.md");
    expect(notices[0]).toContain("+CHILD-FACT-F2-CHANGED");
  }, 60_000);

  it("坏声明（越界 glob + 缺失文件）：watcher 装配与派发照常，降级不抛", async () => {
    await dispatch([taskCall("88_broken"), reply("子完成"), reply("收尾")]);

    const sp = String(callAt(1).systemPrompt ?? "");
    expect(sp).toContain("CHILD-BODY-BROKEN");
    expect(sp).toContain("[assembly: source missing, degraded]");
    expect(warns.some((w) => w["msg"] === "loom memory glob rejected")).toBe(true);
  }, 60_000);
});
