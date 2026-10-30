/**
 * PTY 真退出唤醒 Loom 会话端到端（fake-model + 真 node-pty，本测试绝不 mock spawn）。
 *
 * Given: 临时 workspace + stateRoot + FakeModel 脚本 + 真 serve 工具面接线。
 * When:  registry.send 起第一轮（pty_spawn → converge），进程仍在 sleep 时本轮先收尾；
 *        真 PTY 退出经 onPtyExit → registry.deliverWake 投递。
 * Then:  空闲会话以 <pty_exited> 行作为 durable user 消息起**新一轮**（fake 响应 #3），
 *        模型请求面与转录均见退出行；notifyOnExit=false 时进程退出不触发任何唤醒。
 *        忙路径：当前轮 delayed converge 期间退出 → 退出行入 durable 发送队列，
 *        当前轮收尾后自动起新轮，且边界提醒队列零滞留。
 *
 * 依据：registry.deliverWake 的 durable send-queue 路径（空闲 → #drainQueue 立即起轮；
 *       忙 → #start finally 的 #drainQueue 接棒起新轮）；
 *       pty-manager handleExit 仅对 notifyOnExit 会话回调 onExit。
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HarnessTool, HookContext, Message, StoredEntry } from "@axeuh/loom-core";
import { MemorySessionStore } from "@axeuh/loom-core";
import {
  createFakeModel,
  createTestContext,
  type FakeAssistantResponse,
  type FakeModel,
} from "@axeuh/loom-core/testing";

import { SessionRegistry } from "../session-api/index.js";

// 加载纪律（同 boot-pty.test）：boot/tool-wiring 图动态 import，避免 core 桶经
// server 环先实例化（ConvergenceGate "is not a constructor"）。
type CreateWiring = typeof import("./tool-wiring.js").createServeToolWiring;
let createServeToolWiring!: CreateWiring;

const POLL_MS = 25;

interface Stack {
  readonly model: FakeModel;
  readonly store: MemorySessionStore;
  readonly registry: SessionRegistry;
  readonly tools: readonly HarnessTool[];
  readonly workspace: string;
  readonly stateRoot: string;
}

const stacks: Stack[] = [];

beforeAll(async () => {
  const mod = await import("./tool-wiring.js");
  createServeToolWiring = mod.createServeToolWiring;
});

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    try {
      // 逐个已登记会话列出并清理 PTY（owner 口径 = ctx.sessionId）；失败一律忽略，
      // 已退出/已清理的会话无需二次处理。
      for (const view of stack.registry.list({ archived: "all" })) {
        const ctx = createTestContext({ sessionId: view.sessionID }).ctx;
        let listed = "";
        try {
          listed = await runTool(stack.tools, "pty_list", {}, ctx);
        } catch {
          listed = "";
        }
        for (const id of ptyIdsOf(listed)) {
          try {
            await runTool(stack.tools, "pty_kill", { id, cleanup: true }, ctx);
          } catch {
            // 进程已消失/已清理。
          }
        }
      }
    } finally {
      stack.model.teardown();
      rmSync(stack.workspace, { recursive: true, force: true });
      rmSync(stack.stateRoot, { recursive: true, force: true });
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同步谓词轮询（25ms 一探，deadline 必炸，绝不悬挂）。 */
async function waitUntil(probe: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`${what}: timed out after ${budgetMs}ms`);
    await delay(POLL_MS);
  }
}

/** 异步探针轮询（pty_list 直读真实进程状态用）。 */
async function pollUntil(probe: () => Promise<boolean>, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`${what}: timed out after ${budgetMs}ms`);
    await delay(POLL_MS);
  }
}

/** 直调工具（仅用于清理与 pty 状态轮询；唤醒路径一律走 registry）。 */
async function runTool(
  tools: readonly HarnessTool[],
  name: string,
  args: Record<string, unknown>,
  ctx: HookContext,
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  const result = await tool.execute(args, ctx, new AbortController().signal);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** 消息正文（user 可为字符串；assistant/toolResult 为内容块数组 → JSON 文本）。 */
function messageText(message: Message): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

/** 转录里某一角色的全部消息正文（store 证据面）。 */
function storedTextsOf(path: readonly StoredEntry[], role: Message["role"]): string[] {
  const out: string[] = [];
  for (const stored of path) {
    if (stored.entry.kind !== "message") continue;
    const message = stored.entry.message;
    if (message.role !== role) continue;
    out.push(messageText(message));
  }
  return out;
}

/** pty_list 输出里的会话 id（同机并存的其它会话不会串入：owner 已由 ctx 隔离）。 */
function ptyIdsOf(text: string): readonly string[] {
  return text.match(/pty_[0-9a-f]{8}\b/g) ?? [];
}

/** 真栈子集装配（镜像 w11-live-events）：双惰性 onPtyExit → registry.deliverWake。 */
async function makeStack(script: readonly FakeAssistantResponse[]): Promise<Stack> {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "loom-pty-e2e-ws-")));
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "loom-pty-e2e-state-")));
  const model = createFakeModel([...script]);
  const sink: { deliver?: ((sid: string, line: string) => void) | undefined } = {};
  const wiring = await createServeToolWiring({
    workspaceRoot: workspace,
    stateRoot,
    model,
    llmOptions: {},
    onPtyExit: (sid, line) => sink.deliver?.(sid, line),
  });
  const store = new MemorySessionStore();
  const registry = new SessionRegistry({
    model,
    store,
    stateRoot,
    tools: wiring.tools,
    workspaceRoot: wiring.workspaceReal,
    version: "pty-e2e",
  });
  sink.deliver = (sid, line) => registry.deliverWake(sid, line);
  const stack: Stack = { model, store, registry, tools: wiring.tools, workspace, stateRoot };
  stacks.push(stack);
  return stack;
}

describe("PTY 真退出唤醒 Loom 会话（真 node-pty + fake model）", () => {
  it("notifyOnExit=true：PTY 退出在空闲会话起唤醒轮，<pty_exited> 成为 durable user 消息", async () => {
    const stack = await makeStack([
      {
        content: [
          {
            type: "toolCall",
            name: "pty_spawn",
            arguments: {
              command: "/bin/bash",
              args: ["-lc", "sleep 1.2; echo PTY_E2E_DONE"],
              description: "e2e exit wake",
              notifyOnExit: true,
              timeoutSeconds: 10,
            },
          },
        ],
      },
      {
        content: [
          {
            type: "toolCall",
            name: "converge",
            arguments: { status: "已完成", digest: "spawned", body: "spawn done" },
          },
        ],
      },
      {
        content: [
          {
            type: "toolCall",
            name: "converge",
            arguments: { status: "已完成", digest: "resumed", body: "saw pty exit" },
          },
        ],
      },
    ]);
    const { registry, model, store } = stack;
    const rec = registry.create();
    const sid = rec.sessionID;

    expect(registry.send(sid, "start the PTY task").accepted).toBe(true);

    // 第一轮（pty_spawn → converge）必须在 1.2s 的 PTY 退出前收尾：空闲是唤醒前置。
    await waitUntil(() => registry.get(sid)?.running === null, 10_000, "run 1 idle");
    expect(model.getCalls().length, "run 1 消费 spawn + converge 两条脚本").toBe(2);

    // 真进程退出 → onPtyExit → sink → deliverWake 空闲快路径 → 新唤醒轮（脚本 #3）。
    await waitUntil(() => model.getCalls().length >= 3, 15_000, "PTY-exit wake run");
    await waitUntil(() => registry.get(sid)?.running === null, 10_000, "wake run idle");

    expect(model.getCalls().length).toBeGreaterThanOrEqual(3);

    const wakeCall = model.getCalls().find((call) =>
      call.messages.some(
        (message) =>
          message.role === "user" &&
          messageText(message).includes("<pty_exited>") &&
          messageText(message).includes("PTY_E2E_DONE"),
      ),
    );
    expect(wakeCall, "唤醒请求必须携带 <pty_exited> + PTY_E2E_DONE 的 user 消息").toBeDefined();

    const path = await store.getPathToLeaf(sid);
    const userTexts = storedTextsOf(path, "user");
    expect(
      userTexts.some((text) => text.includes("<pty_exited>") && text.includes("Exit Code: 0")),
      "唤醒行必须以 durable user 消息落盘（含 Exit Code: 0）",
    ).toBe(true);

    const toolTexts = storedTextsOf(path, "toolResult");
    expect(
      toolTexts.some((text) => text.includes("<pty_spawned>") && text.includes("ID: pty_")),
      "第一轮 pty_spawn 工具结果须在转录里",
    ).toBe(true);

    expect(registry.get(sid)?.running).toBeNull();
    expect(registry.get(sid)?.status).toBe("idle");
  }, 30_000);

  it("notifyOnExit=false：PTY 真退出不触发唤醒（零额外模型调用、无 <pty_exited> 用户消息）", async () => {
    const stack = await makeStack([
      {
        content: [
          {
            type: "toolCall",
            name: "pty_spawn",
            arguments: {
              command: "/bin/bash",
              args: ["-lc", "sleep 0.4; echo PTY_NO_NOTIFY"],
              description: "no notify",
              notifyOnExit: false,
            },
          },
        ],
      },
      {
        content: [
          {
            type: "toolCall",
            name: "converge",
            arguments: { status: "已完成", digest: "no-notify", body: "spawn done" },
          },
        ],
      },
    ]);
    const { registry, model, store, tools } = stack;
    const rec = registry.create();
    const sid = rec.sessionID;
    const ctx = createTestContext({ sessionId: sid }).ctx;

    expect(registry.send(sid, "start no-notify PTY").accepted).toBe(true);
    await waitUntil(() => registry.get(sid)?.running === null, 10_000, "run idle");

    // 直读真实进程状态直到退出（退出回调不参与本用例——本就不该有通知）。
    await pollUntil(async () => {
      const listed = await runTool(tools, "pty_list", {}, ctx);
      return /exit: 0\b/.test(listed);
    }, 10_000, "PTY exit observed via pty_list");

    // 有界 settle：给（不应存在的）唤醒留出发起窗口，再断言零额外模型调用。
    await delay(300);
    expect(model.getCalls().length).toBe(2);

    const path = await store.getPathToLeaf(sid);
    expect(
      storedTextsOf(path, "user").some((text) => text.includes("<pty_exited>")),
      "notifyOnExit=false 不得产生 <pty_exited> 唤醒消息",
    ).toBe(false);

    // 显式清理本用例的 PTY 会话（afterEach 兜底，此处给确定性断开点）。
    const listed = await runTool(tools, "pty_list", {}, ctx);
    for (const id of ptyIdsOf(listed)) {
      try {
        await runTool(tools, "pty_kill", { id, cleanup: true }, ctx);
      } catch {
        // 已消失/已清理。
      }
    }
  }, 30_000);

  it("忙路径：当前轮 delayed converge 期间 PTY 退出 → 收尾后 durable 退出行起新轮且无边界提醒滞留", async () => {
    const stack = await makeStack([
      {
        content: [
          {
            type: "toolCall",
            name: "pty_spawn",
            arguments: {
              command: "/bin/bash",
              args: ["-lc", "sleep 0.15; echo PTY_BUSY_DONE"],
              description: "busy exit wake",
              notifyOnExit: true,
              timeoutSeconds: 10,
            },
          },
        ],
      },
      {
        // 800ms 延迟保证 PTY（150ms 退出）落在 run 1 的在途 converge 请求内。
        delayMs: 800,
        content: [
          {
            type: "toolCall",
            name: "converge",
            arguments: { status: "已完成", digest: "busy-spawn", body: "spawn done while pty exits" },
          },
        ],
      },
      {
        content: [
          {
            type: "toolCall",
            name: "converge",
            arguments: { status: "已完成", digest: "busy-resumed", body: "saw pty exit" },
          },
        ],
      },
    ]);
    const { registry, model, store } = stack;
    const rec = registry.create();
    const sid = rec.sessionID;

    expect(registry.send(sid, "start busy PTY task").accepted).toBe(true);

    // run 1 的 delayed converge 请求已在途 = PTY 退出必然发生在 busy 窗口内。
    await waitUntil(() => model.getCalls().length >= 2, 10_000, "run 1 delayed converge turn");
    expect(registry.get(sid)?.running, "PTY 退出窗口内 run 1 必须仍在 busy").not.toBeNull();

    // 忙路径投递 → durable 队列；run 1 收尾后 #drainQueue 自动起唤醒轮（脚本 #3）。
    await waitUntil(() => model.getCalls().length >= 3, 15_000, "busy-path wake run");
    await waitUntil(() => registry.get(sid)?.running === null, 10_000, "busy-path wake run idle");

    // 退出行不得提前混入 run 1 的请求面（busy 不 steer）：它只属于收尾后的新轮。
    const preWakeCalls = model.getCalls().slice(0, 2);
    expect(
      preWakeCalls.some((call) =>
        call.messages.some(
          (message) => message.role === "user" && messageText(message).includes("<pty_exited>"),
        ),
      ),
      "run 1 请求面不得包含 <pty_exited>（退出行 busy 时入队列而非 steer）",
    ).toBe(false);
    expect(
      preWakeCalls.some((call) =>
        call.messages.some(
          (message) =>
            message.role === "toolResult" && messageText(message).includes("<pty_spawned>"),
        ),
      ),
      "run 1 的 converge 请求须已带 pty_spawn 工具结果（证明退出发生在该轮在途期间）",
    ).toBe(true);

    const wakeCall = model.getCalls().find((call) =>
      call.messages.some(
        (message) =>
          message.role === "user" &&
          messageText(message).includes("<pty_exited>") &&
          messageText(message).includes("PTY_BUSY_DONE"),
      ),
    );
    expect(wakeCall, "唤醒轮必须携带 <pty_exited> + PTY_BUSY_DONE 的 user 消息").toBeDefined();

    const path = await store.getPathToLeaf(sid);
    expect(
      storedTextsOf(path, "user").some(
        (text) => text.includes("<pty_exited>") && text.includes("Exit Code: 0"),
      ),
      "忙路径退出行必须以 durable user 消息落盘（含 Exit Code: 0）",
    ).toBe(true);

    expect(registry.get(sid)?.running).toBeNull();
    expect(registry.get(sid)?.status).toBe("idle");
    expect(
      registry.get(sid)?.loop.pendingReminders(),
      "busy 路径不得再走 transient 边界提醒（收束前滞留 = 丢失）",
    ).toBe(0);
  }, 30_000);
});
