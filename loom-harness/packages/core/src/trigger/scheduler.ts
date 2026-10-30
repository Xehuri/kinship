/**
 * T15 调度器 —— 注入时钟 + 注入提交端口的排班触发器
 * （docs/02 §T15；决策 docs/01 D14/D15/D24/D31）。
 *
 * 一句话职责：把一组 `TriggerDefinition` 与「当下时刻」比对，命中者**只声明提交意图**
 * ——调用注入的 `onSubmit(runSpec)`（server 装配接到 `RunEngine.dispatch({trigger:"cron"})`）。
 *
 * 三条硬约束（T15 MUST DO / MUST NOT DO）：
 *   1. 全注入、无真定时器：本模块**不含** setInterval/setTimeout/sleep；测试用假时钟
 *      调 `tick()` 快进，绝不消耗真实时间（防 flaky）；
 *   2. 漏触发不补：只判定「当前这一分钟」是否命中；错过的班次由 T13 按 catchup 策略
 *      处理（latest/all/none），T15 不生成补跑意图；
 *   3. 同分钟幂等：同一 (workflow, 分钟) 只提交一次——重复 tick 同一时刻不重复开火。
 *
 * 暂停开关（D31/T17）：本模块**不**直接读开关。暂停在 run-engine 的 AdmissionControl
 * 层拦截（见 run-engine/types.ts §准入钩子）；server 装配时把 PauseAdmission 注入
 * RunEngine，cron 经 dispatch 走同一钩子即自动生效——单一拦截点，不重复实现。
 */

import { type CronExpression, matchesCron, parseCron } from "./cron.js";
import type { TriggerDefinition } from "./trigger.js";

/* ────────────── 提交意图（runSpec） ────────────── */

/**
 * 一条提交意图（cron 触发产出的最小形状）。装配层据此调 `RunEngine.dispatch`：
 *   { workflow: spec.workflow, prompt: spec.prompt, trigger: spec.trigger }
 * `trigger` 恒为 "cron"（D15 账本触发行字段）。
 */
export interface RunSubmitSpec {
  readonly workflow: string;
  readonly prompt: string;
  readonly trigger: "cron";
  /** 角色文件引用（task yaml `agent:` 透传；装配层据此 dispatch）。 */
  readonly agent?: string;
  /** 命中的调度时刻（epoch ms，来自注入时钟）。 */
  readonly at: number;
  /** 命中的规范化 cron 表达式（审计/去重键用）。 */
  readonly cron: string;
  /** 定义来源路径（可空）。 */
  readonly source: string | null;
}

/** 提交端口：返回 void 或 Promise（dispatch 为异步时 await）。 */
export type TriggerSubmitPort = (spec: RunSubmitSpec) => void | Promise<void>;

/** 结构化日志（与内核/引擎同形；缺省静默）。 */
export type TriggerLog = (
  level: "debug" | "info" | "warn",
  msg: string,
  fields: Record<string, unknown>,
) => void;

/* ────────────── 装配面 ────────────── */

export interface TriggerSchedulerOptions {
  /** 注入时钟（T15 确定性铁律：测试传假时钟，缺省 Date.now）。 */
  readonly clock?: () => Date;
  /** 提交端口（装配层接 RunEngine.dispatch；必填，无默认=不静默丢弃触发）。 */
  readonly onSubmit: TriggerSubmitPort;
  /** 初始定义集（也可后经 add() 注入；热载由 T20 换实例，本模块不监听文件）。 */
  readonly definitions?: readonly TriggerDefinition[];
  /** 结构化日志，缺省静默。 */
  readonly log?: TriggerLog;
}

/** 单条定义的运行态（编译后的 cron + 上次开火键）。 */
interface CompiledTrigger {
  readonly def: TriggerDefinition;
  readonly expr: CronExpression;
  /** 上次开火的分钟键（`YYYY-MM-DDTHH:MM` 本地时间）；未开火 = null。 */
  lastFiredKey: string | null;
}

/** 分钟去重键（本地时间到分钟；秒/毫秒无关）。 */
function minuteKey(at: Date): string {
  const y = at.getFullYear();
  const mo = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  const h = String(at.getHours()).padStart(2, "0");
  const mi = String(at.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

/**
 * TriggerScheduler —— 注入式排班触发器。**无内部定时器**：由外部（server 的 tick
 * 循环 / 测试的假时钟）调用 `tick()` 驱动，每次 tick = 判定一个时刻。
 */
export class TriggerScheduler {
  private readonly _clock: () => Date;
  private readonly _onSubmit: TriggerSubmitPort;
  private readonly _log: TriggerLog;
  private readonly _triggers = new Map<string, CompiledTrigger>();
  /** 提交端口抛错留痕（fail-soft：一条坏定义不拖垮同刻其余触发）。 */
  private readonly _errors: Array<{ workflow: string; at: number; error: string }> = [];

  constructor(opts: TriggerSchedulerOptions) {
    this._clock = opts.clock ?? (() => new Date());
    this._onSubmit = opts.onSubmit;
    this._log = opts.log ?? (() => {});
    for (const def of opts.definitions ?? []) {
      this.add(def);
    }
  }

  /** 新增/替换一条定义（同名覆盖）。cron 编译失败即抛（fail-loud）。 */
  add(def: TriggerDefinition): void {
    const expr = parseCron(def.cron);
    this._triggers.set(def.name, { def, expr, lastFiredKey: null });
    this._log("debug", "trigger:added", { workflow: def.name, cron: def.cron, enabled: def.enabled });
  }

  /** 移除一条定义；返回是否命中。 */
  remove(name: string): boolean {
    return this._triggers.delete(name);
  }

  /** 当前定义名列表（按插入序）。 */
  names(): string[] {
    return [...this._triggers.keys()];
  }

  /** 提交端口抛错留痕（测试观察面）。 */
  get errors(): readonly { readonly workflow: string; readonly at: number; readonly error: string }[] {
    return this._errors;
  }

  /**
   * 推进到 `at`（缺省读注入时钟）并处理命中者。
   * 返回本次实际提交的 runSpec 列表（禁用/未命中/同分钟重复 → 不出现）。
   *
   * 幂等铁律：同一定义的同一分钟键只提交一次；即使被 disabled 后重新启用，
   * 也不会回补该分钟（漏触发不补）。
   */
  async tick(at?: Date): Promise<RunSubmitSpec[]> {
    const now = at ?? this._clock();
    const key = minuteKey(now);
    const submitted: RunSubmitSpec[] = [];

    for (const trigger of this._triggers.values()) {
      const { def, expr } = trigger;
      if (!def.enabled) continue; // disabled 静默跳过（验收：disabled schedules skipped）
      if (trigger.lastFiredKey === key) continue; // 同分钟去重
      if (!matchesCron(expr, now)) continue;

      trigger.lastFiredKey = key;
      const spec: RunSubmitSpec = {
        workflow: def.name,
        prompt: def.prompt,
        trigger: "cron",
        ...(def.agent === undefined ? {} : { agent: def.agent }),
        at: now.getTime(),
        cron: def.cron,
        source: def.source,
      };
      try {
        await this._onSubmit(spec);
        submitted.push(spec);
        this._log("info", "trigger:fired", { workflow: def.name, cron: def.cron, at: spec.at });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._errors.push({ workflow: def.name, at: spec.at, error: msg });
        this._log("warn", "trigger:submit-failed", { workflow: def.name, error: msg });
      }
    }
    return submitted;
  }

  /**
   * 表驱动便捷入口：按给定时刻序列逐个 tick，聚合提交结果。
   * 测试「假时钟快进」即 `tickAll([t0, t1, t2, ...])`。
   */
  async tickAll(times: readonly Date[]): Promise<RunSubmitSpec[]> {
    const all: RunSubmitSpec[] = [];
    for (const t of times) {
      all.push(...(await this.tick(t)));
    }
    return all;
  }
}
