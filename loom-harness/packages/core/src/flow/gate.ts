/**
 * FlowGate（L3）—— 把共享提交槽翻译成 run 终止的唯一 hook 接线层。
 *
 * 判别规则：
 *   - onTurnEnd 只接受 `session_id + turn_idx` 双匹配的 FLOW_COMMIT_SLOT；
 *     过期槽（上一 turn / 别的 session）永不终止本轮。
 *   - terminal（waiting_user / waiting_event / closed）→ continue:false，
 *     stopReason 固定为 `flow:<state>:<subject_id>`；active → 放行。
 *   - 无提交的回合恰记一条 appendUnset；store 失败 fail-open（不终止、不抛错）。
 *
 * 本文件不 import convergence，也不催办/强制续跑：gate 只做「提交了才终止」，
 * 不替模型发明回合。
 */

import type { Hook, HookContext, HookResult, TurnEndInput } from "../hook.js";
import { FLOW_COMMIT_SLOT, type FlowCommitSlot } from "./slot.js";
import type { FlowStore } from "./store.js";
import type { FlowState, FlowUnsetReason } from "./types.js";

export interface FlowGateOptions {
  readonly store: FlowStore;
}

/** L4 消费的终态视图：只在本 run 受理了 terminal 提交时非 null。 */
export interface FlowRunOutcome {
  readonly subject_id: string;
  readonly subject_name: string;
  readonly state: FlowState;
  readonly next_decision_at: number | null;
}

function isTerminalFlowState(state: FlowState): boolean {
  switch (state) {
    case "active":
      return false;
    case "waiting_user":
    case "waiting_event":
    case "closed":
      return true;
    default: {
      const unreachable: never = state;
      throw new Error(`unhandled FlowState: ${String(unreachable)}`);
    }
  }
}

/** 双匹配：槽必须来自本 session 的本 turn，否则视为本回合没有提交。 */
function currentCommit(
  ctx: HookContext,
  turnIdx: number,
): FlowCommitSlot | null {
  const slot = ctx.state.get(FLOW_COMMIT_SLOT) ?? null;
  if (slot === null) return null;
  if (slot.session_id !== ctx.sessionId) return null;
  if (slot.turn_idx !== turnIdx) return null;
  return slot;
}

/**
 * 无提交回合的 unset 原因：无工具结果且 assistant 已终局（非 toolUse）时视为
 * run 的最后一个 assistant 回合；其余为普通 no_commit。
 */
function unsetReasonOf(input: TurnEndInput): FlowUnsetReason {
  const finalAssistantTurn =
    input.toolResults.length === 0 &&
    input.assistantMessage.stopReason !== "toolUse";
  return finalAssistantTurn ? "run_end_no_commit" : "no_commit";
}

export class FlowGate {
  private readonly _store: FlowStore;
  private _outcome: FlowRunOutcome | null = null;
  private _unsetTurn: number | null = null;

  constructor(opts: FlowGateOptions) {
    this._store = opts.store;
  }

  /** 本 run 受理的 terminal 提交；active 提交或未提交均为 null。 */
  runOutcome(): FlowRunOutcome | null {
    return this._outcome;
  }

  /** 每 run 起点：清槽 + 清终态视图 + 清 unset 去重哨兵。 */
  private _reset(ctx: HookContext): void {
    ctx.state.set(FLOW_COMMIT_SLOT, null);
    this._outcome = null;
    this._unsetTurn = null;
  }

  buildHooks(): Hook[] {
    return [
      {
        name: "flow-gate",
        timeout: 200,

        onSessionStart: (_input, ctx) => {
          this._reset(ctx);
        },

        onTurnEnd: async (input, ctx): Promise<HookResult | void> => {
          const slot = currentCommit(ctx, input.turnIdx);
          if (slot !== null) {
            if (!isTerminalFlowState(slot.state)) return;
            this._outcome = {
              subject_id: slot.subject_id,
              subject_name: slot.subject_name,
              state: slot.state,
              next_decision_at: slot.next_decision_at,
            };
            return {
              continue: false,
              stopReason: `flow:${slot.state}:${slot.subject_id}`,
            };
          }

          // 同一 turn 只记一条（hook 被重复派发时也不重复落审计）。
          if (this._unsetTurn === input.turnIdx) return;
          this._unsetTurn = input.turnIdx;
          try {
            await this._store.appendUnset(ctx.sessionId, {
              turn_idx: input.turnIdx,
              reason: unsetReasonOf(input),
              had_tool_results: input.toolResults.length > 0,
            });
          } catch {
            /* fail-open：审计面写失败不终止 run、不把错误抛给 dispatcher */
          }
        },
      },
    ];
  }
}
