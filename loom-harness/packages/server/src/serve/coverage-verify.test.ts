/**
 * T09 覆盖校验绑定验收：
 * - 假 spawn 只发 close/error/data，不真起 python、不读 ai/data；
 * - 钉住退出码映射（0/1/2/其他）、超时 kill、ENOENT、同步抛错与非法日期；
 * - 钉住 T07 `PlanCoverageVerifier.verify(input)` 的类型兼容与日期直调面。
 */

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EffectivePlanEntry } from "../plan/plan-overlay.js";
import type { PlanCoverageVerifier } from "./plan-overlay-tool.js";
import {
  createCoverageVerifier,
  DEFAULT_COVERAGE_TIMEOUT_MS,
  type CoverageChildProcess,
  type CoverageEventStream,
  type CoverageSpawn,
  type CoverageVerifierOptions,
} from "./coverage-verify.js";

const DATE = "2026-10-28";
const PYTHON = "/opt/kinship/.venv-health/bin/python";
const SCRIPT = "/opt/kinship/ai/analysis/check_coverage.py";

class FakeStream extends EventEmitter implements CoverageEventStream {}

class FakeChild extends EventEmitter implements CoverageChildProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

interface SpawnScript {
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
  readonly hang?: boolean;
}

interface SpawnHarness {
  readonly spawn: CoverageSpawn;
  readonly calls: SpawnCall[];
  readonly children: FakeChild[];
}

function fakeSpawn(script: SpawnScript = {}): SpawnHarness {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: CoverageSpawn = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    if (script.error !== undefined) {
      const error = script.error;
      queueMicrotask(() => child.emit("error", error));
    } else if (script.hang !== true) {
      queueMicrotask(() => {
        if (script.stdout !== undefined) child.stdout.emit("data", script.stdout);
        if (script.stderr !== undefined) child.stderr.emit("data", script.stderr);
        child.emit(
          "close",
          script.exitCode === undefined ? 0 : script.exitCode,
          script.signal ?? null,
        );
      });
    }
    return child;
  };
  return { spawn, calls, children };
}

function verifierFor(
  harness: SpawnHarness,
  overrides: Partial<CoverageVerifierOptions> = {},
): ReturnType<typeof createCoverageVerifier> {
  return createCoverageVerifier({
    pythonBin: PYTHON,
    scriptPath: SCRIPT,
    spawn: harness.spawn,
    ...overrides,
  });
}

const ENTRY: EffectivePlanEntry = {
  id: "cov-12",
  kind: "coverage",
  at_override: false,
  status: "planned",
  source: "master",
  suppressed: false,
  master_version: 1,
  overlay_version: 0,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createCoverageVerifier", () => {
  it("exit 0 -> pass, ok true, last stdout line as summary", async () => {
    const h = fakeSpawn({
      exitCode: 0,
      stdout: "[check_coverage] 2026-10-28\n状态: 通过\n缺口: 0s -> 通过",
    });
    const verifier = verifierFor(h);

    const result = await verifier.check(DATE);

    expect(result).toEqual({
      ok: true,
      status: "pass",
      exitCode: 0,
      summary: "缺口: 0s -> 通过",
    });
    expect(h.calls).toEqual([{ command: PYTHON, args: [SCRIPT, DATE] }]);
  });

  it("exit 1 -> gap, ok false", async () => {
    const h = fakeSpawn({
      exitCode: 1,
      stdout: "原始数据最晚: 23:40:00\n原因: 未覆盖时段 22:00~23:40",
    });

    const result = await verifierFor(h).check(DATE);

    expect(result).toEqual({
      ok: false,
      status: "gap",
      exitCode: 1,
      summary: "原因: 未覆盖时段 22:00~23:40",
    });
  });

  it("exit 2 -> no_data, ok false", async () => {
    const h = fakeSpawn({
      exitCode: 2,
      stdout: "状态: 数据不完整\n原因: 原始数据不足",
    });

    const result = await verifierFor(h).check(DATE);

    expect(result).toEqual({
      ok: false,
      status: "no_data",
      exitCode: 2,
      summary: "原因: 原始数据不足",
    });
  });

  it("unexpected exit -> error with generated summary", async () => {
    const h = fakeSpawn({ exitCode: 7 });

    const result = await verifierFor(h).check(DATE);

    expect(result).toEqual({
      ok: false,
      status: "error",
      exitCode: 7,
      summary: "check_coverage error (exit 7)",
    });
  });

  it("closes without an exit code -> error, signal in summary", async () => {
    const h = fakeSpawn({ exitCode: null, signal: "SIGTERM" });

    const result = await verifierFor(h).check(DATE);

    expect(result).toEqual({
      ok: false,
      status: "error",
      exitCode: null,
      summary: "check_coverage terminated by SIGTERM",
    });
  });

  it("falls back to stderr when stdout is empty", async () => {
    const h = fakeSpawn({ exitCode: 2, stderr: "perception.jsonl 不存在" });

    const result = await verifierFor(h).check(DATE);

    expect(result.status).toBe("no_data");
    expect(result.summary).toBe("perception.jsonl 不存在");
  });

  it("timeout kills the child and reports error", async () => {
    vi.useFakeTimers();
    const h = fakeSpawn({ hang: true });
    const pending = verifierFor(h, { timeoutMs: 1_234 }).check(DATE);

    await vi.advanceTimersByTimeAsync(1_234);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      status: "error",
      exitCode: null,
      summary: "check_coverage timeout after 1234ms",
    });
    expect(h.children[0]?.signals).toEqual(["SIGKILL"]);
  });

  it("applies the 30s default timeout", async () => {
    vi.useFakeTimers();
    const h = fakeSpawn({ hang: true });
    const pending = verifierFor(h).check(DATE);

    await vi.advanceTimersByTimeAsync(DEFAULT_COVERAGE_TIMEOUT_MS);
    const result = await pending;

    expect(result.status).toBe("error");
    expect(result.summary).toContain(`${DEFAULT_COVERAGE_TIMEOUT_MS}ms`);
  });

  it("ENOENT on the error event -> error, never throws", async () => {
    const h = fakeSpawn({
      error: new Error(`spawn ${PYTHON} ENOENT`),
    });

    const result = await verifierFor(h).check(DATE);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("error");
    expect(result.exitCode).toBeNull();
    expect(result.summary).toContain("ENOENT");
  });

  it("synchronous spawn throw -> error, never throws", async () => {
    const spawn: CoverageSpawn = () => {
      throw new Error("spawn exploded");
    };

    const result = await createCoverageVerifier({
      pythonBin: PYTHON,
      scriptPath: SCRIPT,
      spawn,
    }).check(DATE);

    expect(result).toEqual({
      ok: false,
      status: "error",
      exitCode: null,
      summary: "check_coverage spawn error: spawn exploded",
    });
  });

  it("rejects a malformed date before spawning", async () => {
    const h = fakeSpawn({ exitCode: 0 });

    const result = await verifierFor(h).check("2026/10/28");

    expect(result.status).toBe("error");
    expect(result.summary).toContain("非法日期");
    expect(h.calls).toEqual([]);
  });

  it("verify(input) matches T07 shape and checks input.date", async () => {
    const h = fakeSpawn({ exitCode: 0, stdout: "状态: 通过" });
    const verifier = verifierFor(h);
    const asT07: PlanCoverageVerifier = verifier;

    const result = await asT07.verify({
      date: DATE,
      id: "cov-12",
      status: "done",
      entry: ENTRY,
    });

    expect(result).toMatchObject({ ok: true, status: "pass", exitCode: 0 });
    expect(h.calls).toEqual([{ command: PYTHON, args: [SCRIPT, DATE] }]);
  });
});
