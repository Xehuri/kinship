/**
 * ConvergenceGate（D25/D26/D30/D31）—— 收束终止机制的 hook 接线层。
 *
 * 判别逻辑全部在 machine.ts（纯 reducer）；本文件只把 reducer 的 GateEffect 翻译成
 * 内核 hook 动作。建在已移植的 turn-end-guard（持久注入 + 强制续跑引擎）之上；
 * token-budget 可选组合。不改二者既有行为。
 *
 * 终止通道（内核事实，T10 接线必读）：
 *   - 成功收束：收束 turn 必含 toolCall → 内核该 turn 后只会「继续下一轮」，永不自然
 *     done；gate 在 onTurnEnd 见 convergence.accepted → {continue:false} → 内核 abort →
 *     RunSummary.reason==="aborted" 且 abortReason 以 "convergence:converged" 开头。
 *     这就是「本轮到此结束」。**判据 = abortReason 前缀 + runOutcome()，不是 reason==="done"。**
 *   - 分级强制收束（催办上限 / 轮数硬顶）：先落一条如实合成回执（持久 marker，
 *     _meta.kind="convergence_receipt"）再终止；stopReason 含 "convergence:nudge-limit" /
 *     "convergence:turn-hard-cap"。副会话 deadLetter=true（死信投主由 T12/T13 消费）。
 *   - 绝不静默假完成：非 converged 的一切终止都是 forceEnded + 合成回执。
 *
 * 阈值全部从注入的 Limits 对象**事件时刻现读**（热载可改，不快照）。
 * 生命周期：一个 gate 实例绑定一个 session（buildHooks() / buildAdjudicationHooks()
 * 合计只可调一次）。
 *
 * W47 hook 拆分（主会话自然停专用）：
 *   - 强制子集 = buildHooks() 全量（催办/分级/盖棺/turnEndGuard，side/子会话与
 *     enforced 主会话挂载面，语义逐字节不变）。
 *   - 终审子集 = buildAdjudicationHooks()：仅 onSessionStart 复位（槽/账本/run 代际）
 *     + onTurnEnd 受理判别（accepted.turnIdx===本 turn → terminate "convergence:converged:*"）。
 *     不含任何催办/分级/硬顶——"自然停 = 系统不催办、不强制续跑、不封顶杀，
 *     但模型自愿 converge 的受理必须真实终结本轮"（用户批准语义，修复 hm/ai 挂死事故）。
 */

// 环纪律（vitest SSR 实测坑）：包内模块**不得** import 自身 barrel "../index.js"——
// barrel `export *` 回指本目录时形成环，SSR 图按入口顺序解析会丢活绑定
// （症状："ConvergenceGate is not a constructor"）。深路径直引真源。
import { createUserMessage, type HarnessTool, type ToolExecResult } from "../types.js";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { tokenBudget } from "../plugins/token-budget.js";
import { turnEndGuard } from "../plugins/turn-end-guard.js";
import type { Hook, HookContext, HookResult, TurnEndInput } from "../hook.js";
import type { ConvergenceOutcome } from "./receipt.js";
import type { NudgeReason } from "./receipt.js";
import { DEFAULT_LIMITS, assertValidLimits, type Limits } from "./limits.js";
import {
  type Receipt,
  type SessionKind,
} from "./receipt.js";
import {
  ACCEPTED_SLOT,
  ConvergenceTool,
  FAIL_SLOT,
  RUN_GEN_SLOT,
  isConvergeCallName,
  type AcceptedConvergence,
  type ConvergeFailInfo,
} from "./tool.js";
import {
  decideContinuation,
  decideNaturalTerminal,
  decideTurnEnd,
  newRunState,
  observeToolResult,
  type GateEffect,
  type RunState,
  type ToolResultEvent,
  type TurnEndEvent,
} from "./machine.js";

/**
 * 催办观察事件（B 面：server 装配把每条 nudged outcome 落 trace nudge 行）。
 * 由 gate 在 outcome 账本新增 nudged 条目时同步发出；纯观测，不参与判别。
 */
export interface NudgeObservation {
  readonly sessionId: string;
  readonly turnIdx: number;
  /** 催办原因（与 machine reducer 的 nudged outcome 同源）。 */
  readonly reason: NudgeReason;
  /** 本 run 累计催办数（含本次；= outcome.nudgeCount）。 */
  readonly nudgeCount: number;
}

export interface ConvergenceGateOptions {
  readonly kind: SessionKind;
  /** 注入的阈值对象（可变；gate 事件时刻现读）。缺省 = DEFAULT_LIMITS 冻结值。 */
  readonly limits?: Limits;
  /** 可选 token 预算（组合已移植 token-budget 插件；缺省 = 不限）。 */
  readonly tokenBudget?: number;
  /**
   * 主会话自动唤醒开关：undefined = 启用（与 ConvergenceTool 缺省一致）；显式 false
   * 时 wake 键从 schema 消失、带 wake 的收束走 fields 拒收。仅主会话消费（side 无 wake）。
   */
  readonly autoWakeEnabled?: boolean;
  /** 可注入时钟（确定性测试）；缺省 = Date.now。仅用于 wake 解析。 */
  readonly now?: () => number;
  /**
   * 催办观察钩子（T21 trace nudge 行的生产接线点）：每条 nudged outcome
   * 恰回调一次（execute 层拒收 / schema 拒收 / text-only 三通道穷尽）。
   * 回调抛错被吞——观测面绝不反噬收束判别路径。
   */
  readonly onNudge?: (ev: NudgeObservation) => void;
}

export interface RunOutcomeView {
  /** 终止 outcome（converged / forceEnded）；run 未终止时 null。 */
  readonly outcome: ConvergenceOutcome | null;
  /** 本 run 全部 outcome 账本（含 nudged / escalated / continued）。 */
  readonly outcomes: ReadonlyArray<ConvergenceOutcome>;
}

export type ConvergenceTermination = "converged" | "not-converged";

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function resultText(result: ToolExecResult): string {
  return result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
}

function toolCallsOf(content: ReadonlyArray<{ type: string }>): ToolCall[] {
  return content.filter((b): b is ToolCall => b.type === "toolCall");
}

function receiptMarker(
  text: string,
  outcome: ConvergenceOutcome,
  receipt: Receipt,
  deadLetter: boolean,
): Message {
  const marker = createUserMessage(text) as Message & {
    _meta?: Record<string, unknown>;
  };
  marker._meta = {
    kind: "convergence_receipt",
    result: { converged: false, outcome, receipt, deadLetter },
  };
  return marker;
}

/** schema 拒收明细：converge 在 assistant content 里的位置 = toolResults 里的位置。 */
function schemaRejectDetail(input: TurnEndInput): string {
  const calls = toolCallsOf(input.assistantMessage.content);
  const idx = calls.findIndex((c) => isConvergeCallName(c.name));
  const result = idx >= 0 ? input.toolResults[idx] : undefined;
  const observed = result !== undefined ? truncate(resultText(result)) : "";
  return observed === ""
    ? "回执必填字段未过 schema 校验；补齐 status 等必填字段后重新收束。"
    : `schema 校验未过：${observed}`;
}

/**
 * 每 run 起点的状态复位唯一实现（强制 core 钩子与 W47 终审子集共用）：
 * 账本清零 + 槽清空 + run 代际 +1。槽复位必须与 hook 挂载同生死——registry 的
 * loop/ctx.state 按 sid 长驻而内核 turnIdx 每个 run 从 0 重数，残留 ACCEPTED_SLOT
 * 会假拒新 run 的合法首收敛、残留 FAIL_SLOT 无消费方时无界增长。代际再兜一层：
 * 即便复位因 hook 超时被跳过，tool 查重也不认旧代际受理（双保险）。
 */
function resetRunState(state: RunState, ctx: HookContext): void {
  state.sessionId = ctx.sessionId;
  state.nudges = 0;
  state.pendingNudge = null;
  state.convergeFailCountedTurn = -1;
  state.outcomes = [];
  state.terminal = null;
  state.errors = new Map();
  ctx.state.set(RUN_GEN_SLOT, (ctx.state.get(RUN_GEN_SLOT) ?? 0) + 1);
  ctx.state.set(ACCEPTED_SLOT, null);
  ctx.state.set(FAIL_SLOT, []);
}

/**
 * GateEffect → 内核 hook 动作的统一翻译层（强制 core 钩子与 W47 终审子集共用，
 * 一条 effect 序列只有一种解释）。"terminate" 短路返回；nudge/persist/force-end/
 * log-warn 只在强制路的 effect 流里出现。
 */
function runGateEffects(effects: GateEffect[], ctx: HookContext): HookResult | void {
  let updated: ToolExecResult | null = null;
  for (const e of effects) {
    switch (e.kind) {
      case "terminate":
        return { continue: false, stopReason: e.stopReason };
      case "nudge-tool-output":
        updated = {
          content: [{ type: "text", text: e.text }],
          isError: true,
        };
        break;
      case "persist":
        ctx.appendMessage(createUserMessage(e.text));
        break;
      case "force-end": {
        if (e.finalNudge !== null) ctx.appendMessage(createUserMessage(e.finalNudge));
        ctx.appendMessage(
          receiptMarker(e.markerText, e.outcome, e.outcome.receipt, e.outcome.deadLetter),
        );
        return { continue: false, stopReason: e.stopReason };
      }
      case "log-warn":
        ctx.log.warn(e.msg, e.fields);
        break;
      default: {
        const unreachable: never = e;
        throw new Error(`unhandled GateEffect: ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return updated !== null ? { updatedToolOutput: updated } : undefined;
}

export class ConvergenceGate {
  readonly kind: SessionKind;
  readonly limits: Limits;
  readonly tool: HarnessTool;

  private readonly _opts: ConvergenceGateOptions;
  private _run: RunState | null = null;
  private _built = false;

  constructor(opts: ConvergenceGateOptions) {
    const limits = opts.limits ?? DEFAULT_LIMITS;
    assertValidLimits(limits);
    this.kind = opts.kind;
    this.limits = limits;
    this._opts = opts;
    this.tool = ConvergenceTool(opts.kind, { ...(opts.autoWakeEnabled !== undefined ? { autoWakeEnabled: opts.autoWakeEnabled } : {}), ...(opts.now !== undefined ? { now: opts.now } : {}) });
  }

  /**
   * T10 接线校验用：内核 maxContinuations 至少要到催办上限，纯文本空转的催办
   * 才可能在被内核预算（reason:"max_continuations"）掐死前全部投递。
   */
  minKernelBudget(): number {
    return this.limits.nudgeLimit;
  }

  /** 收束盖棺的 run 必然 reason==="aborted"；用前缀区分「成功收束」与硬错误。 */
  isConvergedTermination(
    sessionId: string,
    abortReason: string | undefined,
  ): ConvergenceTermination {
    if (this._run === null || this._run.sessionId !== sessionId) {
      return "not-converged";
    }
    if (
      abortReason !== undefined &&
      abortReason.startsWith("convergence:converged")
    ) {
      return "converged";
    }
    return "not-converged";
  }

  runOutcome(): RunOutcomeView {
    if (this._run === null) {
      return { outcome: null, outcomes: [] };
    }
    return { outcome: this._run.terminal, outcomes: this._run.outcomes };
  }

  /** 每 gate 一次性占位运行态（buildHooks / buildAdjudicationHooks 两入口互斥共用）。 */
  private _claimRunState(): RunState {
    if (this._built) {
      throw new Error(
        "ConvergenceGate.buildHooks()/buildAdjudicationHooks() must be called once per gate (one gate = one session)",
      );
    }
    this._built = true;
    const state = newRunState();
    this._run = state;
    return state;
  }

  /**
   * W47 终审子集（主会话自然停取代全量 buildHooks 的 hook 面）：
   *   - onSessionStart = 每 run 起点复位（槽/账本/run 代际，见 resetRunState）——
   *     受理面（converge tool）在自然停照常挂，复位面绝不能因强制链整体缺席而失守。
   *   - onTurnEnd = 唯一终审：判别逻辑在 machine.decideNaturalTerminal（与强制路
   *     decideTurnEnd 的受理分支共用 acceptEffects——同 stopReason 前缀、同 converged
   *     账本形状），本钩子只做事件组装与 terminate 翻译；改标门面与
   *     isConvergedTermination 判据两路共用。
   * 催办/分级强制/turnHardCap/自动续跑全部不在场（W26 语义保留：不催办、不强制、
   * 不封顶杀；"受理必终结"不替模型发明回合——模型不收束就什么都不发生）。
   */
  buildAdjudicationHooks(): Hook[] {
    const state = this._claimRunState();
    const adjudicator: Hook = {
      name: "convergence-gate",
      timeout: 200,

      onSessionStart(_input, ctx) {
        resetRunState(state, ctx);
      },

      onTurnEnd(input: TurnEndInput, ctx) {
        const accepted: AcceptedConvergence | null = ctx.state.get(ACCEPTED_SLOT) ?? null;
        const calls = toolCallsOf(input.assistantMessage.content);
        const ev: TurnEndEvent = {
          turnIdx: input.turnIdx,
          toolResultsCount: input.toolResults.length,
          hadConvergeCall: calls.some((c) => isConvergeCallName(c.name)),
          // schemaRejectDetail 只喂催办文案（强制链专属），终审 reducer 不读它。
          schemaRejectDetail: "",
          accepted,
        };
        // decideNaturalTerminal 的 effect 形状穷尽：受理→[terminate]，其余→[]。
        const [effect] = decideNaturalTerminal(state, ev);
        if (effect === undefined || effect.kind !== "terminate") return;
        return { continue: false, stopReason: effect.stopReason };
      },
    };
    return [adjudicator];
  }

  buildHooks(): Hook[] {
    const state = this._claimRunState();
    const gate = this;

    // nudged outcome 观察者分发：reducer 只写账本，本函数把「账本新增的 nudged 条目」
    // 逐条翻译成 onNudge 回调（三通道穷尽；回调抛错吞掉，观测面不反噬判别路径）。
    const observeNudges = (before: number, sessionId: string, turnIdx: number): void => {
      const cb = gate._opts.onNudge;
      if (cb === undefined) return;
      for (let i = before; i < state.outcomes.length; i += 1) {
        const o = state.outcomes[i];
        if (o === undefined || o.type !== "nudged") continue;
        try {
          cb({ sessionId, turnIdx, reason: o.reason, nudgeCount: o.nudgeCount });
        } catch {
          /* fail-soft：观察面抛错只丢这一行 */
        }
      }
    };

    const core: Hook = {
      name: "convergence-gate",
      timeout: 200,

      onSessionStart(_input, ctx) {
        resetRunState(state, ctx);
      },

      onPostToolUse(input, ctx) {
        const isConverge = isConvergeCallName(input.call.name);
        const isError = input.result.isError === true;
        let fail: ConvergeFailInfo | null = null;
        if (isConverge && isError) {
          // execute 层拒收的原因 FIFO：仅 converge 的失败结果消费队首（同 turn 校验）。
          const queue = ctx.state.get(FAIL_SLOT) ?? [];
          const head = queue[0];
          if (head !== undefined && head.turnIdx === ctx.turnIdx) {
            ctx.state.set(FAIL_SLOT, queue.slice(1));
            fail = head;
          }
        }
        const ev: ToolResultEvent = {
          turnIdx: ctx.turnIdx,
          toolName: input.call.name,
          isConvergeCall: isConverge,
          isError: isError,
          resultText: truncate(resultText(input.result)),
          convergeFail: fail,
        };
        const before = state.outcomes.length;
        const result = runGateEffects(
          observeToolResult(state, ev, gate.limits, ctx.sessionId, ctx.turnIdx),
          ctx,
        );
        observeNudges(before, ctx.sessionId, ctx.turnIdx);
        return result;
      },

      onTurnEnd(input: TurnEndInput, ctx) {
        const accepted: AcceptedConvergence | null =
          ctx.state.get(ACCEPTED_SLOT) ?? null;
        const calls = toolCallsOf(input.assistantMessage.content);
        const ev: TurnEndEvent = {
          turnIdx: input.turnIdx,
          toolResultsCount: input.toolResults.length,
          hadConvergeCall: calls.some((c) => isConvergeCallName(c.name)),
          schemaRejectDetail: schemaRejectDetail(input),
          accepted,
        };
        const before = state.outcomes.length;
        const result = runGateEffects(
          decideTurnEnd(state, gate.kind, ev, gate.limits, ctx.sessionId),
          ctx,
        );
        observeNudges(before, ctx.sessionId, input.turnIdx);
        return result;
      },
    };

    // 催办投递引擎：复用已移植 turn-end-guard（持久阻断消息 + 强制续跑）。
    // 计数与文案由 reducer 备好（pendingNudge），guard 只负责投递 + 强制下一轮；
    // 达 nudgeLimit 时 gate 必已在 onTurnEnd 强制终止，guard 不再介入。
    const guard = turnEndGuard({
      maxRetries: Number.MAX_SAFE_INTEGER,
      check: () => {
        const d = decideContinuation(state, gate.limits);
        if (d.ok) return { ok: true };
        state.pendingNudge = null;
        return { ok: false, message: d.message };
      },
    });

    const hooks: Hook[] = [core, guard];
    if (this._opts.tokenBudget !== undefined) {
      hooks.push(tokenBudget({ budget: this._opts.tokenBudget }));
    }
    return hooks;
  }
}
