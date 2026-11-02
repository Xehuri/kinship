/**
 * inbox 配置段：缺省不物化、全键解析、枚举/整数/时区/source 键校验、未知键容忍。
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

describe("inbox 配置段", () => {
  it("整段缺省 = undefined 不物化", () => {
    const cfg = parseLoomConfig(BASE, "<test>");
    expect(cfg.inbox).toBeUndefined();
    expect("inbox" in cfg).toBe(false);
  });

  it("空段 = 空对象（所有键保持缺席）", () => {
    const cfg = parseLoomConfig(`${BASE}\ninbox: {}\n`, "<test>");
    expect(cfg.inbox).toEqual({});
  });

  it("全键合法 = 逐值解析", () => {
    const yaml = `${BASE}
inbox:
  mode: shadow
  sessionId: main_session
  sources:
    qq:
      maxTrust: external
      maxClass: notify
      ratePerMinute: 30
      burst: 5
      cooldownMs: 1000
      requireDedupeKey: true
      tokenEnv: LOOM_INBOX_QQ_TOKEN
    backend.tasks:
      maxTrust: trusted_service
      maxClass: interrupt
      burst: 10
  limits:
    maxBodyBytes: 8192
    maxPending: 100
    maxLettersPerMinute: 60
  digest:
    cadenceMs: 600000
    maxAgeMs: 3600000
    maxBatch: 10
    leaseMs: 30000
  classes:
    weights:
      interrupt: 3
      notify: 2
      digest: 1
  accumulate:
    notifyBurst: 4
    windowMs: 120000
  quietHours:
    enabled: true
    start: "22:30"
    end: "07:15"
    timezone: Asia/Shanghai
    downgradeExternalInterruptTo: digest
  redelivery:
    maxAttempts: 2
    backoffMs: 5000
  ackGraceTurns: 3
  autoAckKinds:
    - system_note
    - health_tick
  dedupeTtlMs: 1000
  coalesceWindowMs: 2000
  echo:
    maxCausationDepth: 4
    blockedSources:
      - qq
  planMirror: false
  metricsIntervalMs: 1000
`;
    const cfg = parseLoomConfig(yaml, "<test>");
    expect(cfg.inbox).toEqual({
      mode: "shadow",
      sessionId: "main_session",
      sources: {
        qq: {
          maxTrust: "external",
          maxClass: "notify",
          ratePerMinute: 30,
          burst: 5,
          cooldownMs: 1000,
          requireDedupeKey: true,
          tokenEnv: "LOOM_INBOX_QQ_TOKEN",
        },
        "backend.tasks": {
          maxTrust: "trusted_service",
          maxClass: "interrupt",
          burst: 10,
        },
      },
      limits: { maxBodyBytes: 8192, maxPending: 100, maxLettersPerMinute: 60 },
      digest: { cadenceMs: 600000, maxAgeMs: 3600000, maxBatch: 10, leaseMs: 30000 },
      classes: { weights: { interrupt: 3, notify: 2, digest: 1 } },
      accumulate: { notifyBurst: 4, windowMs: 120000 },
      quietHours: {
        enabled: true,
        start: "22:30",
        end: "07:15",
        timezone: "Asia/Shanghai",
        downgradeExternalInterruptTo: "digest",
      },
      redelivery: { maxAttempts: 2, backoffMs: 5000 },
      ackGraceTurns: 3,
      autoAckKinds: ["system_note", "health_tick"],
      dedupeTtlMs: 1000,
      coalesceWindowMs: 2000,
      echo: { maxCausationDepth: 4, blockedSources: ["qq"] },
      planMirror: false,
      metricsIntervalMs: 1000,
    });
  });

  it("mode 枚举非法值 → 精确错误点名 inbox.mode", () => {
    const errs = errorsOf(() => parseLoomConfig(`${BASE}\ninbox:\n  mode: pause\n`, "<test>"));
    expect(errs.some((e) => e.includes("inbox.mode") && e.includes('"off"'))).toBe(true);
  });

  it("source 键必须匹配 [a-z0-9_.-]{1,64}", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\ninbox:\n  sources:\n    BadKey: {}\n`, "<test>"),
    );
    expect(errs.some((e) => e.includes('inbox.sources["BadKey"]'))).toBe(true);
  });

  it("maxTrust=external 与 maxClass=interrupt 冲突 → fail-fast", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\ninbox:\n  sources:\n    qq:\n      maxTrust: external\n      maxClass: interrupt\n`,
        "<test>",
      ),
    );
    expect(errs.some((e) => e.includes("inbox.sources.qq.maxClass") && e.includes("冲突"))).toBe(true);
  });

  it("quietHours.enabled=true 时 timezone 必填", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\ninbox:\n  quietHours:\n    enabled: true\n`, "<test>"),
    );
    expect(errs.some((e) => e.includes("inbox.quietHours.timezone"))).toBe(true);
  });

  it("HH:MM 与 IANA 时区校验", () => {
    const badStart = errorsOf(() =>
      parseLoomConfig(`${BASE}\ninbox:\n  quietHours:\n    start: "25:00"\n`, "<test>"),
    );
    expect(badStart.some((e) => e.includes("inbox.quietHours.start"))).toBe(true);
    const badTz = errorsOf(() =>
      parseLoomConfig(`${BASE}\ninbox:\n  quietHours:\n    timezone: Mars/Base\n`, "<test>"),
    );
    expect(badTz.some((e) => e.includes("inbox.quietHours.timezone"))).toBe(true);
  });

  it("class 权重倒挂 → fail-fast", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\ninbox:\n  classes:\n    weights:\n      interrupt: 1\n      notify: 2\n`,
        "<test>",
      ),
    );
    expect(errs.some((e) => e.includes("inbox.classes.weights.interrupt"))).toBe(true);
  });

  it("正整数/非负整数边界", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\ninbox:\n  limits:\n    maxBodyBytes: 0\n  metricsIntervalMs: 0\n`,
        "<test>",
      ),
    );
    expect(errs.some((e) => e.includes("inbox.limits.maxBodyBytes"))).toBe(true);
    expect(errs.some((e) => e.includes("inbox.metricsIntervalMs"))).toBe(true);
  });

  it("autoAckKinds 重复与 echo.blockedSources 非法键", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\ninbox:\n  autoAckKinds: [a, a]\n  echo:\n    blockedSources: [Bad]\n`,
        "<test>",
      ),
    );
    expect(errs.some((e) => e.includes("inbox.autoAckKinds[1]"))).toBe(true);
    expect(errs.some((e) => e.includes("inbox.echo.blockedSources[0]"))).toBe(true);
  });

  it("tokenEnv 必须是合法环境变量名", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\ninbox:\n  sources:\n    qq:\n      tokenEnv: "not a name"\n`,
        "<test>",
      ),
    );
    expect(errs.some((e) => e.includes("inbox.sources.qq.tokenEnv"))).toBe(true);
  });

  it("未知键静默容忍（只物化已知键）", () => {
    const yaml = `${BASE}
inbox:
  mode: live
  futureKnob: 42
  sources:
    qq:
      maxClass: notify
      futureSourceKnob: true
  nested:
    x: 1
`;
    const cfg = parseLoomConfig(yaml, "<test>");
    expect(cfg.inbox).toEqual({
      mode: "live",
      sources: { qq: { maxClass: "notify" } },
    });
  });

  it("非映射段 → 需要映射", () => {
    const errs = errorsOf(() => parseLoomConfig(`${BASE}\ninbox: "x"\n`, "<test>"));
    expect(errs.some((e) => e.includes("inbox") && e.includes("需要映射"))).toBe(true);
  });
});
