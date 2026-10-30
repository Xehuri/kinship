/**
 * autoCompaction —— 「自动压缩」标准策略（roadmap core-parity #2，docs/09 §4.2 的孪生件）。
 *
 * 与 `compactSummarize` 同款无副作用 view 压缩（在 `transformMessagesBeforeLlm` 里把早期消息总结成一条
 * summary + 保留 recent tail，不动 `session.messages`，完整历史仍由内核 durable 保存），但**触发判据
 * 从「消息条数」换成「估算的 context token 体积」**——这才是 context 压力的真实信号：一段超长 tool
 * 输出或大文档会让很少几条消息就逼近窗口，按条数根本测不出来。
 *
 * 可选地，在内核 fire 真实 `onContextOverflow` 时 `ctx.abort("compaction: ...")`，把恢复交给
 * `compactRestartFresh` 控制器兜底（`compaction:` 前缀是它识别重启的契约）。默认关闭。
 *
 * 与 `compactSummarize` 的关系：两者互补、可二选一。条数阈值直观；token 阈值贴近真实窗口压力，
 * 是 Claude Code 式 auto-compaction 的「自动」所在。summary 后端仍由调用方 `summarize` 提供（与
 * `compactSummarize` 同契约）；本插件负责的是「何时压缩」这条标准策略，不再要业务侧手搓触发逻辑。
 *
 * **语义：view-only（#16 的结论）。** 本插件是**只读、非破坏**的——`transformMessagesBeforeLlm` 只压缩
 * 「本 turn 发给 LLM 的 view」，**绝不改写 `session.messages`**，故完整原始历史**天然**留在 store 里
 * （by construction 满足 #2「原始历史保留在 store」）。这与 `compactSummarize` 同款。
 * 因此 resume 时会重放全量历史、模型每 turn 看到的是重新总结的 view，本插件**不写** `compaction_boundary`
 * store 条目——那是另一条路径（**persistent boundary**）的职责：由 `compactRestartFresh` 控制器把 summary
 * 持久化进 store、resume 从 summary 起算、丢弃边界前缀，经 `abortOnOverflow` 抵达。两条路径分工明确，
 * 本插件刻意不再叠加写 store 的机制（会与 `compactRestartFresh` 冗余、并破坏内核 _flushToStore 不变量）。
 */

import { randomUUID } from "node:crypto";
import type { Hook, HookContext } from "../index.js";
import { createUserMessage, ACTIVE_BOUNDARY_KEY } from "../index.js";
import type { Message } from "@earendil-works/pi-ai";
import { POST_COMPACT_PENDING_KEY } from "./post-compact-file-reread.js";
import { summarizeCompactionPrefix } from "../compaction/summarize-prefix.js";
import { isContextWatermarkMessage } from "../compaction/context-watermark.js";
import {
  PER_MESSAGE_OVERHEAD,
  estimateRequestTokens,
  estimateTokensByChars,
  hasMeasuredUsage,
  hybridTokenCounter,
  type TokenCounter,
} from "./token-estimate.js";

// 公开 API 兼容：token 估算原语已搬到 ./token-estimate.js（压缩分块与 autoCompaction 共用）。
export {
  PER_MESSAGE_OVERHEAD,
  defaultTokenCounter,
  estimateRequestTokens,
  estimateTokensByChars,
  hybridTokenCounter,
} from "./token-estimate.js";
export type { RequestTokenInput, TokenCounter } from "./token-estimate.js";
// 公开 API 兼容：分块 helper 现由 compaction/summarize-prefix.js 拥有。
export { chunkMessagesForSummary } from "../compaction/summarize-prefix.js";

export interface AutoCompactionOptions {
  /**
   * context token 预算（百分比触发路径）。须 > 0。
   *
   * **触发路径优先级（X2 / #57）**：
   *   - 显式给了 `maxContextTokens` → 永远走百分比路径 `> maxContextTokens * triggerRatio`（尊重调用方的显式上限，
   *     与旧行为一致；现有测试多走此路径）。
   *   - 未给 `maxContextTokens`、但 `ctx.config.model.contextWindow > 0` → 走**绝对窗口路径**
   *     `> contextWindow − reserveForOutput − safetyBuffer`（X2 的有效窗口阈值，更贴近真实窗口压力）。
   *   - 两者都不可得（无 maxContextTokens 且 contextWindow 为 0/缺）→ 算不出阈值，本 turn 不压缩
   *     （contextWindow 是运行时值、构造期无从校验，故退化为 no-op 而非构造期报错）。
   *
   * 即：**显式 maxContextTokens 压过窗口路径**；窗口路径是「没显式上限时用模型自带窗口」的兜底主路。
   */
  maxContextTokens?: number;
  /** 触发比例（百分比路径）：估算 tokens > `maxContextTokens * triggerRatio` 才压缩。默认 0.8，须 ∈ (0, 1]。 */
  triggerRatio?: number;
  /**
   * 窗口路径（X2 / #57）给模型输出 + summary/续答预留的 token 数（从 contextWindow 里扣掉）。
   * 默认 `Math.min(model.maxTokens, 4096)`——既不超模型实际能输出的上限、又给个合理保底。须 ≥ 0。
   */
  reserveForOutput?: number;
  /**
   * 窗口路径（X2 / #57）的绝对安全缓冲（再从 contextWindow 里多扣一截，吸收估算误差）。默认 0，须 ≥ 0。
   */
  safetyBuffer?: number;
  /** 压缩后原样保留的最近消息条数（recent tail）。默认 6，须 ≥ 1。 */
  keepRecent?: number;
  /**
   * recent tail 的 token 预算（Plan B T4）：从末尾向前按 {@link estimateTailMessage} 累计，
   * 预算耗尽即停止扩展 tail。与 `keepRecent` 的条数下限**并用**：两者取更长的 tail
   * （起点索引更小者），且起点仍会回退到 user / 安全边界。
   *
   * 缺省 `undefined` = 只看 `keepRecent` 条数（旧行为，保持不变）。须为有限数且 ≥ 0；
   * 即使最新一条单独超预算也至少保留它。
   */
  keepRecentTokens?: number;
  /** 把一批早期消息总结成文本（可 async / 调 LLM）——与 compactSummarize 同契约。 */
  summarize: (
    earlyMessages: Message[],
    ctx: HookContext,
  ) => string | Promise<string>;
  /**
   * Token 计数器（issue #55）。默认 {@link defaultTokenCounter}：`estimate` = {@link estimateRequestTokens}，
   * 在 messages 字符估算之上**加回** tool schema + systemPrompt + 每消息格式开销（只数消息会低估真 usage ~7x）。
   * 触发判据据此算，故有 tools 时**触发点比旧 messages-only 更早 = 更贴近真实窗口压力**（0.x 可接受的行为变更）。
   * tools / systemPrompt 由内核经 `ctx.config` 提供，无需调用方传。接入真 tokenizer 时覆盖本选项即可。
   */
  tokenCounter?: TokenCounter;
  /**
   * 「想覆盖的前缀」比上次缓存增长达到这么多条才重算 summary；默认 = keepRecent。
   * 调大省 LLM 调用，调小更省 token。须 ≥ 1。
   */
  resummarizeEvery?: number;
  /** summary 消息的文案包装（默认带「auto-compacted N 条」前缀）。 */
  summaryText?: (summary: string, coveredCount: number) => string;
  /**
   * 单次 summarize 调用的输入 token 上限（分块 map-reduce 的块大小）。默认 200000，须 ≥ 1000。
   *
   * **W52 死锁修复**：旧实现把整个前缀一次性喂给 summarize；前缀一旦涨过模型窗口
   * （如 1.07M > 1,048,576），摘要调用永久 400 → 边界永不推进 → 历史只增不减 → 会话彻底停摆。
   * 现在把前缀切成 ≤ 本值的块逐块总结、再合并；单块时行为与旧实现逐字节等价。
   * **W57**：任一块或合并失败即整体抛错（all-or-nothing），不推进部分边界。
   */
  summaryChunkTokens?: number;
  /**
   * 命中真实 `onContextOverflow` 时 `ctx.abort("compaction: ...")`，交给 compactRestartFresh 兜底。
   * 默认 false（纯主动压缩，不改控制流）。仅在配套 compactRestartFresh 时开启才有恢复意义。
   */
  abortOnOverflow?: boolean;
}

/**
 * 把期望的前缀覆盖边界回退到最近的安全 tail 起点（**绝不前移**）：优先最近的前置 user 边界，
 * 其次是最近的非 toolResult（通常是拥有整批 toolCall 的 assistant），都不行才退到 floor。
 * P3 水位提醒（`[context-watermark:...]`）不是真实用户轮次，任何边界选择都跳过它。
 *
 * 目的：避免投影后的 tail 以孤儿 toolResult 开头 —— 其 assistant toolCall 已被折进 summary，
 * 这种视图会让 provider 以 400 拒绝请求。
 */
export function alignCoverBoundary(
  messages: ReadonlyArray<Message>,
  desiredCover: number,
  floor = 0,
): number {
  if (messages.length === 0) return 0;
  const maxIndex = messages.length - 1;
  const desired = Math.max(0, Math.min(desiredCover, maxIndex));
  const lower = Math.max(0, Math.min(floor, maxIndex));
  if (desired <= lower) return lower;
  const desiredMessage = messages[desired];
  if (
    desiredMessage !== undefined &&
    desiredMessage.role !== "toolResult" &&
    !isContextWatermarkMessage(desiredMessage)
  ) {
    return desired;
  }
  for (let i = desired - 1; i > lower; i--) {
    const candidate = messages[i];
    if (
      candidate !== undefined &&
      candidate.role === "user" &&
      !isContextWatermarkMessage(candidate)
    ) {
      return i;
    }
  }
  for (let i = desired - 1; i > lower; i--) {
    const candidate = messages[i];
    if (
      candidate !== undefined &&
      candidate.role !== "toolResult" &&
      !isContextWatermarkMessage(candidate)
    ) {
      return i;
    }
  }
  return lower;
}

/** 单条消息在 tail 预算中的估算体积：字符估算 + 每消息格式开销。 */
export function estimateTailMessage(message: Message): number {
  return estimateTokensByChars([message]) + PER_MESSAGE_OVERHEAD;
}

/**
 * 选择 recent tail 的起点（= 折进 summary 的前缀条数），在条数下限与 token 预算之间取更长 tail。
 *
 * 顺序：
 *   1. 未给 token 预算 → 旧行为 `alignCoverBoundary(raw, raw.length - keepRecent, floor)`。
 *   2. 从末尾向前累计 token，预算耗尽即停；最新一条即使单独超预算也保留。
 *   3. 与 `raw.length - keepRecent` 的下限取更小起点（更长 tail），再回退到 recent tail 内最近的
 *      user 边界（避免把 assistant toolCall 折走而留下孤儿 toolResult）。
 *   4. 若仍落在 floor 上：首次压缩覆盖全部（summary 兜住，绝不丢消息）；已有 boundary 则停在
 *      floor（本 turn 不重复总结），有更早的 user exchange 时推进到该 exchange 起点。
 */
export function chooseTailStart(
  raw: ReadonlyArray<Message>,
  opts: {
    keepRecentTokens?: number;
    keepRecent: number;
    floor: number;
    hasPrevious: boolean;
  },
): number {
  const length = raw.length;
  const floor = Math.max(0, Math.min(opts.floor, length));
  if (length <= floor) return length;

  const { keepRecent, keepRecentTokens, hasPrevious } = opts;
  if (keepRecentTokens === undefined) {
    return alignCoverBoundary(raw, length - keepRecent, floor);
  }

  let startByTokens = length;
  let tailTokens = 0;
  for (let i = length - 1; i >= floor; i--) {
    const message = raw[i];
    if (message === undefined) break;
    const size = estimateTailMessage(message);
    if (tailTokens + size > keepRecentTokens && startByTokens < length) break;
    tailTokens += size;
    startByTokens = i;
  }

  const startByCount = Math.max(floor, length - keepRecent);
  let desired = Math.min(startByTokens, startByCount);

  let boundaryUser = -1;
  for (let i = desired; i > floor; i--) {
    const candidate = raw[i];
    if (candidate?.role === "user" && !isContextWatermarkMessage(candidate)) {
      boundaryUser = i;
      break;
    }
  }
  desired = boundaryUser >= 0 ? boundaryUser : alignCoverBoundary(raw, desired, floor);

  if (desired <= floor) {
    let latestUser = -1;
    for (let i = length - 2; i > floor; i--) {
      const candidate = raw[i];
      if (candidate?.role === "user" && !isContextWatermarkMessage(candidate)) {
        latestUser = i;
        break;
      }
    }
    if (latestUser >= 0) desired = latestUser;
    else if (hasPrevious) desired = floor;
    else desired = length;
  }

  return Math.max(floor, Math.min(desired, length));
}

/**
 * 构造一个 autoCompaction hook。三条**使用须知**（issue #13，违反会得到悄无声息的错误压缩）：
 *
 * 1. **Hook 顺序**：本插件从 `transformMessagesBeforeLlm` 收到的 `messages`（≈ `session.messages`）估算
 *    token，故它必须排在 `trimHistory` 这类**内容裁剪型** transform **之前**。若 `trimHistory` 先跑、把
 *    旧 toolResult 换成了占位符，autoCompaction 读到的体积就是裁剪**后**的、与真实 context 不符的**陈旧值**，
 *    可能漏触发。准则：压缩型 hook 排在裁剪型 hook 前面。
 * 2. **与 compactSummarize 共存**：两者是**二选一**（pick one）。同一 session 的 hook 链里**同时**挂两个，
 *    会顺序各跑、各自维护**独立缓存**，产生**未定义的压缩边界**（谁先压、压到哪、summary 互相覆盖均无保证）。
 *    选一个用。
 * 3. **每 session 一个实例**：闭包缓存（`coveredCount` + summary 文本）假设**一个 hook 实例只服务一个 session**。
 *    把同一个实例**跨 session 复用**会让 `coveredCount` 被另一个 session 的前缀长度污染，导致 view 错位。
 *    每个 session 各 `autoCompaction(...)` 一次。
 */
export function autoCompaction(opts: AutoCompactionOptions): Hook {
  // maxContextTokens 可选（X2）：给了就走百分比路径(并须 > 0)；不给则走窗口路径(阈值来自 ctx.config.model)。
  if (opts.maxContextTokens !== undefined && !(opts.maxContextTokens > 0)) {
    throw new Error("autoCompaction: maxContextTokens must be > 0");
  }
  const triggerRatio = opts.triggerRatio ?? 0.8;
  if (!(triggerRatio > 0 && triggerRatio <= 1)) {
    throw new Error("autoCompaction: triggerRatio must be in (0, 1]");
  }
  const keepRecent = opts.keepRecent ?? 6;
  if (keepRecent < 1) {
    throw new Error("autoCompaction: keepRecent must be >= 1");
  }
  if (
    opts.keepRecentTokens !== undefined &&
    !(Number.isFinite(opts.keepRecentTokens) && opts.keepRecentTokens >= 0)
  ) {
    throw new Error("autoCompaction: keepRecentTokens must be a finite number >= 0");
  }
  const resummarizeEvery = opts.resummarizeEvery ?? keepRecent;
  if (resummarizeEvery < 1) {
    throw new Error("autoCompaction: resummarizeEvery must be >= 1");
  }
  const summaryChunkTokens = opts.summaryChunkTokens ?? 200_000;
  if (summaryChunkTokens < 1000) {
    throw new Error("autoCompaction: summaryChunkTokens must be >= 1000");
  }
  if (opts.reserveForOutput !== undefined && opts.reserveForOutput < 0) {
    throw new Error("autoCompaction: reserveForOutput must be >= 0");
  }
  if (opts.safetyBuffer !== undefined && opts.safetyBuffer < 0) {
    throw new Error("autoCompaction: safetyBuffer must be >= 0");
  }
  // 默认走混合计量（C5）：有真 usage 用真基线（更准、修 D0 残差），无真 usage（turn-0 / fake）退回 X1。
  const counter = opts.tokenCounter ?? hybridTokenCounter;
  const safetyBuffer = opts.safetyBuffer ?? 0;
  // 百分比路径阈值是构造期常量；窗口路径阈值依赖 ctx.config.model.contextWindow，须每请求算。
  const percentThreshold =
    opts.maxContextTokens !== undefined ? opts.maxContextTokens * triggerRatio : undefined;
  const wrap =
    opts.summaryText ??
    ((summary, n) => `[auto-compacted summary of ${n} earlier messages]\n${summary}`);

  // 闭包缓存：session 级（每 session 一个 hook 实例）。
  // summaryMsg 缓存 Message 对象本身（不只是文本）→ 同一对象跨 turn 复用 → bytes 不变 → provider 缓存命中。
  // coveredCount：单一 _messages 真相坐标 —— 折进 summary 的前缀条数（内核切片 + 本插件本 turn 投影共用同一坐标）。
  let cache: {
    coveredCount: number;
    summaryMsg: Message;
    restored: boolean;
  } | null = null;
  // resume 恢复的边界在更早的视图坐标里测量过；只信任该坐标之后的 assistant usage。
  let measurementFloor = 0;
  // 恢复时重放的消息条数（含 summary）。新 summary 落地后用它把 floor 重映射到新视图。
  let rehydratedCount = 0;
  let adoptedRestored = false;

  return {
    name: "autoCompaction",

    async transformMessagesBeforeLlm(messages, ctx) {
      if (cache === null) {
        const seeded = ctx.state.get(ACTIVE_BOUNDARY_KEY);
        if (seeded !== undefined) {
          cache = {
            coveredCount: seeded.coveredCount,
            summaryMsg: seeded.summary,
            restored: seeded.restored === true,
          };
          measurementFloor = seeded.restored === true ? seeded.rehydratedCount ?? 0 : 0;
          rehydratedCount = seeded.rehydratedCount ?? 0;
          adoptedRestored = seeded.restored === true;
        }
      }
      // 触发阈值（X2 #57，优先级：显式 maxContextTokens 压过窗口路径）：
      //   - 给了 maxContextTokens → 百分比路径常量 percentThreshold（旧行为，尊重显式上限）。
      //   - 否则用 model.contextWindow > 0 → 窗口路径 contextWindow − reserveForOutput − safetyBuffer。
      //   - 两者都不可得 → 算不出阈值，本 turn 不压缩（return undefined）。
      let threshold = percentThreshold;
      if (threshold === undefined) {
        const contextWindow = ctx.config.model.contextWindow;
        if (contextWindow > 0) {
          const reserveForOutput = opts.reserveForOutput ?? Math.min(ctx.config.model.maxTokens, 4096);
          const w = contextWindow - reserveForOutput - safetyBuffer;
          // 防 footgun:reserve+safetyBuffer >= contextWindow 时 w<=0,直接用会让 estimated(>=0)永远 > 阈值
          // → 每 turn 都压缩(过度激进)。视为「算不出有意义阈值」→ 本 turn no-op(下面 threshold===undefined 兜底)。
          // 这种 misconfig 需 window < reserve(本就荒谬),no-op 比每 turn 空压更安全、更可诊断。
          if (w > 0) threshold = w;
        }
      }
      if (threshold === undefined) return undefined;

      // 未到 token 阈值 → 原样。tools / systemPrompt 由 ctx.config 提供，计入每请求随发的固定开销（X1）。
      // deferredTools 在场时，本 turn 实际随发的是激活子集（deferred.activeListing），按它估更准；
      // 无 deferredTools 则退回 ctx.config.tools 全集（0.2.x 行为）。
      const tools = ctx.state.get("deferred.activeListing") ?? ctx.config.tools;
      const systemPrompt = ctx.config.systemPrompt;
      // 恢复边界后的首轮：重放尾巴里的 usage 测的是压缩前的大视图，不能当基线。
      // 在没有该 floor 之后的真实 usage 时，用序列化视图估算（仍会因真实超大视图触发）。
      const trusted =
        measurementFloor === 0 ||
        messages.some((message, i) => i >= measurementFloor && hasMeasuredUsage(message));
      const estimated =
        adoptedRestored && !trusted
          ? estimateRequestTokens({ messages, tools, systemPrompt })
          : counter.estimate({ messages, tools, systemPrompt, usageFloorIndex: measurementFloor });
      if (estimated <= threshold) return undefined;
      // 真相消息坐标 raw：真实会话用内核 _messages（ctx.messages）；直接调 transform 的单元测试场景
      // （ctx.messages 为空）降级用 pipe 入参 messages。覆盖范围一律基于 raw，绝不混用投影视图坐标。
      const raw = ctx.messages.length > 0 ? ctx.messages : messages;

      // 已经压无可压（raw tail 即全部）→ 总结救不了，交给 overflow 兜底。
      if (raw.length <= keepRecent) return undefined;

      // ⚠️ 坐标系统一（修 Codex 交叉验证发现的 High bug）：targetCover / summary / coveredCount / 投影
      // 全部基于 raw（_messages 真相），绝不用投影视图 messages（含 _pendingAttachments + 上一个 summary，
      // 坐标会漂）。targetCover = 折进 summary 的前缀条数，经安全边界回退（绝不前移）后尾部至少保留
      // keepRecent 条真实消息，且 tail 不会以孤儿 toolResult 开头。
      const prevCovered = cache?.coveredCount ?? 0;
      const targetCover = chooseTailStart(raw, {
        ...(opts.keepRecentTokens === undefined
          ? {}
          : { keepRecentTokens: opts.keepRecentTokens }),
        keepRecent,
        floor: prevCovered,
        hasPrevious: cache !== null,
      });
      const needsResummarize =
        cache === null
          ? targetCover > 0
          : targetCover - cache.coveredCount >= resummarizeEvery;

      if (!needsResummarize) return undefined;
      if (targetCover <= 0) return undefined;

      if (needsResummarize) {
        // summary 覆盖范围用 raw（_messages 真相）坐标算 targetCover；但**本 turn 投影从 pipe 入参 messages 切**，
        // 以保留上游 transform 的修改（文档顺序 microcompact → autoCompaction 中 microcompact 已压过的 tail
        // 不能被还原成原始大输出 —— 见 codex 交叉验证 P1）。viewCover = targetCover 映射到 messages 视图坐标：
        //   真实会话 messages=[prevSummary?, raw.slice(prevCovered), ...pending] → (有 prevSummary?1:0)+(targetCover-prevCovered)；
        //   直接测试场景（ctx.messages 为空）messages 即 raw、无 prevSummary 偏移 → viewCover=targetCover。

        // 分块 map-reduce（W52）：前缀按 summaryChunkTokens 切块逐块总结再合并。
        // W57 all-or-nothing：任一块或合并失败即抛错，不推进 boundary / 缓存（无部分进度）。
        const text = await summarizeCompactionPrefix({
          prefix: raw.slice(0, targetCover),
          summarize: opts.summarize,
          summaryChunkTokens,
          ctx,
        });

        if (targetCover <= 0) return undefined;
        if (cache !== null && targetCover <= cache.coveredCount) return undefined;

        // viewCover = targetCover 映射到 messages 视图坐标（raw 坐标 → 投影视图坐标）。
        const previousSummaryInView = cache !== null && messages[0] === cache.summaryMsg;
        if (cache !== null && !previousSummaryInView && messages.length < raw.length) {
          return undefined;
        }

        let viewCover =
          ctx.messages.length > 0
            ? previousSummaryInView
              ? 1 + (targetCover - prevCovered)
              : targetCover
            : targetCover;

        viewCover = Math.max(0, Math.min(viewCover, messages.length));

        if (messages[viewCover]?.role === "toolResult") {
          const safeViewCover = alignCoverBoundary(
            messages,
            viewCover,
            previousSummaryInView ? 1 : 0,
          );
          if (messages[safeViewCover]?.role === "toolResult") return undefined;
          viewCover = safeViewCover;
        }

        // 缓存 Message 对象本身 → 同一对象跨 turn 复用 → bytes 稳定 → provider 缓存命中。
        const summaryMsg = createUserMessage(wrap(text, targetCover));
        cache = { coveredCount: targetCover, summaryMsg, restored: false };
        // 新 summary 把恢复视图的前缀折掉：投影首条换成新 summary（+1），
        // 幸存的重放尾巴从此位置之前结束；floor 重映射到第一条 resume 后新消息。
        measurementFloor = 1 + Math.max(0, rehydratedCount - targetCover);
        adoptedRestored = false;
        // 本 turn 真跑了新总结才标记，供 postCompactFileReread 下一 turn 重读关键文件（opt-in）。
        ctx.state.set(POST_COMPACT_PENDING_KEY, ctx.turnIdx);
        // live boundary 只在 coveredCount 基于 durable ctx.messages(_messages 真相)坐标时写 —— 否则
        // 内核下一 turn 按它 slice _messages 会丢真实消息（codex P2：ctx.messages 空 + 仅 transient
        // pending 的退化场景，如 fresh session continue() 只带 onTurnStart attachments）。
        // ctx.messages 空时本 turn 投影仍生效（view-only one-turn），但不持久化 boundary。
        if (ctx.messages.length > 0) {
          // 内核 turn 末读取、下一 turn 投影 [summary, _messages.slice(coveredCount), pending]；
          // 下一 turn firePipeMessages 会对该投影重跑上游 transform，效果不丢。
          ctx.state.set(ACTIVE_BOUNDARY_KEY, {
            summary: summaryMsg,
            coveredCount: targetCover,
            checkpointId: randomUUID(),
            anchorTimestampMs: raw[targetCover]?.timestamp ?? null,
          });
        }
        // 本 turn 投影从 messages 视图切（保留上游 transform 处理过的 tail + 尾部 pending），首条换 summary。
        return [summaryMsg, ...messages.slice(viewCover)];
      }

      // 已有 boundary、本 turn 无需重算：return undefined（pass-through）。
      // 内核已在 _phaseLlmCall 用 _activeBoundary 投影 [summary, _messages.slice(coveredCount), pending]；
      // 随新消息追加自然增长 → append-only、prefix 稳定。
      return undefined;
    },

    onContextOverflow(input, ctx) {
      if (!opts.abortOnOverflow) return;
      // `compaction:` 前缀 = compactRestartFresh 识别重启的契约（见 hook.ts ContextOverflowInput 注释）。
      ctx.abort(
        `compaction: context overflow at turn ${input.turnIdx} (stopReason=${input.stopReason})`,
      );
    },
  };
}
