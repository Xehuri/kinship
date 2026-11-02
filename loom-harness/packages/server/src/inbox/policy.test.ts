/**
 * policy 纯函数：只降级、quiet hours、maxClass/maxTrust、rate/burst/cooldown、notify burst、
 * dedupe/coalesce、shadow/off、maxPending、权重只用于排序。
 */

import { describe, expect, it } from "vitest";

import type { InboxSourceConfig } from "../config/section-checks.js";
import {
  classWeight,
  classify,
  compareInboxPriority,
  type InboxPolicyContext,
} from "./policy.js";
import type { InboxPolicyIndex, LetterInput } from "./types.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function letter(overrides: Partial<LetterInput> = {}): LetterInput {
  return {
    source: "qq",
    kind: "system_note",
    class: "notify",
    trust: "external",
    principal: "123456",
    body: "hello",
    ...overrides,
  };
}

function index(overrides: Partial<InboxPolicyIndex> = {}): InboxPolicyIndex {
  return {
    dedupe: new Map(),
    coalesce: new Map(),
    rate: new Map(),
    globalRate: [],
    pendingCount: 0,
    ...overrides,
  };
}

function live(overrides: InboxPolicyContext = {}): InboxPolicyContext {
  return { mode: "live", index: index(), ...overrides };
}

const INTERNAL_INTERRUPT: InboxSourceConfig = {
  maxTrust: "trusted_service",
  maxClass: "interrupt",
};

describe("classify", () => {
  it("external interrupt → trust ceiling 压到 notify", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "external" }),
      { maxTrust: "external", maxClass: "interrupt" },
      NOW,
      live(),
    );
    expect(decision.class).toBe("notify");
    expect(decision.route).toBe("deliver_wake");
    expect(decision.reasons).toContain("trust_ceiling");
  });

  it("source.maxClass 只降不升", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "user" }),
      { maxTrust: "user", maxClass: "digest" },
      NOW,
      live(),
    );
    expect(decision.class).toBe("digest");
    expect(decision.route).toBe("digest");
    expect(decision.reasons).toContain("source_max_class");
  });

  it("quiet hours 把 external interrupt 降到配置目标（digest）", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "external" }),
      { maxTrust: "external", maxClass: "interrupt" },
      Date.UTC(2026, 0, 1, 23, 0, 0),
      live({
        quietHours: {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timezone: "UTC",
          downgradeExternalInterruptTo: "digest",
        },
      }),
    );
    expect(decision.class).toBe("digest");
    expect(decision.reasons).toContain("quiet_hours");
  });

  it("quiet hours 不影响 trusted_service 的 interrupt", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "trusted_service" }),
      INTERNAL_INTERRUPT,
      Date.UTC(2026, 0, 1, 23, 0, 0),
      live({
        quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" },
      }),
    );
    expect(decision.class).toBe("interrupt");
    expect(decision.route).toBe("send");
  });

  it("notify burst 窗口内达到阈值 → digest", () => {
    const decision = classify(
      letter({ class: "notify", trust: "trusted_service" }),
      { maxTrust: "trusted_service", maxClass: "notify" },
      NOW,
      live({
        index: index({
          rate: new Map([
            [
              "qq",
              [
                { at: NOW - 100, class: "notify" },
                { at: NOW - 200, class: "notify" },
                { at: NOW - 300, class: "notify" },
              ],
            ],
          ]),
        }),
        accumulate: { notifyBurst: 3, windowMs: 60_000 },
      }),
    );
    expect(decision.class).toBe("digest");
    expect(decision.reasons).toContain("notify_burst");
  });

  it("ratePerMinute 超限 → 降一档", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "trusted_service" }),
      { ...INTERNAL_INTERRUPT, ratePerMinute: 1 },
      NOW,
      live({
        index: index({
          rate: new Map([["qq", [{ at: NOW - 1_000, class: "interrupt" }]]]),
        }),
      }),
    );
    expect(decision.class).toBe("notify");
    expect(decision.reasons).toContain("rate_limited");
  });

  it("burst 超限 → 降一档", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "trusted_service" }),
      { ...INTERNAL_INTERRUPT, burst: 1 },
      NOW,
      live({
        index: index({
          rate: new Map([["qq", [{ at: NOW - 100, class: "interrupt" }]]]),
        }),
      }),
    );
    expect(decision.class).toBe("notify");
    expect(decision.reasons).toContain("burst_limited");
  });

  it("cooldown 未到期 → 降一档", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "trusted_service" }),
      { ...INTERNAL_INTERRUPT, cooldownMs: 10_000 },
      NOW,
      live({
        index: index({
          rate: new Map([["qq", [{ at: NOW - 1_000, class: "interrupt" }]]]),
        }),
      }),
    );
    expect(decision.class).toBe("notify");
    expect(decision.reasons).toContain("cooldown");
  });

  it("全局速率超限 → 降一档", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "trusted_service" }),
      INTERNAL_INTERRUPT,
      NOW,
      live({
        index: index({ globalRate: [{ at: NOW - 100, class: "notify" }] }),
        limits: { maxLettersPerMinute: 1 },
      }),
    );
    expect(decision.class).toBe("notify");
    expect(decision.reasons).toContain("global_rate_limited");
  });

  it("dedupe TTL 命中 → duplicate/抑制", () => {
    const decision = classify(
      letter({ dedupe_key: "d1" }),
      { maxTrust: "external" },
      NOW,
      live({
        index: index({ dedupe: new Map([["d1", { id: "l1", at: NOW - 1_000 }]]) }),
        dedupeTtlMs: 5_000,
      }),
    );
    expect(decision.outcome).toBe("duplicate");
    expect(decision.route).toBe("suppressed");
    expect(decision.reason).toBe("duplicate");
    expect(decision.dedupe).toEqual({
      key: "d1",
      ttl_ms: 5_000,
      duplicate: true,
      existing_id: "l1",
      existing_at: NOW - 1_000,
    });
  });

  it("dedupe TTL 过期 → 不命中", () => {
    const decision = classify(
      letter({ dedupe_key: "d1" }),
      { maxTrust: "external" },
      NOW,
      live({
        index: index({ dedupe: new Map([["d1", { id: "l1", at: NOW - 6_000 }]]) }),
        dedupeTtlMs: 5_000,
      }),
    );
    expect(decision.outcome).toBe("accepted");
    expect(decision.dedupe?.duplicate).toBe(false);
  });

  it("requireDedupeKey 缺失 → 抑制", () => {
    const decision = classify(
      letter(),
      { maxTrust: "external", requireDedupeKey: true },
      NOW,
      live(),
    );
    expect(decision.outcome).toBe("suppressed");
    expect(decision.reason).toBe("dedupe_key_required");
  });

  it("coalesce 窗口命中 → coalesced/抑制；interrupt 不参与合并", () => {
    const coalesced = classify(
      letter({ class: "notify", coalesce_key: "c1" }),
      { maxTrust: "external", maxClass: "notify" },
      NOW,
      live({
        index: index({ coalesce: new Map([["c1", { id: "l1", at: NOW - 1_000 }]]) }),
        coalesceWindowMs: 5_000,
      }),
    );
    expect(coalesced.outcome).toBe("coalesced");
    expect(coalesced.reason).toBe("coalesced");
    expect(coalesced.coalesce?.target_id).toBe("l1");

    const interrupted = classify(
      letter({ class: "interrupt", trust: "trusted_service", coalesce_key: "c1" }),
      INTERNAL_INTERRUPT,
      NOW,
      live({
        index: index({ coalesce: new Map([["c1", { id: "l1", at: NOW - 1_000 }]]) }),
        coalesceWindowMs: 5_000,
      }),
    );
    expect(interrupted.outcome).toBe("accepted");
    expect(interrupted.class).toBe("interrupt");
  });

  it("mode=off → 抑制；source 未注册 → 抑制", () => {
    const off = classify(letter(), { maxTrust: "external" }, NOW, { mode: "off" });
    expect(off.reason).toBe("mode_off");
    expect(off.route).toBe("suppressed");

    const unregistered = classify(letter(), undefined, NOW, { mode: "live", index: index() });
    expect(unregistered.reason).toBe("source_unregistered");
    expect(unregistered.route).toBe("suppressed");
  });

  it("mode=shadow → 完整定级但 route=observed", () => {
    const decision = classify(letter(), { maxTrust: "external" }, NOW, {
      mode: "shadow",
      index: index(),
    });
    expect(decision.outcome).toBe("accepted");
    expect(decision.route).toBe("observed");
    expect(decision.reason).toBe("mode_shadow");
  });

  it("source.maxTrust 向下钳制，不保留调用方虚高 trust", () => {
    const decision = classify(
      letter({ class: "interrupt", trust: "user" }),
      { maxTrust: "external", maxClass: "interrupt" },
      NOW,
      live(),
    );
    expect(decision.trust).toBe("external");
    expect(decision.class).toBe("notify");
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["source_max_trust", "trust_ceiling"]),
    );
  });

  it("maxPending 达上限 → 抑制", () => {
    const decision = classify(
      letter(),
      { maxTrust: "external" },
      NOW,
      live({ index: index({ pendingCount: 2 }), limits: { maxPending: 2 } }),
    );
    expect(decision.outcome).toBe("suppressed");
    expect(decision.reason).toBe("max_pending");
  });

  it("过期信件 → 抑制", () => {
    const decision = classify(
      letter({ expires_at: NOW }),
      { maxTrust: "external" },
      NOW,
      live(),
    );
    expect(decision.reason).toBe("expired");
    expect(decision.outcome).toBe("suppressed");
  });

  it("decision 不含数值权重；权重只用于内部排序", () => {
    const decision = classify(letter(), { maxTrust: "external" }, NOW, live());
    expect("weight" in decision).toBe(false);
    expect("score" in decision).toBe(false);
    expect(classWeight("interrupt")).toBeGreaterThan(classWeight("notify"));
    expect(classWeight("notify")).toBeGreaterThan(classWeight("digest"));
    expect(
      classWeight("interrupt", { classes: { weights: { interrupt: 9, notify: 2, digest: 1 } } }),
    ).toBe(9);
    const ordered = [
      { class: "digest" as const, created_at: 1 },
      { class: "interrupt" as const, created_at: 2 },
      { class: "notify" as const, created_at: 3 },
    ].sort((a, b) => compareInboxPriority(a, b));
    expect(ordered.map((x) => x.class)).toEqual(["interrupt", "notify", "digest"]);
  });
});
