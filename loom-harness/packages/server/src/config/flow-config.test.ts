/**
 * L6 flow 配置段：缺省缺省关闭、enabled/retireConverge 解析、非法值 fail-fast。
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

describe("flow 配置段", () => {
  it("整段缺省 = undefined 不物化（旧配置逐字节）", () => {
    const cfg = parseLoomConfig(BASE, "<test>");
    expect(cfg.flow).toBeUndefined();
    expect("flow" in cfg).toBe(false);
  });

  it("空段 = 两键缺省 false（物化缺省）", () => {
    const cfg = parseLoomConfig(`${BASE}\nflow: {}\n`, "<test>");
    expect(cfg.flow).toEqual({ enabled: false, retireConverge: false });
  });

  it("enabled:true → 启用且默认不退役 converge", () => {
    const cfg = parseLoomConfig(`${BASE}\nflow:\n  enabled: true\n`, "<test>");
    expect(cfg.flow).toEqual({ enabled: true, retireConverge: false });
  });

  it("enabled:true + retireConverge:true 逐值解析", () => {
    const cfg = parseLoomConfig(
      `${BASE}\nflow:\n  enabled: true\n  retireConverge: true\n`,
      "<test>",
    );
    expect(cfg.flow).toEqual({ enabled: true, retireConverge: true });
  });

  it("limits 合法值逐键解析", () => {
    const cfg = parseLoomConfig(
      `${BASE}
flow:
  enabled: true
  limits:
    maxActive: 10
    maxWaiting: 8
    maxSubjects: 32
    maxNotesBytes: 16384
`,
      "<test>",
    );
    expect(cfg.flow).toEqual({
      enabled: true,
      retireConverge: false,
      limits: { maxActive: 10, maxWaiting: 8, maxSubjects: 32, maxNotesBytes: 16384 },
    });
  });

  it("limits 缺席 = 键不物化（既有两键对象逐字节）", () => {
    const cfg = parseLoomConfig(`${BASE}\nflow:\n  enabled: true\n`, "<test>");
    expect(cfg.flow).toEqual({ enabled: true, retireConverge: false });
    expect(cfg.flow === undefined || "limits" in cfg.flow).toBe(false);
  });

  it("limits 非法形状/值 fail-fast", () => {
    const shape = errorsOf(() =>
      parseLoomConfig(`${BASE}\nflow:\n  limits: "x"\n`, "<test>"),
    );
    expect(shape.some((e) => e.includes("flow.limits") && e.includes("需要映射"))).toBe(true);

    const zero = errorsOf(() =>
      parseLoomConfig(`${BASE}\nflow:\n  limits:\n    maxActive: 0\n`, "<test>"),
    );
    expect(
      zero.some((e) => e.includes("flow.limits.maxActive") && e.includes("需要 ≥1 的整数")),
    ).toBe(true);

    const str = errorsOf(() =>
      parseLoomConfig(`${BASE}\nflow:\n  limits:\n    maxNotesBytes: "16384"\n`, "<test>"),
    );
    expect(
      str.some((e) => e.includes("flow.limits.maxNotesBytes") && e.includes("需要 ≥1 的整数")),
    ).toBe(true);
  });

  it("非映射 / 非布尔 → schema 错误", () => {
    const shape = errorsOf(() => parseLoomConfig(`${BASE}\nflow: "x"\n`, "<test>"));
    expect(shape.some((e) => e.includes("flow") && e.includes("需要映射"))).toBe(true);

    for (const bad of ["\"yes\"", "1", "[true]"]) {
      const errs = errorsOf(() =>
        parseLoomConfig(`${BASE}\nflow:\n  enabled: ${bad}\n`, "<test>"),
      );
      expect(
        errs.some((e) => e.includes("flow.enabled") && e.includes("需要布尔值")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });
});
