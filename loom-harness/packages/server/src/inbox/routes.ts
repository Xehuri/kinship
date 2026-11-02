/**
 * 收件箱 HTTP 入口（T3）。
 *
 * 端点：
 *   POST /inbox/letters —— 外部异步来源入箱；用户聊天仍走 /sessions/:id/messages。
 *   GET  /inbox/status  —— 只读积压/按类/按源/摘要到期面。
 *
 * 响应映射（与 docs/dev/loom-inbox-contract.md §6 对齐）：
 *   503 inbox_disabled / 400 invalid_letter / 403 source_unregistered|trust_ceiling /
 *   410 letter_expired / 413 letter_body_too_large / 429 rate_limited|inbox_full /
 *   200 duplicate / 202 coalesced|accepted|observed。
 *
 * 鉴权继承 http/Router（无未鉴权路径）。off 模式仍注册这两个路由但一律 503
 * （便于区分"未装配"与"路由不存在"），此时不创建 store。
 * trusted_service/user 的限速直接 429 回压；external 不回压，按 policy 降级 class
 * 继续投递（确定性规则集中在 ingress.ts 的 rateLimitReason/retryAfterSeconds）。
 */

import type { ServerResponse } from "node:http";

import type { InboxConfig, InboxMode, InboxSourceConfig } from "../config/section-checks.js";
import { readJsonBody, sendJson } from "../http/index.js";
import type { Router } from "../http/router.js";
import { DEFAULT_MAX_BODY_BYTES, TRUST_RANK } from "./defaults.js";
import {
  publicDecision,
  rateLimitReason,
  recordSuppression,
  respondSuppressed,
  retryAfterSeconds,
  sendError,
  validateOrRespond,
} from "./ingress.js";
import type { InboxJournalStore } from "./journal-store.js";
import { classify } from "./policy.js";
import {
  deliverAcceptedLetter,
  type InboxDeliveryTarget,
  type InboxDigestTrigger,
  type InboxLog,
} from "./router.js";
import type {
  InboxPolicyDecision,
  InboxPolicyIndex,
  LetterInput,
} from "./types.js";

export interface InboxPolicyEngine {
  readonly config: InboxConfig;
  classify(
    input: LetterInput,
    source: InboxSourceConfig | undefined,
    now: number,
    index: InboxPolicyIndex,
  ): InboxPolicyDecision;
}

export function createInboxPolicyEngine(config: InboxConfig): InboxPolicyEngine {
  return {
    config,
    classify: (input, source, now, index) => classify(input, source, now, { ...config, index }),
  };
}

export interface InboxRouteDeps {
  readonly store: InboxJournalStore | undefined;
  readonly policy: InboxPolicyEngine;
  readonly registry: InboxDeliveryTarget;
  readonly sessionID: string;
  readonly mode: InboxMode;
  readonly log?: InboxLog;
  readonly now?: () => number;
  readonly digest?: InboxDigestTrigger;
}

export function registerInboxRoutes(router: Router, deps: InboxRouteDeps): void {
  const nowOf = deps.now ?? Date.now;

  router.add("POST", "/inbox/letters", async (req, res) => {
    const store = deps.store;
    if (deps.mode === "off" || store === undefined) {
      sendError(res, 503, "inbox_disabled", "inbox is disabled (mode=off)");
      return;
    }
    const now = nowOf();
    const raw = await readJsonBody(req);
    const maxBodyBytes = deps.policy.config.limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const input = validateOrRespond(res, raw, maxBodyBytes);
    if (input === null) return;

    const source = deps.policy.config.sources?.[input.source];
    if (source === undefined) {
      recordSuppression(store, input, input.trust, input.class, "source_unregistered", now);
      respondSuppressed(res, "source_unregistered");
      return;
    }
    if (source.maxTrust !== undefined && TRUST_RANK[input.trust] > TRUST_RANK[source.maxTrust]) {
      recordSuppression(store, input, source.maxTrust, input.class, "trust_ceiling", now);
      respondSuppressed(res, "trust_ceiling");
      return;
    }

    const decision = deps.policy.classify(input, source, now, store.policyIndex());
    switch (decision.outcome) {
      case "duplicate": {
        const result = store.append(input, { decision, now });
        if (result.outcome !== "duplicate") {
          throw new Error("inbox duplicate decision did not record a deduped event");
        }
        const existing = store.get(result.existing_id);
        sendJson(res, 200, {
          duplicate: true,
          letter_id: result.existing_id,
          state: existing?.state ?? "unknown",
        });
        return;
      }
      case "coalesced": {
        const result = store.append(input, { decision, now });
        if (result.outcome !== "coalesced") {
          throw new Error("inbox coalesced decision did not record a coalesced event");
        }
        sendJson(res, 202, {
          accepted: true,
          coalesced: true,
          target_id: result.target_id,
        });
        return;
      }
      case "suppressed": {
        store.append(input, { decision, now });
        respondSuppressed(res, decision.reason);
        return;
      }
      case "accepted": {
        await acceptLetter(res, deps, store, input, source, decision, now);
        return;
      }
      default: {
        const _exhaustive: never = decision.outcome;
        return _exhaustive;
      }
    }
  });

  router.add("GET", "/inbox/status", (_req, res) => {
    const store = deps.store;
    if (deps.mode === "off" || store === undefined) {
      sendError(res, 503, "inbox_disabled", "inbox is disabled (mode=off)");
      return;
    }
    const now = nowOf();
    const knownSources = Object.keys(deps.policy.config.sources ?? {});
    const snapshot = store.snapshot({ now, knownSources });
    sendJson(res, 200, {
      as_of: snapshot.as_of,
      mode: deps.mode,
      pending: snapshot.pending,
      by_class: snapshot.by_class,
      by_source: snapshot.by_source,
      oldest_age_ms: snapshot.oldest_age_ms,
      dead_letter: snapshot.dead_letter,
      unknown: snapshot.unknown,
      digest_due_at: snapshot.digest_due_at,
      session_id: deps.sessionID,
    });
  });
}

async function acceptLetter(
  res: ServerResponse,
  deps: InboxRouteDeps,
  store: InboxJournalStore,
  input: LetterInput,
  source: InboxSourceConfig,
  decision: InboxPolicyDecision,
  now: number,
): Promise<void> {
  if (decision.route === "observed") {
    const observed = store.append(input, { decision, now });
    if (observed.outcome !== "observed") {
      throw new Error("inbox shadow decision did not record an observed letter");
    }
    sendJson(res, 202, {
      accepted: true,
      observed: true,
      decision: publicDecision(decision),
    });
    return;
  }

  const rateReason = rateLimitReason(decision);
  if (rateReason !== undefined && decision.trust !== "external") {
    recordSuppression(store, input, decision.trust, decision.class, rateReason, now);
    const retryAfter = retryAfterSeconds(rateReason, source, store, input.source, now);
    res.setHeader("Retry-After", String(retryAfter));
    sendError(res, 429, "rate_limited", `source is rate limited (${rateReason})`, {
      retry_after_s: retryAfter,
      reason: rateReason,
    });
    return;
  }

  const result = store.append(input, { decision, now });
  if (result.outcome !== "received") {
    throw new Error(`inbox accepted decision recorded ${result.outcome}`);
  }
  const record = result.record;
  const delivery = await deliverAcceptedLetter(record, {
    store,
    registry: deps.registry,
    sessionID: deps.sessionID,
    now,
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.digest === undefined ? {} : { digest: deps.digest }),
  });
  deps.log?.("debug", "loom inbox accepted", {
    letterID: record.id,
    source: record.source,
    class: record.class,
    route: delivery.route,
  });
  sendJson(res, 202, {
    accepted: true,
    letter_id: record.id,
    class: record.class,
    route: delivery.route,
    ...(delivery.downgraded === undefined ? {} : { downgraded: delivery.downgraded }),
    ...(delivery.interrupted === true ? { interrupted: true } : {}),
    ...(delivery.queued === true ? { queued: true } : {}),
  });
}
