import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage } from "./summary-template.js";

describe("renderMessage thinking blocks", () => {
  it("renderMessage 只渲染 thinking 文本：无 JSON 引号、无转义换行、无 thinkingSignature", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "a\nb", thinkingSignature: "SIG" }],
      timestamp: 0,
    } as unknown as Message;

    expect(renderMessage(message)).toBe("assistant: a\nb");
    expect(renderMessage(message)).not.toContain("SIG");
    expect(renderMessage(message)).not.toContain("\\n");
    expect(renderMessage(message)).not.toContain('"thinking"');
  });
});
