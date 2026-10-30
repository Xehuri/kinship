/**
 * RunEngine —— 副会话（Run）运行引擎 **门面**（T12 出身；W9 切片 1 起生命周期收编进 SpawnKernel）。
 *
 * 公共面（类名/构造签名/dispatch/listRuns/cancel/activeCount/get/gaps）逐字节不变——
 * task-api/control-plane/ledger-e2e/golden/contract 全链压在此上；内部只剩两件事：
 *   1. 边界解析（parseDispatchInput/parseAgentRef + id 生成器，types.ts 词表）；
 *   2. 委托 SpawnKernel 走「账本序正确的状态机迁移」全序（kernel.ts：登记→准入→
 *      expected fsync→running→观察者→执行→盖棺/崩溃缺口→产物/死信/终盖观察者）。
 *
 * 核心不变量随内核平移（原 engine 文档逐条对应）：
 *   - D15 时序：`ledger.expected()` 同步返回之后，sessionPort 才可能被触碰；
 *   - 崩溃形状：执行器抛 = failed+crashed、**故意不写 actual** 留缺口（T13/T35 输入）；
 *   - completion 恒 resolve（崩溃也是数据不是异常）；
 *   - D31/T17 paused = 账本零痕迹、不登记；
 *   - D19 全新会话零残留 = 执行端口职责（side-session-port / kernel 工厂）。
 *
 * 进程单例口径（W9 切片 1，boot 装配）：boot 先 `new SpawnKernel(engineOpts)` 再
 * `new RunEngine({...同款 opts, kernel})`——显式 kernel 在场时门面不自建，其余 opts
 * 字段由 kernel 构造时的同款注入生效（两面同源，无双份状态）。测试/直调不传
 * kernel = 门面内部自建（登记表/aborter 通道随门面实例，隔离语义不变）。
 */

import { SpawnKernel } from "../kernel/kernel.js";
import {
  defaultRunId,
  defaultSessionId,
  parseAgentRef,
  parseDispatchInput,
  type AdmissionControl,
  type ArtifactSink,
  type DeadLetterSink,
  type DispatchInput,
  type DispatchResult,
  type LedgerPort,
  type RunEngineLog,
  type RunRecord,
  type RunRow,
  type RunSessionPort,
} from "./types.js";

/** 引擎装配面（签名冻结；协作件全部注入：core 不 import adapters/server）。 */
export interface RunEngineOptions {
  /** T08 账本端口。server 传真 `Ledger`；core 测试传 `MemoryLedger`（见 DoneClaim）。 */
  readonly ledger: LedgerPort;
  /** 每次 run 的执行端口（「全新会话」由其保证，见 side-session-port.ts）。 */
  readonly sessionPort: RunSessionPort;
  /** 准入钩子，缺省全放行；T17 在此接暂停开关。 */
  readonly admission?: AdmissionControl;
  /** 产物快照出口（D5 单向产物通道），缺省不发。 */
  readonly artifactSink?: ArtifactSink;
  /** 死信出口（D26 failed 形状），缺省不发。 */
  readonly deadLetterSink?: DeadLetterSink;
  /**
   * 观测缝：run 开跑（expected fsync 落盘后、sessionPort 触碰前同步调用）。
   * server 侧开 trace RunTracker；抛错经 safe-side-effect 通道吞掉留 warn，
   * 绝不反噬账本/执行路径（观测面反噬 = 缺陷）。
   */
  readonly onRunStarted?: (row: RunRow) => void;
  /**
   * 观测缝：run 终态盖棺（引擎记录进终态处恰调一次：正常 actual 落盘后 /
   * 崩溃形状；actual 写失败属缺口形状不调，T13 对账后补）。
   * server 侧据此 finishRun 落 trace run_end 行；吞错契约同上。
   */
  readonly onRunTerminal?: (record: RunRecord) => void;
  /** 结构化日志，缺省静默。 */
  readonly log?: RunEngineLog;
  /** 时钟注入（T15/T35 确定性；缺省 Date.now）。 */
  readonly now?: () => number;
  /** run id 生成器，缺省 `run_<hex16>`（连字符永久禁用，docs/04 §3.2）。 */
  readonly newRunId?: () => string;
  /** session id 生成器，缺省 `ses_<hex16>`。 */
  readonly newSessionId?: () => string;
  /**
   * W9 切片 1 装配接线（缺省 = 门面内部自建内核，旧调用面零变化）：boot 传真进程
   * 单例内核，令「唯一 spawn 登记面」名副其实。给了 kernel 后其余生命周期字段
   * 以 kernel 构造注入为准（门面不再二次持有状态）。
   */
  readonly kernel?: SpawnKernel;
}

export class RunEngine {
  private readonly _kernel: SpawnKernel;
  private readonly _newRunId: () => string;
  private readonly _newSessionId: () => string;

  constructor(opts: RunEngineOptions) {
    this._kernel = opts.kernel ?? new SpawnKernel(opts);
    this._newRunId = opts.newRunId ?? defaultRunId;
    this._newSessionId = opts.newSessionId ?? defaultSessionId;
  }

  /**
   * 开火 = 解析 + 委托内核（时序/崩溃/盖棺全序见 kernel._spawnRun）。
   *
   * 返回 launched（`completion`=终态 RunRecord，**永不 reject**：崩溃也如实回记录）
   * 或 paused（账本零痕迹、引擎不登记，D31/T17）。
   * 抛 RunEngineError 仅三种情况：输入非法、run_id 撞号、expected 落盘失败（=绝不开火）。
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const row = parseDispatchInput(input, this._newRunId, this._newSessionId);
    const prompt = input.prompt;
    // 角色引用与 row 同步解析（边界一次、内部不再验）；未进账本行，只进执行上下文。
    const agent = parseAgentRef(input.agent);

    const spawned = await this._kernel.spawn({
      kind: "run",
      row,
      prompt,
      ...(agent === undefined ? {} : { agent }),
    });
    if (spawned.kind === "paused") return spawned;
    return { kind: "launched", row: spawned.row, completion: spawned.handle.completion };
  }

  /**
   * 取消在途 run（T25 控制面接缝）：记录原因 + abort 执行 signal。
   * 返回是否命中在途 run。终态由执行端口对 abort 的映射决定（signal 契约在端口）。
   */
  cancel(runId: string, reason = "cancel requested"): boolean {
    return this._kernel.cancel(runId, reason);
  }

  /** run 记录（只读快照）；未知 id = undefined。 */
  get(runId: string): RunRecord | undefined {
    return this._kernel.get(runId);
  }

  /** 全量列表（T28 列表/详情原料；按受理插入序）。 */
  listRuns(workflow?: string): RunRecord[] {
    return this._kernel.listRuns(workflow);
  }

  /** 在途 run 数（dispatch 准入层 max_inflight 参数原料，D24）。 */
  activeCount(): number {
    return this._kernel.activeCount();
  }

  /**
   * 引擎视角缺口：crashed 或未达终态的 run。
   * **重启后此值恒空——对账真相只在账本**（T13 全量重扫 `Ledger.gaps()`）。
   */
  gaps(): string[] {
    return this._kernel.gaps();
  }
}
