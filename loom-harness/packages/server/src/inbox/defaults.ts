/**
 * 收件箱消费层默认值。
 *
 * 纪律：schema（section-checks.ts）只校验调用方写下的值，缺席 = undefined；
 * 所有缺省语义集中在这里，由 store/policy 在消费时刻现读。这样配置面永远
 * 不会伪造“用户写过的值”，也不会把默认值固化进 YAML 模板。
 */

import type { LetterClass, LetterTrust } from "./types.js";

/** body UTF-8 字节上限（16 KiB；配置 limits.maxBodyBytes 可覆盖）。 */
export const DEFAULT_MAX_BODY_BYTES = 16_384;
/** title 码点上限（契约固定 200）。 */
export const DEFAULT_MAX_TITLE_CHARS = 200;
/** ref 序列化 JSON 字节上限（2 KiB）。 */
export const DEFAULT_MAX_REF_BYTES = 2_048;
/** correlation_id/dedupe_key/coalesce_key/reply_to 字符上限。 */
export const DEFAULT_MAX_KEY_CHARS = 128;
/** principal 字符上限。 */
export const DEFAULT_MAX_PRINCIPAL_CHARS = 256;
/** kind 字符上限。 */
export const DEFAULT_MAX_KIND_CHARS = 64;
/** causation_depth 上限（防转发链无限增长）。 */
export const DEFAULT_MAX_CAUSATION_DEPTH = 32;
/** thread_id 字符上限（线程身份与来源组合唯一）。 */
export const DEFAULT_MAX_THREAD_ID_CHARS = 128;
/** thread_name 字符上限（展示名，单行）。 */
export const DEFAULT_MAX_THREAD_NAME_CHARS = 200;
/** thread_kind 字符上限（`[a-z0-9_.-]`）。 */
export const DEFAULT_MAX_THREAD_KIND_CHARS = 32;

/** 未 ack 积压上限；超过后 policy 抑制新信件（防止内存/账本无界增长）。 */
export const DEFAULT_MAX_PENDING = 1_000;
/** 全局速率上限（所有 source 合计，每分钟）。 */
export const DEFAULT_MAX_LETTERS_PER_MINUTE = 120;
export const DEFAULT_GLOBAL_RATE_WINDOW_MS = 60_000;

/** dedupe_key 保留时长（48h，与唤醒队列计划保留口径一致）。 */
export const DEFAULT_DEDUPE_TTL_MS = 48 * 60 * 60 * 1000;
/** coalesce_key 合并窗口（30min）。 */
export const DEFAULT_COALESCE_WINDOW_MS = 30 * 60 * 1000;
/** notify 在窗口内超过该次数即折叠为 digest。 */
export const DEFAULT_NOTIFY_BURST = 3;
/** notify burst 统计窗口（5min）。 */
export const DEFAULT_NOTIFY_WINDOW_MS = 5 * 60 * 1000;

/** 摘要批次缺省参数（消费层 T3/T4 读取；T2 只提供类型/默认值）。 */
export const DEFAULT_DIGEST_CADENCE_MS = 15 * 60 * 1000;
export const DEFAULT_DIGEST_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_DIGEST_MAX_BATCH = 20;
export const DEFAULT_DIGEST_LEASE_MS = 60 * 1000;

/** 未 ack 宽限轮数。 */
export const DEFAULT_ACK_GRACE_TURNS = 2;
/** 重投缺省：首次失败 + 一次重试（与 WAKE_QUEUE_MAX_ATTEMPTS 口径一致）。 */
export const DEFAULT_REDELIVERY_MAX_ATTEMPTS = 1;
export const DEFAULT_REDELIVERY_BACKOFF_MS = 30_000;

/** 内部权重仅用于同批排序（不进入 decision/prompt/日志/HTTP）。 */
export const DEFAULT_CLASS_WEIGHTS: Readonly<Record<LetterClass, number>> = {
  interrupt: 3,
  notify: 2,
  digest: 1,
};

/** quietHours 对 external interrupt 的缺省降级目标。 */
export const DEFAULT_QUIET_HOURS_DOWNGRADE: Exclude<LetterClass, "interrupt"> = "notify";
export const DEFAULT_QUIET_HOURS_START = "22:00";
export const DEFAULT_QUIET_HOURS_END = "08:00";
export const DEFAULT_QUIET_HOURS_TIMEZONE = "UTC";

/** 内部 trust 排序（只用于比较，不对外输出）。 */
export const TRUST_RANK: Readonly<Record<LetterTrust, number>> = {
  external: 0,
  trusted_service: 1,
  user: 2,
};

/** 内部 class 排序（只用于比较，不对外输出）。 */
export const CLASS_RANK: Readonly<Record<LetterClass, number>> = {
  digest: 0,
  notify: 1,
  interrupt: 2,
};

/** 由低到高比较后取较低一档；digest 已是最低，返回 digest。 */
export function lowerClass(current: LetterClass): LetterClass {
  switch (current) {
    case "interrupt":
      return "notify";
    case "notify":
      return "digest";
    case "digest":
      return "digest";
    default: {
      const _exhaustive: never = current;
      return _exhaustive;
    }
  }
}
