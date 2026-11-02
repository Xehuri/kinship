/**
 * 收件箱定级函数（纯函数，无 IO、无 LLM、无 send/deliverWake 调用）。
 *
 * 输入：调用方信件 + 该 source 的注册配置 + now + inbox 配置/index。
 * 输出：最终 class / effective trust / route / outcome / reason + dedupe/coalesce 证据。
 *
 * 铁律：
 *   - 只允许降级：source.maxClass、external trust ceiling、quiet hours、rate/burst/cooldown、
 *     notify burst → digest；绝不把低 class 抬高。
 *   - class 是契约；数值权重只在 decisionWeight/compareInboxPriority 内部排序使用，
 *     不进入 decision 对象、prompt、日志或 HTTP 响应。
 *   - dedupe/coalesce/rate 全部来自 journal replay 的只读索引，不自己扫描日志。
 *   - mode=off 直接抑制；mode=shadow 仍完整定级但 route=observed（旁路观测，不投递）。
 */

import type { InboxConfig, InboxSourceConfig } from "../config/section-checks.js";
import {
  CLASS_RANK,
  DEFAULT_CLASS_WEIGHTS,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_DEDUPE_TTL_MS,
  DEFAULT_GLOBAL_RATE_WINDOW_MS,
  DEFAULT_MAX_PENDING,
  DEFAULT_MAX_LETTERS_PER_MINUTE,
  DEFAULT_NOTIFY_BURST,
  DEFAULT_NOTIFY_WINDOW_MS,
  DEFAULT_QUIET_HOURS_DOWNGRADE,
  DEFAULT_QUIET_HOURS_END,
  DEFAULT_QUIET_HOURS_START,
  DEFAULT_QUIET_HOURS_TIMEZONE,
  TRUST_RANK,
  lowerClass,
} from "./defaults.js";
import type {
  InboxCoalesceDecision,
  InboxDedupeDecision,
  InboxPolicyDecision,
  InboxPolicyIndex,
  InboxPolicyOutcome,
  InboxPolicyReason,
  InboxRateSample,
  InboxRoute,
  LetterClass,
  LetterInput,
  LetterTrust,
} from "./types.js";

/**
 * classify 的第 4 个参数：inbox 配置 + journal 索引。
 * index 缺省 = 无历史（dedupe/coalesce/rate 均不命中），供纯单元测试使用。
 */
export interface InboxPolicyContext extends InboxConfig {
  readonly index?: InboxPolicyIndex;
}

export interface InboxOrderable {
  readonly class: LetterClass;
  readonly not_before?: number;
  readonly created_at?: number;
}

function isExternal(trust: LetterTrust): boolean {
  return trust === "external";
}

/** source.maxTrust 只向下钳制调用方声明的 trust；绝不上抬。 */
function clampTrust(requested: LetterTrust, sourceConfig: InboxSourceConfig): LetterTrust {
  const maxTrust = sourceConfig.maxTrust;
  if (maxTrust === undefined) return requested;
  return TRUST_RANK[requested] <= TRUST_RANK[maxTrust] ? requested : maxTrust;
}

function clampClassByTrust(letterClass: LetterClass, trust: LetterTrust): LetterClass {
  // external 最高只能 notify；interrupt 需要 trusted_service/user。
  if (isExternal(trust) && CLASS_RANK[letterClass] > CLASS_RANK.notify) return "notify";
  return letterClass;
}

function clampClassByMax(
  letterClass: LetterClass,
  maxClass: LetterClass | undefined,
): LetterClass {
  if (maxClass === undefined) return letterClass;
  return CLASS_RANK[letterClass] > CLASS_RANK[maxClass] ? maxClass : letterClass;
}

function routeForClass(letterClass: LetterClass): InboxRoute {
  switch (letterClass) {
    case "interrupt":
      return "send";
    case "notify":
      return "deliver_wake";
    case "digest":
      return "digest";
    default: {
      const _exhaustive: never = letterClass;
      return _exhaustive;
    }
  }
}

function parseHhMm(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour * 60 + minute;
}

/** quietHours 判定（start > end 视为跨夜区间；相等视为未启用）。 */
export function isQuietHours(now: number, config: InboxConfig): boolean {
  const quiet = config.quietHours;
  if (quiet?.enabled !== true) return false;
  const start = parseHhMm(quiet.start ?? DEFAULT_QUIET_HOURS_START);
  const end = parseHhMm(quiet.end ?? DEFAULT_QUIET_HOURS_END);
  if (start === null || end === null || start === end) return false;
  const timezone = quiet.timezone ?? DEFAULT_QUIET_HOURS_TIMEZONE;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
  } catch {
    // 非法 timezone 已由 checkInbox fail-fast；直接调用时保守视为非静默。
    return false;
  }
  const hourPart = parts.find((p) => p.type === "hour")?.value;
  const minutePart = parts.find((p) => p.type === "minute")?.value;
  if (hourPart === undefined || minutePart === undefined) return false;
  const current = Number(hourPart) * 60 + Number(minutePart);
  if (!Number.isFinite(current)) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function samplesSince(
  samples: readonly InboxRateSample[],
  now: number,
  windowMs: number,
): readonly InboxRateSample[] {
  return samples.filter((s) => s.at <= now && s.at >= now - windowMs);
}

function lastAt(samples: readonly InboxRateSample[], now: number): number | null {
  let last: number | null = null;
  for (const sample of samples) {
    if (sample.at > now) continue;
    if (last === null || sample.at > last) last = sample.at;
  }
  return last;
}

function dedupeInfo(
  input: LetterInput,
  now: number,
  config: InboxPolicyContext,
): InboxDedupeDecision | undefined {
  if (input.dedupe_key === undefined) return undefined;
  const ttlMs = config.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  const entry = config.index?.dedupe.get(input.dedupe_key);
  const hit = entry !== undefined && now - entry.at <= ttlMs;
  return {
    key: input.dedupe_key,
    ttl_ms: ttlMs,
    duplicate: hit,
    ...(entry === undefined ? {} : { existing_id: entry.id, existing_at: entry.at }),
  };
}

function coalesceInfo(
  input: LetterInput,
  now: number,
  config: InboxPolicyContext,
): InboxCoalesceDecision | undefined {
  if (input.coalesce_key === undefined) return undefined;
  const windowMs = config.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const entry = config.index?.coalesce.get(input.coalesce_key);
  const hit = entry !== undefined && now - entry.at <= windowMs;
  return {
    key: input.coalesce_key,
    window_ms: windowMs,
    coalesced: hit,
    ...(entry === undefined ? {} : { target_id: entry.id, target_at: entry.at }),
  };
}

function decision(
  letterClass: LetterClass,
  trust: LetterTrust,
  route: InboxRoute,
  outcome: InboxPolicyOutcome,
  reasons: readonly InboxPolicyReason[],
  extras: {
    readonly dedupe?: InboxDedupeDecision;
    readonly coalesce?: InboxCoalesceDecision;
  } = {},
): InboxPolicyDecision {
  const reason = reasons.length === 0 ? "accepted" : reasons[reasons.length - 1] ?? "accepted";
  return {
    class: letterClass,
    trust,
    route,
    outcome,
    reason,
    reasons,
    ...(extras.dedupe === undefined ? {} : { dedupe: extras.dedupe }),
    ...(extras.coalesce === undefined ? {} : { coalesce: extras.coalesce }),
  };
}

function suppress(
  letterClass: LetterClass,
  trust: LetterTrust,
  reason: InboxPolicyReason,
  extras: {
    readonly dedupe?: InboxDedupeDecision;
    readonly coalesce?: InboxCoalesceDecision;
    readonly reasons?: readonly InboxPolicyReason[];
  } = {},
): InboxPolicyDecision {
  return decision(letterClass, trust, "suppressed", "suppressed", [...(extras.reasons ?? []), reason], {
    ...(extras.dedupe === undefined ? {} : { dedupe: extras.dedupe }),
    ...(extras.coalesce === undefined ? {} : { coalesce: extras.coalesce }),
  });
}

/**
 * 纯定级。sourceConfig 由调用方从 `config.sources[input.source]` 取出；
 * undefined = 未注册来源 → 抑制。
 */
export function classify(
  input: LetterInput,
  sourceConfig: InboxSourceConfig | undefined,
  now: number,
  config: InboxPolicyContext = {},
): InboxPolicyDecision {
  const mode = config.mode ?? "off";
  const dedupe = dedupeInfo(input, now, config);
  const coalesce = coalesceInfo(input, now, config);
  const extras = {
    ...(dedupe === undefined ? {} : { dedupe }),
    ...(coalesce === undefined ? {} : { coalesce }),
  };

  if (mode === "off") {
    return suppress(input.class, input.trust, "mode_off", extras);
  }
  if (sourceConfig === undefined) {
    return suppress(input.class, input.trust, "source_unregistered", extras);
  }

  const trust = clampTrust(input.trust, sourceConfig);
  const reasons: InboxPolicyReason[] = [];
  if (trust !== input.trust) reasons.push("source_max_trust");

  if (input.expires_at !== undefined && now >= input.expires_at) {
    return suppress(input.class, trust, "expired", { ...extras, reasons });
  }
  if (sourceConfig.requireDedupeKey === true && input.dedupe_key === undefined) {
    return suppress(input.class, trust, "dedupe_key_required", { ...extras, reasons });
  }
  if (dedupe?.duplicate === true) {
    return decision(input.class, trust, "suppressed", "duplicate", [...reasons, "duplicate"], extras);
  }
  if (input.class !== "interrupt" && coalesce?.coalesced === true) {
    return decision(input.class, trust, "suppressed", "coalesced", [...reasons, "coalesced"], extras);
  }

  const maxPending = config.limits?.maxPending ?? DEFAULT_MAX_PENDING;
  if (config.index !== undefined && config.index.pendingCount >= maxPending) {
    return suppress(input.class, trust, "max_pending", { ...extras, reasons });
  }

  let letterClass = input.class;

  // quiet hours 针对“external 的 interrupt 请求”本身；必须先于 trust ceiling 判定，
  // 否则 external interrupt 会先被压成 notify，静默期配置的 digest 降级就永远不生效。
  if (isQuietHours(now, config) && isExternal(trust) && letterClass === "interrupt") {
    letterClass = config.quietHours?.downgradeExternalInterruptTo ?? DEFAULT_QUIET_HOURS_DOWNGRADE;
    reasons.push("quiet_hours");
  }

  const beforeTrustCeiling = letterClass;
  letterClass = clampClassByTrust(letterClass, trust);
  if (letterClass !== beforeTrustCeiling) reasons.push("trust_ceiling");

  const beforeSourceMax = letterClass;
  letterClass = clampClassByMax(letterClass, sourceConfig.maxClass);
  if (letterClass !== beforeSourceMax) reasons.push("source_max_class");

  const sourceSamples = config.index?.rate.get(input.source) ?? [];
  const globalSamples = config.index?.globalRate ?? [];
  const rateExceeded =
    sourceConfig.ratePerMinute !== undefined &&
    samplesSince(sourceSamples, now, 60_000).length >= sourceConfig.ratePerMinute;
  const burstExceeded =
    sourceConfig.burst !== undefined &&
    samplesSince(sourceSamples, now, 1_000).length >= sourceConfig.burst;
  const lastSourceAt = lastAt(sourceSamples, now);
  const cooldownActive =
    sourceConfig.cooldownMs !== undefined && lastSourceAt !== null &&
    now - lastSourceAt < sourceConfig.cooldownMs;
  const globalMax = config.limits?.maxLettersPerMinute ?? DEFAULT_MAX_LETTERS_PER_MINUTE;
  const globalExceeded =
    samplesSince(globalSamples, now, DEFAULT_GLOBAL_RATE_WINDOW_MS).length >= globalMax;

  if (rateExceeded) {
    const before = letterClass;
    letterClass = lowerClass(letterClass);
    if (letterClass !== before) reasons.push("rate_limited");
  } else if (burstExceeded) {
    const before = letterClass;
    letterClass = lowerClass(letterClass);
    if (letterClass !== before) reasons.push("burst_limited");
  } else if (cooldownActive) {
    const before = letterClass;
    letterClass = lowerClass(letterClass);
    if (letterClass !== before) reasons.push("cooldown");
  }

  if (globalExceeded) {
    const before = letterClass;
    letterClass = lowerClass(letterClass);
    if (letterClass !== before) reasons.push("global_rate_limited");
  }

  if (letterClass === "notify") {
    const notifyBurst = config.accumulate?.notifyBurst ?? DEFAULT_NOTIFY_BURST;
    const notifyWindow = config.accumulate?.windowMs ?? DEFAULT_NOTIFY_WINDOW_MS;
    const notifyCount = samplesSince(sourceSamples, now, notifyWindow).filter(
      (s) => s.class === "notify",
    ).length;
    if (notifyCount >= notifyBurst) {
      letterClass = "digest";
      reasons.push("notify_burst");
    }
  }

  if (mode === "shadow") {
    return decision(letterClass, trust, "observed", "accepted", [...reasons, "mode_shadow"], extras);
  }

  return decision(letterClass, trust, routeForClass(letterClass), "accepted", reasons, extras);
}

/** 内部排序权重（不进入 decision/prompt/日志/HTTP）。 */
export function classWeight(letterClass: LetterClass, config: InboxConfig = {}): number {
  const weights = config.classes?.weights;
  switch (letterClass) {
    case "interrupt":
      return weights?.interrupt ?? DEFAULT_CLASS_WEIGHTS.interrupt;
    case "notify":
      return weights?.notify ?? DEFAULT_CLASS_WEIGHTS.notify;
    case "digest":
      return weights?.digest ?? DEFAULT_CLASS_WEIGHTS.digest;
    default: {
      const _exhaustive: never = letterClass;
      return _exhaustive;
    }
  }
}

/**
 * 同批排序：权重降序 → not_before/created_at 升序 → class 名稳定 tie-break。
 * 权重只在此内部使用，调用方拿不到数值评分。
 */
export function compareInboxPriority(
  left: InboxOrderable,
  right: InboxOrderable,
  config: InboxConfig = {},
): number {
  const weightDelta = classWeight(right.class, config) - classWeight(left.class, config);
  if (weightDelta !== 0) return weightDelta;
  const leftAt = left.not_before ?? left.created_at ?? 0;
  const rightAt = right.not_before ?? right.created_at ?? 0;
  if (leftAt !== rightAt) return leftAt - rightAt;
  return left.class < right.class ? -1 : left.class > right.class ? 1 : 0;
}
