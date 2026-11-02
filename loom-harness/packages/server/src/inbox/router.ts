/**
 * 收件箱投递路由（T3）：把 policy 的最终 route 映射到既有投递原语。
 *
 * 不新增第二队列/调度器：
 *   - interrupt -> registry.send()（interruptOnSend=true 时可由 registry  abort 当前轮）
 *   - notify    -> registry.deliverWake()（只入 durable 队列，永不 abort）
 *   - digest    -> 只入账；由 InboxDigestRuntime 经既有 WakeQueue 排一次摘要唤醒
 *
 * send 回压（accepted:false，队列满）时降级为 notify：仍走 deliverWake，
 * 响应带 downgraded:"notify"，journal 记录实际 route。
 */

import type { SendOutcome } from "../session-api/types.js";
import { countsFromSnapshot, previewText, renderLetterEnvelope } from "./envelope.js";
import type { InboxJournalStore } from "./journal-store.js";
import type { InboxRoute, LetterRecord } from "./types.js";

export type InboxLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;

export interface InboxDeliveryTarget {
  send(sessionID: string, text: string): SendOutcome;
  deliverWake(
    sessionID: string,
    line: string,
    notifyProps?: Readonly<Record<string, unknown>>,
  ): void;
}

export interface InboxDigestTrigger {
  reconcile(): Promise<void> | void;
}

export interface InboxDeliveryDeps {
  readonly store: InboxJournalStore;
  readonly registry: InboxDeliveryTarget;
  readonly sessionID: string;
  readonly now: number;
  readonly log?: InboxLog;
  readonly digest?: InboxDigestTrigger;
}

export interface InboxDeliveryResult {
  readonly route: InboxRoute;
  readonly downgraded?: "notify";
  readonly interrupted?: true;
  readonly queued?: true;
}

function notifyProps(record: LetterRecord): Readonly<Record<string, unknown>> {
  const message = record.title ?? previewText(record.body, 80);
  return { title: "收件箱通知", message, variant: "info" };
}

function routedEvent(
  record: LetterRecord,
  route: InboxRoute,
  at: number,
): Parameters<InboxJournalStore["appendEvent"]>[0] {
  return {
    schema: 1,
    event: "letter.routed",
    at,
    id: record.id,
    route,
    class: record.class,
  };
}

function countsFor(store: InboxJournalStore, now: number, ids: readonly string[]) {
  return countsFromSnapshot(store.snapshot({ now }), ids);
}

async function deliverInterrupt(
  record: LetterRecord,
  deps: InboxDeliveryDeps,
): Promise<InboxDeliveryResult> {
  const counts = countsFor(deps.store, deps.now, [record.id]);
  const envelope = renderLetterEnvelope(record, "full", counts);
  deps.store.appendEvent(routedEvent(record, "send", deps.now));
  const outcome = deps.registry.send(deps.sessionID, envelope);
  if (!outcome.accepted) {
    deps.store.appendEvent(routedEvent(record, "deliver_wake", deps.now));
    deps.registry.deliverWake(
      deps.sessionID,
      renderLetterEnvelope(record, "preview", counts),
      notifyProps(record),
    );
    return { route: "deliver_wake", downgraded: "notify" };
  }
  return {
    route: "send",
    ...("interrupted" in outcome ? { interrupted: true as const } : {}),
    ...("queued" in outcome ? { queued: true as const } : {}),
  };
}

function deliverNotify(
  record: LetterRecord,
  deps: InboxDeliveryDeps,
): InboxDeliveryResult {
  const counts = countsFor(deps.store, deps.now, [record.id]);
  deps.store.appendEvent(routedEvent(record, "deliver_wake", deps.now));
  deps.registry.deliverWake(
    deps.sessionID,
    renderLetterEnvelope(record, "preview", counts),
    notifyProps(record),
  );
  return { route: "deliver_wake" };
}

async function deliverDigest(
  record: LetterRecord,
  deps: InboxDeliveryDeps,
): Promise<InboxDeliveryResult> {
  if (deps.digest === undefined) {
    deps.log?.("warn", "loom inbox digest accepted without scheduler", {
      letterID: record.id,
    });
    return { route: "digest" };
  }
  try {
    await deps.digest.reconcile();
  } catch (error: unknown) {
    deps.log?.("warn", "loom inbox digest reconcile failed", {
      letterID: record.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { route: "digest" };
}

export async function deliverAcceptedLetter(
  record: LetterRecord,
  deps: InboxDeliveryDeps,
): Promise<InboxDeliveryResult> {
  switch (record.class) {
    case "interrupt":
      return deliverInterrupt(record, deps);
    case "notify":
      return deliverNotify(record, deps);
    case "digest":
      return deliverDigest(record, deps);
    default: {
      const _exhaustive: never = record.class;
      return _exhaustive;
    }
  }
}
