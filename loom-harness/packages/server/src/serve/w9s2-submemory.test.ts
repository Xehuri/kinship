/**
 * W9 切片 2 —— F4 补链验收（task 子会话获得 memory 声明注入）。
 * Given: 临时 workspace（AGENTS.md 哨兵 + memory/fact/f1.md 哨兵 + 三个角色：
 *        01-data-check 声明 [AGENTS.md, memory/fact/**]、90-plain 未声明、
 *        88-broken 声明含越界 glob 与缺失文件）+ createServeToolWiring 真装配
 * When:  主会话 fake toolCall task 逐角色派发（子会话模型=同一 fake，取 calls 断 systemPrompt）
 * Then:  声明角色=正文+AGENTS.md+fact 两块记忆段；未声明角色=恰 AGENTS.md 基集（零 fact）——
 *        W8' 语义 1 正片（子会话旧实况零记忆，此为裁决补齐非回归）；
 *        坏声明=degrade 不炸（越界 glob 记 warn、缺失文件落占位），派发照常完成。
 * 装配面口径：记忆段拼装发生在 serve tool-wiring（workspaceReal/扫描结果在场），
 * 内核 buildSubSession 保持 domain-free；展开复用 memory-declaration 单真源
 * （side-binding.assembleRoleSystemPrompt 与副会话同函数）。
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

/** 每派发消耗 3 条脚本：主 turn1=task 派发；子 turn1=指定回复（其 systemPrompt=断言对象）；主 turn2=收尾文本。 */
function dispatchScript(agentType: string): FakeAssistantResponse[] {
  return [
    { content: [{ type: "toolCall", id: `s2-${agentType}`, name: "task", arguments: { agent_type: agentType, task: "读一句结论" } }] },
    { content: [{ type: "text", text: "子结论" }] },
    { content: [{ type: "text", text: "收到子结论" }] },
  ];
}

beforeEach(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "loom-w9s2-")));
  ws = join(work, "ws");
  mkdirSync(join(ws, "agents"), { recursive: true });
  mkdirSync(join(ws, "memory", "fact"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# 一级记忆\nS2-AGENTS-哨兵\n");
  writeFileSync(join(ws, "memory", "fact", "f1.md"), "S2-FACT-哨兵\n");
  writeFileSync(join(ws, "agents", "01-data-check.md"), "---\nmemory: [AGENTS.md, memory/fact/**]\n---\nS2-角色正文-数据检查\n");
  writeFileSync(join(ws, "agents", "90-plain.md"), "---\ntags: [角色]\n---\nS2-裸角色正文\n");
  writeFileSync(join(ws, "agents", "88-broken.md"), "---\nmemory: [AGENTS.md, ../leak/**, memory/fact/ghost.md]\n---\nS2-坏声明角色\n");
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
    version: "w9s2-test",
  });
});

afterEach(() => {
  model.teardown();
  rmSync(work, { recursive: true, force: true });
});

async function dispatch(agentType: string): Promise<void> {
  model.push(...dispatchScript(agentType));
  const rec = registry.create();
  registry.send(rec.sessionID, "派子");
  const settled = await waitForIdle(rec.sessionID);
  expect(settled, `${agentType} 派发应在预算内收尾`).toBe(true);
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

/** 第 n 次子会话调用的 systemPrompt（calls 顺序：主1/子1/主2 → 子=索引 1+3k）。 */
function childSystemPrompt(callIndex: number): string {
  const call = model.getCalls()[callIndex];
  expect(call, `calls[${callIndex}] 在场`).toBeDefined();
  return String(call!.systemPrompt ?? "");
}

describe("F4：task 子会话 memory 声明注入", () => {
  it("声明角色（01=fact）派发：子 systemPrompt=角色正文 + AGENTS.md + fact 展开内容（memory-declaration 口径）", async () => {
    await dispatch("01_data_check");
    const sp = childSystemPrompt(1);
    expect(sp).toContain("S2-角色正文-数据检查");
    expect(sp).toContain("### memory[0] AGENTS.md");
    expect(sp).toContain("S2-AGENTS-哨兵");
    expect(sp).toContain("### memory[1] memory/fact/f1.md");
    expect(sp).toContain("S2-FACT-哨兵");
  }, 60_000);

  it("未声明角色（90-plain）派发：恰 AGENTS.md 基集、零 fact（W8' 语义 1 正片）", async () => {
    await dispatch("90_plain");
    const sp = childSystemPrompt(1);
    expect(sp).toContain("S2-裸角色正文");
    expect(sp).toContain("### memory[0] AGENTS.md");
    expect(sp).toContain("S2-AGENTS-哨兵");
    expect(sp).not.toContain("S2-FACT-哨兵");
    expect(sp.match(/### memory\[/g) ?? []).toHaveLength(1);
  }, 60_000);

  it("坏声明角色（88-broken：越界 glob + 缺失文件）：degrade 不炸——派发完成、warn 留痕、占位入块、零泄漏", async () => {
    await dispatch("88_broken");
    const sp = childSystemPrompt(1);
    expect(sp).toContain("S2-坏声明角色");
    // 越界 glob：fail-soft 记 warn（loom memory glob rejected），不进任何内容。
    expect(warns.some((w) => w["msg"] === "loom memory glob rejected" && String(w["pattern"]).includes("leak"))).toBe(true);
    expect(sp).not.toContain("越界");
    // 缺失显式文件：声明占位（resolveMemorySources MISSING 形状），绝不 throw 拖垮派发。
    expect(sp).toContain("### memory");
    expect(sp).toContain("[assembly: source missing, degraded]");
  }, 60_000);
});
