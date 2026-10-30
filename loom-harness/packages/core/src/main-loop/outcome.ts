/**
 * Outcome 消费（T10）—— 把 T09 的 ConvergenceOutcome 判别联合翻译成主循环的记账与合成终态。
 *
 * 消费映射（docs/01 D25/D26 冻结语义）：
 *   - continued  → 续：闸放行了下一轮（内核 turn loop 已在跑），仅记账 round-continued。
 *   - nudged     → 催办：gate 已把催办**持久注入**会话消息（persist / turnEndGuard 通道），
 *                  循环侧记 nudge-injected。
 *   - escalated  → 升级提示：如实记账（不终止会话）。
 *   - converged  → 真收束终态（唯一"完成"通道）。
 *   - forceEnded → 强制收束终态：主会话恒为"需用户确认"，**绝不静默假完成**。
 *
 * 另有循环级合成终态：跨请求自动续跑预算（Limits.autoContinuations，默认 2）用尽且
 * gate 仍未盖棺时，主会话**自动收束"需用户确认"**（budgetExhaustedReceipt，如实说明卡点）。
 */

import { createUserMessage } from "../types.js";
import { FORCE_MARK } from "../convergence/receipt.js";
import type { ConvergenceOutcome, ForceReason, MainReceipt, Receipt } from "../convergence/receipt.js";
import type { Limits } from "../convergence/limits.js";
import type { Message } from "@earendil-works/pi-ai";
import type { RunSummary } from "../session.js"; // // 环纪律：深路径直引，不 import 自身 barrel（见 convergence/gate.ts 注释）
import type { OutcomeDisposition } from "./types.js";

/** 判别联合 → 记账处置（exhaustive switch，新变体漏处理编译期即失败）。 */
export function classifyOutcome(outcome: ConvergenceOutcome): OutcomeDisposition {
  switch (outcome.type) {
    case "converged":
      return "terminal-converged";
    case "forceEnded":
      return "terminal-forced";
    case "nudged":
      return "nudge-injected";
    case "escalated":
      return "escalation-recorded";
    case "continued":
      return "round-continued";
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled ConvergenceOutcome: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * 盖棺判据（gate.ts 冻结的 T10 接线契约）：gate 账本 terminal 是唯一真相，
 * 不是 `reason==="done"`。terminal 缺席时按内核 reason 归类非收束终态：
 * pending = 未盖棺（done / max_turns / max_continuations），交循环跨请求续跑。
 */
export type TerminalDecision =
  | { kind: "converged"; receipt: Receipt }
  | { kind: "forceEnded"; cause: ForceReason; receipt: Receipt; deadLetter: boolean }
  | { kind: "userAbort" }
  | { kind: "error" }
  | { kind: "pending" };

export function classifyTerminal(
  terminal: ConvergenceOutcome | null,
  summary: RunSummary,
): TerminalDecision {
  if (terminal !== null) {
    switch (terminal.type) {
      case "converged":
        return { kind: "converged", receipt: terminal.receipt };
      case "forceEnded":
        return {
          kind: "forceEnded",
          cause: terminal.reason,
          receipt: terminal.receipt,
          deadLetter: terminal.deadLetter,
        };
      case "nudged":
      case "escalated":
      case "continued":
        break;
      default: {
        const unreachable: never = terminal;
        throw new Error(`unhandled terminal outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  }
  switch (summary.reason) {
    case "error":
      return { kind: "error" };
    case "aborted":
      // gate terminal 缺席的 abort = 用户/外部 abort（store 完整，可 resume）。
      return { kind: "userAbort" };
    case "done":
    case "max_turns":
    case "max_continuations":
      return { kind: "pending" };
    default: {
      const unreachable: never = summary.reason;
      throw new Error(`unhandled RunSummary.reason: ${String(unreachable)}`);
    }
  }
}

/**
 * 自动续跑预算用尽的合成"需用户确认"回执（D26 超限分级处置：主会话=自动收束，
 * 如实说明卡点，绝不静默假完成）。文案与 gate 的 makeForceReceipt 同构，
 * 原因字段如实为 auto-continuations-exhausted。
 */
export function budgetExhaustedReceipt(limits: Limits): MainReceipt {
  const detail =
    `跨请求自动续跑上限 ${limits.autoContinuations} 次已用尽，` +
    "会话仍未给出合法收束回执，已由主循环自动收束";
  return {
    status: "需用户确认",
    digest: `需用户确认：触发自动续跑上限——${detail}`,
    body:
      `${detail}。模型在 ${limits.autoContinuations + 1} 次请求内均未调用 converge 给出` +
      "必填字段齐全的回执，请用户确认后续处置（继续下达指令或人工介入）。",
    pointers: [],
    blockers: ["自动续跑上限"],
  };
}

/**
 * 自动收束的持久 marker（与 gate 的强制收束 marker 同格式：user role +
 * `_meta.kind="convergence_receipt"`，resume / 审计侧可用同一判据提取）。
 */
export function forceMarker(receipt: MainReceipt): Message {
  const marker = createUserMessage(`${FORCE_MARK}${receipt.digest}`) as Message & {
    _meta?: Record<string, unknown>;
  };
  marker._meta = {
    kind: "convergence_receipt",
    result: {
      converged: false,
      outcome: {
        type: "forceEnded",
        reason: "auto-continuations-exhausted",
        receipt,
        deadLetter: false,
      },
      receipt,
      deadLetter: false,
    },
  };
  return marker;
}
