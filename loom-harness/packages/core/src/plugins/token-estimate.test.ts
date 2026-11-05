import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { createUserMessage } from "../types.js";
import {
  SUMMARY_CHARS_PER_TOKEN,
  SUMMARY_TRUNCATION_MARK,
  estimateSummaryText,
  estimateSummaryTokens,
  estimateTokensByChars,
  truncateTextToSummaryBudget,
} from "./token-estimate.js";

function thinkingMessage(thinking: string, thinkingSignature: string): Message {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking, thinkingSignature }],
    timestamp: 0,
  } as unknown as Message;
}

describe("estimateTokensByChars（主请求尺子，保持不变）", () => {
  it("thinking 仍按 JSON.stringify 计（含 thinkingSignature）", () => {
    const block = {
      type: "thinking" as const,
      thinking: "a".repeat(40),
      thinkingSignature: "SIG",
    };
    const message = {
      role: "assistant",
      content: [block],
      timestamp: 0,
    } as unknown as Message;

    expect(estimateTokensByChars([message])).toBe(Math.ceil(JSON.stringify(block).length / 4));
  });
});

describe("estimateSummaryTokens（摘要尺子）", () => {
  it("100 个 ASCII 字符 = 50 token，100 个 CJK 字符 = 100 token", () => {
    expect(estimateSummaryTokens([createUserMessage("x".repeat(100))])).toBe(50);
    expect(estimateSummaryTokens([createUserMessage("汉".repeat(100))])).toBe(100);
    expect(SUMMARY_CHARS_PER_TOKEN).toBe(2);
  });

  it("thinking 只数 thinking 文本，不计 thinkingSignature", () => {
    const message = thinkingMessage("a".repeat(40), "SIGNATURE_THAT_MUST_NOT_COUNT");
    expect(estimateSummaryTokens([message])).toBe(20);
  });

  it("image block 按保守扁平值 1000 计", () => {
    const message = createUserMessage([{ type: "image", data: "x", mimeType: "image/png" }]);
    expect(estimateSummaryTokens([message])).toBe(1000);
  });
});

describe("truncateTextToSummaryBudget", () => {
  it("未超预算时原样返回、不加截断标记", () => {
    expect(truncateTextToSummaryBudget("hello", 100)).toBe("hello");
    expect(truncateTextToSummaryBudget("hello", 100)).not.toContain(SUMMARY_TRUNCATION_MARK);
  });

  it("ASCII 按 1/2 token/字符截断，并保证截断后估算不超预算", () => {
    const out = truncateTextToSummaryBudget("x".repeat(1000), 100);
    expect(out.endsWith(SUMMARY_TRUNCATION_MARK)).toBe(true);
    expect(estimateSummaryText(out)).toBeLessThanOrEqual(100);
    const prefix = out.slice(0, out.length - SUMMARY_TRUNCATION_MARK.length);
    const markTokens = estimateSummaryText(SUMMARY_TRUNCATION_MARK);
    expect(prefix).toHaveLength((100 - markTokens) * SUMMARY_CHARS_PER_TOKEN);
  });

  it("CJK 按 1 token/字符截断，不会像 1/4 尺子那样多留 4 倍", () => {
    const out = truncateTextToSummaryBudget("汉".repeat(1000), 100);
    expect(out.endsWith(SUMMARY_TRUNCATION_MARK)).toBe(true);
    expect(estimateSummaryText(out)).toBeLessThanOrEqual(100);
    const prefix = out.slice(0, out.length - SUMMARY_TRUNCATION_MARK.length);
    const markTokens = estimateSummaryText(SUMMARY_TRUNCATION_MARK);
    expect(prefix).toBe("汉".repeat(100 - markTokens));
  });
});
