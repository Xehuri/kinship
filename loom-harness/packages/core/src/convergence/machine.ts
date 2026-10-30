/**
 * 收束状态机的纯 reducer（D25/D26 阈值的判别逻辑全在这里；gate.ts 只做 hook 接线与
 * effect 解释）。状态 = 一个离散记录（RunState），无隐式布尔堆叠；每条规则产出一条
 * ConvergenceOutcome 进账本，终止判定穷尽于 onTurnEnd。
 *
 * 不变量：
 *   - 每轮催办至多计一次（execute 层拒收与 schema 层拒收两通道互斥）。
 *   - terminal 一旦落定不再改变；任何后续 turn 直接 terminate（幂等盖棺）。
 *   - 非 converged 的一切终止必为 forceEnded + 如实合成回执（绝不静默假完成）。
 */

import {
  DEAD_LETTER_MARK,
  ESCALATE_MARK,
  FORCE_MARK,
  makeForceReceipt,
  nudgeText,
  receiptStatusOf,
  type ConvergenceOutcome,
  type NudgeReason,
  type Receipt,
  type SessionKind,
} from "./receipt.js";
import type { Limits } from "./limits.js";
import type { AcceptedConvergence, ConvergeFailInfo } from "./tool.js";

interface ErrorTally {
  count: number;
  escalated: boolean;
}

/** gate 的离散运行态（唯一可变记录；reducer 之外不得直接改）。 */
export interface RunState {
  sessionId: string;
  nudges: number;
  pendingNudge: string | null;
  convergeFailCountedTurn: number;
  outcomes: ConvergenceOutcome[];
  terminal: ConvergenceOutcome | null;
  errors: Map<string, ErrorTally>;
}

export function newRunState(): RunState {
  return {
    sessionId: "",
    nudges: 0,
    pendingNudge: null,
    convergeFailCountedTurn: -1,
    outcomes: [],
    terminal: null,
    errors: new Map(),
  };
}

export type GateEffect =
  | { kind: "terminate"; stopReason: string }
  | { kind: "nudge-tool-output"; text: string }
  | { kind: "persist"; text: string }
  | {
      kind: "force-end";
      stopReason: string;
      finalNudge: string | null;
      markerText: string;
      outcome: ConvergenceOutcome & { type: "forceEnded" };
    }
  | { kind: "log-warn"; msg: string; fields: Record<string, unknown> };

export interface ToolResultEvent {
  readonly turnIdx: number;
  readonly toolName: string;
  readonly isConvergeCall: boolean;
  readonly isError: boolean;
  readonly resultText: string;
  /** execute 层拒收原因（gate 从 FAIL_SLOT FIFO 弹出后传入；schema 拒收为 null）。 */
  readonly convergeFail: ConvergeFailInfo | null;
}

function bumpOutcome(
  state: RunState,
  outcome: ConvergenceOutcome,
): void {
  state.outcomes.push(outcome);
}

/** 干活工具同错计数 + converge 失败催办（不终止会话，只产 effect）。 */
export function observeToolResult(
  state: RunState,
  ev: ToolResultEvent,
  limits: Limits,
  sessionId: string,
  turnIdx: number,
): GateEffect[] {
  const effects: GateEffect[] = [];

  if (ev.isConvergeCall) {
    if (!ev.isError) return effects;
    const reason: NudgeReason = ev.convergeFail?.reason ?? "fields";
    const detail = ev.convergeFail?.detail ?? ev.resultText;
    state.nudges += 1;
    state.convergeFailCountedTurn = ev.turnIdx;
    bumpOutcome(state, { type: "nudged", reason, nudgeCount: state.nudges });
    effects.push({
      kind: "nudge-tool-output",
      text: nudgeText(reason, detail, state.nudges, limits.nudgeLimit),
    });
    return effects;
  }

  if (!ev.isError) return effects;
  const key = `${ev.toolName}::${ev.resultText}`;
  const tally = state.errors.get(key) ?? { count: 0, escalated: false };
  tally.count += 1;
  state.errors.set(key, tally);
  if (tally.count >= limits.escalateSameError && !tally.escalated) {
    tally.escalated = true;
    bumpOutcome(state, {
      type: "escalated",
      tool: ev.toolName,
      errorText: ev.resultText,
      attempt: tally.count,
    });
    effects.push({
      kind: "persist",
      text:
        `${ESCALATE_MARK}同工具同错误 ×${tally.count}（${ev.toolName}：${ev.resultText}）。` +
        "停止重复同一动作：换思路处理该错误，或如实调用 converge 说明卡点（不许假完成）。",
    });
    effects.push({
      kind: "log-warn",
      msg: "convergence: same-tool-same-error escalated",
      fields: { hook: "convergence-gate", tool: ev.toolName, count: tally.count, sessionId, turnIdx },
    });
  }
  return effects;
}

export interface TurnEndEvent {
  readonly turnIdx: number;
  readonly toolResultsCount: number;
  readonly hadConvergeCall: boolean;
  /** schema 层拒收的明细文本（仅 hadConvergeCall 且未被 PostToolUse 记账时使用）。 */
  readonly schemaRejectDetail: string;
  readonly accepted: AcceptedConvergence | null;
}

/**
 * converged 终态形状唯一构造器：强制路（decideTurnEnd）与 W47 终审子集
 * （decideNaturalTerminal）经同一 acceptEffects 共用，杜绝两路各手抄一份
 * 造成账本条目/回执前缀漂移。
 */
function convergedOutcomeOf(accepted: AcceptedConvergence): ConvergenceOutcome {
  return { type: "converged", status: accepted.receipt.status, receipt: accepted.receipt };
}

/**
 * 受理盖棺的唯一 effect 序列（强制/自然停两路共用体）：terminal 定稿 + 落账 +
 * terminate "convergence:converged:<status>"。改标门面与 isConvergedTermination
 * 判据（gate.ts / loop.ts convergeTerminalStore）全部认这一条前缀通道。
 */
function acceptEffects(state: RunState, accepted: AcceptedConvergence): GateEffect[] {
  const outcome = convergedOutcomeOf(accepted);
  state.terminal = outcome;
  bumpOutcome(state, outcome);
  return [
    {
      kind: "terminate",
      stopReason: `convergence:converged:${receiptStatusOf(accepted.receipt)}`,
    },
  ];
}

/**
 * W47 自然停终审 reducer（主会话 convergenceEnforced:false 的唯一判别）：
 * 本 run 本 turn 有受理（accepted.turnIdx === ev.turnIdx）→ 盖棺终结，兑现
 * "收束已受理，本轮到此结束。"；其余一律放行空 effect。
 * 不催办、不分级、不读 limits/nudgeLimit/turnHardCap——自然停 =「系统不催办、
 * 不强制续跑、不封顶杀」，但模型自愿 converge 的受理必须真实终结本轮（hm/ai
 * 挂死事故的根因修复；W26 免强制语义边界保持）。
 */
export function decideNaturalTerminal(
  state: RunState,
  ev: TurnEndEvent,
): GateEffect[] {
  if (ev.accepted !== null && ev.accepted.turnIdx === ev.turnIdx) {
    return acceptEffects(state, ev.accepted);
  }
  return [];
}

function forceOutcome(
  kind: SessionKind,
  reason: "nudge-limit" | "turn-hard-cap",
  limits: Limits,
): { outcome: ConvergenceOutcome & { type: "forceEnded" }; markerText: string } {
  const receipt = makeForceReceipt(kind, reason, limits);
  const deadLetter = kind === "side";
  const outcome = { type: "forceEnded" as const, reason, receipt, deadLetter };
  const head = deadLetter
    ? `${DEAD_LETTER_MARK}${receipt.digest}（副会话强制收束，死信投主会话处置）`
    : `${FORCE_MARK}${receipt.digest}`;
  return { outcome, markerText: head };
}

/** 终止判别：converged → 盖棺；催办满 → 分级强制；硬顶 → 分级强制；否则放行。 */
export function decideTurnEnd(
  state: RunState,
  kind: SessionKind,
  ev: TurnEndEvent,
  limits: Limits,
  sessionId: string,
): GateEffect[] {
  if (state.terminal !== null) {
    return [{ kind: "terminate", stopReason: "convergence:already-terminated" }];
  }

  if (ev.accepted !== null && ev.accepted.turnIdx === ev.turnIdx) {
    return acceptEffects(state, ev.accepted);
  }

  const forceEnd = (
    reason: "nudge-limit" | "turn-hard-cap",
    finalNudge: string | null,
  ): GateEffect[] => {
    const { outcome, markerText } = forceOutcome(kind, reason, limits);
    state.terminal = outcome;
    state.pendingNudge = null;
    bumpOutcome(state, outcome);
    return [
      {
        kind: "log-warn",
        msg: `convergence: forced end (${reason})`,
        fields: { hook: "convergence-gate", reason, kind, sessionId, turnIdx: ev.turnIdx },
      },
      {
        kind: "force-end",
        stopReason: `convergence:${reason}:forced`,
        finalNudge,
        markerText,
        outcome,
      },
    ];
  };

  const schemaNudgeEffects: GateEffect[] = [];
  if (ev.hadConvergeCall && state.convergeFailCountedTurn !== ev.turnIdx) {
    state.nudges += 1;
    state.convergeFailCountedTurn = ev.turnIdx;
    bumpOutcome(state, { type: "nudged", reason: "fields", nudgeCount: state.nudges });
    schemaNudgeEffects.push({
      kind: "persist",
      text: nudgeText("fields", ev.schemaRejectDetail, state.nudges, limits.nudgeLimit),
    });
  }

  const textOnly = ev.toolResultsCount === 0 && !ev.hadConvergeCall;
  if (textOnly) {
    state.nudges += 1;
    bumpOutcome(state, { type: "nudged", reason: "text-only", nudgeCount: state.nudges });
    state.pendingNudge = nudgeText(
      "text-only",
      "上一轮以纯文本结束；只有 converge 成功调用才能结束会话。",
      state.nudges,
      limits.nudgeLimit,
    );
  }

  if (state.nudges >= limits.nudgeLimit) {
    return [...schemaNudgeEffects, ...forceEnd("nudge-limit", textOnly ? state.pendingNudge : null)];
  }

  if (ev.turnIdx + 1 >= limits.turnHardCap) {
    return [...schemaNudgeEffects, ...forceEnd("turn-hard-cap", null)];
  }

  bumpOutcome(state, { type: "continued", nudgeCount: state.nudges });
  return schemaNudgeEffects;
}

/** guard.check 的续跑决策（事件时刻现读 limits，热载即刻生效）。 */
export function decideContinuation(
  state: RunState,
  limits: Limits,
): { ok: true } | { ok: false; message: string } {
  if (state.terminal !== null) return { ok: true };
  if (state.nudges >= limits.nudgeLimit) return { ok: true };
  return {
    ok: false,
    message:
      state.pendingNudge ??
      "会话尚未收束：请在正文同一轮调用 converge，给出必填字段齐全的回执。",
  };
}

export function receiptOfOutcome(o: ConvergenceOutcome): Receipt {
  switch (o.type) {
    case "converged":
    case "forceEnded":
      return o.receipt;
    case "nudged":
    case "escalated":
    case "continued":
      throw new Error(`outcome ${o.type} carries no receipt`);
    default: {
      const unreachable: never = o;
      throw new Error(`unhandled outcome: ${String(unreachable)}`);
    }
  }
}
