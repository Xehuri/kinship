import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { makeOpenAICompatibleModel } from "./llm-model.js";
import { markDeepSeekReasoningContent } from "./reasoning-replay.js";

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(thinkingFormat: "deepseek" | "openai") {
  return makeOpenAICompatibleModel({
    id: "deepseek-flash",
    baseUrl: "https://api.example/v1",
    provider: "xehuri-api",
    reasoning: true,
    contextWindow: 1000,
    maxTokens: 100,
    compat: { thinkingFormat },
  });
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "xehuri-api",
    model: "deepseek-flash",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("markDeepSeekReasoningContent", () => {
  it("DeepSeek thinking 块补 reasoning_content 签名，正文不变", () => {
    const original = assistant([
      { type: "thinking", thinking: "reasoning text" },
      { type: "text", text: "answer" },
    ]);
    const [marked] = markDeepSeekReasoningContent([original], model("deepseek"));
    expect(marked).not.toBe(original);
    expect((marked as AssistantMessage).content).toEqual([
      { type: "thinking", thinking: "reasoning text", thinkingSignature: "reasoning_content" },
      { type: "text", text: "answer" },
    ]);
    expect((original.content[0] as { thinkingSignature?: string }).thinkingSignature).toBeUndefined();
  });

  it("非 DeepSeek thinkingFormat 不修改", () => {
    const original = assistant([{ type: "thinking", thinking: "reasoning text" }]);
    const same = markDeepSeekReasoningContent([original], model("openai"))[0];
    expect(same).toBeDefined();
    if (!same) throw new Error("expected one message");
    expect(same).toEqual(original);
    expect((same.content[0] as { thinkingSignature?: string }).thinkingSignature).toBeUndefined();
  });

  it("已有 thinkingSignature 不自作主张覆盖", () => {
    const original = assistant([
      { type: "thinking", thinking: "reasoning text", thinkingSignature: "encrypted-item" },
    ]);
    const same = markDeepSeekReasoningContent([original], model("deepseek"))[0];
    expect(same).toBeDefined();
    if (!same) throw new Error("expected one message");
    expect((same.content[0] as { thinkingSignature?: string }).thinkingSignature).toBe(
      "encrypted-item",
    );
  });

  it("非 assistant 消息与空 thinking 原样保留", () => {
    const user: Message = { role: "user", content: "hello", timestamp: 1 };
    const empty = assistant([{ type: "thinking", thinking: "   " }]);
    const out = markDeepSeekReasoningContent([user, empty], model("deepseek"));
    expect(out[0]).toBe(user);
    expect(out[1]).toBe(empty);
  });
});
