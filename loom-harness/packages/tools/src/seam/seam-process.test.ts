/**
 * W4 seam-process 装配测试。
 * Given: bashSpawnPlan 纯函数（平台/ComSpec 参数化）+ makeProcessRunner（vi.mock spawn）
 * When:  显式 spec / 缺省分支 / 真起进程回声
 * Then:  spawn(program, [...args, command], {shell 不再传 true, detached 口径不变})；
 *        POSIX 缺省 = /bin/bash -c（有意升级，非 /bin/sh）；win32 缺省 = ComSpec ?? cmd.exe
 *        + ["/d","/s","/c"]；显式 spec 全量接管前缀（不自动补 -c）。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { bashSpawnPlan, makeProcessRunner, runProcess } from "./seam-process.js";

/** 仅实现 seam-process 实际消费的调用面（stdout/stderr/stdin/on/kill/pid）。 */
function fakeChild(): ChildProcessWithoutNullStreams & { emitClose(code: number): void } {
  const child = new PassThrough(); // 仅作 EventEmitter 宿主，close 事件手动 emit
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, {
    pid: 4242,
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    emitClose: (code: number): void => {
      child.emit("close", code);
    },
  });
  return child as unknown as ChildProcessWithoutNullStreams & { emitClose(code: number): void };
}

function runnerOptions() {
  const chunks: Buffer[] = [];
  return {
    chunks,
    options: {
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      timeoutSeconds: 10,
      signal: undefined,
      onData: (d: Buffer) => chunks.push(d),
    },
  };
}

describe("bashSpawnPlan（纯函数 argv 组装）", () => {
  it("显式 spec：program 直取，args 原样为前缀；args 缺省 = 空前缀（不自动补 -c）", () => {
    expect(
      bashSpawnPlan({ program: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--login", "-c"] }, "win32", undefined),
    ).toEqual({ program: "C:\\Program Files\\Git\\bin\\bash.exe", argvHead: ["--login", "-c"] });
    expect(bashSpawnPlan({ program: "/usr/local/bin/zsh" }, "linux", undefined)).toEqual({
      program: "/usr/local/bin/zsh",
      argvHead: [],
    });
  });

  it("缺省分支：win32 = ComSpec ?? cmd.exe + [/d,/s,/c]（shell:true 旧语义逐字保持）", () => {
    expect(bashSpawnPlan(undefined, "win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      program: "C:\\Windows\\System32\\cmd.exe",
      argvHead: ["/d", "/s", "/c"],
    });
    expect(bashSpawnPlan(undefined, "win32", undefined)).toEqual({
      program: "cmd.exe",
      argvHead: ["/d", "/s", "/c"],
    });
  });

  it("缺省分支：POSIX = /bin/bash -c（有意升级：不再隐式 /bin/sh）", () => {
    expect(bashSpawnPlan(undefined, "linux", undefined)).toEqual({
      program: "/bin/bash",
      argvHead: ["-c"],
    });
    expect(bashSpawnPlan(undefined, "darwin", "irrelevant")).toEqual({
      program: "/bin/bash",
      argvHead: ["-c"],
    });
  });
});

describe("makeProcessRunner：spawn 实参拼装（mock 断言）", () => {
  it("显式 spec → spawn(program, [...args, command], 选项无 shell、detached 平台口径不变)", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const runner = makeProcessRunner({ program: "/usr/bin/mybash", args: ["--login", "-c"] });
    const { options } = runnerOptions();

    const done = runner("echo hi", "/work", options);
    const [program, argv, opts] = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(program).toBe("/usr/bin/mybash");
    expect(argv).toEqual(["--login", "-c", "echo hi"]);
    const spawnOpts = opts as Record<string, unknown>;
    expect("shell" in spawnOpts).toBe(false); // 不再 shell:true（避免双层解释）
    expect(spawnOpts["detached"]).toBe(process.platform !== "win32");
    expect(spawnOpts["cwd"]).toBe("/work");
    expect(spawnOpts["stdio"]).toEqual(["ignore", "pipe", "pipe"]);
    child.emitClose(0);
    await expect(done).resolves.toMatchObject({ exitCode: 0 });
  });

  it("缺省 spec → 当前平台默认程序在位（POSIX=/bin/bash；darwin 同分支）", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const runner = makeProcessRunner();
    const { options } = runnerOptions();
    const done = runner("printf ok", "/work", options);
    const [program, argv] = vi.mocked(spawn).mock.calls.at(-1)!;
    if (process.platform === "win32") {
      expect(argv!.at(-1)).toBe("printf ok");
    } else {
      expect(program).toBe("/bin/bash");
      expect(argv).toEqual(["-c", "printf ok"]);
    }
    child.emitClose(0);
    await expect(done).resolves.toMatchObject({ exitCode: 0 });
  });

  it("runProcess 兼容签名保留（= 缺省 runner 通路：argv 尾元素恒为 command）", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const { options } = runnerOptions();
    const done = runProcess("true", "/work", options);
    const [program, argv] = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(argv!.at(-1)).toBe("true");
    expect(program).toBe(bashSpawnPlan(undefined, process.platform, process.env.ComSpec).program);
    child.emitClose(0);
    await expect(done).resolves.toMatchObject({ exitCode: 0 });
  });
});
