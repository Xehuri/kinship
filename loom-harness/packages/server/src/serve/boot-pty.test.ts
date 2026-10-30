/**
 * serve 工具面 pty 五件套接线端到端（fake-model 离线，直驱 wiring）。
 *
 * Given: 临时 workspace（realpath）+ stateRoot + FakeModel。
 * When:  createServeToolWiring 以缺省 / enabled:false / caps / onPtyExit 多路装配，
 *        并直调 pty_spawn/pty_read/pty_kill 驱动真 PTY。
 * Then:  缺省面含五件套、enabled:false 全缺席；pty_spawn 只授权不执行（permission +
 *        cwd 围栏）；真进程退出经 onPtyExit 送出 <pty_exited>；caps 上限真拒绝。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HarnessTool, HookContext } from "@axeuh/loom-core";
import { createFakeModel, createTestContext, type FakeModel } from "@axeuh/loom-core/testing";
import { SeamDeniedError } from "@axeuh/loom-tools/seam";

// 加载纪律（同 boot-tools.test）：boot/tool-wiring 图必须动态 import，
// 避免 core 桶经 server 环先实例化（ConvergenceGate "is not a constructor" 稳定复现）。
type CreateWiring = typeof import("./tool-wiring.js").createServeToolWiring;
let createServeToolWiring!: CreateWiring;

const PTY_NAMES = ["pty_kill", "pty_list", "pty_read", "pty_spawn", "pty_write"] as const;

interface PtyCleanup {
  readonly tools: readonly HarnessTool[];
  readonly ctx: HookContext;
  readonly id: string;
}

interface ExitEvent {
  readonly owner: string;
  readonly line: string;
}

const models: FakeModel[] = [];
const roots: string[] = [];
const cleanups: PtyCleanup[] = [];

beforeAll(async () => {
  const mod = await import("./tool-wiring.js");
  createServeToolWiring = mod.createServeToolWiring;
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    try {
      await run(c.tools, "pty_kill", { id: c.id, cleanup: true }, c.ctx);
    } catch {
      // 已显式清理/已消失的会话无需二次处理。
    }
  }
  for (const m of models.splice(0)) m.teardown();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** realpath 工作区根（executor 以 realpath 为界；/tmp 符号链接体系必须先归一）。 */
function makeWorkspace(): { ws: string; stateRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-pty-")));
  const ws = join(root, "ws");
  const stateRoot = join(root, "state");
  mkdirSync(ws, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  roots.push(root);
  return { ws: realpathSync(ws), stateRoot: realpathSync(stateRoot) };
}

function makeModel(): FakeModel {
  const model = createFakeModel([]);
  models.push(model);
  return model;
}

async function run(
  tools: readonly HarnessTool[],
  name: string,
  args: Record<string, unknown>,
  ctx: HookContext,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool not found: ${name}`);
  const result = await tool.execute(args, ctx, new AbortController().signal);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function spawnIdOf(text: string): string {
  const match = /^ID: (pty_[0-9a-f]+)$/m.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(`pty_spawn 输出缺会话 ID：${text}`);
  }
  return match[1];
}

function track(tools: readonly HarnessTool[], ctx: HookContext, id: string): void {
  cleanups.push({ tools, ctx, id });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("serve 工具面 pty 接线", () => {
  it("缺省启用：五件套全部进面（键缺席 = enabled !== false）", async () => {
    const { ws, stateRoot } = makeWorkspace();
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: makeModel(),
      llmOptions: {},
    });

    const names = wiring.tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("pty_")).sort()).toEqual([...PTY_NAMES].sort());
    expect(names).toContain("bash");
    expect(names).toContain("task");
  }, 30_000);

  it("enabled:false：五件套全部缺席", async () => {
    const { ws, stateRoot } = makeWorkspace();
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: makeModel(),
      llmOptions: {},
      pty: { enabled: false },
    });

    const names = wiring.tools.map((t) => t.name);
    for (const name of PTY_NAMES) expect(names).not.toContain(name);
    expect(names).toContain("bash");
  }, 30_000);

  it("serve-pty 允许规则：pty_spawn 放行、未登记工具 default-deny（kind=permission）", async () => {
    const { ws, stateRoot } = makeWorkspace();
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: makeModel(),
      llmOptions: {},
    });

    await expect(
      wiring.executor.authorizeTool("pty_spawn", "echo hi", ws),
    ).resolves.toBe(ws);

    const denied: unknown = await wiring.executor
      .authorizeTool("not_allowed", "echo hi", ws)
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(denied).toBeInstanceOf(SeamDeniedError);
    if (!(denied instanceof SeamDeniedError)) throw new Error("expected SeamDeniedError");
    expect(denied.kind).toBe("permission");
  }, 30_000);

  it("sandbox cwd：workdir 越出 workspace → pty_spawn 拒绝且不落进程", async () => {
    const { ws, stateRoot } = makeWorkspace();
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: makeModel(),
      llmOptions: {},
    });
    const { ctx } = createTestContext({ sessionId: "owner-a" });

    await expect(
      run(
        wiring.tools,
        "pty_spawn",
        { command: "/bin/bash", args: ["-lc", "echo nope"], workdir: "/tmp", description: "cwd escape probe" },
        ctx,
      ),
    ).rejects.toThrow(/cwd escapes workspace/);

    const listed = await run(wiring.tools, "pty_list", {}, ctx);
    expect(listed).toContain("No active PTY sessions.");
    expect(listed).toContain("Total: 0 session(s)");
  }, 30_000);

  it("真退出回调：onPtyExit 收 <pty_exited>/Exit Code: 0，pty_read 见真实输出", async () => {
    const { ws, stateRoot } = makeWorkspace();
    const exited: ExitEvent[] = [];
    const waiters: Array<(event: ExitEvent) => void> = [];
    const onPtyExit = (owner: string, line: string): void => {
      const event: ExitEvent = { owner, line };
      const waiter = waiters.shift();
      if (waiter === undefined) exited.push(event);
      else waiter(event);
    };
    const nextExit = (): Promise<ExitEvent> => {
      const queued = exited.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<ExitEvent>((resolve) => waiters.push(resolve));
    };

    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: makeModel(),
      llmOptions: {},
      onPtyExit,
    });
    const { ctx } = createTestContext({ sessionId: "owner-a" });

    const spawned = await run(
      wiring.tools,
      "pty_spawn",
      {
        command: "/bin/bash",
        args: ["-lc", "sleep 0.15; echo PTY_EXIT_OK"],
        description: "exit callback e2e",
        notifyOnExit: true,
        timeoutSeconds: 10,
      },
      ctx,
    );
    const id = spawnIdOf(spawned);
    track(wiring.tools, ctx, id);

    const event = await withTimeout(nextExit(), 10_000, "pty exit notification");
    expect(event.owner).toBe("owner-a");
    expect(event.line).toContain("<pty_exited>");
    expect(event.line).toContain("Exit Code: 0");

    const read = await run(wiring.tools, "pty_read", { id }, ctx);
    expect(read).toContain("PTY_EXIT_OK");

    const killed = await run(wiring.tools, "pty_kill", { id, cleanup: true }, ctx);
    expect(killed).toContain("Cleaned up");
  }, 30_000);

  it("caps：maxSessionsPerLoomSession=1 → 第二次 spawn 被上限拒绝", async () => {
    const { ws, stateRoot } = makeWorkspace();
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: makeModel(),
      llmOptions: {},
      pty: { maxSessionsPerLoomSession: 1, maxSessionsTotal: 2 },
    });
    const { ctx } = createTestContext({ sessionId: "owner-a" });

    const first = await run(
      wiring.tools,
      "pty_spawn",
      {
        command: "/bin/bash",
        args: ["-lc", "sleep 5"],
        description: "cap one",
        notifyOnExit: false,
      },
      ctx,
    );
    const id = spawnIdOf(first);
    track(wiring.tools, ctx, id);

    await expect(
      run(
        wiring.tools,
        "pty_spawn",
        {
          command: "/bin/bash",
          args: ["-lc", "sleep 5"],
          description: "cap two",
          notifyOnExit: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/limit reached/);

    await run(wiring.tools, "pty_kill", { id, cleanup: true }, ctx);
  }, 30_000);
});
