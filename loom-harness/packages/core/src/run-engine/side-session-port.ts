/**
 * createSideSessionPort —— RunSessionPort 的真实实现（T12 默认执行端口）。
 *
 * 契约（D19 全新会话 + T09 收束终止 + D25/D26 词表）：
 *   - **每次 run 新建一个 AgentSession**（不给 initialMessages、不回读任何历史；
 *     W9 切片0 起可挂注入 store 做只写落盘，跨 run 内存零残留语义不动），
 *     挂全新 ConvergenceGate({kind:"side"})——引擎跨 run 零残留的结构性保证。
 *   - session.run(prompt, {signal}) 后按 gate.runOutcome() 穷尽判别映射到 RunLaunchResult：
 *       converged  → 回执三态（done/partial/failed）+ digest/pointers/blockers；
 *       forceEnded → D26 分级强制收束：status=failed + forceReason（引擎据此发死信形状）；
 *       无终止态   → 非收束通道结束（caller abort / 内核 error / 未预期 done）：
 *                    如实映射 failed，digest 说明原因，**绝不**伪装成功。
 *   - 端口自身抛出的异常（模型未配置等 = 执行器炸）由引擎转成「账本缺口」形状。
 *
 * 回执里的 runId/workflow/attempt 是模型自述（T09 只验形状）；**账本行 identity 以
 * 引擎的 RunRow 为真源**，T14 验证块据此比对。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { buildConvergeSession } from "../kernel/kernel.js";
import type {
  ConvergenceOutcome,
  Limits,
  NudgeObservation,
  SideReceipt,
} from "../convergence/index.js";
import { SessionContextWatcher, type MemorySource } from "../assembly/index.js";
import type { Hook } from "../hook.js";
import type { HarnessTool } from "../types.js";
import type { LlmOptions } from "../llm-model.js";
import type { SessionStore } from "../session-store.js";
import type { WireRequestSnapshot } from "../wire-capture.js";
import type { RunLaunchContext, RunLaunchResult, RunSessionPort } from "./types.js";

/**
 * 一次副会话 run 的装配绑定（B 面：任务 `agent:` 引用角色文件时非空）。
 * systemPrompt 由端口拼定：角色正文在前、记忆注入块（renderMemorySegment 形状）
 * 在后；两者都已按前缀纪律定序 ⇒ 同输入双跑字节全等。
 */
export interface SideRunBinding {
  readonly systemPrompt: string;
  /** 注入清单（已按路径字典序；仅用于观测/trace 行数，渲染已并入 systemPrompt）。 */
  readonly memorySources: readonly MemorySource[];
  /** 工作区真实根：侧会话 watcher 的 stat/read 根（Task 5 消费）。 */
  readonly workspaceRoot: string;
}

/** 绑定解析结果：成功 = SideRunBinding；失败 = 带原因（端口据此抛错，绝不静默）。 */
export type SideBindingResolution = SideRunBinding | { readonly error: string };

export interface SideSessionPortOptions {
  /** 该工作流路由到的模型（T07 config 提供；测试注入 createFakeModel）。 */
  readonly model: Model<Api>;
  /** 干活工具集（业务工具；converge 工具由 gate 自带，不在此列）。 */
  readonly tools?: readonly HarnessTool[];
  /**
   * 静态 systemPrompt 回落（仅当某 run **未走 resolveBinding 通道**时生效；
   * resolveBinding 存在时逐 run 覆盖——角色自声明优先级更高）。
   */
  readonly systemPrompt?: string;
  /** 收束阈值（热载对象，缺省 DEFAULT_LIMITS）。 */
  readonly limits?: Limits;
  /** 透传 provider options（T07 模型路由参数；apiKey 接线见 serve/model-source.ts）。 */
  readonly llmOptions?: LlmOptions;
  /**
   * 逐 run 绑定解析（serve 装配接 workspace 角色加载器）：
   * ctx.agent 有值 → 角色文件正文 + 其 frontmatter.memory 注入集；
   * 无值 → 缺省语义（AGENTS.md 基础集，无角色正文）。
   * 解析失败（角色不存在等）返回 {error} → 端口抛错走引擎崩溃形状，绝不静默降级。
   */
  readonly resolveBinding?: (ctx: RunLaunchContext) => Promise<SideBindingResolution>;
  /**
   * 会话级附加 hooks（W5 skills 接线：catalog 进 system prompt 的 transform hook）。
   * 与 gate 自身 hooks 并列挂上每个新建 AgentSession；缺省 = 不挂（旧调用面不变）。
   */
  readonly hooks?: readonly Hook[];
  /**
   * 催办观察钩子（trace nudge 行生产接线点，server 注入）：逐 run 透传给该 run
   * 专属 ConvergenceGate；sessionId=账本 session_id（与 runId 同键，server 侧 join）。
   */
  readonly onNudge?: (ev: NudgeObservation) => void;
  /**
   * W9 切片0 决策：副会话转录落盘面。注入后每次 run 的 AgentSession 挂同一 SessionStore
   * 实例（内核每 turn flush 语义现成，零新工作）；**只写不读**——引擎"跨 run 零残留"
   * 语义不动（仍不喂 initialMessages、不回读历史），本项只补转录的 L0 持久化面。
   * 缺省 = 不挂（旧调用面逐字节不变）。
   */
  readonly store?: SessionStore;
  /**
   * W23-A 发线面持久回调（逐 run 绑账本 session_id 后透传 buildConvergeSession）：
   * 该 run 每次 LLM call 解析完成后恰好一次；server 侧落 wire/{sid}.json（写前脱敏）。
   * 缺省 = 不挂（旧调用面逐字节不变）。
   */
  readonly onWireSnapshot?: (
    sessionId: string,
    snapshot: WireRequestSnapshot,
    providerPayload: string | null,
  ) => void;
}

/** converged/forceEnded 回执 narrow 到 side 形状（MainReceipt 无 runId 字段）。 */
function sideReceiptOf(outcome: ConvergenceOutcome): SideReceipt | null {
  if (outcome.type !== "converged" && outcome.type !== "forceEnded") return null;
  const r = outcome.receipt;
  return "runId" in r ? r : null;
}

export function createSideSessionPort(opts: SideSessionPortOptions): RunSessionPort {
  return {
    async run(ctx: RunLaunchContext): Promise<RunLaunchResult> {
      // ── 逐 run 装配绑定：resolveBinding 缺省时回落静态 systemPrompt（旧调用面不变）。
      // 有绑定且有注入源时，再为本次 run 现造一个 watcher（每次 run 全新，零跨 run 残留）；
      // 降级源 content=null 只占位，首见走 set（"Additional instructions"）而非伪造 diff。
      let systemPrompt = opts.systemPrompt;
      let contextWatcher: SessionContextWatcher | undefined;
      if (opts.resolveBinding !== undefined) {
        const binding = await opts.resolveBinding(ctx);
        if ("error" in binding) {
          throw new Error(`side-session-port: binding resolve failed: ${binding.error}`);
        }
        systemPrompt = binding.systemPrompt;
        if (binding.memorySources.length > 0) {
          contextWatcher = new SessionContextWatcher({
            workspaceRoot: binding.workspaceRoot,
            sources: binding.memorySources.map((s) => ({
              relPath: s.source,
              content: s.degrade === null ? s.content : null,
            })),
          });
        }
      }

      // ── 全新会话：每次 run 经内核工厂新建 AgentSession + 新建 gate；零 initialMessages。
      // 构造段本体已平移至 kernel.buildConvergeSession（W9 切片 1 唯一工厂收口），
      // 此处只保留「逐 run 现造 + 终局映射」两端，行为逐字节不变。
      const onWire = opts.onWireSnapshot;
      const { gate, session } = buildConvergeSession({
        model: opts.model,
        sessionId: ctx.row.session_id,
        tools: opts.tools ?? [],
        hooks: opts.hooks ?? [],
        ...(opts.limits === undefined ? {} : { limits: opts.limits }),
        ...(opts.onNudge === undefined ? {} : { onNudge: opts.onNudge }),
        ...(opts.llmOptions === undefined ? {} : { llmOptions: opts.llmOptions }),
        ...(opts.store === undefined ? {} : { store: opts.store }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(contextWatcher === undefined ? {} : { contextWatcher }),
        ...(onWire === undefined
          ? {}
          : { onWireSnapshot: (snap: WireRequestSnapshot, payload: string | null) => onWire(ctx.row.session_id, snap, payload) }),
      });

      const summary = await session.run(ctx.prompt, { signal: ctx.signal });
      const outcome = gate.runOutcome().outcome;

      if (outcome !== null && outcome.type === "converged") {
        const receipt = sideReceiptOf(outcome);
        if (receipt === null) {
          throw new Error("converged outcome without side receipt (internal T09 invariant break)");
        }
        return {
          status: receipt.status,
          digest: receipt.digest,
          pointers: receipt.pointers,
          blockers: receipt.blockers,
          receipt,
          // W16-F4：usage 自内核 RunSummary 如实透传（trace run_end totals 的取数口）。
          usage: summary.usage,
        };
      }

      if (outcome !== null && outcome.type === "forceEnded") {
        const receipt = sideReceiptOf(outcome);
        // D26：副会话强制收束 = failed 进死信（deadLetter=true 由 gate 给出，
        // 死信投递是引擎在 failed 终态统一做的形状，见 engine._execute）。
        return {
          status: "failed",
          digest: receipt?.digest ?? `failed：强制收束（${outcome.reason}），无合法回执`,
          pointers: receipt?.pointers ?? [],
          blockers: receipt?.blockers ?? [outcome.reason],
          forceReason: outcome.reason,
          ...(receipt === undefined || receipt === null ? {} : { receipt }),
          usage: summary.usage,
        };
      }

      // ── 非收束通道结束（abort / kernel error / 未预期自然 done）：如实 failed。
      const why =
        summary.abortReason ??
        summary.error?.message ??
        summary.reason ??
        "unknown termination";
      return {
        status: "failed",
        digest: `failed：会话未经收束终止（${why}）`,
        pointers: [],
        blockers: [`termination:${summary.reason}`, `detail:${String(why)}`],
        usage: summary.usage,
      };
    },
  };
}
