/**
 * DeepSeek thinking 回放修复。
 *
 * 背景：pi-ai 的 openai-completions 适配层只有在 thinking 块带 `thinkingSignature`
 * 时，才把真实 thinking 文本写到 `assistantMsg[signature]`；否则 DeepSeek 兼容模式
 * 只会补一个空 `reasoning_content`，上游会报
 * `The reasoning_content in the thinking mode must be passed back to the API`。
 *
 * 本模块不改 pi-ai：只在发给 pi-ai 之前，给 DeepSeek 模型的 thinking 块补
 * `thinkingSignature: "reasoning_content"`。pi-ai 随后把它展开成
 * `assistantMsg.reasoning_content = <thinking 文本>`，满足上游 thinking 模式回传要求。
 */

import type {
  Api,
  Message,
  Model,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";

export function markDeepSeekReasoningContent(
  messages: readonly Message[],
  model: Model<Api>,
): Message[] {
  if (model.api !== "openai-completions") {
    return messages.slice();
  }
  const compat = model.compat as OpenAICompletionsCompat | undefined;
  if (compat?.thinkingFormat !== "deepseek") {
    return messages.slice();
  }

  return messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    let changed = false;
    const content = message.content.map((block) => {
      if (
        block.type !== "thinking" ||
        block.thinking.trim().length === 0 ||
        block.thinkingSignature !== undefined
      ) {
        return block;
      }
      changed = true;
      return { ...block, thinkingSignature: "reasoning_content" };
    });
    return changed ? { ...message, content } : message;
  });
}
