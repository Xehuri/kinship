/**
 * Loom 统一收件箱（letters）核心类型。
 *
 * 设计约束（与 docs/dev/loom-inbox-contract.md 对齐）：
 *   - class 是唯一契约（interrupt/notify/digest）；数值权重只在 policy 内部用于排序，
 *     不接受调用方提供，也不进入 prompt/日志/HTTP 响应。
 *   - source 是注册键（配置 `inbox.sources.<key>`），trust 是独立维度；
 *     两者正交，不把 QQ 之类的来源硬编码成 enum。
 *   - 用户聊天不进 inbox：LetterInput 没有 user-chat 通道语义，只有异步来源使用。
 *   - 收件箱是账本（ledger），不是第二队列/数据库；状态由 journal replay 得出。
 */

export const LETTER_CLASSES = ["digest", "notify", "interrupt"] as const;
export type LetterClass = (typeof LETTER_CLASSES)[number];

/** 从低到高的信任层级；policy 只允许向下钳制，不允许调用方抬高。 */
export const LETTER_TRUSTS = ["external", "trusted_service", "user"] as const;
export type LetterTrust = (typeof LETTER_TRUSTS)[number];

/**
 * 信件生命周期状态。
 * observed 是 shadow 模式的旁路态：落账但不投递、不计入 pending 积压。
 */
export const LETTER_STATES = [
  "pending",
  "routed",
  "delivered",
  "read",
  "deferred",
  "acked",
  "expired",
  "dead_letter",
  "observed",
] as const;
export type LetterState = (typeof LETTER_STATES)[number];

/** 调用方提交的信件字段（服务端字段 id/created_at/state/attempts 不在其中）。 */
export interface LetterInput {
  readonly source: string;
  readonly kind: string;
  readonly class: LetterClass;
  readonly trust: LetterTrust;
  readonly principal: string;
  readonly not_before?: number;
  readonly expires_at?: number;
  readonly title?: string;
  readonly body: string;
  /** 关联资源（run id / session id / url / 结构化 JSON）；上限 2KB。 */
  readonly ref?: unknown;
  readonly correlation_id?: string;
  readonly dedupe_key?: string;
  readonly coalesce_key?: string;
  readonly reply_to?: string;
  /** 因果链深度（0 = 直接来源；>0 = 转发/派生）。 */
  readonly causation_depth?: number;
}

/** 服务端账本记录：input + 分配字段 + 生命周期字段。 */
export interface LetterRecord extends LetterInput {
  readonly id: string;
  readonly created_at: number;
  readonly state: LetterState;
  readonly attempts: number;
  readonly delivered_at?: number;
  readonly read_at?: number;
  readonly acked_at?: number;
  readonly ack_outcome?: string;
  readonly evidence_ref?: string;
  /** ack 备注（模型可选提供；上限 2KB，绝不记录正文之外的隐式内容）。 */
  readonly ack_note?: string;
  readonly deferred_until?: number;
  /**
   * 已 defer 次数（服务端管理，replay 时按 letter.deferred 事件递增）。
   * 用于 inbox_defer 的每信上限（3 次）；客户端不可写。
   */
  readonly defer_count: number;
  /**
   * 最近一次 digest 投递批次 id（来自 letter.delivered.batch_id）。
   * T4 batch runtime 用它从 journal 恢复 digest 批次归属，不新增批次表。
   */
  readonly batch_id?: string;
}

/**
 * 快照口径：
 *   - pending = 尚未终结（pending/routed/delivered/read/deferred），这些仍需处理或 ack；
 *   - dead_letter = 独立计数，不混入 pending；
 *   - observed（shadow）不计入 pending/by_class/by_source；
 *   - unknown = pending 中 source 不在调用方给出的 knownSources 集合内的数量
 *     （不给 knownSources 时无法判定，恒 0）；
 *   - digest_due_at = 最早可摘要时刻（not_before ?? created_at），无 digest 时为 null。
 */
export interface InboxSnapshot {
  readonly as_of: number;
  readonly pending: number;
  readonly by_class: Readonly<Record<LetterClass, number>>;
  readonly by_source: Readonly<Record<string, number>>;
  readonly oldest_age_ms: number;
  readonly dead_letter: number;
  readonly unknown: number;
  readonly digest_due_at: number | null;
}

/** 路由（policy → T3/T4 投递层）；observed 是 shadow 模式的路由结果。 */
export const INBOX_ROUTES = ["send", "deliver_wake", "digest", "observed", "suppressed"] as const;
export type InboxRoute = (typeof INBOX_ROUTES)[number];

export type InboxPolicyOutcome = "accepted" | "duplicate" | "coalesced" | "suppressed";

/**
 * policy 判定原因。accepted = 无降级；其余值描述唯一一次或最后一次决定性降级/抑制。
 * reasons 数组保留全部已应用规则（审计用，不含正文/凭据）。
 */
export const INBOX_POLICY_REASONS = [
  "accepted",
  "mode_off",
  "mode_shadow",
  "source_unregistered",
  "source_max_trust",
  "trust_ceiling",
  "source_max_class",
  "quiet_hours",
  "expired",
  "dedupe_key_required",
  "duplicate",
  "coalesced",
  "max_pending",
  "rate_limited",
  "burst_limited",
  "global_rate_limited",
  "cooldown",
  "notify_burst",
] as const;
export type InboxPolicyReason = (typeof INBOX_POLICY_REASONS)[number];

export interface InboxDedupeDecision {
  readonly key: string;
  readonly ttl_ms: number;
  readonly duplicate: boolean;
  readonly existing_id?: string;
  readonly existing_at?: number;
}

export interface InboxCoalesceDecision {
  readonly key: string;
  readonly window_ms: number;
  readonly coalesced: boolean;
  readonly target_id?: string;
  readonly target_at?: number;
}

export interface InboxPolicyDecision {
  /** 降级后的最终 class（class 是契约，调用方只能请求，不能指定最终值）。 */
  readonly class: LetterClass;
  /** 钳制后的有效 trust（source.maxTrust 只允许向下钳制）。 */
  readonly trust: LetterTrust;
  readonly route: InboxRoute;
  readonly outcome: InboxPolicyOutcome;
  /** 决定性原因；无降级且接收 = accepted；shadow 接收 = mode_shadow。 */
  readonly reason: InboxPolicyReason;
  /** 本次判定应用过的全部原因（按应用顺序）。 */
  readonly reasons: readonly InboxPolicyReason[];
  readonly dedupe?: InboxDedupeDecision;
  readonly coalesce?: InboxCoalesceDecision;
}

/** journal replay 得出的 dedupe/coalesce 索引项。 */
export interface InboxIndexEntry {
  readonly id: string;
  readonly at: number;
}

/** 速率采样：class 用于 notify burst 判定。 */
export interface InboxRateSample {
  readonly at: number;
  readonly class: LetterClass;
}

/** policy 的只读输入视图（由 journal-store 构建，policy 不自己扫描日志）。 */
export interface InboxPolicyIndex {
  readonly dedupe: ReadonlyMap<string, InboxIndexEntry>;
  readonly coalesce: ReadonlyMap<string, InboxIndexEntry>;
  readonly rate: ReadonlyMap<string, readonly InboxRateSample[]>;
  readonly globalRate: readonly InboxRateSample[];
  readonly pendingCount: number;
}
