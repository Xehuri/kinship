// Loom 统一收件箱：T2 核心（配置类型/信件类型/事件账本/policy/观测）+ T3 入口
// （HTTP 路由、投递路由、摘要排班）+ T4 消费面（主会话 pull tools、batch 生命周期）。

export {
  LETTER_CLASSES,
  LETTER_STATES,
  LETTER_TRUSTS,
  INBOX_ROUTES,
  INBOX_POLICY_REASONS,
  type InboxCoalesceDecision,
  type InboxDedupeDecision,
  type InboxIndexEntry,
  type InboxPolicyDecision,
  type InboxPolicyIndex,
  type InboxPolicyOutcome,
  type InboxPolicyReason,
  type InboxRateSample,
  type InboxRoute,
  type InboxSnapshot,
  type LetterClass,
  type LetterInput,
  type LetterRecord,
  type LetterState,
  type LetterTrust,
} from "./types.js";

export {
  DEFAULT_ACK_GRACE_TURNS,
  DEFAULT_CLASS_WEIGHTS,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_DEDUPE_TTL_MS,
  DEFAULT_DIGEST_CADENCE_MS,
  DEFAULT_DIGEST_LEASE_MS,
  DEFAULT_DIGEST_MAX_AGE_MS,
  DEFAULT_DIGEST_MAX_BATCH,
  DEFAULT_GLOBAL_RATE_WINDOW_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_CAUSATION_DEPTH,
  DEFAULT_MAX_KEY_CHARS,
  DEFAULT_MAX_KIND_CHARS,
  DEFAULT_MAX_LETTERS_PER_MINUTE,
  DEFAULT_MAX_PENDING,
  DEFAULT_MAX_PRINCIPAL_CHARS,
  DEFAULT_MAX_REF_BYTES,
  DEFAULT_MAX_TITLE_CHARS,
  DEFAULT_NOTIFY_BURST,
  DEFAULT_NOTIFY_WINDOW_MS,
  DEFAULT_QUIET_HOURS_DOWNGRADE,
  DEFAULT_QUIET_HOURS_END,
  DEFAULT_QUIET_HOURS_START,
  DEFAULT_QUIET_HOURS_TIMEZONE,
  DEFAULT_REDELIVERY_BACKOFF_MS,
  DEFAULT_REDELIVERY_MAX_ATTEMPTS,
  CLASS_RANK,
  TRUST_RANK,
  lowerClass,
} from "./defaults.js";

export {
  LetterValidationError,
  SOURCE_KEY_RE,
  validateLetterInput,
  type LetterFieldError,
  type LetterValidationOptions,
} from "./validate.js";

export {
  INBOX_EVENTS,
  InboxJournalError,
  InboxJournalStore,
  isInboxEventShape,
  type InboxAckedEvent,
  type InboxAppendOptions,
  type InboxAppendResult,
  type InboxCoalescedEvent,
  type InboxDeadLetterEvent,
  type InboxDeferredEvent,
  type InboxDeliveredEvent,
  type InboxDedupedEvent,
  type InboxEvent,
  type InboxEventType,
  type InboxExpiredEvent,
  type InboxJournalStoreOptions,
  type InboxListFilter,
  type InboxObservedEvent,
  type InboxRateWindow,
  type InboxReadEvent,
  type InboxReceivedEvent,
  type InboxRedeliveredEvent,
  type InboxRoutedEvent,
  type InboxSuppressedEvent,
  type InboxTornTail,
} from "./journal-store.js";

export {
  classify,
  classWeight,
  compareInboxPriority,
  isQuietHours,
  type InboxOrderable,
  type InboxPolicyContext,
} from "./policy.js";

export {
  observeInboxEvent,
  observeInboxSnapshot,
  principalRef,
  type InboxEventObservation,
  type InboxObservation,
  type InboxSnapshotObservation,
} from "./observation.js";

export {
  countsFromSnapshot,
  previewText,
  renderDigestEnvelope,
  renderLetterEnvelope,
  type InboxEnvelopeCounts,
} from "./envelope.js";

export {
  deliverAcceptedLetter,
  type InboxDeliveryDeps,
  type InboxDeliveryResult,
  type InboxDeliveryTarget,
  type InboxDigestTrigger,
  type InboxLog,
} from "./router.js";

export {
  InboxDigestRuntime,
  type InboxDigestRuntimeOptions,
} from "./digest.js";

export {
  InboxBatchRuntime,
  parseInboxPromptMarkers,
  type InboxBatchRuntimeOptions,
  type InboxBatchToken,
  type InboxPromptMarkers,
} from "./batch.js";

export {
  INBOX_TOOL_LIMITS,
  createInboxTools,
  type InboxToolsOptions,
} from "./tools.js";

export {
  createInboxPolicyEngine,
  registerInboxRoutes,
  type InboxPolicyEngine,
  type InboxRouteDeps,
} from "./routes.js";

export {
  publicDecision,
  rateLimitReason,
  recordSuppression,
  respondSuppressed,
  retryAfterSeconds,
  sendError,
  suppressedResponse,
  validateOrRespond,
  type SuppressedResponse,
} from "./ingress.js";
