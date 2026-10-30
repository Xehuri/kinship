/**
 * ControlPlane —— T25 控制面 cancel/rerun + actor 审计（docs/02 §T25；docs/01 D5/D15/D19/D22/D25）。
 *
 * 一句话职责：把「主会话/HTTP/脚本」的控制指令翻译成对 RunEngine 的既有调用，
 * 并对每次动作写一条带 `actor` 的控制审计行（独立通道，不污染 run 账本）。
 *
 * 三条指令：
 *   cancel(req)     → engine.cancel(runId, reason)   —— 转发 AbortSignal 到在途句柄；
 *   rerun(req)      → engine.dispatch(...)           —— 新 run 新会话，parent_run=源 run、
 *                                                       attempt=源 attempt+1、trigger 默认 manual；
 *   spawnSide(req)  → engine.dispatch(...)           —— 受 D22 防环谓词约束（side 拒绝）。
 *
 * 铁律：
 *   - 只 import run-engine 现有导出，**不碰** run-engine/pause/recovery 文件；
 *   - 控制审计与 run 账本分离：控制行走 ControlAuditSink，绝不写 expected/actual
 *     （否则会伪造 T13 对账缺口）；
 *   - 拒绝也留痕：被 D22 拦下的 side→side、未知源 run 的 rerun 都先记审计再抛；
 *   - fail-loud：非法 actor/prompt 抛 ControlPlaneError，不静默降级（D28 精神）。
 */

import {
  RunEngine,
  type DispatchResult,
} from "../run-engine/index.js";
import {
  ControlPlaneError,
  assertCanSpawnSide,
  isControlActor,
  type CancelOutcome,
  type CancelRequest,
  type ControlActor,
  type ControlAuditEntry,
  type ControlAuditSink,
  type ControlLaunchOutcome,
  type RerunRequest,
  type SpawnSideRequest,
} from "./types.js";

/** 取消原因缺省词（与 run-engine 默认一致）。 */
export const DEFAULT_CANCEL_REASON = "cancel requested";

/** 控制面装配面：引擎 + 审计出口 + 时钟（全注入，core 不 import adapters）。 */
export interface ControlPlaneOptions {
  /** 被控引擎（T12）。控制面只调用其公开方法，不读取/篡改内部状态。 */
  readonly engine: RunEngine;
  /** 控制审计出口（无默认：控制动作必须留痕，缺则装配期编译不过）。 */
  readonly audit: ControlAuditSink;
  /** 时钟注入（与 RunEngine.now 同惯例；缺省 Date.now）。 */
  readonly now?: () => number;
}

export class ControlPlane {
  private readonly _engine: RunEngine;
  private readonly _audit: ControlAuditSink;
  private readonly _now: () => number;

  constructor(opts: ControlPlaneOptions) {
    this._engine = opts.engine;
    this._audit = opts.audit;
    this._now = opts.now ?? Date.now;
  }

  /**
   * 取消在途 run：转发到 engine.cancel（引擎把 AbortSignal 交给在途执行端口句柄）。
   * 命中与否都留审计行；不抛异常（对未知/终态 run 返回 accepted=false，幂等安全）。
   */
  cancel(req: CancelRequest): CancelOutcome {
    const actor = this._requireActor(req.actor);
    const reason = req.reason ?? DEFAULT_CANCEL_REASON;
    const accepted = this._engine.cancel(req.runId, reason);
    const at = this._now();
    this._audit.audit(this._entry("cancel", actor, accepted, req.runId, null, null, null, reason, at));
    return { run_id: req.runId, actor, accepted, reason, at };
  }

  /**
   * 重派：以源 run 为父开一条**新 run 新会话**（parent_run=源、attempt+1、trigger 默认 manual）。
   * 源 run 必须在引擎登记表中（否则无法取 attempt/workflow，抛 unknown-run）。
   * actor="side" 被 D22 拒绝（副会话不得派生副会话）——先记拒绝审计再抛。
   * 返回 dispatch 结果（launched 含新行；paused=准入拒绝，仍留痕）。
   */
  async rerun(req: RerunRequest): Promise<ControlLaunchOutcome> {
    const actor = this._requireActor(req.actor);
    if (typeof req.prompt !== "string" || req.prompt.trim() === "") {
      throw new ControlPlaneError("input", "rerun prompt must be non-blank");
    }
    // D22 防环：副会话不得派生副会话（rerun 会开一条新 side run）。
    this._assertSpawnAllowed(actor, "rerun", req.parentRunId);

    const parent = this._engine.get(req.parentRunId);
    if (parent === undefined) {
      this._audit.audit(
        this._entry("rerun", actor, false, req.parentRunId, null, null, null, `unknown parent run ${req.parentRunId}`, this._now()),
      );
      throw new ControlPlaneError("unknown-run", `rerun source ${req.parentRunId} is not known to this engine`);
    }

    const outcome = await this._engine.dispatch({
      workflow: parent.row.workflow,
      prompt: req.prompt,
      trigger: req.trigger ?? "manual",
      attempt: parent.row.attempt + 1,
      parentRun: req.parentRunId,
      // 角色引用只认显式声明：agent 不进账本行（RunRow 形状冻结），
      // 引擎登记表无法代存源 run 的声明——重跑沿用角色请由调用方重新给出。
      ...(req.agent === undefined ? {} : { agent: req.agent }),
      ...(req.runId === undefined ? {} : { runId: req.runId }),
      ...(req.sessionId === undefined ? {} : { sessionId: req.sessionId }),
    });
    this._auditLaunch("rerun", actor, outcome, req.parentRunId);
    return outcome;
  }

  /**
   * 副会话派发入口：受 D22 防环谓词约束（side 拒绝）。
   * 通过谓词后走同一 dispatch，父 run 为 null（顶层派发）。
   */
  async spawnSide(req: SpawnSideRequest): Promise<ControlLaunchOutcome> {
    const actor = this._requireActor(req.actor);
    if (typeof req.workflow !== "string" || req.workflow.trim() === "") {
      throw new ControlPlaneError("input", "spawnSide workflow must be non-blank");
    }
    if (typeof req.prompt !== "string" || req.prompt.trim() === "") {
      throw new ControlPlaneError("input", "spawnSide prompt must be non-blank");
    }
    this._assertSpawnAllowed(actor, "spawn", null);

    const outcome = await this._engine.dispatch({
      workflow: req.workflow,
      prompt: req.prompt,
      trigger: req.trigger ?? "manual",
      ...(req.agent === undefined ? {} : { agent: req.agent }),
      ...(req.runId === undefined ? {} : { runId: req.runId }),
      ...(req.sessionId === undefined ? {} : { sessionId: req.sessionId }),
    });
    this._auditLaunch("spawn", actor, outcome, null);
    return outcome;
  }

  /** 内部：开火后补审计（accepted=是否真的开火；paused 记为未受理但留痕）。 */
  private _auditLaunch(
    action: "rerun" | "spawn",
    actor: ControlActor,
    outcome: DispatchResult,
    parentRun: string | null,
  ): void {
    const launched = outcome.kind === "launched";
    this._audit.audit({
      kind: "control",
      action,
      actor,
      accepted: launched,
      run_id: outcome.row.run_id,
      parent_run: parentRun,
      attempt: action === "rerun" ? outcome.row.attempt : null,
      trigger: outcome.row.trigger,
      reason: launched ? null : outcome.reason,
      at: this._now(),
    });
  }

  /** 内部：actor 合法性校验。 */
  private _requireActor(actor: ControlActor): ControlActor {
    if (!isControlActor(actor)) {
      throw new ControlPlaneError("input", `unknown actor ${JSON.stringify(actor)}; must be one of main/http/script/side`);
    }
    return actor;
  }

  /** 内部：D22 谓词 + 拒绝留痕（拒绝先写审计行再抛）。 */
  private _assertSpawnAllowed(
    actor: ControlActor,
    action: "rerun" | "spawn",
    runId: string | null,
  ): void {
    if (actor !== "side") return;
    this._audit.audit(
      this._entry(action, actor, false, runId, null, null, null, "side-to-side forbidden (D22 anti-loop)", this._now()),
    );
    assertCanSpawnSide(actor); // 统一抛点（此处必抛）
  }

  /** 内部：构造审计行。 */
  private _entry(
    action: ControlAuditEntry["action"],
    actor: ControlActor,
    accepted: boolean,
    runId: string | null,
    parentRun: string | null,
    attempt: number | null,
    trigger: ControlAuditEntry["trigger"],
    reason: string | null,
    at: number,
  ): ControlAuditEntry {
    return {
      kind: "control",
      action,
      actor,
      accepted,
      run_id: runId,
      parent_run: parentRun,
      attempt,
      trigger,
      reason,
      at,
    };
  }
}
