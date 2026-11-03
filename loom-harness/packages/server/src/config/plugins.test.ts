/**
 * plugins 配置段（Feature Plugin P0 W2a）：enable 开关表的严格校验。
 */

import { describe, expect, it } from "vitest";

import { LoomConfigError, parseLoomConfig } from "./loom-config.js";

const BASE = `
server:
  port: 5097
  hostname: 127.0.0.1
workspace: /srv/loom/fixture-workspace
models:
  - id: m1
    provider: fake
    contextWindow: 1000
    maxOutput: 100
    timeout: 5000
pricing:
  fake:
    input: 0
    output: 0
`;

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof LoomConfigError) return [...error.errors];
    throw error;
  }
  return [];
}

describe("plugins 配置段", () => {
  it("合法开关表逐项解析并暴露 plugins", () => {
    const cfg = parseLoomConfig(
      `${BASE}
plugins:
  todo:
    enabled: true
  inbox:
    enabled: false
`,
      "<test>",
    );
    expect(cfg.plugins).toEqual({
      todo: { enabled: true },
      inbox: { enabled: false },
    });
  });

  it("整段缺省 = undefined 不物化", () => {
    const cfg = parseLoomConfig(BASE, "<test>");
    expect(cfg.plugins).toBeUndefined();
    expect("plugins" in cfg).toBe(false);
  });

  it("enabled:false 被接受（禁用条目）", () => {
    const cfg = parseLoomConfig(`${BASE}\nplugins:\n  plan:\n    enabled: false\n`, "<test>");
    expect(cfg.plugins).toEqual({ plan: { enabled: false } });
  });

  it("path 绝对路径被接受；trust 缺省不物化", () => {
    const cfg = parseLoomConfig(
      `${BASE}\nplugins:\n  ext:\n    path: /opt/loom/plugins/ext.mjs\n`,
      "<test>",
    );
    expect(cfg.plugins).toEqual({ ext: { path: "/opt/loom/plugins/ext.mjs" } });
  });

  it("path + trust trusted 被接受", () => {
    const cfg = parseLoomConfig(
      `${BASE}\nplugins:\n  ext:\n    path: /opt/loom/plugins/ext.mjs\n    trust: trusted\n`,
      "<test>",
    );
    expect(cfg.plugins).toEqual({
      ext: { path: "/opt/loom/plugins/ext.mjs", trust: "trusted" },
    });
  });

  it("path 相对路径 fail-fast", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\nplugins:\n  ext:\n    path: ./ext.mjs\n`, "<test>"),
    );
    expect(
      errs.some((e) => e.includes("plugins.ext.path") && e.includes("需要绝对路径")),
    ).toBe(true);
  });

  it("trust 缺少 path fail-fast", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\nplugins:\n  ext:\n    trust: trusted\n`, "<test>"),
    );
    expect(
      errs.some((e) => e.includes("plugins.ext.trust") && e.includes("需要同时声明 path")),
    ).toBe(true);
  });

  it("trust sandboxed 在 P2a fail-fast 且点名 P2b", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\nplugins:\n  ext:\n    path: /opt/loom/plugins/ext.mjs\n    trust: sandboxed\n`,
        "<test>",
      ),
    );
    expect(errs.some((e) => e.includes("plugins.ext.trust") && e.includes("P2b"))).toBe(true);
  });

  it("空映射 = 空开关表；空条目 = 空对象", () => {
    const empty = parseLoomConfig(`${BASE}\nplugins: {}\n`, "<test>");
    expect(empty.plugins).toEqual({});
    const entry = parseLoomConfig(`${BASE}\nplugins:\n  todo: {}\n`, "<test>");
    expect(entry.plugins).toEqual({ todo: {} });
  });

  it("非法插件 id fail-fast 并点名键", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\nplugins:\n  "Bad_ID":\n    enabled: true\n`, "<test>"),
    );
    expect(errs.some((e) => e.includes('plugins["Bad_ID"]') && e.includes("非法插件 id"))).toBe(
      true,
    );
  });

  it("条目非映射 fail-fast", () => {
    const errs = errorsOf(() => parseLoomConfig(`${BASE}\nplugins:\n  todo: true\n`, "<test>"));
    expect(errs.some((e) => e.includes("plugins.todo") && e.includes("需要映射"))).toBe(true);
  });

  it("条目未知键 fail-fast（仅允许 enabled/path/trust）", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\nplugins:\n  todo:\n    enabled: true\n    extra: 1\n`,
        "<test>",
      ),
    );
    expect(
      errs.some(
        (e) =>
          e.includes("plugins.todo.extra") &&
          e.includes("未知键") &&
          e.includes("enabled/path/trust"),
      ),
    ).toBe(true);
  });

  it("enabled 非布尔 fail-fast", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\nplugins:\n  todo:\n    enabled: "yes"\n`, "<test>"),
    );
    expect(
      errs.some((e) => e.includes("plugins.todo.enabled") && e.includes("需要布尔值")),
    ).toBe(true);
  });

  it("plugins 非映射 fail-fast", () => {
    const errs = errorsOf(() => parseLoomConfig(`${BASE}\nplugins: true\n`, "<test>"));
    expect(errs.some((e) => e.includes("plugins") && e.includes("需要映射"))).toBe(true);
  });
});
