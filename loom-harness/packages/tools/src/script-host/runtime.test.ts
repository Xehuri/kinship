import { describe, expect, it } from "vitest";

import { minimalEnv, resolveInterpreter } from "./runtime.js";

describe("resolveInterpreter - 语言中立解释器映射", () => {
  it("python 默认 python3（系统 3.12）", () => {
    expect(resolveInterpreter("python", undefined)).toEqual({ command: "python3", prefixArgs: [] });
  });

  it("ts 无覆盖 -> undefined（node20 无内置 TS runner，宿主拒绝挂载）", () => {
    expect(resolveInterpreter("ts", undefined)).toBeUndefined();
  });

  it("显式覆盖优先（如 tsx 跑 TS）", () => {
    expect(resolveInterpreter("ts", { command: "npx", prefixArgs: ["tsx"] })).toEqual({
      command: "npx",
      prefixArgs: ["tsx"],
    });
  });

  it("覆盖对任意语言生效", () => {
    expect(
      resolveInterpreter("python", { command: "/usr/bin/python3.12", prefixArgs: ["-B"] })?.command,
    ).toBe("/usr/bin/python3.12");
  });
});

describe("minimalEnv - 正向白名单环境", () => {
  it("不透传密钥类变量，保留 PATH/HOME，合并 extra", () => {
    process.env["LOOM_TEST_SECRET"] = "s";
    const env = minimalEnv({ CRASH_MARKER: "/tmp/x" });
    expect(env["LOOM_TEST_SECRET"]).toBeUndefined();
    expect(env["PATH"]).toBe(process.env["PATH"]);
    expect(env["CRASH_MARKER"]).toBe("/tmp/x");
    delete process.env["LOOM_TEST_SECRET"];
  });
});
