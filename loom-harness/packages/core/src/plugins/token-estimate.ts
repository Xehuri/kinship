/**
 * token-estimate —— 消息级 / 请求级 token 估算原语（issue #14 / #55 / X1 / C5）。
 *
 * 从 `auto-compaction.ts` 抽出成独立模块：压缩分块（`compaction/summarize-prefix.ts`）与 autoCompaction
 * 共用同一把尺，同时避免 `compaction → plugins/auto-compaction → compaction` 的模块环。
 * 语义与搬出前逐字节一致（仅位置变化）。
 */

import type { Message, Tool } from "@earendil-works/pi-ai";

/**
 * 单个 CJK 码点判定（含统一表意文字 + 常见 CJK 标点 / 全角字符）。这些码点在主流 tokenizer 里普遍
 * ≈ 1 token/字，远稠密于 ASCII 的 ≈ 4 char/token，故单独计数。**非 global**，用于逐码点 `.test`：
 * 　-〿 CJK 符号与标点、㐀-䶿 扩展 A、一-鿿 统一表意文字、豈-﫿 兼容表意文字、＀-￯ 全角/半角形式，
 * 以及 \u{20000}-\u{2ffff} 扩展 B–F（代理对，需 /u flag + 按码点迭代才能正确命中，否则被当 2 个 ASCII）。
 */
const CJK_CP = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]|[\u{20000}-\u{2ffff}]/u;

/** 单张图片的保守、扁平 token 估算（issue #14）：宁可高估、不可低估，避免漏触发→窗口溢出。 */
const IMAGE_TOKENS = 1000;

/**
 * 估算单条文本的 token：CJK 码点按 ≈ 1 token/字计，其余字符按 ≈ 1/4 token 计（向上取整）。
 * 偏向**高估**——本数用于压缩触发判据，低估的代价是漏触发后 context 溢出（安全 bug，见 #14）。
 *
 * **按码点迭代**（`for...of`）而非按 `.length`（UTF-16 码元）：这样扩展 B+ 的代理对 CJK（如 𠀀）算 1 个
 * 码点 = 1 token（否则 `.length===2` 会被当 2 个 ASCII 字符），且 CJK/ASCII 混排时 `rest` 计数单位一致。
 */
function estimateText(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_CP.test(ch)) cjk++;
    else rest++;
  }
  return cjk + Math.ceil(rest / 4);
}

/**
 * 默认 token 估算：CJK 感知 + 图片感知，整体偏保守（高估）。粗但单调、确定、零依赖。
 *
 * - **CJK**：每个 CJK 码点 ≈ 1 token（不是 chars/4）。`你好世界` → ≈ 4 token，不再被 4× 低估。
 * - **图片**：image content block（pi-ai 判别式 `type === "image"`）贡献**扁平** {@link IMAGE_TOKENS} token，
 *   既不按短 ref 的字符数低估、也不按内联 base64 `data` 的字符数疯狂高估。
 * - **其余文本**（ASCII 等）：≈ 1/4 token/字符（向上取整），故纯英文仍 ≈ chars/4。
 *
 * **仅数消息文本**——不含每请求随发的 tool schema / systemPrompt / 格式开销（那些会**严重低估**真 usage，
 * 见 {@link estimateRequestTokens}）。保留本函数原样是为向后兼容；消费插件默认走请求级的 {@link defaultTokenCounter}。
 * 想接真 tokenizer：覆盖插件的 `tokenCounter` 选项即可。
 */
export function estimateTokensByChars(messages: Message[]): number {
  let tokens = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      tokens += estimateText(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "image") {
        tokens += IMAGE_TOKENS;
      } else if ("text" in b && typeof b.text === "string") {
        tokens += estimateText(b.text);
      } else {
        // 其余块（thinking / toolCall 等）按其 JSON 序列化长度粗估，仍走 1/4 规则。
        tokens += estimateText(JSON.stringify(b));
      }
    }
  }
  return tokens;
}

/** 每条消息的固定格式开销（role / 分隔符 / 模板包装），主流 chat 模板约 3–4 tok/消息，取保守 4。 */
export const PER_MESSAGE_OVERHEAD = 4;

/** {@link estimateRequestTokens} 的输入：一次 LLM 请求随发的三部分（tools / systemPrompt 每请求都发）。 */
export interface RequestTokenInput {
  messages: Message[];
  /** 本次请求随发的 tool schema（pi-ai `Tool`：name + description + parameters）。 */
  tools?: ReadonlyArray<Tool>;
  /** 本次请求的 system prompt。 */
  systemPrompt?: string;
  /**
   * 只信任该索引（messages 视图坐标）及之后的 assistant usage。resume 恢复边界后，
   * 边界之前的 usage 是压缩前旧视图的读数，不能当作当前请求体积的基线。
   */
  usageFloorIndex?: number;
}

/** assistant 是否带可用的真实 usage（与 hybrid 计数器判别同口径：input+output > 0）。 */
export function hasMeasuredUsage(message: Message): boolean {
  if (message.role !== "assistant") return false;
  const usage = message.usage;
  return usage !== undefined && usage.input + usage.output > 0;
}

/**
 * 估算**整次 LLM 请求**的 token —— 在 {@link estimateTokensByChars}(messages) 之上，**加回**那些每请求随发、
 * 却被「只数消息文本」漏掉的固定开销（issue #55 / D0 实测：只数消息低估真 usage ~7x，根因正是漏了下面三项）：
 *
 *   1. **tool schema**：每个 tool 的 `name` + `description` + `JSON.stringify(parameters)` 字符估算（走 1/4 规则）。
 *      工具一多、parameters schema 一深，这块就是估算盲区里最大的一块。
 *   2. **systemPrompt**：整段 system prompt 的字符估算（复用 CJK 感知的 {@link estimateTokensByChars}）。
 *   3. **每消息格式开销**：每条消息一个小常量（{@link PER_MESSAGE_OVERHEAD}），覆盖 role / 分隔符 / 模板包装。
 *
 * CJK / image / chars-1/4 规则全部沿用 estimateTokensByChars，整体仍偏**保守高估**（压缩触发判据宁高勿低）。
 * tools / systemPrompt **不传**时本函数退化为「estimateTokensByChars(messages) + 每消息常量」——比纯 messages-only
 * 仍多算每消息常量，但语义一致。
 */
export function estimateRequestTokens(input: RequestTokenInput): number {
  let tokens = estimateTokensByChars(input.messages);
  tokens += input.messages.length * PER_MESSAGE_OVERHEAD;
  if (input.systemPrompt) {
    tokens += estimateText(input.systemPrompt);
  }
  if (input.tools) {
    for (const t of input.tools) {
      tokens += estimateText(t.name);
      tokens += estimateText(t.description);
      tokens += estimateText(JSON.stringify(t.parameters));
    }
  }
  return tokens;
}

/**
 * Token 计数 seam（issue #55）。`estimate` = 同步、零依赖的字符估算（默认 {@link estimateRequestTokens}）；
 * `count` = 未来 opt-in 的**真** tokenizer（async）。
 *
 * **当前不实现 `count`**：pi-ai 0.74.2 无 `countTokens`（D0 已核），保留可选签名只为留一个不破坏 API 的接入口
 * （将来接真 tokenizer / provider count endpoint 时填它，消费方按需 `await counter.count?.(...)`）。
 *
 * **`estimate` 的 additivity 契约（自定义实现须遵守）**：`microcompact` 的增量 running-total
 * （`total -= estimate({messages:[原]}) - estimate({messages:[占位]})`）只有在「`estimate` 对 messages 逐条可加、
 * 且 tools/systemPrompt/每消息开销是**与单条消息无关的固定常量**」时才与全量重估逐 token 等价。默认
 * {@link estimateRequestTokens} 满足。**非可加的真 BPE tokenizer 不满足**（token 跨消息边界、request framing 非线性）——
 * 注入这类 counter 会让 microcompact 的体积早停漂移。届时应让 microcompact 改为每步全量 `estimate(整段)`，或只在
 * autoCompaction（无增量假设）里用它。
 */
export interface TokenCounter {
  estimate(input: RequestTokenInput): number;
  count?(input: RequestTokenInput): Promise<number>;
}

/** 默认 TokenCounter：`estimate` = {@link estimateRequestTokens}；不提供 `count`。 */
export const defaultTokenCounter: TokenCounter = {
  estimate: estimateRequestTokens,
};

/**
 * 混合 token 计量（issue #13 / C5）：取 messages 里**最近一条带真 `Usage` 的 assistant** 作基线
 * （`input + cacheRead + cacheWrite + output` —— 那一刻真实的 prompt+output 体积，**已含 tools/systemPrompt**），
 * 只对其后的消息走字符估算补尾（{@link estimateTokensByChars}，messages-only，**不再加 tools/systemPrompt**：
 * 它们已计在真基线里，再加会双重计）。有真 usage 时基线精确——修掉 D0 实测的残差（messages-only 低估
 * ~7x；X1 加回 tools/sys 后仍 ~2x，因 chat 模板/tool schema 自有格式比 char/4 重）。
 *
 * 无可用真 usage 时退回 {@link estimateRequestTokens}（X1，含 tools/systemPrompt）：(a) turn-0 还没 assistant；
 * (b) assistant `usage` 全 0（fake-model / provider 未回 usage）—— 视为「无真值」而非「真的 0」。这保证不挂真
 * provider 时（如 fake-model 测试）行为与 {@link defaultTokenCounter} 完全一致。
 *
 * **不满足 additivity 契约**（基线随「最近 assistant」跳变、非逐条可加）——故**别**用作 microcompact 的增量
 * counter；它专给 autoCompaction（每 turn 全量 estimate、无增量假设）做更准的触发判据。
 */
export const hybridTokenCounter: TokenCounter = {
  estimate(input: RequestTokenInput): number {
    const msgs = input.messages;
    const floor = input.usageFloorIndex ?? 0;
    for (let i = msgs.length - 1; i >= floor; i--) {
      const m = msgs[i];
      if (m === undefined || m.role !== "assistant") continue;
      const u = m.usage;
      // 判别「有无真值」**故意只看 input+output、忽略 cache**：fake-model / 未回 usage 的标志是
      // input==output==0(testing.ts zeroUsage);真 assistant 输出内容必有 output>0。别把判别改成含
      // cacheRead/cacheWrite —— 否则纯缓存命中(理论上 input=output=0、cacheRead>0)会被误判为真值,
      // 且会让 fake 全 0 的 parity 假设变脆。continue(非 break):越过零-usage 继续往前找最近真值。
      if (!u || u.input + u.output <= 0) continue;
      // 基线 = 那一刻真实 prompt+output footprint(= pi-ai 自己的 totalTokens;input 已排除 cached,故 +cache)。
      const baseline = u.input + u.cacheRead + u.cacheWrite + u.output;
      // 补尾只数后缀消息字符(messages-only)。注:未加后缀的每消息 framing(~4tok/条),故对后缀略偏低估;
      // 后缀在 turn 间有界(就最近几条)、基线主导且精确,这点偏差对「宁高勿低」的触发阈值可忽略。
      return baseline + estimateTokensByChars(msgs.slice(i + 1));
    }
    return estimateRequestTokens(input);
  },
};
