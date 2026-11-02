/**
 * 收件箱可观测面：结构化生命周期日志 + 快照投影。
 *
 * 安全约束：这里输出的一切都可能进 journalctl/日志聚合，因此
 *   - 绝不包含 body/title/ref 正文或任何 token；
 *   - principal 只输出 SHA-256 前缀（不可逆、固定长度）；
 *   - 数值权重不出现在观测面（class 是契约）。
 */

import { createHash } from "node:crypto";

import type { InboxEvent } from "./journal-store.js";
import type {
  InboxRoute,
  InboxSnapshot,
  LetterClass,
  LetterState,
  LetterTrust,
} from "./types.js";

export interface InboxEventObservation {
  readonly schema: 1;
  readonly kind: "inbox.event";
  readonly event: string;
  readonly at: number;
  readonly id: string;
  readonly source?: string;
  readonly class?: LetterClass;
  readonly trust?: LetterTrust;
  readonly state?: LetterState;
  readonly route?: InboxRoute;
  readonly principal_ref?: string;
  readonly reason?: string;
}

export interface InboxSnapshotObservation {
  readonly schema: 1;
  readonly kind: "inbox.snapshot";
  readonly as_of: number;
  readonly pending: number;
  readonly by_class: Readonly<Record<LetterClass, number>>;
  readonly by_source: Readonly<Record<string, number>>;
  readonly oldest_age_ms: number;
  readonly dead_letter: number;
  readonly unknown: number;
  readonly digest_due_at: number | null;
}

export type InboxObservation = InboxEventObservation | InboxSnapshotObservation;

/** principal 的不可逆短引用（12 hex = 48 bit；足够关联日志，不足以还原）。 */
export function principalRef(principal: string): string {
  return `sha256:${createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 12)}`;
}

function stateForEvent(event: InboxEvent): LetterState | undefined {
  switch (event.event) {
    case "letter.received":
      return "pending";
    case "letter.observed":
      return "observed";
    case "letter.routed":
      return "routed";
    case "letter.delivered":
      return "delivered";
    case "letter.read":
      return "read";
    case "letter.acked":
      return "acked";
    case "letter.deferred":
      return "deferred";
    case "letter.expired":
      return "expired";
    case "letter.redelivered":
      return "pending";
    case "letter.dead_letter":
      return "dead_letter";
    case "letter.deduped":
    case "letter.coalesced":
    case "letter.suppressed":
      return undefined;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** 事件 → 可安全落日志的结构化观测（不含正文/调用方 principal 明文）。 */
export function observeInboxEvent(event: InboxEvent): InboxEventObservation {
  const state = stateForEvent(event);
  switch (event.event) {
    case "letter.received":
    case "letter.observed":
      return {
        schema: 1,
        kind: "inbox.event",
        event: event.event,
        at: event.at,
        id: event.id,
        source: event.letter.source,
        class: event.letter.class,
        trust: event.letter.trust,
        ...(state === undefined ? {} : { state }),
        principal_ref: principalRef(event.letter.principal),
      };
    case "letter.deduped":
      return {
        schema: 1,
        kind: "inbox.event",
        event: event.event,
        at: event.at,
        id: event.id,
        source: event.source,
        class: event.class,
        ...(event.trust === undefined ? {} : { trust: event.trust }),
        reason: "duplicate",
      };
    case "letter.coalesced":
      return {
        schema: 1,
        kind: "inbox.event",
        event: event.event,
        at: event.at,
        id: event.id,
        source: event.source,
        class: event.class,
        ...(event.trust === undefined ? {} : { trust: event.trust }),
        reason: "coalesced",
      };
    case "letter.suppressed":
      return {
        schema: 1,
        kind: "inbox.event",
        event: event.event,
        at: event.at,
        id: event.id,
        source: event.source,
        class: event.class,
        ...(event.trust === undefined ? {} : { trust: event.trust }),
        reason: event.reason,
      };
    case "letter.routed":
      return {
        schema: 1,
        kind: "inbox.event",
        event: event.event,
        at: event.at,
        id: event.id,
        class: event.class,
        ...(state === undefined ? {} : { state }),
        route: event.route,
      };
    case "letter.dead_letter":
      return {
        schema: 1,
        kind: "inbox.event",
        event: event.event,
        at: event.at,
        id: event.id,
        ...(state === undefined ? {} : { state }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
    default:
      return {
        schema: 1,
        kind: "inbox.event",
        event: event.event,
        at: event.at,
        id: event.id,
        ...(state === undefined ? {} : { state }),
      };
  }
}

export function observeInboxSnapshot(snapshot: InboxSnapshot): InboxSnapshotObservation {
  return {
    schema: 1,
    kind: "inbox.snapshot",
    as_of: snapshot.as_of,
    pending: snapshot.pending,
    by_class: { ...snapshot.by_class },
    by_source: { ...snapshot.by_source },
    oldest_age_ms: snapshot.oldest_age_ms,
    dead_letter: snapshot.dead_letter,
    unknown: snapshot.unknown,
    digest_due_at: snapshot.digest_due_at,
  };
}
