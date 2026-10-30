/**
 * CompactionRoutine —— 压缩内部例程编排层（T19，docs/01 D21「压缩定形」、docs/02 §T19）。
 *
 * 定位：harness **内部例程**（非 agent、非副会话；副会话 run 默认不压缩=不挂本例程），
 * 只做**编排**——六个 vendored 插件（microcompact / auto-compaction / compact-summarize /
 * summary-template / post-compact-file-reread / trim-history）语义原样复用、不改写：
 *   - 微压缩走 `microcompact` hook（白名单工具输出换占位符，廉价、不调 LLM）；
 *   - 摘要走注入的 `Summarizer` seam（生产=summary-template `defaultSummarize` 热载模板
 *     + 单次非流式廉价模型 `complete`；测试=fake，绝不触真模型）；
 *   - postCompactFileReread / trim-history 由挂链方按需并列（本例程不代理 hook 链）。
 *
 * 判定与执行（阈值全部从注入的 `CompactionLimits` **事件时刻现读**，热载可改，对齐 D26 惯例）：
 *   - `evaluate(tokens)`：水位下恒 "none"（**watermark 下永不重压**）；水位~fullRatio 之间
 *     规划 "micro"；超 fullRatio 规划 "full"。
 *   - `compact(...)`：**先 micro 后 full**——任何非 none 档都先跑廉价微压缩；清理后仍在水位
 *     之上才升级 full：裁早期前缀 → Summarizer 单次调用 → 溢出原文归档留**重读指针** →
 *     boundary 条目**幂等写**进 L0（同 key 再写 = duplicate；撕裂重放不二次裁由
 *     `projectThroughBoundaries` 按 key 去重保证，见 boundary.ts）。
 *   - 每次压缩落 trace（前后 token / 耗时 / 缓存断点），经注入 `onTrace` seam 吐出（T21
 *     Tracer 接线归 server 层；core 编排层不直写文件）。
 */

import type { HookContext } from "../hook.js";
import type { Message } from "@earendil-works/pi-ai";
import { createUserMessage } from "../types.js"; // 环纪律：深路径直引
import { microcompact } from "../plugins/microcompact.js";
import {
  defaultTokenCounter,
  hybridTokenCounter,
  type TokenCounter,
} from "../plugins/auto-compaction.js";
import {
  assertValidCompactionLimits,
  DEFAULT_COMPACTION_LIMITS,
  type CompactionLimits,
} from "./limits.js";
import {
  boundaryCacheBreakpoint,
  buildBoundarySummaryText,
  makeBoundaryKey,
  type ArchiveSinkLike,
  type BoundaryLedger,
  type BoundaryRecord,
} from "./boundary.js";

/** 压缩档位：none=水位下不压；micro=廉价微压缩；full=微压缩先行后仍超压→总结+boundary。 */
export type CompactionTier = "none" | "micro" | "full";

/** `evaluate` 结果（含现读阈值快照，便于 trace/调试）。 */
export interface CompactionDecision {
  readonly tier: CompactionTier;
  readonly tokens: number;
  readonly watermarkTokens: number;
  readonly fullTokens: number;
}

/** 摘要 seam：把早期消息总结成正文文本（生产=summary-template+廉价模型；测试=fake）。 */
export type Summarizer = (
  earlyMessages: Message[],
  ctx: HookContext,
) => string | Promise<string>;

/** 溢出原文归档 seam（D21「溢出原文留档…read 按需读回，不自动塞回」）。 */
export interface OverflowArchive {
  /** 归档一批被裁原文，返回重读指针。 */
  store(rec: {
    readonly sessionId: string;
    readonly boundaryKey: string;
    readonly messages: readonly Message[];
  }): string;
  /** 按指针回读原文（手动重读通道）；无 → null。 */
  load(pointer: string): readonly Message[] | null;
}

/** 一次压缩的执行轨迹信息（D21「每次压缩落执行轨迹（前后 token/耗时/缓存断点）」）。 */
export interface CompactionTraceInfo {
  readonly sessionId: string;
  readonly tier: CompactionTier;
  readonly preTokens: number;
  readonly postTokens: number;
  readonly durationMs: number;
  readonly cacheBreakpoint: string | null;
  readonly boundaryKey: string | null;
  /** 微压缩清理的 toolResult 条数（view 与原 view 逐位对比）。 */
  readonly microCleared: number;
}

export interface CompactionResult {
  readonly decision: CompactionDecision;
  /** 压缩后的模型 view（none = 原样）。 */
  readonly view: readonly Message[];
  readonly preTokens: number;
  readonly postTokens: number;
  /** 本次实际执行到的最重档位（planned full 但 micro 已够 → "micro"）。 */
  readonly executed: CompactionTier;
  /** full 档产生的 boundary（未产生 → null）。 */
  readonly boundary: BoundaryRecord | null;
  /** boundary 幂等写结果（未写 → null）。 */
  readonly writeOutcome: "written" | "duplicate" | null;
}

export interface CompactionRoutineOptions {
  /** 阈值对象（可变注入，判定时刻现读；构造即校验）。默认 {@link DEFAULT_COMPACTION_LIMITS}。 */
  readonly limits?: CompactionLimits;
  /** 微压缩白名单（哪些工具的 toolResult 可清）。默认 `["read", "bash", "grep", "glob"]`。 */
  readonly compactableTools?: Set<string> | readonly string[];
  /** full 档摘要器（必填——harness 不隐式调模型；测试注入 fake）。 */
  readonly summarize: Summarizer;
  /** boundary 账本（幂等写；L0 落盘经其注入 sink）。 */
  readonly ledger: BoundaryLedger;
  /** 溢出原文归档。 */
  readonly archive: OverflowArchive;
  /** 触发判据 token 计数器。默认 {@link hybridTokenCounter}（同 autoCompaction 惯例）。 */
  readonly tokenCounter?: TokenCounter;
  /** 执行轨迹回调（缺省 = noop）。 */
  readonly onTrace?: (info: CompactionTraceInfo) => void;
  /** 时钟（耗时计量）；默认 `Date.now`。 */
  readonly now?: () => number;
}

/** 归档一批消息为 JSONL 文本（每行一条，原样保真；重读逐行 parse 回 Message）。 */
function serializeMessages(messages: readonly Message[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
}

/** 内置 JSONL 归档适配器：原文文本交给 `ArchiveSinkLike` 存储，指针可回读。 */
export function jsonlOverflowArchive(sink: ArchiveSinkLike): OverflowArchive {
  return {
    store({ sessionId, boundaryKey, messages }) {
      const pointer = `overflow://${sessionId}/${boundaryKey.replace("@", "_")}.jsonl`;
      sink.put(pointer, serializeMessages(messages));
      return pointer;
    },
    load(pointer) {
      const text = sink.get(pointer);
      if (text === null) return null;
      return text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Message);
    },
  };
}

/** 微压缩清理计数：同位对比引用变化条数（仅 trace 观测用）。 */
function countCleared(before: readonly Message[], after: readonly Message[]): number {
  if (before === after) return 0;
  let n = 0;
  const len = Math.min(before.length, after.length);
  for (let i = 0; i < len; i++) {
    if (before[i] !== after[i]) n += 1;
  }
  return n;
}

export class CompactionRoutine {
  readonly limits: CompactionLimits;

  private readonly _opts: CompactionRoutineOptions;
  private readonly _counter: TokenCounter;
  private readonly _compactable: Set<string>;
  private readonly _now: () => number;

  constructor(opts: CompactionRoutineOptions) {
    this._opts = opts;
    this.limits = opts.limits ?? DEFAULT_COMPACTION_LIMITS;
    assertValidCompactionLimits(this.limits);
    // 触发判据默认 hybrid（更准的窗口压力）；微压缩内部固定用 defaultTokenCounter——
    // vendor microcompact 的增量 running-total 要求**可加**计数器契约（additivity），hybrid 不满足。
    this._counter = opts.tokenCounter ?? hybridTokenCounter;
    this._compactable =
      opts.compactableTools instanceof Set
        ? opts.compactableTools
        : new Set(opts.compactableTools ?? ["read", "bash", "grep", "glob"]);
    this._now = opts.now ?? Date.now;
  }

  /**
   * 档位判定（纯阈值比较，零副作用）。tokens ≤ 水位 → **恒 "none"**（watermark 下永不重压）。
   * 阈值从 `this.limits` 现读 ⇒ 热载改字段即刻影响下一次判定（不快照）。
   */
  evaluate(tokens: number): CompactionDecision {
    const l = this.limits;
    const watermarkTokens = l.contextWindow * l.watermarkRatio;
    const fullTokens = l.contextWindow * l.fullRatio;
    const tier: CompactionTier =
      tokens <= watermarkTokens ? "none" : tokens <= fullTokens ? "micro" : "full";
    return { tier, tokens, watermarkTokens, fullTokens };
  }

  /**
   * 执行一次压缩判定+动作（**先 micro 后 full**）。
   *
   * 坐标契约：`messages` 为当前会话的**存活消息序列**（boundary 投影后的视图），`startSeq`
   * 是其中 `messages[0]` 的全局 seq（默认 0）。full 档裁 `[startSeq, startSeq+trimmedCount-1]`，
   * 保留尾部 `keepRecent` 条。microcompact 是原位替换（不改条数），故 microView 与
   * input.messages 逐位同长同坐标，trimmedCount 两个坐标系一致。
   */
  async compact(input: {
    readonly sessionId: string;
    readonly messages: readonly Message[];
    readonly ctx: HookContext;
    /** messages[0] 的全局 seq（boundary 之后的存活偏移）。默认 0。 */
    readonly startSeq?: number;
  }): Promise<CompactionResult> {
    const t0 = this._now();
    const startSeq = input.startSeq ?? 0;
    const reqExtras = {
      tools: input.ctx.config.tools,
      systemPrompt: input.ctx.config.systemPrompt,
    };
    const preTokens = this._counter.estimate({ messages: [...input.messages], ...reqExtras });
    const decision = this.evaluate(preTokens);

    const finish = (
      executed: CompactionTier,
      view: readonly Message[],
      boundary: BoundaryRecord | null,
      writeOutcome: "written" | "duplicate" | null,
    ): CompactionResult => {
      const postTokens = this._counter.estimate({ messages: [...view], ...reqExtras });
      this._opts.onTrace?.({
        sessionId: input.sessionId,
        tier: decision.tier,
        preTokens,
        postTokens,
        durationMs: this._now() - t0,
        cacheBreakpoint: boundary?.cacheBreakpoint ?? null,
        boundaryKey: boundary?.key ?? null,
        microCleared: countCleared(input.messages, view),
      });
      return { decision, view, preTokens, postTokens, executed, boundary, writeOutcome };
    };

    // 水位之下：什么都不做（**永不重压**）。
    if (decision.tier === "none") {
      return finish("none", input.messages, null, null);
    }

    // ── 第一步：廉价微压缩（vendor microcompact 原样语义：trigger=水位、target=microTarget）──
    const micro = microcompact({
      compactableTools: this._compactable,
      triggerTokens: Math.max(1, Math.floor(this.limits.contextWindow * this.limits.watermarkRatio)),
      targetTokens: Math.max(1, Math.floor(this.limits.contextWindow * this.limits.microTargetRatio)),
      keepRecent: this.limits.microKeepRecent,
      tokenCounter: defaultTokenCounter,
    });
    // hook 契约 `Message[] | void | Promise<...>`：void/undefined = 未动手 → 原 view。
    const microOut = await micro.transformMessagesBeforeLlm?.([...input.messages], input.ctx);
    const microView: readonly Message[] =
      microOut === undefined ? input.messages : microOut;

    // 微压缩后复估：回落到水位下 → micro 已足够（即便规划是 full，也不花 summarize 的钱）。
    const afterMicroTokens = this._counter.estimate({ messages: [...microView], ...reqExtras });
    if (afterMicroTokens <= decision.watermarkTokens) {
      return finish("micro", microView, null, null);
    }

    // ── 第二步：full 压缩（总结 + boundary 幂等写 + 溢出原文归档指针）──
    const keepRecent = this.limits.keepRecent;
    if (input.messages.length <= keepRecent) {
      // 裁无可裁（全在 recent tail 内）：总结救不了，本次只带 micro 成果。
      return finish("micro", microView, null, null);
    }
    const trimmedCount = input.messages.length - keepRecent;
    const trimmedThroughSeq = startSeq + trimmedCount - 1;
    const key = makeBoundaryKey(input.sessionId, trimmedThroughSeq);

    // 幂等预检：同 key 已有完整 boundary（如上次崩溃前已写盘）→ 不重调 summarize、不再写，
    // 直接复用既有摘要块接续 tail。
    const existing = this._opts.ledger.last();
    if (existing !== null && existing.key === key) {
      const view: readonly Message[] = [
        createUserMessage(existing.summaryText),
        ...input.messages.slice(trimmedCount),
      ];
      return finish("full", view, existing, "duplicate");
    }

    // 摘要输入=微压缩清理后的早期（省钱）；归档=被裁的**原始**消息（保真，供指针回读）。
    const early = microView.slice(0, trimmedCount);
    const tail = input.messages.slice(trimmedCount);
    // Summarizer 可注入（测试 fake 不调真模型）；抛错冒泡：本次压缩失败，不产生半套 boundary。
    const body = await this._opts.summarize(early, input.ctx);

    const pointer = this._opts.archive.store({
      sessionId: input.sessionId,
      boundaryKey: key,
      messages: input.messages.slice(0, trimmedCount),
    });
    const summaryText = buildBoundarySummaryText(body, {
      trimmedFromSeq: startSeq,
      trimmedThroughSeq,
      trimmedCount,
      rereadPointer: pointer,
    });
    const view: readonly Message[] = [createUserMessage(summaryText), ...tail];
    const postTokens = this._counter.estimate({ messages: [...view], ...reqExtras });
    const boundary: BoundaryRecord = {
      key,
      sessionId: input.sessionId,
      summaryText,
      trimmedFromSeq: startSeq,
      trimmedThroughSeq,
      trimmedCount,
      rereadPointer: pointer,
      preTokens,
      postTokens,
      cacheBreakpoint: boundaryCacheBreakpoint(summaryText),
      at: this._now(),
    };
    const writeOutcome = this._opts.ledger.write(boundary);
    return finish("full", view, boundary, writeOutcome);
  }
}
