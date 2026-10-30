import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { createTestContext } from "../testing.js";
import { microcompact } from "../plugins/microcompact.js";
import {
  projectToolResultsForSummary,
  summaryProjectionPlaceholder,
} from "./summary-projection.js";

type ToolResult = Extract<Message, { role: "toolResult" }>;

/** 与 microcompact 默认占位符逐字节相同的期望值（测试独立写出，不从实现反推）。 */
function expectedPlaceholder(toolName: string, chars: number): string {
  return `[microcompact: ${toolName} output cleared, ~${chars} chars]`;
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function tr(toolName: string, text: string, callId = `${toolName}-call`): Message {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((b) => ("text" in b ? b.text : "")).join("");
}

describe("summaryProjectionPlaceholder", () => {
  it("renders the exact microcompact placeholder text", () => {
    expect(summaryProjectionPlaceholder("grep", 7)).toBe(
      "[microcompact: grep output cleared, ~7 chars]",
    );
  });
});

describe("projectToolResultsForSummary", () => {
  it("preserves array length, order, and roles without mutating the input", () => {
    const old = "x".repeat(120);
    const msgs: Message[] = [
      user("hello"),
      tr("read", old, "c1"),
      tr("bash", "B".repeat(30), "c2"),
      user("again"),
      tr("read", "recent", "c3"),
    ];

    const out = projectToolResultsForSummary(msgs, {
      compactableTools: new Set(["read"]),
      keepRecent: 1,
    });

    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
    expect(out.map((m) => (m.role === "toolResult" ? m.toolCallId : null))).toEqual([
      null,
      "c1",
      "c2",
      null,
      "c3",
    ]);
    // 纯函数：入参数组与消息未被改写；被清的那条是新对象。
    expect(textOf(msgs[1]!)).toBe(old);
    expect(out[1]).not.toBe(msgs[1]);
  });

  it("clears only compactable toolResults outside the last keepRecent toolResults (global recency)", () => {
    const msgs: Message[] = [
      tr("read", "OLD_READ_0", "r0"),
      user("interleaved"),
      tr("bash", "OLD_BASH", "b1"),
      tr("read", "OLD_READ_2", "r2"),
      tr("read", "OLD_READ_3", "r3"),
      tr("read", "RECENT_READ", "r4"),
    ];

    // keepRecent=2 按 toolResult 全局计数（最近两条 = r3、r4），与消息下标无关。
    const out = projectToolResultsForSummary(msgs, {
      compactableTools: new Set(["read"]),
      keepRecent: 2,
    });

    expect(textOf(out[0]!)).toBe(expectedPlaceholder("read", "OLD_READ_0".length));
    expect(textOf(out[1]!)).toBe("interleaved");
    expect(textOf(out[2]!)).toBe("OLD_BASH"); // 非白名单：即使在旧区也不清
    expect(textOf(out[3]!)).toBe(expectedPlaceholder("read", "OLD_READ_2".length));
    expect(textOf(out[4]!)).toBe("OLD_READ_3"); // 最近 2 条 toolResult 原样保留
    expect(textOf(out[5]!)).toBe("RECENT_READ");
  });

  it("leaves non-toolResult messages and non-compactable toolResults untouched", () => {
    const msgs: Message[] = [
      user("keep me"),
      tr("bash", "BASH_OUTPUT"),
      tr("read", "READ_OUTPUT"),
    ];

    const out = projectToolResultsForSummary(msgs, {
      compactableTools: new Set(["read"]),
      keepRecent: 0,
    });

    expect(out[0]).toEqual(msgs[0]);
    expect(out[1]).toEqual(msgs[1]);
    expect(textOf(out[2]!)).toBe(expectedPlaceholder("read", "READ_OUTPUT".length));
  });

  it("reports the tool name and the original content char count in the placeholder", () => {
    const msgs: Message[] = [tr("read", "z".repeat(321)), tr("read", "recent")];
    const out = projectToolResultsForSummary(msgs, {
      compactableTools: new Set(["read"]),
      keepRecent: 1,
    });

    expect(textOf(out[0]!)).toBe(expectedPlaceholder("read", 321));
    expect(textOf(out[0]!)).toContain("read");
    expect(textOf(out[0]!)).toContain("~321 chars");
  });

  it("counts chars like microcompact: text block lengths summed, images counted as 1", () => {
    const multi: ToolResult = {
      role: "toolResult",
      toolCallId: "multi",
      toolName: "read",
      content: [
        { type: "text", text: "abc" },
        { type: "text", text: "de" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 0,
    };

    const out = projectToolResultsForSummary([multi], {
      compactableTools: new Set(["read"]),
      keepRecent: 0,
    });

    expect(textOf(out[0]!)).toBe(expectedPlaceholder("read", 6));
  });

  it("is idempotent: projecting an already-projected toolResult does not double-wrap it", () => {
    const msgs: Message[] = [tr("read", "y".repeat(321)), tr("read", "recent")];
    const opts = { compactableTools: new Set(["read"]), keepRecent: 1 };

    const once = projectToolResultsForSummary(msgs, opts);
    expect(textOf(once[0]!)).toBe(expectedPlaceholder("read", 321));

    const twice = projectToolResultsForSummary(once, opts);
    expect(twice).toEqual(once);
    expect(textOf(twice[0]!)).toBe(expectedPlaceholder("read", 321));
    expect(textOf(twice[0]!).split("microcompact:")).toHaveLength(2);
  });

  it("keepRecent=0 clears every eligible toolResult", () => {
    const msgs: Message[] = [tr("read", "A"), tr("bash", "B"), user("u"), tr("read", "C")];
    const out = projectToolResultsForSummary(msgs, {
      compactableTools: new Set(["read"]),
      keepRecent: 0,
    });

    expect(textOf(out[0]!)).toBe(expectedPlaceholder("read", 1));
    expect(textOf(out[1]!)).toBe("B");
    expect(textOf(out[2]!)).toBe("u");
    expect(textOf(out[3]!)).toBe(expectedPlaceholder("read", 1));
  });

  it("is a no-op when the list has fewer toolResults than keepRecent", () => {
    const msgs: Message[] = [tr("read", "A"), user("u"), tr("read", "B")];
    const out = projectToolResultsForSummary(msgs, {
      compactableTools: new Set(["read"]),
      keepRecent: 5,
    });

    expect(out).toEqual(msgs);
    expect(textOf(out[0]!)).toBe("A");
    expect(textOf(out[2]!)).toBe("B");
  });

  it("is a no-op when the toolResult count exactly equals keepRecent", () => {
    const msgs: Message[] = [tr("read", "A"), tr("read", "B")];
    const out = projectToolResultsForSummary(msgs, {
      compactableTools: new Set(["read"]),
      keepRecent: 2,
    });

    expect(out).toEqual(msgs);
  });
});

describe("microcompact placeholder parity", () => {
  it("keeps the microcompact default placeholder byte-identical to summaryProjectionPlaceholder", () => {
    const body = "z".repeat(4000);
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1,
      targetTokens: 1,
      keepRecent: 0,
    });
    const { ctx } = createTestContext();

    const view = compact.transformMessagesBeforeLlm!([tr("read", body)], ctx) as Message[];

    expect(textOf(view[0]!)).toBe(summaryProjectionPlaceholder("read", body.length));
    expect(textOf(view[0]!)).toBe("[microcompact: read output cleared, ~4000 chars]");
  });
});
