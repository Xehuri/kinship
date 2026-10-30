/**
 * scrubPtyEnv：base 过滤（safeShellEnv 同款密钥正则 + 服务前缀）、extra 约束、
 * 不可变性，以及前缀大小写敏感 vs 正则大小写不敏感的刻意行为。
 */
import { describe, expect, it } from "vitest";
import { scrubPtyEnv } from "./env-guard.js";

describe("scrubPtyEnv", () => {
  it("strips LOOM_/AXEUH_/OPENCODE_/MI_/MOP_ prefixed keys", () => {
    const env = scrubPtyEnv(undefined, {
      PATH: "/usr/bin",
      LOOM_TOKEN: "loom-token",
      LOOM_KEY_X: "loom-key",
      LOOM_HOST: "loom-host",
      AXEUH_KERNEL_TOKEN: "kernel-token",
      OPENCODE_X: "opencode-x",
      MI_FOO: "mi-foo",
      MOP_FOO: "mop-foo",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps ordinary PATH/HOME/LANG variables", () => {
    const env = scrubPtyEnv(undefined, {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
    });
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
    });
  });

  it("lets extra override base values", () => {
    const env = scrubPtyEnv({ PATH: "/extra/bin", TERM: "xterm-256color" }, {
      PATH: "/base/bin",
      HOME: "/home/tester",
    });
    expect(env.PATH).toBe("/extra/bin");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.HOME).toBe("/home/tester");
  });

  it("rejects blocked keys from extra (prefix and secret regex)", () => {
    const env = scrubPtyEnv({ LOOM_TOKEN: "x", MY_SECRET: "y", SAFE_FLAG: "1" }, {
      PATH: "/base/bin",
    });
    expect(env).toEqual({ PATH: "/base/bin", SAFE_FLAG: "1" });
  });

  it("does not mutate the base object and returns a fresh object", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/base/bin",
      LOOM_TOKEN: "secret",
      HOME: "/home/tester",
    };
    const snapshot = { ...base };
    const env = scrubPtyEnv(undefined, base);
    expect(base).toEqual(snapshot);
    expect(env).not.toBe(base);
    expect(env).toEqual({ PATH: "/base/bin", HOME: "/home/tester" });
  });

  it("handles empty extra", () => {
    const env = scrubPtyEnv({}, { PATH: "/base/bin", LOOM_TOKEN: "secret" });
    expect(env).toEqual({ PATH: "/base/bin" });
  });

  it("lowercase loom_token is stripped by the case-insensitive regex, not the prefix", () => {
    const env = scrubPtyEnv(undefined, {
      PATH: "/base/bin",
      loom_token: "secret",
      loom_host: "kept",
    });
    // 前缀大小写敏感（loom_host 保留）；密钥正则大小写不敏感（loom_token 因 TOKEN 被剥离）。
    expect(env).toEqual({ PATH: "/base/bin", loom_host: "kept" });
  });
});
