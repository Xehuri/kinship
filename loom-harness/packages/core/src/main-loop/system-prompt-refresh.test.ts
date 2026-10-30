/**
 * MainSessionLoop 装配计划热重载接线：
 *   - session-start 刷新 → 首个 turn 边界的装配使用新 plan；
 *   - 压缩（fallback）后重载 → currentAssembly() 与 session.systemPrompt 同源；
 *   - plan 未变 → currentAssembly() 返回同一装配对象；
 *   - 首轮之前 currentAssembly() 为 null（保持旧的“未装配”观测面）。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  Type,
  type HarnessTool,
} from "../index.js";
import {
  SessionContextWatcher,
  renderAssemblyPrefix,
  type Assembly,
  type AssemblyPlan,
} from "../assembly/index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { CompactionStateStore } from "../compaction/index.js";
import type { SystemPromptRefreshReason } from "../session.js";
import { MainSessionLoop } from "./loop.js";

function quietSink(): void {
  /* 保持测试输出干净 */
}

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：prompt 热重载",
  body: "本轮结论：收束。",
};

const convergeTurn = (): FakeAssistantResponse => ({
  content: [
    { type: "text", text: "收束正文" },
    { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
  ],
});

const echoTurn = (msg: string): FakeAssistantResponse => ({
  content: [{ type: "toolCall", name: "echo", arguments: { msg } }],
});

const echoTool: HarnessTool = {
  name: "echo",
  description: "测试工具",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echo:${String(args["msg"] ?? "")}` }] };
  },
};

function plan(systemPrompt: string): AssemblyPlan {
  return { systemPrompt, memorySources: [], workflows: [] };
}

function systemText(assembly: Assembly): string {
  const segment = assembly.segments.find((s) => s.name === "system");
  if (segment === undefined) throw new Error("system segment missing");
  return new TextDecoder().decode(segment.bytes);
}

function sha256Prompt(prompt: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(prompt, "utf8")).digest("hex")}`;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function userTexts(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map(messageText);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-main-prompt-refresh-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("MainSessionLoop systemPrompt refresh", () => {
  it("uses the freshly refreshed plan at the first turn boundary and is null before the first turn", async () => {
    const reasons: SystemPromptRefreshReason[] = [];
    const model = createFakeModel([convergeTurn()]);
    const loop = MainSessionLoop.create({
      model,
      tools: [echoTool],
      logSink: quietSink,
      consoleSink: quietSink,
      assembly: { plan: plan("OLD-SYSTEM"), reader: null },
      refreshAssemblyPlan: (reason) => {
        reasons.push(reason);
        return reason === "session-start" ? plan("NEW-SYSTEM") : null;
      },
    });

    expect(loop.currentAssembly()).toBeNull();

    const result = await loop.start("hello");

    expect(result.type).toBe("converged");
    expect(reasons).toEqual(["session-start"]);
    const current = loop.currentAssembly();
    if (current === null) throw new Error("expected an assembly after the first turn");
    expect(systemText(current)).toContain("NEW-SYSTEM");
    expect(systemText(current)).not.toContain("OLD-SYSTEM");
    expect(systemText(loop.assemblies()[0]!)).toContain("NEW-SYSTEM");
    expect(model.getCalls()[0]?.systemPrompt).toContain("NEW-SYSTEM");
    expect(current.prefixHash).toBe(sha256Prompt(loop.session.systemPrompt));
    model.teardown();
  });

  it("returns the same assembly object when the plan refresh yields no change", async () => {
    const reasons: SystemPromptRefreshReason[] = [];
    const model = createFakeModel([convergeTurn()]);
    const stable = plan("STABLE-SYSTEM");
    const loop = MainSessionLoop.create({
      model,
      tools: [echoTool],
      logSink: quietSink,
      consoleSink: quietSink,
      assembly: { plan: stable, reader: null },
      refreshAssemblyPlan: (reason) => {
        reasons.push(reason);
        return null;
      },
    });

    const result = await loop.start("hello");

    expect(result.type).toBe("converged");
    expect(reasons).toEqual(["session-start"]);
    const current = loop.currentAssembly();
    const historical = loop.assemblies().at(-1);
    expect(current).not.toBeNull();
    expect(current).toBe(historical);
    expect(current?.prefixHash).toBe(sha256Prompt(loop.session.systemPrompt));
    model.teardown();
  });

  it("reseeds the context watcher when the refreshed plan keeps identical bytes", async () => {
    let fileText = "V1: rule one\n";
    let fileMtime = 1;
    const watcher = new SessionContextWatcher({
      workspaceRoot: "/main-loop-context",
      sources: [{ relPath: "AGENTS.md", content: fileText }],
      statFile: () => ({
        mtimeMs: fileMtime,
        size: Buffer.byteLength(fileText, "utf8"),
      }),
      readTextFile: () => fileText,
    });
    const stable = plan("STABLE-SYSTEM");
    const model = createFakeModel([convergeTurn(), convergeTurn()]);
    const loop = MainSessionLoop.create({
      model,
      tools: [echoTool],
      logSink: quietSink,
      consoleSink: quietSink,
      assembly: { plan: stable, reader: null },
      contextWatcher: watcher,
      refreshAssemblyPlan: () => ({
        plan: stable,
        contextBaseline: [{ relPath: "AGENTS.md", content: fileText }],
      }),
    });

    fileText = "V1: rule one\nV2: rule two changed\n";
    fileMtime = 2;
    const first = await loop.start("hello");

    expect(first.type).toBe("converged");
    expect(loop.session.systemPrompt).toBe(renderAssemblyPrefix(stable));
    expect(
      userTexts(model.getCalls()[0]!.messages).filter((text) =>
        text.includes("<system-reminder>"),
      ),
    ).toHaveLength(0);

    fileText = "V1: rule one\nV3: rule three\n";
    fileMtime = 3;
    const second = await loop.start("again");

    expect(second.type).toBe("converged");
    const secondUsers = userTexts(model.getCalls()[1]!.messages);
    expect(secondUsers.at(-2)).toContain("-V2: rule two changed");
    expect(secondUsers.at(-2)).toContain("+V3: rule three");
    expect(secondUsers.at(-1)).toBe("again");
    model.teardown();
  });

  it("rebases currentAssembly to the post-compaction plan and keeps sessionPrompt in sync", async () => {
    const reasons: SystemPromptRefreshReason[] = [];
    const model = createFakeModel([echoTurn("work"), convergeTurn()]);
    const stateStore = new CompactionStateStore({ stateRoot: root });
    const loop = MainSessionLoop.create({
      model,
      tools: [echoTool],
      store: new MemorySessionStore(),
      sessionId: "main-prompt-refresh-compaction",
      logSink: quietSink,
      consoleSink: quietSink,
      maxTurns: 4,
      assembly: { plan: plan("BOOT-SYSTEM"), reader: null },
      refreshAssemblyPlan: (reason) => {
        reasons.push(reason);
        if (reason === "session-start") return plan("START-SYSTEM");
        return plan("POST-COMPACT-SYSTEM");
      },
      compaction: {
        stateStore,
        summarize: () => "summary-text",
        wrapSummary: (text, coveredCount) => `[compacted ${String(coveredCount)}]\n${text}`,
        fallbackTokens: 1,
        keepRecent: 1,
        summaryChunkTokens: 1_000,
        retryCount: 0,
      },
    });

    const result = await loop.start("开工");

    expect(result.type).toBe("converged");
    expect(reasons).toEqual(["session-start", "compaction"]);
    expect(loop.session.compactionView).not.toBeNull();
    expect(loop.session.systemPrompt).toContain("POST-COMPACT-SYSTEM");

    const calls = model.getCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.systemPrompt).toContain("START-SYSTEM");
    expect(calls[1]?.systemPrompt).toContain("POST-COMPACT-SYSTEM");

    const current = loop.currentAssembly();
    if (current === null) throw new Error("expected a current assembly");
    expect(current.prefixHash).toBe(sha256Prompt(loop.session.systemPrompt));
    expect(systemText(current)).toContain("POST-COMPACT-SYSTEM");
    // 历史装配不被改写（仍是压缩前的 plan）。
    expect(loop.assemblies().length).toBeGreaterThanOrEqual(1);
    expect(systemText(loop.assemblies()[0]!)).toContain("START-SYSTEM");
    model.teardown();
  });
});
