/**
 * W9 切片 1 —— SpawnKernel：统一 spawn 内核（纯重构零行为变更；设计定稿=Oracle 蓝图）。
 *
 * 收编四件（逐字节平移自现网，语义=现网，行号引 engine.ts@9e8197b）：
 *   1. 唯一造 AgentSession 的工厂：buildConvergeSession（side-session-port.ts:109-123
 *      构造段平移）+ buildSubSession（tool-wiring childSessionFactory / task-tool
 *      buildDefaultChild 构造语义平移）——store 挂载/gate hooks/tools/resolveBinding
 *      现有传参照搬；本模块之外不再有 run/sub 两面的 AgentSession 构造点（主会话
 *      loop 属 session-api 域，不在本内核面）。
 *   2. 身份登记与 aborter/cancel（engine.ts:105,173-183,217-242,249-250 语义照搬）：
 *      _runs 登记表 + _aborters 在途通道，run 面唯一持有者。
 *   3. completion 恒 resolve 的终态语义（engine.ts:244-275 crash 形状零改动）：
 *      执行器炸 = failed+crashed、**不写 actual** 留账本缺口、观察者照常盖棺。
 *   4. onRunTerminal/onNudge/deadLetterSink 三缝（engine.ts:62-77 观测缝原文案照搬）：
 *      run-trace/gate 催办/dead-letter 走同一出口（onNudge 属 converge profile 的
 *      gate 构造参数——经 buildConvergeSession 入参透传，缝位不变、时序不变）。
 *
 * 时序铁律（D15）随 spawnRun 平移：`ledger.expected()` 同步返回之后，sessionPort
 * 才可能被触碰；paused = 账本零痕迹；expected 落盘失败 = 不开火、撤登记、响亮抛。
 *
 * 生命周期 options 全部来自注入（与 RunEngineOptions 同形），core 不 import
 * adapters/server；日志串（"run:queued" 等）逐字保留——观测面同属行为面。
 */

import {
  RunEngineError,
  type AdmissionControl,
  type ArtifactSink,
  type DeadLetterSink,
  type LedgerPort,
  type RunEngineLog,
  type RunLaunchResult,
  type RunRecord,
  type RunRow,
  type RunSessionPort,
  type RunState,
  type RunTerminalState,
  type TerminalSnapshot,
} from "../run-engine/types.js";import { AgentSession } from "../session.js";
import { ConvergenceGate } from "../convergence/index.js";
import type {
  ConvergeSessionBundle,
  ConvergeSessionProfile,
  KernelHandle,
  KernelSpawnResult,
  SpawnRunPolicy,
  SpawnSubPolicy,
  SubBackgroundHandle,
  SubFanout,
  SubSessionProfile,
  SubTaskRecord,
  SpawnSubBackgroundArgs,
} from "./types.js";

/* ────────────────────── 唯一 AgentSession 工厂（纯函数，无实例态） ────────────────────── */

/**
 * converge-receipt 档案：造一副会话专用 ConvergenceGate + 挂它的 AgentSession。
 * 构造段逐字节平移自 createSideSessionPort（gate kind 恒 "side"；tools 首位 =
 * gate.tool；limits/onNudge/llmOptions/store/systemPrompt 条件展开，undefined=键缺席）。
 */
export function buildConvergeSession(profile: ConvergeSessionProfile): ConvergeSessionBundle {
  const gate = new ConvergenceGate({
    kind: "side",
    ...(profile.limits === undefined ? {} : { limits: profile.limits }),
    ...(profile.onNudge === undefined ? {} : { onNudge: profile.onNudge }),
  });
  const session = new AgentSession({
    model: profile.model,
    tools: [gate.tool, ...profile.tools],
    hooks: [...gate.buildHooks(), ...profile.hooks],
    sessionId: profile.sessionId,
    ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
    ...(profile.llmOptions === undefined ? {} : { llmOptions: profile.llmOptions }),
    ...(profile.store === undefined ? {} : { store: profile.store }),
    ...(profile.contextWatcher === undefined
      ? {}
      : { contextWatcher: profile.contextWatcher }),
    ...(profile.contextCheckEachTurn === undefined
      ? {}
      : { contextCheckEachTurn: profile.contextCheckEachTurn }),
    ...(profile.onWireSnapshot === undefined ? {} : { onWireSnapshot: profile.onWireSnapshot }),
  });
  return { gate, session };
}

/**
 * raw-summary 档案：造 task 子会话/派发子的 AgentSession（无 gate，终局整形归调用方）。
 * 构造语义平移自 serve childSessionFactory 与 task-tool buildDefaultChild 的并集：
 * hooks/maxTurns/llmOptions/store 条件展开（undefined=键缺席），其余恒给。
 */
export function buildSubSession(profile: SubSessionProfile): AgentSession {
  return new AgentSession({
    model: profile.model,
    sessionId: profile.sessionId,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    ...(profile.hooks === undefined || profile.hooks.length === 0 ? {} : { hooks: [...profile.hooks] }),
    ...(profile.llmOptions === undefined ? {} : { llmOptions: profile.llmOptions }),
    ...(profile.store === undefined ? {} : { store: profile.store }),
    ...(profile.maxTurns === undefined ? {} : { maxTurns: profile.maxTurns }),
    ...(profile.contextWatcher === undefined
      ? {}
      : { contextWatcher: profile.contextWatcher }),
    ...(profile.contextCheckEachTurn === undefined
      ? {}
      : { contextCheckEachTurn: profile.contextCheckEachTurn }),
    ...(profile.onWireSnapshot === undefined ? {} : { onWireSnapshot: profile.onWireSnapshot }),
  });
}

/* ────────────────────── 生命周期内核 ────────────────────── */

/** 内核装配面：RunEngineOptions 的运行时子集（id 生成归门面 parse 段，内核不造 id）。 */
export interface SpawnKernelOptions {
  readonly ledger: LedgerPort;
  readonly sessionPort: RunSessionPort;
  readonly admission?: AdmissionControl;
  readonly artifactSink?: ArtifactSink;
  readonly deadLetterSink?: DeadLetterSink;
  readonly onRunStarted?: (row: RunRow) => void;
  readonly onRunTerminal?: (record: RunRecord) => void;
  readonly log?: RunEngineLog;
  readonly now?: () => number;
}

const TERMINALS: readonly RunState[] = ["done", "partial", "failed"];

function isTerminalState(s: RunState): boolean {
  return TERMINALS.includes(s);
}

/**
 * 进程唯一 spawn 内核（boot 装配单例）。run 面持有登记表/aborter 通道/终态机；
 * sub 面只走工厂（登记/账本零染指——切片 1 不扩记账面，policy 词表见 types.ts 注释）。
 */
export class SpawnKernel {
  private readonly _ledger: LedgerPort;
  private readonly _sessionPort: RunSessionPort;
  private readonly _admission: AdmissionControl;
  private readonly _artifactSink: ArtifactSink | undefined;
  private readonly _deadLetterSink: DeadLetterSink | undefined;
  private readonly _onRunStarted: ((row: RunRow) => void) | undefined;
  private readonly _onRunTerminal: ((record: RunRecord) => void) | undefined;
  private readonly _log: RunEngineLog;
  private readonly _now: () => number;
  /** run 登记表（重启即空；持久化真相只在账本）。 */
  private readonly _runs = new Map<string, RunRecord>();
  /** 在途 run 的 abort 通道（T25 取消接缝）；执行结束即删。 */
  private readonly _aborters = new Map<string, AbortController>();
  /**
   * W9 切片 2 决策：sub 在飞册与 _runs **分册**（同 map 分 kind 需给 RunRecord 加 kind 判别——
   * RunRecord 是 task-api/control/12+ 测试压着的冻结读面，动形=契约变更；且 listRuns/gaps
   * 的 run 语义会被 sub 条目污染。分册+计数=最小正解）。
   * 切片 2 同步语义：task 门面入册（构建）/出册（子 run 终态）与旧局部计数同窗（同一
   * 同步 JS 帧），跨门面共享一份；后台化后出册改挂子终态（切片 3），册面不变。
   */
  private readonly _subs = new Set<string>();
  /**
   * W9 切片 3：后台 sub 账本册（durable：expected-before-fire / actual-at-terminal，
   * 与 _runs 分册——/runs 契约纯度自动成立，见 types.ts SubTaskRecord 注释）。
   */
  private readonly _subRuns = new Map<string, SubTaskRecord>();
  /** 后台 sub 的门面侧终态钩子（taskId→出池/回调/retain；派发登记、终态消费即删）。 */
  private readonly _localTerminalHooks = new Map<string, (rec: SubTaskRecord, result: RunLaunchResult | null) => void>();

  constructor(opts: SpawnKernelOptions) {
    this._ledger = opts.ledger;
    this._sessionPort = opts.sessionPort;
    this._admission = opts.admission ?? { admit: () => ({ kind: "admit" }) };
    this._artifactSink = opts.artifactSink;
    this._deadLetterSink = opts.deadLetterSink;
    this._onRunStarted = opts.onRunStarted;
    this._onRunTerminal = opts.onRunTerminal;
    this._log = opts.log ?? (() => {});
    this._now = opts.now ?? Date.now;
  }

  /**
   * 判别入口（overload 收口两类 policy）：run → 全生命周期（恒 launched|paused）；
   * sub → 纯工厂（返回 session，登记面零触碰）。
   */
  spawn(policy: SpawnRunPolicy): Promise<KernelSpawnResult>;
  spawn(policy: SpawnSubPolicy, profile: SubSessionProfile): AgentSession;
  spawn(
    policy: SpawnRunPolicy | SpawnSubPolicy,
    profile?: SubSessionProfile,
  ): Promise<KernelSpawnResult> | AgentSession {
    if (policy.kind === "run") return this._spawnRun(policy);
    if (profile === undefined) {
      // 直调防御：sub 面的构造入参必须显式给全（现网调用方经 buildSubSession 自带 profile）。
      throw new Error("SpawnKernel.spawn: sub policy requires SubSessionProfile");
    }
    // W9 切片 2：内核入口的 sub 构建即入册（出册由持有终态观测的调用方 releaseSub/
    // fanout.release——切片 2 同步流=task 门面 finally，切片 3 后台化后随终态通道走）。
    const session = buildSubSession(profile);
    this.registerSub(session.id);
    return session;
  }

  /**
   * run 全序（engine.ts dispatch:136-167 逐字节平移，仅去掉 parse 段=门面职责）：
   * 撞号拒 → 登记 queued → 准入（paused 撤登记零痕迹）→ admitted → expected fsync
   * （失败撤登记响亮抛）→ running → started 观察者（await，抛错吞进 warn）→
   * _execute 起飞（completion 恒 resolve）→ launched 返回。
   */
  private async _spawnRun(policy: SpawnRunPolicy): Promise<KernelSpawnResult> {
    const row = policy.row;
    const dispatchedAt = this._now();

    if (this._runs.has(row.run_id)) {
      throw new RunEngineError("dispatch-input", `run_id ${row.run_id} already known to this engine`);
    }

    this._register(row, "queued", dispatchedAt);
    this._log("info", "run:queued", { run_id: row.run_id, workflow: row.workflow, attempt: row.attempt });

    // 准入钩子在 expected 之前：paused → 撤登记、账本无痕（T17 自行记审计行）。
    const decision = this._admission.admit(row);
    if (decision.kind === "paused") {
      this._runs.delete(row.run_id);
      this._log("info", "run:paused", { run_id: row.run_id, workflow: row.workflow, reason: decision.reason });
      return { kind: "paused", row, reason: decision.reason };
    }
    this._patch(row.run_id, { state: "admitted" });

    // expected 落盘（真 Ledger 在此 fsync）：失败 = 不开火、不留痕（宁可漏一班，不假开火）。
    try {
      this._ledger.expected(row.run_id, dispatchedAt, row);
    } catch (err) {
      this._runs.delete(row.run_id);
      const msg = err instanceof Error ? err.message : String(err);
      this._log("error", "run:expected-write-failed", { run_id: row.run_id, error: msg });
      throw new RunEngineError("ledger", `expected write failed for ${row.run_id}: ${msg}`);
    }
    this._patch(row.run_id, { state: "running" });
    this._log("debug", "run:expected-persisted", { run_id: row.run_id, at: dispatchedAt });
    await this._safeSideEffect("run-started-observer", () => this._onRunStarted?.(row));

    const completion = this._execute(row, policy.prompt, policy.agent);
    const handle: KernelHandle = {
      id: row.run_id,
      sessionId: row.session_id,
      status: () => this._runs.get(row.run_id),
      completion,
      cancel: (reason?: string) => this.cancel(row.run_id, reason ?? "cancel requested"),
    };
    return { kind: "launched", row, handle };
  }

  /**
   * 取消在途 run（engine.ts:169-183 照搬）：记录原因 + abort 执行 signal。
   * 返回是否命中在途 run。终态由执行端口对 abort 的映射决定（signal 契约在端口）。
   */
  cancel(runId: string, reason = "cancel requested"): boolean {
    const rec = this._runs.get(runId);
    const ctrl = this._aborters.get(runId);
    if (rec === undefined || ctrl === undefined || rec.state !== "running") {
      return false;
    }
    this._patch(runId, { cancelRequested: reason });
    this._log("info", "run:cancel-requested", { run_id: runId, reason });
    ctrl.abort(new Error(reason));
    return true;
  }

  /** run 记录（只读快照）；未知 id = undefined。 */
  get(runId: string): RunRecord | undefined {
    return this._runs.get(runId);
  }

  // ────────────── sub 在飞册（W9 切片 2；与 run 账本面分册） ──────────────

  /** 当前在飞子会话数（task 横向闸检查时刻现读）。 */
  subInFlight(): number {
    return this._subs.size;
  }

  /** 构建即入册；重复 id 响亮抛（sid 逐派发全新，撞号=上游 bug）。 */
  registerSub(id: string): void {
    if (this._subs.has(id)) {
      throw new Error(`registerSub: sub ${id} already in flight (duplicate construction)`);
    }
    this._subs.add(id);
  }

  /** 出册（幂等；未知/已出册 = false）。 */
  releaseSub(id: string): boolean {
    return this._subs.delete(id);
  }

  /** 在飞册的窄接口视图（task 门面/装配层注入用，不暴露 Set 本体）。 */
  asFanout(): SubFanout {
    return {
      count: () => this.subInFlight(),
      register: (id) => this.registerSub(id),
      release: (id) => this.releaseSub(id),
    };
  }

  /** 全量列表（T28 列表/详情原料；按受理插入序）。 */
  listRuns(workflow?: string): RunRecord[] {
    const all = [...this._runs.values()];
    return workflow === undefined ? all : all.filter((r) => r.row.workflow === workflow);
  }

  /** 在途 run 数（dispatch 准入层 max_inflight 参数原料，D24）。 */
  activeCount(): number {
    let n = 0;
    for (const r of this._runs.values()) {
      if (r.state === "running") n += 1;
    }
    return n;
  }

  /**
   * 引擎视角缺口：crashed 或未达终态的 run（+ 后台 sub 账本册同判——停机日志/运维观察
   * 需要看到全部 expected-without-actual；run 面既有测试无 sub，逐字节不变）。
   */
  gaps(): string[] {
    const out: string[] = [];
    for (const r of this._runs.values()) {
      if (r.crashed || !isTerminalState(r.state)) out.push(r.row.run_id);
    }
    for (const s of this._subRuns.values()) {
      if (s.crashed || !isTerminalState(s.state)) out.push(s.row.run_id);
    }
    return out;
  }

  // ────────────── W9 切片 3：后台 sub 派发（durable 账本机器） ──────────────

  /**
   * 后台派发全序（同步前缀=与 run 同一时序铁律）：撞号拒 → 入册 queued →
   * expected fsync（payload = RunRow 六键 + **additive** kind:"sub"/agent_type/parent_session
   * + W49.2 条件 title，reader 宽容、既有行形状不动）→ running → started 观察者（**不 await**——门面即返是
   * 后台的立身之本；观察者 fail-soft 吞错口径不变）→ _executeSub 起飞 → 句柄同步返回。
   *
   * 决策：
   * - **不吃 admission 暂停闸**：暂停开关是 cron/排班运维面（T17），会话内派发=用户对话
   *   意图，闸停排班不停对话；同步 sub 历史上也不经准入，后台保持同口径。
   * - **不吃父 turn abort**（D24 重定义）：signal=内核自备 aborter（deadline/cancelSub/停机排水
   *   三个收口方），父轮 abort 只影响父会话——后台的立身之本。
   * - run-trace/gate/dead-letter/reminder 三缝复用 run 面同一出口（onRunStarted/onRunTerminal/
   *   deadLetterSink），durable 才发射=后台专属；同步 sub 零账本行零发射（今日口径不变）。
   */
  dispatchSubBackground(args: SpawnSubBackgroundArgs): SubBackgroundHandle {
    const row = args.row;
    const dispatchedAt = this._now();
    if (this._subRuns.has(row.run_id)) {
      throw new RunEngineError("dispatch-input", `task_id ${row.run_id} already known to this kernel`);
    }
    this._subRuns.set(row.run_id, {
      kind: "sub",
      taskId: row.run_id,
      agentType: args.agentType,
      parentSessionId: args.parentSessionId,
      task: args.task,
      depth: args.depth,
      // W49.2：title 给了才落键（缺省=键缺席非 title:null，视图 ?? 投影诚实）。
      ...(args.title === undefined ? {} : { title: args.title }),
      row,
      state: "queued",
      dispatchedAt,
      terminalAt: null,
      terminal: null,
      error: null,
      crashed: false,
      cancelRequested: null,
    });
    this._log("info", "sub:queued", { run_id: row.run_id, workflow: row.workflow, task_id: row.run_id });
    if (args.onTerminalLocal !== undefined) {
      this._localTerminalHooks.set(row.run_id, args.onTerminalLocal);
    }

    try {
      // expected 落盘（真 Ledger fsync）：失败 = 撤册、不开火、响亮抛（run 面同款纪律）。
      this._ledger.expected(row.run_id, dispatchedAt, {
        ...row,
        kind: "sub",
        agent_type: args.agentType,
        parent_session: args.parentSessionId,
        // W49.2 additive 键：adapters 账本零 payload 校验 → 旧行（无 title）重放天然容忍。
        ...(args.title === undefined ? {} : { title: args.title }),
      });
    } catch (err) {
      this._subRuns.delete(row.run_id);
      const msg = err instanceof Error ? err.message : String(err);
      this._log("error", "sub:expected-write-failed", { run_id: row.run_id, error: msg });
      throw new RunEngineError("ledger", `expected write failed for ${row.run_id}: ${msg}`);
    }
    this._patchSub(row.run_id, { state: "running" });
    this._log("debug", "sub:expected-persisted", { run_id: row.run_id, at: dispatchedAt });
    void this._safeSideEffect("sub-started-observer", () => this._onRunStarted?.(row));

    const completion = this._executeSub(args);
    return {
      taskId: row.run_id,
      sessionId: row.session_id,
      completion,
      cancel: (reason?: string) => this.cancelSub(row.run_id, reason ?? "cancel requested"),
    };
  }

  /** 后台 sub 终态记录（/tasks 与 task_fetch 寻址原料）；未知 id = undefined。 */
  getSub(taskId: string): SubTaskRecord | undefined {
    return this._subRuns.get(taskId);
  }

  /** 后台 sub 全量列表（/tasks 视图原料；按派发插入序）。 */
  listSubRuns(): readonly SubTaskRecord[] {
    return [...this._subRuns.values()];
  }

  /** 后台在飞（非终态）计数——maxInflightTotal 闸现读源。 */
  subActiveCount(): number {
    let n = 0;
    for (const s of this._subRuns.values()) {
      if (!isTerminalState(s.state)) n += 1;
    }
    return n;
  }

  /** 取消后台 sub（同 run cancel 形状：running 才命中、记原因、abort signal）。 */
  cancelSub(taskId: string, reason = "cancel requested"): boolean {
    const rec = this._subRuns.get(taskId);
    const ctrl = this._aborters.get(taskId);
    if (rec === undefined || ctrl === undefined || rec.state !== "running") {
      return false;
    }
    this._patchSub(taskId, { cancelRequested: reason });
    this._log("info", "sub:cancel-requested", { run_id: taskId, reason });
    ctrl.abort(new Error(reason));
    return true;
  }

  /**
   * 后台执行 + 盖棺（_execute 同构：completion 恒 resolve、crash 不写 actual 留缺口、
   * actual 写失败不调终盖、旁路 sink 不回滚）。差异仅在：执行体=args.run（自备 aborter
   * signal）、登记面=_subRuns 册、死信 payload 加 kind:"sub"（自证身份不静默）、
   * deadline 定时器到点走 cancelSub（=既有 failed+cancelRequested 形状，零新状态）。
   */
  private async _executeSub(args: SpawnSubBackgroundArgs): Promise<SubTaskRecord> {
    const row = args.row;
    const aborter = new AbortController();
    this._aborters.set(row.run_id, aborter);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (args.deadlineMs !== undefined && args.deadlineMs > 0) {
      timer = setTimeout(() => {
        // 到点 = 既有取消形状（session 协作式收尾 → failed+cancelRequested=deadline）。
        this.cancelSub(row.run_id, "deadline");
      }, args.deadlineMs);
      timer.unref?.(); // 缺省 15min 长定时器不吊住进程/测试事件循环（hub 心跳同款纪律）
    }
    const settleTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    let result: RunLaunchResult;
    try {
      result = await args.run(aborter.signal);
    } catch (err) {
      settleTimer();
      const msg = err instanceof Error ? err.message : String(err);
      this._patchSub(row.run_id, { state: "failed", terminalAt: this._now(), error: msg, crashed: true });
      this._aborters.delete(row.run_id);
      this._log("error", "sub:executor-crashed", {
        run_id: row.run_id,
        workflow: row.workflow,
        error: msg,
        note: "ledger gap kept: expected-without-actual (T13 catchup input, T35 crash shape)",
      });
      await this._safeSideEffect("run-terminal-observer", () =>
        this._onRunTerminal?.(this._requireSub(row.run_id)),
      );
      this._safeLocalTerminal(row.run_id, null);
      return this._requireSub(row.run_id);
    }
    settleTimer();
    this._aborters.delete(row.run_id);

    const at = this._now();
    const status: RunTerminalState = result.status;
    const terminal: TerminalSnapshot = {
      at,
      status,
      digest: result.digest,
      pointers: Object.freeze([...result.pointers]),
      blockers: Object.freeze([...result.blockers]),
      ...(result.forceReason === undefined ? {} : { forceReason: result.forceReason }),
      ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    };

    try {
      this._ledger.actual(row.run_id, at, status, terminal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._patchSub(row.run_id, { error: `actual write failed: ${msg}` });
      this._log("error", "sub:actual-write-failed", { run_id: row.run_id, error: msg });
      return this._requireSub(row.run_id);
    }
    this._patchSub(row.run_id, {
      state: status,
      terminalAt: at,
      terminal,
      // W16-F4：同 run 面——内存登记带 usage，actual payload（terminal）形状逐字节不变。
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    });
    this._log("info", `sub:${status}`, {
      run_id: row.run_id,
      workflow: row.workflow,
      digest: terminal.digest,
    });

    await this._safeSideEffect("artifact-sink", () =>
      this._artifactSink?.publish({
        run_id: row.run_id,
        workflow: row.workflow,
        attempt: row.attempt,
        session_id: row.session_id,
        status,
        artifacts: Object.freeze([...result.pointers]),
        at,
      }),
    );
    if (status === "failed") {
      // 死信 sub-kind：payload 六形同 run 面 + additive kind/agent_type/parent_session（自证身份）。
      await this._safeSideEffect("dead-letter-sink", () =>
        this._deadLetterSink?.emit({
          kind: "dead-letter",
          run_id: row.run_id,
          workflow: row.workflow,
          attempt: row.attempt,
          trigger: row.trigger,
          parent_run: row.parent_run,
          session_id: row.session_id,
          digest: terminal.digest,
          blockers: [...terminal.blockers],
          ...(terminal.forceReason === undefined ? {} : { forceReason: terminal.forceReason }),
          at,
          // 后台 sub 自证身份（additive 键；run 面不写=旧形状逐字节，见 types.ts 注释）。
          sub_kind: "sub" as const,
          agent_type: args.agentType,
          parent_session: args.parentSessionId,
        }),
      );
    }
    await this._safeSideEffect("run-terminal-observer", () =>
      this._onRunTerminal?.(this._requireSub(row.run_id)),
    );
    this._safeLocalTerminal(row.run_id, result);
    return this._requireSub(row.run_id);
  }

  private _patchSub(taskId: string, fields: Partial<RunRecord>): void {
    const cur = this._subRuns.get(taskId);
    if (cur === undefined) return;
    this._subRuns.set(taskId, { ...cur, ...fields });
  }

  private _requireSub(taskId: string): SubTaskRecord {
    const rec = this._subRuns.get(taskId);
    if (rec === undefined) {
      throw new RunEngineError("ledger", `sub ${taskId} vanished from registry (internal invariant break)`);
    }
    return rec;
  }

  /** 本地终态观察（出池/回调/retain 归门面；吞错留痕，绝不反噬账本盖棺）。 */
  private _safeLocalTerminal(taskId: string, result: RunLaunchResult | null): void {
    const rec = this._subRuns.get(taskId);
    if (rec === undefined) return;
    try {
      const cb = this._localTerminalHooks.get(taskId);
      if (cb !== undefined) {
        this._localTerminalHooks.delete(taskId);
        cb(rec, result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log("warn", "sub:terminal-observer-failed", { run_id: taskId, error: msg });
    }
  }

  private _register(row: RunRow, state: RunState, dispatchedAt: number): void {
    this._runs.set(row.run_id, {
      row,
      state,
      dispatchedAt,
      terminalAt: null,
      terminal: null,
      error: null,
      crashed: false,
      cancelRequested: null,
    });
  }

  private _patch(runId: string, fields: Partial<RunRecord>): void {
    const cur = this._runs.get(runId);
    if (cur === undefined) return;
    this._runs.set(runId, { ...cur, ...fields });
  }

  private _require(runId: string): RunRecord {
    const rec = this._runs.get(runId);
    if (rec === undefined) {
      throw new RunEngineError("ledger", `run ${runId} vanished from registry (internal invariant break)`);
    }
    return rec;
  }

  /**
   * 执行 + 终态盖棺（engine.ts:244-340 逐字节平移：crash 不写 actual 留缺口、
   * completion 恒 resolve、actual 写失败=缺口形状不调终盖、旁路 sink 失败不回滚）。
   */
  private async _execute(row: RunRow, prompt: string, agent?: string): Promise<RunRecord> {
    const aborter = new AbortController();
    this._aborters.set(row.run_id, aborter);

    let result: RunLaunchResult;
    try {
      result = await this._sessionPort.run({
        row,
        prompt,
        signal: aborter.signal,
        ...(agent === undefined ? {} : { agent }),
      });
    } catch (err) {
      // 崩溃形状：**不写 actual**。账本停在「只有 expected」缺口态，T13 对账补。
      const msg = err instanceof Error ? err.message : String(err);
      this._patch(row.run_id, { state: "failed", terminalAt: this._now(), error: msg, crashed: true });
      this._aborters.delete(row.run_id);
      this._log("error", "run:executor-crashed", {
        run_id: row.run_id,
        workflow: row.workflow,
        error: msg,
        note: "ledger gap kept: expected-without-actual (T13 catchup input, T35 crash shape)",
      });
      await this._safeSideEffect("run-terminal-observer", () =>
        this._onRunTerminal?.(this._require(row.run_id)),
      );
      return this._require(row.run_id);
    }
    this._aborters.delete(row.run_id);

    const at = this._now();
    const status: RunTerminalState = result.status;
    const terminal: TerminalSnapshot = {
      at,
      status,
      digest: result.digest,
      pointers: Object.freeze([...result.pointers]),
      blockers: Object.freeze([...result.blockers]),
      ...(result.forceReason === undefined ? {} : { forceReason: result.forceReason }),
      ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    };

    // actual 落盘（终态盖棺）。写失败 = 缺口保持 + error 如实记录；不改内存终局判定。
    try {
      this._ledger.actual(row.run_id, at, status, terminal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._patch(row.run_id, { error: `actual write failed: ${msg}` });
      this._log("error", "run:actual-write-failed", { run_id: row.run_id, error: msg });
      return this._require(row.run_id);
    }
    this._patch(row.run_id, {
      state: status,
      terminalAt: at,
      terminal,
      // W16-F4：usage 只进内存登记面（账本 actual 形状不动），供终态观察者取数。
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    });
    this._log("info", `run:${status}`, {
      run_id: row.run_id,
      workflow: row.workflow,
      attempt: row.attempt,
      digest: terminal.digest,
    });

    // 旁路副作用（产物快照/死信）：失败只记 warn，**绝不**回滚已盖棺的账本终态。
    await this._safeSideEffect("artifact-sink", () =>
      this._artifactSink?.publish({
        run_id: row.run_id,
        workflow: row.workflow,
        attempt: row.attempt,
        session_id: row.session_id,
        status,
        artifacts: Object.freeze([...result.pointers]),
        at,
      }),
    );
    if (status === "failed") {
      await this._safeSideEffect("dead-letter-sink", () =>
        this._deadLetterSink?.emit({
          kind: "dead-letter",
          run_id: row.run_id,
          workflow: row.workflow,
          attempt: row.attempt,
          trigger: row.trigger,
          parent_run: row.parent_run,
          session_id: row.session_id,
          digest: terminal.digest,
          blockers: [...terminal.blockers],
          ...(terminal.forceReason === undefined ? {} : { forceReason: terminal.forceReason }),
          at,
        }),
      );
    }
    await this._safeSideEffect("run-terminal-observer", () =>
      this._onRunTerminal?.(this._require(row.run_id)),
    );
    return this._require(row.run_id);
  }

  private async _safeSideEffect(seam: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log("warn", "run:side-effect-failed", { seam, error: msg });
    }
  }
}
