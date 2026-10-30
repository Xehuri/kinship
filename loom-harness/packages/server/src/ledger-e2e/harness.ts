/**
 * T35 账本崩溃追赶 E2E 装置（docs/02 §T35；决策 docs/01 D15「崩溃即重放」）。
 *
 * 一句话职责：把「真 Ledger（临时目录 jsonl）+ 真 RunEngine + 真 Reconciler」装配成
 * 可反复「崩溃→重启」的进程仿真：
 *   - 崩溃 = 真引擎派发 + 执行端口抛异常（T12 故意只写 expected 不写 actual 的缺口形状），
 *     随后丢弃引擎实例 = 进程被杀（内存视图随之蒸发）；
 *   - 重启 = 全新 `new Ledger(path)`（构造即全量重放磁盘）+ 全新 Reconciler，
 *     对账唯一输入仍是账本文件——无任何内存态可依赖。
 * 断言另走 `readFileRows()` 直读磁盘 jsonl 逐行边界解析（字节真相），不信任何内存镜像。
 *
 * 边界声明：执行端口用 ScriptedSessionPort 仿真「进程级崩溃/终局」；真 LLM 侧会话端口
 * 的覆盖面在 T12 自身测试（run-engine.test.ts），本装置不重复。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Ledger,
  StateLayout,
  isJsonObjectRow,
  parseLedgerRow,
  stateDateKey,
  type LedgerRow,
} from "@axeuh/loom-adapters";
import { DEFAULT_LIMITS, type Limits } from "@axeuh/loom-core";
import {
  RunEngine,
  type DispatchInput,
  type RunLaunchContext,
  type RunLaunchResult,
  type RunRecord,
  type RunSessionPort,
  type RunTerminalState,
  type RunTrigger,
} from "@axeuh/loom-core/run-engine";
import {
  MapCatchupPolicy,
  MemoryAutoResume,
  MemoryCatchupDispatch,
  MemoryMainDeliver,
  Reconciler,
  type CatchupDispatchPort,
  type CatchupRequest,
  type CatchupStrategy,
  type DeadLetterReceipt,
  type RecoveryAction,
} from "@axeuh/loom-core/recovery";

/* ────────────── 常量与判别守卫 ────────────── */

/** 固定起点时刻（日分片键 = 2026-10-08；时钟从此起严格递增，保证 latest 排序确定）。 */
const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0);

/** dispatch 统一 prompt（引擎只透传，非本 E2E 观察对象）。 */
const DISPATCH_PROMPT = "T35 e2e：崩溃追赶场景 prompt";

function assertNever(x: never): never {
  throw new Error(`unhandled discriminated value: ${JSON.stringify(x)}`);
}

/** 取第 i 个元素（strict 下标可能 undefined，统一在此响亮失败）。 */
export function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

/** 按 kind 折出对账动作（穷尽判别，返回精确类型）。 */
export function actionsOfKind<K extends RecoveryAction["kind"]>(
  plan: { readonly actions: readonly RecoveryAction[] },
  kind: K,
): ReadonlyArray<Extract<RecoveryAction, { readonly kind: K }>> {
  return plan.actions.filter(
    (a): a is Extract<RecoveryAction, { readonly kind: K }> => a.kind === kind,
  );
}

/** 磁盘账本行按 t 折叠（expected/actual 两型各自的精确视图）。 */
export type ExpectedRow = Extract<LedgerRow, { readonly t: "expected" }>;
export type ActualRow = Extract<LedgerRow, { readonly t: "actual" }>;

export function expectedRows(rows: readonly LedgerRow[]): ExpectedRow[] {
  return rows.filter((r): r is ExpectedRow => r.t === "expected");
}

export function actualRows(rows: readonly LedgerRow[]): ActualRow[] {
  return rows.filter((r): r is ActualRow => r.t === "actual");
}

/* ────────────── 执行端口仿真（崩溃形状 = 抛异常，T12 留缺口契约） ────────────── */

/** 单 run 行为：terminal = 正常终局；crash = 执行器抛炸（进程级崩溃形状）。 */
export type RunBehavior =
  | { readonly kind: "terminal"; readonly result: RunLaunchResult }
  | { readonly kind: "crash" };

export const CRASH_BEHAVIOR: RunBehavior = { kind: "crash" };

/** 按 run_id 脚本化的执行端口；未脚本的 run 响亮拒绝（防装置误用）。 */
export class ScriptedSessionPort implements RunSessionPort {
  private readonly _byRun = new Map<string, RunBehavior>();
  /** 已进入执行的 run 序列（执行确实开火的观察点）。 */
  readonly entered: string[] = [];

  script(runId: string, behavior: RunBehavior): void {
    this._byRun.set(runId, behavior);
  }

  async run(ctx: RunLaunchContext): Promise<RunLaunchResult> {
    this.entered.push(ctx.row.run_id);
    const behavior = this._byRun.get(ctx.row.run_id);
    if (behavior === undefined) {
      throw new Error(`ScriptedSessionPort: no behavior scripted for run ${ctx.row.run_id}`);
    }
    switch (behavior.kind) {
      case "terminal":
        return behavior.result;
      case "crash":
        throw new Error(`simulated executor crash: run ${ctx.row.run_id}`);
      default:
        return assertNever(behavior);
    }
  }
}

/** 正常终局结果构造（无 receipt/forceReason —— 引擎按需缺省）。 */
export function terminalResult(
  status: RunTerminalState,
  digest: string,
  blockers: readonly string[] = [],
): RunLaunchResult {
  return { status, digest, pointers: [], blockers };
}

/* ────────────── 派发辅助 ────────────── */

export interface DispatchOverrides {
  readonly attempt?: number;
  readonly parentRun?: string;
}

/** 用显式 run_id 构造 DispatchInput（session_id 与 run 同 hex、ses_ 前缀，形状合法）。 */
export function dispatchInput(
  runId: string,
  workflow: string,
  trigger: RunTrigger,
  overrides: DispatchOverrides = {},
): DispatchInput {
  return {
    workflow,
    trigger,
    prompt: DISPATCH_PROMPT,
    runId,
    sessionId: `ses_${runId.slice(4)}`,
    ...(overrides.attempt === undefined ? {} : { attempt: overrides.attempt }),
    ...(overrides.parentRun === undefined ? {} : { parentRun: overrides.parentRun }),
  };
}

/** dispatch 并等待 completion（崩溃也 resolve 成记录）；paused 视为装置误用响亮抛错。 */
export async function launch(engine: RunEngine, input: DispatchInput): Promise<RunRecord> {
  const result = await engine.dispatch(input);
  switch (result.kind) {
    case "launched":
      return result.completion;
    case "paused":
      throw new Error(
        `harness misuse: dispatch paused ${result.row.run_id} (${result.reason})`,
      );
    default:
      return assertNever(result);
  }
}

/* ────────────── 追赶派发端口（真派发链路用：补跑 = 新引擎新 run） ────────────── */

/**
 * 派发端口实现：记录请求 + 调 spawn 回调。
 * T35 用它把「restart 后 catchup 真的再造一台引擎跑一次（再崩）」接成完整链条，
 * 与 server 装配同款（端口补 prompt 后转 RunEngine.dispatch，D19 level 2）。
 */
export class SpawningCatchupPort implements CatchupDispatchPort {
  readonly requests: CatchupRequest[] = [];
  constructor(
    private readonly _spawn: (request: CatchupRequest) => void | Promise<void>,
  ) {}

  async dispatchCatchup(request: CatchupRequest): Promise<void> {
    this.requests.push(request);
    await this._spawn(request);
  }
}

/* ────────────── 装置主体 ────────────── */

export interface Harness {
  /** 临时状态根（测毕 cleanup）。 */
  readonly dir: string;
  /** <root>/ledger/<date>.jsonl —— 唯一持久真源路径。 */
  readonly ledgerPath: string;
  /** 全新 Ledger 实例 = 一次「进程启动」（构造即全量重放磁盘文件）。 */
  openLedger(): Ledger;
  /** 装配一台真引擎（单调时钟从 START_MS 严格递增，latest 排序键确定）。 */
  newEngine(ledger: Ledger, port: RunSessionPort): RunEngine;
  /** 直读磁盘 jsonl：逐行边界解析成 LedgerRow（文件字节真相，绕开一切内存镜像）。 */
  readFileRows(): LedgerRow[];
  /** 账本文件原文（字节级不变性断言用）。 */
  readFileText(): string;
  /** 确定性 id 生成（run_<hex16>，符合 docs/04 §3.2 形状）。 */
  nextRunId(): string;
  cleanup(): void;
}

function parseJsonlFile(path: string): LedgerRow[] {
  const text = readFileSync(path, "utf8");
  const out: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const value: unknown = JSON.parse(line);
    if (!isJsonObjectRow(value)) {
      throw new Error(`ledger jsonl line is not a JSON object: ${line.slice(0, 120)}`);
    }
    out.push(parseLedgerRow(value));
  }
  return out;
}

export function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "loom-e2e-ledger-"));
  const layout = new StateLayout({ root: dir });
  const ledgerPath = layout.dayPath("ledger", stateDateKey(START_MS));
  let tick = 0;
  let idSeq = 0;

  return {
    dir,
    ledgerPath,
    openLedger: () => new Ledger(ledgerPath),
    newEngine: (ledger, port) =>
      new RunEngine({
        ledger,
        sessionPort: port,
        now: () => START_MS + (tick += 1) * 1000,
      }),
    readFileRows: () => parseJsonlFile(ledgerPath),
    readFileText: () => readFileSync(ledgerPath, "utf8"),
    nextRunId: () => `run_${(idSeq += 1).toString(16).padStart(16, "0")}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/* ────────────── 「重启」装配：全新 Ledger + 全新 Reconciler ────────────── */

export interface BootOptions {
  readonly limits?: Limits;
  /** 覆盖 level-2 派发端口（缺省 = 内存记录端口）；F 链用 SpawningCatchupPort。 */
  readonly dispatch?: CatchupDispatchPort;
}

export interface RestartHarness {
  readonly ledger: Ledger;
  readonly reconciler: Reconciler;
  readonly autoResume: MemoryAutoResume;
  readonly mainDeliver: MemoryMainDeliver;
  readonly notified: DeadLetterReceipt[];
}

/**
 * 模拟进程重启：新建 Ledger（构造即重放磁盘）+ 新建 Reconciler。
 * 逐工作流策略走 MapCatchupPolicy（未声明工作流保守回落 "none"）。
 * `over.dispatch` 注入真派发链路端口（如 SpawningCatchupPort）时由其自持观察记录。
 */
export function restart(
  h: Harness,
  strategy: ReadonlyMap<string, CatchupStrategy>,
  over: BootOptions = {},
): RestartHarness {
  const ledger = h.openLedger();
  const autoResume = new MemoryAutoResume();
  const mainDeliver = new MemoryMainDeliver();
  const notified: DeadLetterReceipt[] = [];
  const reconciler = new Reconciler({
    ledger,
    policy: new MapCatchupPolicy(strategy, "none"),
    limits: over.limits ?? DEFAULT_LIMITS,
    autoResume,
    dispatch: over.dispatch ?? new MemoryCatchupDispatch(),
    mainDeliver,
    notify: (receipt) => {
      notified.push(receipt);
    },
  });
  return { ledger, reconciler, autoResume, mainDeliver, notified };
}
