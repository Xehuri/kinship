/**
 * PtyManager 验收：注入 fake spawnPty，验证生命周期、容量、所有权与通知。
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { PtyManager } from "./pty-manager.js";
import type {
  PtyManagerOptions,
  PtyProcessHandle,
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

function makeFake(): FakeHandle {
  let dataCb: ((data: string) => void) | undefined;
  let exitCb: ((event: ExitEvent) => void) | undefined;
  return {
    pid: 4242,
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

function createManager(overrides: PtyManagerOptions = {}) {
  const fakes: FakeHandle[] = [];
  const spawnPty = vi.fn(
    (
      _command: string,
      _args: string[],
      _options: Parameters<SpawnPtyFn>[2],
    ): PtyProcessHandle => {
      const handle = makeFake();
      fakes.push(handle);
      return handle;
    },
  );
  const onExit = vi.fn((_ownerSessionId: string, _line: string) => {});
  const log = vi.fn(
    (
      _level: "debug" | "info" | "warn" | "error",
      _message: string,
      _fields: Record<string, unknown>,
    ) => {},
  );
  const manager = new PtyManager({
    spawnPty,
    onExit,
    log,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  const lastFake = (): FakeHandle => {
    const handle = fakes[fakes.length - 1];
    if (!handle) throw new Error("no fake handle was spawned");
    return handle;
  };
  return { manager, spawnPty, onExit, log, fakes, lastFake };
}

describe("PtyManager", () => {
  it("spawns a running session with a generated id, pid and defaults", () => {
    const { manager } = createManager();

    const info = manager.spawn("owner-1", {
      command: "bash",
      description: "dev shell",
    });

    expect(info.id).toMatch(/^pty_[0-9a-f]{8}$/);
    expect(info.status).toBe("running");
    expect(info.pid).toBe(4242);
    expect(info.title).toBe("dev shell");
    expect(info.args).toEqual([]);
    expect(info.lineCount).toBe(0);
  });

  it("forwards onData into the ring buffer and reads complete lines", () => {
    const { manager, lastFake } = createManager();
    const info = manager.spawn("owner-1", { command: "bash", description: "d" });

    lastFake().emitData("hello\nworld\n");

    const result = manager.read(info.id, "owner-1");
    expect(result.lines).toEqual(["hello", "world"]);
    expect(result.totalLines).toBe(2);
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("notifies exactly once on natural exit with exit code and last line", () => {
    const { manager, onExit, lastFake } = createManager();
    const info = manager.spawn("owner-1", {
      command: "bash",
      description: "d",
      notifyOnExit: true,
    });

    lastFake().emitData("done\n");
    lastFake().emitExit({ exitCode: 0 });

    const exiting = manager.get(info.id, "owner-1");
    expect(exiting?.status).toBe("exited");
    expect(exiting?.exitCode).toBe(0);
    expect(onExit).toHaveBeenCalledTimes(1);

    const call = onExit.mock.calls[0];
    expect(call?.[0]).toBe("owner-1");
    expect(call?.[1]).toContain("<pty_exited>");
    expect(call?.[1]).toContain("Exit Code: 0");
    expect(call?.[1]).toContain("Last Line: done");
  });

  it("latches notifications so a duplicate exit event does not double-notify", () => {
    const { manager, onExit, lastFake } = createManager();
    manager.spawn("owner-1", {
      command: "bash",
      description: "d",
      notifyOnExit: true,
    });

    lastFake().emitExit({ exitCode: 0 });
    lastFake().emitExit({ exitCode: 7 });

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("does not notify when notifyOnExit is false", () => {
    const { manager, onExit, lastFake } = createManager();
    manager.spawn("owner-1", { command: "bash", description: "d" });

    lastFake().emitExit({ exitCode: 0 });

    expect(onExit).not.toHaveBeenCalled();
  });

  it("contains a throwing notifier: exit still completes and warn is logged", () => {
    const { manager, log, lastFake } = createManager({
      onExit: () => {
        throw new Error("notifier boom");
      },
    });
    const info = manager.spawn("owner-1", {
      command: "bash",
      description: "d",
      notifyOnExit: true,
    });

    expect(() => lastFake().emitExit({ exitCode: 1 })).not.toThrow();

    expect(manager.get(info.id, "owner-1")?.status).toBe("exited");
    expect(log.mock.calls[0]?.[0]).toBe("warn");
    expect(log.mock.calls[0]?.[2]).toMatchObject({ id: info.id });
  });

  it("kill marks a running session as killing, then exit resolves it to killed", () => {
    const { manager, lastFake } = createManager();
    const info = manager.spawn("owner-1", { command: "bash", description: "d" });

    const snapshot = manager.kill(info.id, "owner-1");

    expect(snapshot.status).toBe("killing");
    expect(lastFake().kill).toHaveBeenCalledTimes(1);

    lastFake().emitExit({ exitCode: 143, signal: "SIGTERM" });

    const exiting = manager.get(info.id, "owner-1");
    expect(exiting?.status).toBe("killed");
    expect(exiting?.exitSignal).toBe("SIGTERM");
  });

  it("cleanup=true clears and drops the session while cleanup=false retains it", () => {
    const { manager, lastFake } = createManager();
    const dropped = manager.spawn("owner-1", { command: "bash", description: "a" });
    lastFake().emitData("one\ntwo\n");

    const snapshot = manager.kill(dropped.id, "owner-1", true);
    expect(snapshot.lineCount).toBe(2);
    expect(manager.get(dropped.id, "owner-1")).toBeUndefined();
    expect(() => manager.read(dropped.id, "owner-1")).toThrow(
      `PTY session not found: ${dropped.id}`,
    );

    const retained = manager.spawn("owner-1", { command: "bash", description: "b" });
    lastFake().emitData("still here\n");
    manager.kill(retained.id, "owner-1");

    expect(manager.get(retained.id, "owner-1")?.status).toBe("killing");
    expect(manager.read(retained.id, "owner-1").lines).toEqual(["still here"]);
  });

  it("times out a running session, marks timedOut and notifies with Timed Out: yes", () => {
    vi.useFakeTimers();
    try {
      const { manager, onExit, lastFake } = createManager();
      const info = manager.spawn("owner-1", {
        command: "sleep",
        description: "slow",
        timeoutSeconds: 2,
        notifyOnExit: true,
      });

      vi.advanceTimersByTime(1_999);
      expect(lastFake().kill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(lastFake().kill).toHaveBeenCalledTimes(1);
      expect(manager.get(info.id, "owner-1")?.timedOut).toBe(true);
      expect(manager.get(info.id, "owner-1")?.status).toBe("killing");

      lastFake().emitExit({ exitCode: 143 });

      expect(manager.get(info.id, "owner-1")?.status).toBe("killed");
      expect(onExit.mock.calls[0]?.[1]).toContain("Timed Out: yes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when the process exits early", () => {
    vi.useFakeTimers();
    try {
      const { manager, lastFake } = createManager();
      manager.spawn("owner-1", {
        command: "bash",
        description: "d",
        timeoutSeconds: 5,
      });

      lastFake().emitExit({ exitCode: 0 });
      vi.advanceTimersByTime(5_000);

      expect(lastFake().kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-positive and fractional timeoutSeconds before spawning", () => {
    const { manager, spawnPty } = createManager();

    for (const timeoutSeconds of [0, -1, 1.5]) {
      expect(() =>
        manager.spawn("owner-1", {
          command: "bash",
          description: "d",
          timeoutSeconds,
        }),
      ).toThrow(/positive integer/);
    }
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("enforces the per-session cap, then prunes a terminal session to make room", () => {
    const { manager, lastFake } = createManager({
      caps: { maxSessionsPerLoomSession: 1 },
    });
    manager.spawn("owner-1", { command: "bash", description: "one" });

    expect(() =>
      manager.spawn("owner-1", { command: "bash", description: "two" }),
    ).toThrow(/1\/1 per Loom session/);
    expect(() =>
      manager.spawn("owner-1", { command: "bash", description: "two" }),
    ).toThrow(/1\/64 total/);

    lastFake().emitExit({ exitCode: 0 });

    const third = manager.spawn("owner-1", { command: "bash", description: "three" });
    expect(third.status).toBe("running");
    expect(manager.list("owner-1").map((s) => s.id)).toEqual([third.id]);
  });

  it("enforces the global live cap across owners with explicit counts", () => {
    const { manager } = createManager({ caps: { maxSessionsTotal: 1 } });
    manager.spawn("owner-a", { command: "bash", description: "a" });

    expect(() =>
      manager.spawn("owner-b", { command: "bash", description: "b" }),
    ).toThrow(/1\/1 total/);
  });

  it("treats another owner's session as not found for read/write/kill", () => {
    const { manager } = createManager();
    const own = manager.spawn("owner-a", { command: "bash", description: "a" });
    const foreign = manager.spawn("owner-b", { command: "bash", description: "b" });

    expect(manager.get(foreign.id, "owner-a")).toBeUndefined();
    expect(() => manager.read(foreign.id, "owner-a")).toThrow(
      `PTY session not found: ${foreign.id}`,
    );
    expect(() => manager.write(foreign.id, "owner-a", "x")).toThrow(
      `PTY session not found: ${foreign.id}`,
    );
    expect(() => manager.kill(foreign.id, "owner-a")).toThrow(
      `PTY session not found: ${foreign.id}`,
    );

    expect(manager.list("owner-a").map((s) => s.id)).toEqual([own.id]);
    expect(manager.list("owner-b").map((s) => s.id)).toEqual([foreign.id]);
  });

  it("disposeAll kills running handles, empties the map and suppresses notifications", () => {
    const { manager, onExit, lastFake } = createManager();
    manager.spawn("owner-1", {
      command: "bash",
      description: "d",
      notifyOnExit: true,
    });
    const fake = lastFake();

    manager.disposeAll();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(manager.list("owner-1")).toEqual([]);

    fake.emitExit({ exitCode: 0 });
    expect(onExit).not.toHaveBeenCalled();
  });

  it("write forwards while running and rejects a terminal session", () => {
    const { manager, lastFake } = createManager();
    const info = manager.spawn("owner-1", { command: "bash", description: "d" });

    manager.write(info.id, "owner-1", "ls\n");
    expect(lastFake().write).toHaveBeenCalledWith("ls\n");

    manager.kill(info.id, "owner-1");
    lastFake().emitExit({ exitCode: 0 });

    expect(() => manager.write(info.id, "owner-1", "x")).toThrow(
      /session status is 'killed'/,
    );
  });

  it("search paginates matches and propagates invalid regex errors", () => {
    const { manager, lastFake } = createManager();
    const info = manager.spawn("owner-1", { command: "bash", description: "d" });
    lastFake().emitData("error one\nok\nerror two\nerror three\n");

    const page = manager.search(info.id, "owner-1", "error", 1, 1);
    expect(page.matches).toEqual([{ lineNumber: 3, text: "error two" }]);
    expect(page.totalMatches).toBe(3);
    expect(page.offset).toBe(1);
    expect(page.hasMore).toBe(true);

    const insensitive = manager.search(info.id, "owner-1", "ERROR", 0, 10, true);
    expect(insensitive.totalMatches).toBe(3);

    expect(() => manager.search(info.id, "owner-1", "[")).toThrow(SyntaxError);
  });

  it("does not register a session when spawnPty throws", () => {
    const { manager, spawnPty } = createManager();
    spawnPty.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    expect(() =>
      manager.spawn("owner-1", { command: "bash", description: "d" }),
    ).toThrow("spawn failed");
    expect(manager.list("owner-1")).toEqual([]);
  });
});
