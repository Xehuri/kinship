/**
 * T17 排班暂停开关 —— run-engine 准入钩子（AdmissionControl）的开关侧实现
 * （docs/02 §T17；决策 docs/01 D31「全局+逐工作流布尔，账本准入层实现」）。
 *
 * 一句话职责：每次准入**现读** PauseSwitches{global, perWorkflow}，命中即返回
 * 类型化 `paused` 决策并写一条暂停审计行（reason: "paused"）。
 *
 * 与引擎的分工（run-engine/types.ts §准入钩子 冻结的契约）：
 *   - 引擎只保证「paused 则账本零痕迹」：expected 不落盘、run 不进登记（D31/T12）；
 *   - 暂停审计行是 T17 的职责 —— 即本模块的 PauseAuditSink，走独立审计通道
 *     （不占 run 账本的 expected/actual 两型行，否则会伪造 T13 对账缺口）。
 *
 * 热读铁律（验收「无缓存脏值」）：开关源以 `PauseSwitchSource` 回调注入，
 * **每次 admit() 现场调用一次**；本模块不缓存读取结果。开关真身归 server 装配
 * （config 热载后原子换快照），这里只见读者不见写者。
 */

import type {
  AdmissionControl,
  AdmissionDecision,
  RunRow,
  RunTrigger,
} from "../run-engine/types.js";

/* ────────────── 开关形状 ────────────── */

/** 暂停开关快照（D31）：全局布尔 + 逐工作流布尔表（缺键=未暂停）。 */
export interface PauseSwitches {
  readonly global: boolean;
  readonly perWorkflow: ReadonlyMap<string, boolean>;
}

/**
 * 热读源：每次准入现场调用（现读回调）。
 * server 装配时传入「当前配置快照」的读取闭包（config 热载=原子换快照即生效）。
 */
export type PauseSwitchSource = () => PauseSwitches;

/** 暂停决策原因词（审计行与 AdmissionDecision.reason 共用，唯一取值）。 */
export const PAUSE_REASON = "paused" as const;

/* ────────────── 暂停审计通道 ────────────── */

/**
 * 一条暂停审计行。snake_case 行字段与账本行同风格（docs/04）；
 * scope 标注生效层级（global 优先于 workflow，一次拦截只记一行）。
 */
export interface PauseAuditEntry {
  readonly kind: "pause:blocked";
  readonly scope: "global" | "workflow";
  readonly reason: typeof PAUSE_REASON;
  readonly run_id: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly trigger: RunTrigger;
  readonly at: number;
}

/**
 * 暂停审计出口（注入端口，core 不 import adapters）。
 * server 装配接当日 jsonl 审计流（D14 审计归属 + T20 config.applied 同通道惯例）；
 * core 测试用下方 MemoryPauseAudit。
 */
export interface PauseAuditSink {
  audit(entry: PauseAuditEntry): void;
}

/** 内存审计假件：语义 = 同步收下即记账（server 接线前的占位 + 测试观察对象）。 */
export class MemoryPauseAudit implements PauseAuditSink {
  private readonly _entries: PauseAuditEntry[] = [];

  /** 全部审计行（按写入序）。测试据此断「paused 必记账、admit 不记账」。 */
  get entries(): readonly PauseAuditEntry[] {
    return this._entries;
  }

  audit(entry: PauseAuditEntry): void {
    this._entries.push(entry);
  }
}

/* ────────────── 开关面板（可写源，测试/装配起步用） ────────────── */

/**
 * 可写开关面板。生产装配可直接用配置读取闭包当 PauseSwitchSource；
 * 本类提供「写侧」便于测试与 server 端热载器包装（read() 每次返回当下视图）。
 */
export class PauseSwitchBoard {
  private _global = false;
  private readonly _perWorkflow = new Map<string, boolean>();

  setGlobal(paused: boolean): void {
    this._global = paused;
  }

  setWorkflow(workflow: string, paused: boolean): void {
    this._perWorkflow.set(workflow, paused);
  }

  /** 现读视图：返回当前状态（热读语义=「读到的即当下」，故不缓存返回值）。 */
  read(): PauseSwitches {
    return { global: this._global, perWorkflow: this._perWorkflow };
  }
}

/* ────────────── 准入判定（引擎钩子实现） ────────────── */

/** 判定生效层级；全局优先，逐工作流须显式 true（缺键/显式 false = 放行）。 */
function decideScope(sw: PauseSwitches, workflow: string): "global" | "workflow" | null {
  if (sw.global) return "global";
  return sw.perWorkflow.get(workflow) === true ? "workflow" : null;
}

export interface PauseAdmissionOptions {
  /** 热读开关源（每次 admit 现读一次，禁缓存）。 */
  readonly switches: PauseSwitchSource;
  /** 暂停审计出口（无默认：拦了就必须留痕，缺则装配期编译不过）。 */
  readonly audit: PauseAuditSink;
  /** 时钟注入（与 RunEngine.now 同惯例；缺省 Date.now）。 */
  readonly now?: () => number;
}

/**
 * PauseAdmission —— 注入 RunEngineOptions.admission 的 T17 实现。
 * admit 同步执行：现读开关 → 命中则记审计行并返回 {kind:"paused"}；
 * 未命中返回 {kind:"admit"} 且**绝不**产生审计行。
 */
export class PauseAdmission implements AdmissionControl {
  private readonly _switches: PauseSwitchSource;
  private readonly _audit: PauseAuditSink;
  private readonly _now: () => number;

  constructor(opts: PauseAdmissionOptions) {
    this._switches = opts.switches;
    this._audit = opts.audit;
    this._now = opts.now ?? Date.now;
  }

  admit(row: RunRow): AdmissionDecision {
    const sw = this._switches(); // 现读：不缓存、不记忆上次结果
    const scope = decideScope(sw, row.workflow);
    if (scope === null) {
      return { kind: "admit" };
    }
    this._audit.audit({
      kind: "pause:blocked",
      scope,
      reason: PAUSE_REASON,
      run_id: row.run_id,
      workflow: row.workflow,
      attempt: row.attempt,
      trigger: row.trigger,
      at: this._now(),
    });
    return { kind: "paused", reason: PAUSE_REASON };
  }
}
