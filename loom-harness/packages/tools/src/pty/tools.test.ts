/**
 * PTY 五工具验收：注入 fake spawnPty（不加载 node-pty），覆盖描述/元数据、
 * 归属隔离、env 净化、写转义、读分页/检索/ReDoS、超时提醒、列表与清理。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { HarnessTool } from "@axeuh/loom-core";
import { createTestContext } from "@axeuh/loom-core/testing";
import { createPtyTools } from "./index.js";
import type {
  PtyProcessHandle,
  PtyToolOptions,
  SpawnPtyFn,
} from "./types.js";

interface ExitEvent {
  exitCode: number;
  signal?: number | string;
}

interface FakeHandle extends PtyProcessHandle {
  readonly write: Mock<(data: string) => void>;
  readonly kill: Mock<(signal?: string) => void>;
  emitData(data: string): void;
  emitExit(event: ExitEvent): void;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Parameters<SpawnPtyFn>[2];
  handle: FakeHandle;
}

interface Setup {
  tools: HarnessTool[];
  spawnPty: Mock<SpawnPtyFn>;
  onExit: Mock<(ownerSessionId: string, line: string) => void>;
  validateSpawn: Mock<
    (command: string, args: readonly string[], workdir: string) => Promise<void>
  >;
  calls: SpawnCall[];
  handles: FakeHandle[];
  defaultWorkdir: string;
  lastHandle(): FakeHandle;
}

const workspaces: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeFake(pid: number): FakeHandle {
  let dataCb: ((data: string) => void) | undefined;
  let exitCb: ((event: ExitEvent) => void) | undefined;
  return {
    pid,
    write: vi.fn<(data: string) => void>(),
    kill: vi.fn<(signal?: string) => void>(),
    onData: (cb) => {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose() {} };
    },
    emitData: (data) => {
      dataCb?.(data);
    },
    emitExit: (event) => {
      exitCb?.(event);
    },
  };
}

async function setup(overrides: Partial<PtyToolOptions> = {}): Promise<Setup> {
  const created = await mkdtemp(path.join(tmpdir(), "pty-tools-"));
  const defaultWorkdir = overrides.defaultWorkdir ?? created;
  if (overrides.defaultWorkdir === undefined) workspaces.push(created);

  const calls: SpawnCall[] = [];
  const handles: FakeHandle[] = [];
  const spawnPty = vi.fn<SpawnPtyFn>((command, args, options) => {
    const handle = makeFake(4242 + calls.length);
    handles.push(handle);
    calls.push({ command, args, options, handle });
    return handle;
  });
  const onExit = vi.fn((_ownerSessionId: string, _line: string): void => {});
  const validateSpawn = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _workdir: string,
    ): Promise<void> => {},
  );

  const tools = createPtyTools({
    defaultWorkdir,
    workspaceRoot: defaultWorkdir,
    spawnPty,
    onExit,
    validateSpawn,
    ...overrides,
  });

  const lastHandle = (): FakeHandle => {
    const handle = handles[handles.length - 1];
    if (!handle) throw new Error("no fake handle was spawned");
    return handle;
  };

  return {
    tools,
    spawnPty,
    onExit,
    validateSpawn,
    calls,
    handles,
    defaultWorkdir,
    lastHandle,
  };
}

function findTool(setupResult: Setup, name: string): HarnessTool {
  const found = setupResult.tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

async function runTool(
  setupResult: Setup,
  name: string,
  args: Record<string, unknown>,
  sessionId = "owner-a",
): Promise<string> {
  const { ctx } = createTestContext({ sessionId });
  const result = await findTool(setupResult, name).execute(
    args,
    ctx,
    new AbortController().signal,
  );
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function extractId(text: string): string {
  const match = /ID: (pty_[0-9a-f]{8})/.exec(text);
  const id = match?.[1];
  if (id === undefined) throw new Error("spawn output did not contain a session id");
  return id;
}

describe("createPtyTools", () => {
  it("spawns with notifyOnExit default true and the exit-notification reminder", async () => {
    const s = await setup();

    const text = await runTool(s, "pty_spawn", {
      command: "bash",
      description: "interactive shell",
    });

    expect(text).toContain("<pty_spawned>");
    expect(text).toContain("NotifyOnExit: true");
    expect(text).toContain("<system_reminder>");
    expect(text).toContain("wait for <pty_exited>");
    expect(text).toContain("PID: 4242");
    expect(text).toContain(`Workdir: ${s.defaultWorkdir}`);
    expect(s.validateSpawn).toHaveBeenCalledWith("bash", [], s.defaultWorkdir);
    expect(s.spawnPty).toHaveBeenCalledTimes(1);
  });

  it("honours notifyOnExit:false without the reminder", async () => {
    const s = await setup();

    const text = await runTool(s, "pty_spawn", {
      command: "bash",
      description: "quiet shell",
      notifyOnExit: false,
    });

    expect(text).toContain("NotifyOnExit: false");
    expect(text).not.toContain("Completion signal for this session");
    expect(s.onExit).not.toHaveBeenCalled();
  });

  it("resolves a relative workdir against defaultWorkdir before validation", async () => {
    const s = await setup();

    await runTool(s, "pty_spawn", {
      command: "bash",
      description: "nested shell",
      workdir: "nested/dir",
    });

    expect(s.validateSpawn).toHaveBeenCalledWith(
      "bash",
      [],
      path.join(s.defaultWorkdir, "nested/dir"),
    );
    expect(s.calls[0]?.options.cwd).toBe(path.join(s.defaultWorkdir, "nested/dir"));
  });

  it("propagates a validateSpawn rejection without spawning", async () => {
    const validateSpawn = vi.fn(
      async (
        _command: string,
        _args: readonly string[],
        _workdir: string,
      ): Promise<void> => {
        throw new Error("command denied");
      },
    );
    const s = await setup({ validateSpawn });

    await expect(
      runTool(s, "pty_spawn", { command: "bash", description: "denied shell" }),
    ).rejects.toThrow("command denied");
    expect(s.spawnPty).not.toHaveBeenCalled();
  });

  it("scrubs credential-looking and service-prefixed env vars", async () => {
    const s = await setup();

    await runTool(s, "pty_spawn", {
      command: "bash",
      description: "env shell",
      env: { LOOM_TOKEN: "secret", FOO: "bar" },
    });

    const env = s.calls[0]?.options.env;
    expect(env?.["LOOM_TOKEN"]).toBeUndefined();
    expect(env?.["FOO"]).toBe("bar");
    expect(typeof env?.["PATH"]).toBe("string");
  });

  it("parses write escapes and reports bytes plus a rendered preview", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "writer" }),
    );

    const text = await runTool(s, "pty_write", { id, data: "echo hi\\n" });

    expect(s.lastHandle().write).toHaveBeenCalledWith("echo hi\n");
    expect(text).toContain('Sent 8 bytes to ');
    expect(text).toContain('"echo hi\\n"');
  });

  it("rejects a write to an exited session", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "dead writer" }),
    );
    s.lastHandle().emitExit({ exitCode: 0 });

    await expect(runTool(s, "pty_write", { id, data: "x" })).rejects.toThrow(
      "Cannot write",
    );
  });

  it("reads numbered lines and emits the pagination offset", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "reader" }),
    );
    s.lastHandle().emitData("alpha\nbeta\ngamma\n");

    const text = await runTool(s, "pty_read", { id, offset: 1, limit: 1 });

    expect(text).toContain(`<pty_output id="${id}" status="running">`);
    expect(text).toContain("00002| beta");
    expect(text).not.toContain("alpha");
    expect(text).toContain(
      "Buffer has more lines. Use offset=2 to read beyond line 2",
    );
    expect(text).toContain("</pty_output>");
  });

  it("filters by pattern while preserving original line numbers", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "searcher" }),
    );
    s.lastHandle().emitData("error one\nok\nerror two\nerror three\n");

    const text = await runTool(s, "pty_read", {
      id,
      pattern: "error",
      offset: 1,
      limit: 1,
    });

    expect(text).toContain("pattern=\"error\"");
    expect(text).toContain("00003| error two");
    expect(text).toContain("1 of 3 matches shown. Use offset=2 to see more.");

    const empty = await runTool(s, "pty_read", { id, pattern: "zzz" });
    expect(empty).toContain("No lines matched the pattern 'zzz'.");
  });

  it("rejects dangerous and invalid regex patterns", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "regex guard" }),
    );

    await expect(runTool(s, "pty_read", { id, pattern: "(.*)*" })).rejects.toThrow(
      /dangerous regex pattern rejected/i,
    );
    await expect(runTool(s, "pty_read", { id, pattern: "[" })).rejects.toThrow(
      /Invalid regex pattern/,
    );
    await expect(
      runTool(s, "pty_read", { id, pattern: "a".repeat(501) }),
    ).rejects.toThrow(/exceeds 500 characters/);
  });

  it("reminds a running notifyOnExit session not to poll", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "poll guard" }),
    );

    const text = await runTool(s, "pty_read", { id });

    expect(text).toContain("This session was started with notifyOnExit=true.");
    expect(text).toContain("wait for <pty_exited>");
  });

  it("appends the timeout reminder after a timed-out session exits", async () => {
    const s = await setup();
    vi.useFakeTimers();
    try {
      const id = extractId(
        await runTool(s, "pty_spawn", {
          command: "sleep",
          description: "slow command",
          timeoutSeconds: 1,
        }),
      );

      vi.advanceTimersByTime(1_000);
      expect(s.lastHandle().kill).toHaveBeenCalledTimes(1);

      s.lastHandle().emitExit({ exitCode: 143 });

      const text = await runTool(s, "pty_read", { id });
      expect(text).toContain('status="killed"');
      expect(text).toContain("timeoutSeconds=1");
      expect(text).toContain("auto-killed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists zero sessions, then all spawned sessions", async () => {
    const s = await setup();

    const empty = await runTool(s, "pty_list", {});
    expect(empty).toContain("No active PTY sessions.");
    expect(empty).toContain("Total: 0 session(s)");

    const firstId = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "first" }),
    );
    const secondId = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "second" }),
    );

    const text = await runTool(s, "pty_list", {});
    expect(text).toContain(`[${firstId}] first`);
    expect(text).toContain(`[${secondId}] second`);
    expect(text).toContain("Total: 2 session(s)");
    expect(text).toContain("Status: running");
    expect(text).toContain(`PID: ${s.handles[0]?.pid}`);
    expect(text).toContain(`PID: ${s.handles[1]?.pid}`);
    expect(text).toMatch(/Created: \d{4}-\d{2}-\d{2}T/);
  });

  it("kills with cleanup, reports status and throws for unknown ids", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "kill target" }),
    );
    s.lastHandle().emitData("one\ntwo\n");

    const killed = await runTool(s, "pty_kill", { id, cleanup: true });
    expect(killed).toContain("Killed: ");
    expect(killed).toContain("(session removed)");
    expect(killed).toContain("Final line count: 2");
    expect(killed).toContain("Status: killing");

    const list = await runTool(s, "pty_list", {});
    expect(list).toContain("Total: 0 session(s)");

    await expect(runTool(s, "pty_kill", { id })).rejects.toThrow(
      "PTY session not found",
    );
  });

  it("does not call an already-exited cleanup 'Killed'", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "already done" }),
    );
    s.lastHandle().emitExit({ exitCode: 0 });

    const text = await runTool(s, "pty_kill", { id });

    expect(text).toContain("Cleaned up: ");
    expect(text).toContain("(session retained for log access)");
    expect(text).toContain("Status: exited");
  });

  it("exposes the expected names and safety metadata", async () => {
    const s = await setup();

    expect(s.tools.map((tool) => tool.name)).toEqual([
      "pty_spawn",
      "pty_write",
      "pty_read",
      "pty_list",
      "pty_kill",
    ]);

    const read = findTool(s, "pty_read");
    const list = findTool(s, "pty_list");
    expect(read.isReadOnly).toBe(true);
    expect(read.isDestructive).toBe(false);
    expect(read.isOpenWorld).toBe(false);
    expect(list.isReadOnly).toBe(true);
    expect(list.isDestructive).toBe(false);
    expect(list.isOpenWorld).toBe(false);

    for (const name of ["pty_spawn", "pty_write", "pty_kill"]) {
      const tool = findTool(s, name);
      expect(tool.isReadOnly).toBe(false);
      expect(tool.isDestructive).toBe(true);
      expect(tool.isOpenWorld).toBe(true);
    }

    for (const tool of s.tools) {
      expect(tool.isConcurrencySafe?.({})).toBe(false);
    }
  });

  it("isolates sessions by HookContext owner sessionId", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(
        s,
        "pty_spawn",
        { command: "bash", description: "owned by a" },
        "owner-a",
      ),
    );

    await expect(runTool(s, "pty_read", { id }, "owner-b")).rejects.toThrow(
      /not found/,
    );
    await expect(runTool(s, "pty_write", { id, data: "x" }, "owner-b")).rejects.toThrow(
      /not found/,
    );
    await expect(runTool(s, "pty_kill", { id }, "owner-b")).rejects.toThrow(/not found/);
    expect(await runTool(s, "pty_list", {}, "owner-b")).toContain("Total: 0 session(s)");
  });

  it("reports a natural exit and keeps the final output readable", async () => {
    const s = await setup();
    const id = extractId(
      await runTool(s, "pty_spawn", { command: "bash", description: "natural exit" }),
    );
    s.lastHandle().emitData("done\n");
    s.lastHandle().emitExit({ exitCode: 0 });

    expect(s.onExit).toHaveBeenCalledTimes(1);
    expect(s.onExit.mock.calls[0]?.[0]).toBe("owner-a");
    expect(s.onExit.mock.calls[0]?.[1]).toContain("<pty_exited>");

    const text = await runTool(s, "pty_read", { id });
    expect(text).toContain(`status="exited"`);
    expect(text).toContain("00001| done");
    expect(text).toContain("End of buffer - total 1 lines");
  });
});
