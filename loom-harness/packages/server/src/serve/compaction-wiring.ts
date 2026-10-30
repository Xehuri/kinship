/**
 * W49-C 主会话压缩接线的装配层（W49.7 spike memo「W49.8 LOCK」的实现合同）。
 *
 * 定位：server→core 插件的**唯一接线缝**。config `compaction` 段（schema 见
 * ../config/section-checks.ts checkCompaction）在场且 enabled:true 时，boot 经本文件
 * 产出一个 **per-session hook 工厂**，交 SessionRegistry.hooksFor 在 #ensure 建会话时
 * 逐会话调用，返回值追加在 extraHooks 尾部（W47 gate 先序 = 尾部追加的构造性证明）。
 *
 * 为什么是工厂而不是实例数组（T4，本轮实锤）：boot.ts 进 SessionRegistry 的静态 hooks
 * 数组被所有会话复用（registry.ts:694 #ensure 把 opts.hooks spread 进每个 loop），而
 * autoCompaction 的闭包缓存（coveredCount+summaryMsg）假设**一实例一 session**
 * （auto-compaction.ts:256-258）——跨会话共享实例 = coveredCount 串扰、view 错位。
 * skills/toolStream 无状态所以旧例无害；压缩钩子有状态，必须逐会话新构造。
 * microcompact 虽无状态，同样逐会话构造（均匀性，LOCK 清单）。
 *
 * 链序（LOCK）：[microcompact, autoCompaction(+timeout), compactionBoundary?(flag ON)]。
 * microcompact 必须排在 autoCompaction **之前**（microcompact.ts:12-18：先廉价降体积，
 * 昂贵总结据清理后的 view 决定；与 auto-compaction.ts:249-252 的「压缩型排裁剪型之前」
 * 规则相反、勿套用）。与 compactSummarize 互斥（T3：本链只挂 autoCompaction 一族）。
 * abortOnOverflow 保持省略（T10：配套 compactRestartFresh 全仓无实现，置 true=abort
 * 无接盘者）。
 *
 * summarize 后端：summary-template defaultSummarize（9 段模板）× llm-model completeText
 * （一次性无工具补全，非 stop/空文本报错）——与主会话**同一 model 句柄、同一 provider**
 * （零新增凭据路径，凭据铁律不破）。summarize 在 transformMessagesBeforeLlm 内 await
 * LLM，故 hook 必须带 timeout 覆盖（T1：pipe 缺省 500ms 静默杀 = 永不压缩且 hook failure
 * 只落 failureSink）。
 *
 * C.2 compactionBoundary adapter（flag compaction.boundary，**默认 OFF**）：onAfterFlush
 * collect-return seam 的纯渲染生产者（零 LLM 调用、零写权——写由内核 in-band 串行执行，
 * 超时/抛错=该 turn 干净跳过，dispatcher.ts:175-177 特性非缺陷）。B 文本 =
 * boundary.summary 全文 + 分隔线 + ctx.messages（_messages 真相，非占位符视图）自
 * coveredCount 起的逐字渲染——重启重放 100% 持久化前缀有表示（W49.7 Q2 算术）。
 * 发射规则 = coveredCount advance 单发（插件 resummarizeEvery 天然节流频率）。
 * Plan B T6：返回 `CompactionCheckpointPayload`（summary + checkpoint 元数据），resume
 * 恢复的 boundary（`restored === true`）只采纳坐标、绝不重复落一条；后续新 summary
 * 以更大 coveredCount 再发一次。B 文本已内嵌 recent tail，故 checkpoint 声明
 * `tailIncluded: true`，重放据此只换 summary、不重复保留尾巴。
 *
 * 范围申明：**只作用主会话**。side 端口（boot.ts createSideSessionPort）与子会话
 * （tool-wiring childSessionFactory）的 hooks 面零接线零改动——core/compaction/routine.ts
 * 头注「副会话 run 默认不压缩」纪律的 server 侧镜像（用户冻结约束，工单口径）。
 */

import { randomUUID } from "node:crypto";

import {
  ACTIVE_BOUNDARY_KEY,
  COMPACT_CHAT_SUMMARY_TEMPLATE,
  COMPACT_HANDOFF_SUMMARY_TEMPLATE,
  COMPACTION_CHECKPOINT_VERSION,
  COMPACTION_TAIL_SEPARATOR,
  CompactionStateStore,
  autoCompaction,
  buildChatSummaryMergePrompt,
  completeText,
  streamText,
  createUserMessage,
  defaultSummarize,
  microcompact,
  projectToolResultsForSummary,
  renderMessage,
  type Api,
  type CompactionCheckpointPayload,
  type CompactionSummaryPerspective,
  type Hook,
  type LlmOptions,
  type Message,
  type Model,
  type SessionCompactionOptions,
} from "@axeuh/loom-core";
import type { CompactionConfig, ReasoningEffort } from "../config/loom-config.js";

/** 模型句柄结构子集（boot 传 ServeModelHandle 真身；构建期零触，summarize 只在压缩触发时消费）。 */
export interface CompactionModelHandle {
  readonly model: Model<Api>;
  readonly llmOptions: LlmOptions;
}

export interface BuildCompactionHooksInput {
  readonly model: CompactionModelHandle;
  readonly cfg: CompactionConfig;
}

export interface BuildSessionCompactionInput extends BuildCompactionHooksInput {
  readonly stateRoot: string;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 由模型窗口推导单次摘要调用预算：窗口的 85% 扣除输出上限（封顶 32768）与 4096 framing。
 * 非有限/非正输入抛 RangeError；装配层调用前须自行判输入，以便失效时降级而非炸 boot。
 */
export function deriveSingleCallBudgetTokens(contextWindow: number, maxOutput: number): number {
  if (!isFinitePositive(contextWindow) || !isFinitePositive(maxOutput)) {
    throw new RangeError(
      `deriveSingleCallBudgetTokens: contextWindow/maxOutput must be finite positive numbers ` +
        `(got ${String(contextWindow)}/${String(maxOutput)})`,
    );
  }
  return Math.max(
    1_000,
    Math.floor(contextWindow * 0.85) - Math.min(maxOutput, 32_768) - 4_096,
  );
}

/** 摘要调用思考强度覆盖：只克隆顶层与 providerExtras，不改 base。 */
export function buildSummaryLlmOptions(
  base: LlmOptions,
  effort: ReasoningEffort | undefined,
): LlmOptions {
  if (effort === undefined) return base;
  return {
    ...base,
    providerExtras: { ...base.providerExtras, reasoningEffort: effort },
  };
}

/** 生效摘要视角：缺席 = 双视角缺省；声明时归一为 ops 主视角在前。 */
export function resolveSummaryPerspectives(
  cfg: CompactionConfig,
): readonly ("ops" | "chat")[] {
  if (cfg.summaryPerspectives === undefined) return ["ops", "chat"];
  return ["ops", ...cfg.summaryPerspectives.filter((p) => p !== "ops")];
}

/**
 * W57 P2c-2：构造会话级 fallback 压缩依赖。只有 `fallbackTokens` 显式声明时才启用；
 * 启用后自动压缩由 AgentSession worker 接管，`buildCompactionHooks` 不再挂旧 autoCompaction。
 */
export function buildSessionCompactionOptions(
  input: BuildSessionCompactionInput,
): SessionCompactionOptions | undefined {
  const { model, cfg, stateRoot } = input;
  if (!cfg.enabled || cfg.fallbackTokens === undefined) return undefined;
  const complete = (
    prompt: string,
    onDelta?: (delta: { part: "reasoning" | "content"; delta: string }) => void,
  ): Promise<string> =>
    streamText(
      model.model,
      [createUserMessage(prompt)],
      buildSummaryLlmOptions(model.llmOptions, cfg.summaryReasoningEffort),
      onDelta,
    );
  const summarize = defaultSummarize({
    template: COMPACT_HANDOFF_SUMMARY_TEMPLATE,
    complete,
  });
  const chatPerspective: CompactionSummaryPerspective | undefined =
    resolveSummaryPerspectives(cfg).includes("chat")
      ? {
          key: "chat",
          title: "CHAT STATE",
          summarize: defaultSummarize({
            template: COMPACT_CHAT_SUMMARY_TEMPLATE,
            complete,
          }),
          buildMergePrompt: buildChatSummaryMergePrompt,
        }
      : undefined;
  const keepRecent = cfg.keepRecent ?? 6;
  const derivedBudget =
    isFinitePositive(model.model.contextWindow) && isFinitePositive(model.model.maxTokens)
      ? deriveSingleCallBudgetTokens(model.model.contextWindow, model.model.maxTokens)
      : undefined;
  const budget = cfg.singleCallBudgetTokens ?? derivedBudget;
  let summaryMode: "auto" | "single" | "chunked" = cfg.summaryMode ?? "auto";
  if (summaryMode !== "chunked" && budget === undefined) summaryMode = "chunked";
  const compactableTools =
    cfg.microcompact !== undefined &&
    cfg.microcompact.enabled !== false &&
    cfg.microcompact.compactableTools !== undefined &&
    cfg.microcompact.compactableTools.length > 0
      ? cfg.microcompact.compactableTools
      : undefined;
  const projectionKeepRecent = cfg.microcompact?.keepRecent ?? 5;
  return {
    stateStore: new CompactionStateStore({ stateRoot }),
    summarize,
    ...(chatPerspective === undefined
      ? {}
      : { additionalSummaryPerspectives: [chatPerspective] }),
    wrapSummary: (text, coveredCount) =>
      `[auto-compacted summary of ${coveredCount} earlier messages]\n${text}`,
    fallbackTokens: cfg.fallbackTokens,
    ...(cfg.watermark?.levels === undefined ? {} : { watermarkLevels: cfg.watermark.levels }),
    keepRecent,
    keepRecentTokens: cfg.keepRecentTokens ?? 15_000,
    resummarizeEvery: cfg.resummarizeEvery ?? keepRecent,
    summaryChunkTokens: cfg.summaryChunkTokens ?? 200_000,
    summaryMode,
    summaryMaxSplitDepth: 2,
    ...(summaryMode !== "chunked" && budget !== undefined
      ? { singleCallBudgetTokens: budget }
      : {}),
    ...(compactableTools === undefined
      ? {}
      : {
          projectSummaryInput: (messages: Message[]) =>
            projectToolResultsForSummary(messages, {
              compactableTools: new Set(compactableTools),
              keepRecent: projectionKeepRecent,
            }),
        }),
    requestTimeoutMs: cfg.requestTimeoutMs ?? 300_000,
    retryCount: cfg.retryCount ?? 10,
    ...(cfg.stream === undefined ? {} : { stream: cfg.stream }),
  };
}

/** T1 破法的双点常量：summaryTimeoutMs 缺席时 wiring 的唯一物化点（pipe 缺省 500ms 绝不可见）。 */
const DEFAULT_SUMMARY_TIMEOUT_MS = 60_000;

/** C.2 adapter 显式超时（T7：event 类缺省 100ms——纯同步渲染用不满，但显式值钉死"小超时"合同）。 */
const BOUNDARY_HOOK_TIMEOUT_MS = 5_000;

/** Message 正文抽取（string 或 text 块拼接）——boundary.summary 是 createUserMessage 形状。 */
function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  let out = "";
  for (const b of m.content) {
    if ("text" in b && typeof b.text === "string") out += b.text;
  }
  return out;
}

/**
 * C.2 per-session adapter（W49.7 Q2 规格逐句实现 + Plan B T6 checkpoint payload）。
 * 闭包态仅一个整数 lastBoundaryCovered；内核 fireAfterFlush 发生在 flush 后 ⇒
 * ctx.messages.length === persistedCount（合同前提，adapter 不重验）。coveredCount 单调
 * 推进（autoCompaction 坐标纪律），严格 > 判别即 advance。
 *
 * `restored === true` = resume 从 durable checkpoint 恢复的 live boundary（session.ts
 * `_seedReplayedBoundary`）：store 里已经有这条 boundary，adapter 只采纳坐标防止同一
 * coveredCount 再发一次，绝不追加重复 boundary；之后插件产生新 summary（coveredCount
 * 更大）才发恰好一次。
 */
function compactionBoundaryHook(): Hook<Message | CompactionCheckpointPayload> {
  let lastBoundaryCovered: number | null = null;
  return {
    name: "compactionBoundary",
    timeout: BOUNDARY_HOOK_TIMEOUT_MS,

    onAfterFlush(_input, ctx) {
      const boundary = ctx.state.get(ACTIVE_BOUNDARY_KEY);
      if (boundary === undefined) return;
      if (boundary.restored === true || boundary.persisted === true) {
        lastBoundaryCovered = boundary.coveredCount;
        return;
      }
      if (
        lastBoundaryCovered !== null &&
        boundary.coveredCount <= lastBoundaryCovered
      ) {
        return;
      }
      lastBoundaryCovered = boundary.coveredCount;
      const tail = ctx.messages.slice(boundary.coveredCount).map(renderMessage).join("\n");
      const B = messageText(boundary.summary) + COMPACTION_TAIL_SEPARATOR + tail;
      return {
        compactionBoundary: {
          summary: createUserMessage(B),
          checkpoint: {
            version: COMPACTION_CHECKPOINT_VERSION,
            coveredCount: boundary.coveredCount,
            anchorTimestampMs:
              boundary.anchorTimestampMs ??
              ctx.messages[boundary.coveredCount]?.timestamp ??
              null,
            summaryId: boundary.checkpointId ?? randomUUID(),
            createdAt: Date.now(),
            source: "auto",
            tailIncluded: true,
          },
        },
      };
    },
  };
}

/**
 * 产出主会话压缩钩子的 per-session 工厂（boot 交 SessionRegistry.hooksFor；测试直调）。
 * 每次调用返回**全新实例**（T4：autoCompaction 闭包缓存绝不跨会话共享）。配置到插件
 * 选项的映射 undefined-honest：config 键缺席 = 插件选项键不出现 = auto-compaction.ts
 * 构造时刻 ?? 兜缺省（triggerRatio 0.8 / keepRecent 6 / resummarizeEvery=keepRecent）；
 * 唯一在 wiring 物化的缺省是 timeout（500ms pipe 缺省对 summarize 是静默杀，不可兜）。
 *
 * microcompact 注册判据：子段在场 && enabled!==false && triggerTokens!==undefined——
 * 第三项是 schema 不变式（checkCompaction 在场未禁用时必填）的类型面镜像，经
 * parseLoomConfig 进来的合法 cfg 永不因它跳过（单测手工构造形状时才可能）。
 */
export function buildCompactionHooks(
  input: BuildCompactionHooksInput,
): (sessionID: string) => readonly Hook<Message | CompactionCheckpointPayload>[] {
  const { model, cfg } = input;
  const summarize = defaultSummarize({
    complete: (prompt) => completeText(model.model, [createUserMessage(prompt)], model.llmOptions),
  });
  return (
    _sessionID: string,
  ): readonly Hook<Message | CompactionCheckpointPayload>[] => {
    const hooks: Hook<Message | CompactionCheckpointPayload>[] = [];
    const mc = cfg.microcompact;
    if (mc !== undefined && mc.enabled !== false && mc.triggerTokens !== undefined) {
      hooks.push(
        microcompact({
          compactableTools: new Set(mc.compactableTools ?? []),
          triggerTokens: mc.triggerTokens,
          ...(mc.targetTokens === undefined ? {} : { targetTokens: mc.targetTokens }),
          ...(mc.keepRecent === undefined ? {} : { keepRecent: mc.keepRecent }),
        }),
      );
    }
    if (cfg.fallbackTokens === undefined) {
      hooks.push({
        ...autoCompaction({
          ...(cfg.maxContextTokens === undefined ? {} : { maxContextTokens: cfg.maxContextTokens }),
          ...(cfg.triggerRatio === undefined ? {} : { triggerRatio: cfg.triggerRatio }),
          ...(cfg.keepRecent === undefined ? {} : { keepRecent: cfg.keepRecent }),
          keepRecentTokens: cfg.keepRecentTokens ?? 15000,
          ...(cfg.resummarizeEvery === undefined ? {} : { resummarizeEvery: cfg.resummarizeEvery }),
          ...(cfg.summaryChunkTokens === undefined ? {} : { summaryChunkTokens: cfg.summaryChunkTokens }),
          summarize,
          // abortOnOverflow 保持省略（T10：compactRestartFresh 无实现，置 true=abort 无接盘者）。
        }),
        timeout: cfg.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS,
      });
    }
    if (cfg.boundary === true) {
      hooks.push(compactionBoundaryHook());
    }
    return hooks;
  };
}
