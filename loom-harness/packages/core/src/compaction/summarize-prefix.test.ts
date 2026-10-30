import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { createTestContext } from "../testing.js";
import { createUserMessage } from "../types.js";
import { summarizeCompactionPrefix } from "./summarize-prefix.js";
import type { SummarizeDelta } from "./worker-types.js";

const TRUNCATION_SUFFIX = "\n…（单条消息超摘要分块上限，已截断）";

/** 4 条消息，每条 "i:" + 400 ASCII ≈ 101 token（chunkTokens=150 时一块一条）。 */
function fourChunkPrefix(): Message[] {
  return Array.from({ length: 4 }, (_, i) => createUserMessage(`${i}:` + "x".repeat(400)));
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((b) => ("text" in b ? b.text : "")).join("");
}

/** 400 ASCII 字符 = 100 token（estimateTokensByChars 的 1/4 规则）。 */
function sizedText(char: string): string {
  return char.repeat(400);
}

function assistantMessage(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as unknown as Message;
}

const WATERMARK = "[context-watermark:120000]\n<system-reminder>watermark notice</system-reminder>";

describe("summarizeCompactionPrefix", () => {
  it("单块时把（未截断的）整段前缀原样交给 summarize", async () => {
    const prefix = [createUserMessage("a".repeat(400)), createUserMessage("b".repeat(400))];
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 1000,
      ctx,
      summarize: (messages, receivedCtx) => {
        expect(receivedCtx).toBe(ctx);
        seen.push(messages);
        return "ONE";
      },
    });

    expect(result).toBe("ONE");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(prefix.length);
    expect(seen[0]![0]).toBe(prefix[0]);
    expect(seen[0]![1]).toBe(prefix[1]);
  });

  it("多块时逐块 summarize，再用合并 prompt 做最后一次 summarize", async () => {
    const prefix = fourChunkPrefix();
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      ctx,
      summarize: (messages) => {
        seen.push(messages);
        if (seen.length <= prefix.length) return `S${seen.length}`;
        const prompt = textOf(messages[0]!);
        expect(prompt).toContain("以下是同一条会话的 4 段分段摘要（按时间顺序）。");
        expect(prompt).toContain("=== 分段 1 ===\nS1");
        expect(prompt).toContain("=== 分段 4 ===\nS4");
        return "MERGED";
      },
    });

    expect(result).toBe("MERGED");
    expect(seen).toHaveLength(prefix.length + 1);
    for (let i = 0; i < prefix.length; i++) {
      expect(seen[i]).toHaveLength(1);
      expect(seen[i]![0]).toBe(prefix[i]);
    }
  });

  it("chunked 模式使用自定义合并 prompt，并按块顺序传入 partials", async () => {
    const prefix = fourChunkPrefix();
    const seen: Message[][] = [];
    const mergeInputs: string[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "chunked",
      ctx,
      buildMergePrompt: (partials) => {
        mergeInputs.push([...partials]);
        return `CUSTOM-MERGE:${partials.join("|")}`;
      },
      summarize: (messages) => {
        seen.push(messages);
        if (seen.length <= prefix.length) return `S${seen.length}`;
        expect(textOf(messages[0]!)).toBe("CUSTOM-MERGE:S1|S2|S3|S4");
        return "MERGED";
      },
    });

    expect(result).toBe("MERGED");
    expect(mergeInputs).toEqual([["S1", "S2", "S3", "S4"]]);
    expect(seen).toHaveLength(prefix.length + 1);
  });

  it("第一块失败时抛错，不调用后续块", async () => {
    let calls = 0;
    const { ctx } = createTestContext();

    await expect(
      summarizeCompactionPrefix({
        prefix: fourChunkPrefix(),
        summaryChunkTokens: 150,
        ctx,
        summarize: () => {
          calls++;
          throw new Error("first-chunk-failed");
        },
      }),
    ).rejects.toThrow("first-chunk-failed");
    expect(calls).toBe(1);
  });

  it("后块失败时抛错，不返回部分结果、不调用合并", async () => {
    const calls: string[] = [];
    const { ctx } = createTestContext();

    await expect(
      summarizeCompactionPrefix({
        prefix: fourChunkPrefix(),
        summaryChunkTokens: 150,
        ctx,
        summarize: (messages) => {
          const label = `call-${calls.length + 1}`;
          calls.push(label);
          if (calls.length === 2) throw new Error("later-chunk-failed");
          expect(textOf(messages[0]!)).not.toContain("分段摘要");
          return `S${calls.length}`;
        },
      }),
    ).rejects.toThrow("later-chunk-failed");
    expect(calls).toEqual(["call-1", "call-2"]);
  });

  it("合并失败时抛错（不降级为分段拼接）", async () => {
    let calls = 0;
    const { ctx } = createTestContext();

    await expect(
      summarizeCompactionPrefix({
        prefix: fourChunkPrefix(),
        summaryChunkTokens: 150,
        ctx,
        summarize: () => {
          calls++;
          if (calls <= 4) return `S${calls}`;
          throw new Error("merge-failed");
        },
      }),
    ).rejects.toThrow("merge-failed");
    expect(calls).toBe(5);
  });

  it("单条超大消息被裁到块上限内再交给 summarize", async () => {
    const huge = createUserMessage("y".repeat(400_000));
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix: [huge],
      summaryChunkTokens: 10_000,
      ctx,
      summarize: (messages) => {
        seen.push(messages);
        return "CAPPED";
      },
    });

    expect(result).toBe("CAPPED");
    expect(seen).toHaveLength(1);
    const capped = seen[0]![0]!;
    expect(capped).not.toBe(huge);
    const content = textOf(capped);
    expect(content).toHaveLength(40_000 + TRUNCATION_SUFFIX.length);
    expect(content.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("空前缀与旧实现一致：仍调用一次 summarize([])", async () => {
    let seen: Message[] | undefined;
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix: [],
      summaryChunkTokens: 1000,
      ctx,
      summarize: (messages) => {
        seen = messages;
        return "EMPTY";
      },
    });

    expect(result).toBe("EMPTY");
    expect(seen).toEqual([]);
  });
});

describe("summarizeCompactionPrefix 单次调用模式", () => {
  it("single + 预算：只调用一次、原样传全部消息、chunk 为 0", async () => {
    const prefix = fourChunkPrefix().slice(0, 2);
    const seen: Message[][] = [];
    const chunks: Array<number | undefined> = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "single",
      singleCallBudgetTokens: 1000,
      ctx,
      onDelta: (delta) => chunks.push(delta.chunk),
      summarize: (messages, _receivedCtx, onDelta) => {
        seen.push(messages);
        onDelta?.({ part: "content", delta: "x" });
        return "ONE";
      },
    });

    expect(result).toBe("ONE");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(prefix.length);
    expect(seen[0]![0]).toBe(prefix[0]);
    expect(seen[0]![1]).toBe(prefix[1]);
    expect(chunks).toEqual([0]);
  });

  it("single/auto 缺预算或预算非正整数时抛错且不调用 summarize", async () => {
    let calls = 0;
    const { ctx } = createTestContext();
    const summarize = () => {
      calls++;
      return "X";
    };

    await expect(
      summarizeCompactionPrefix({
        prefix: fourChunkPrefix(),
        summaryChunkTokens: 150,
        summaryMode: "single",
        ctx,
        summarize,
      }),
    ).rejects.toThrow(/requires singleCallBudgetTokens/);

    await expect(
      summarizeCompactionPrefix({
        prefix: fourChunkPrefix(),
        summaryChunkTokens: 150,
        summaryMode: "auto",
        ctx,
        summarize,
      }),
    ).rejects.toThrow(/requires singleCallBudgetTokens/);

    await expect(
      summarizeCompactionPrefix({
        prefix: fourChunkPrefix(),
        summaryChunkTokens: 150,
        summaryMode: "single",
        singleCallBudgetTokens: 0,
        ctx,
        summarize,
      }),
    ).rejects.toThrow(/positive integer/);

    expect(calls).toBe(0);
  });

  it("single 模式下单条超大消息按预算截断并打上现有截断标记", async () => {
    const huge = createUserMessage("y".repeat(400_000));
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix: [huge],
      summaryChunkTokens: 150,
      summaryMode: "single",
      singleCallBudgetTokens: 10_000,
      ctx,
      summarize: (messages) => {
        seen.push(messages);
        return "CAPPED";
      },
    });

    expect(result).toBe("CAPPED");
    expect(seen).toHaveLength(1);
    const capped = seen[0]![0]!;
    expect(capped).not.toBe(huge);
    const content = textOf(capped);
    expect(content).toHaveLength(40_000 + TRUNCATION_SUFFIX.length);
    expect(content.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("auto 预算内只调用一次", async () => {
    const prefix = fourChunkPrefix().slice(0, 2);
    const seen: Message[][] = [];
    const chunks: Array<number | undefined> = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "auto",
      singleCallBudgetTokens: 1000,
      ctx,
      onDelta: (delta) => chunks.push(delta.chunk),
      summarize: (messages, _receivedCtx, onDelta) => {
        seen.push(messages);
        onDelta?.({ part: "content", delta: "x" });
        return "ONE";
      },
    });

    expect(result).toBe("ONE");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(chunks).toEqual([0]);
  });

  it("省略 summaryMode 但提供预算时按 auto 处理（预算内单次）", async () => {
    const prefix = fourChunkPrefix().slice(0, 2);
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      singleCallBudgetTokens: 1000,
      ctx,
      summarize: (messages) => {
        seen.push(messages);
        return "ONE";
      },
    });

    expect(result).toBe("ONE");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
  });

  it("auto 超预算：左、右、合并共 3 次调用，合并 prompt 按顺序包含两段摘要", async () => {
    const prefix = fourChunkPrefix();
    const seen: Message[][] = [];
    const chunks: Array<number | undefined> = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "auto",
      singleCallBudgetTokens: 250,
      ctx,
      onDelta: (delta) => chunks.push(delta.chunk),
      summarize: (messages, _receivedCtx, onDelta) => {
        seen.push(messages);
        onDelta?.({ part: "content", delta: "x" });
        if (seen.length === 1) return "LEFT";
        if (seen.length === 2) return "RIGHT";
        const prompt = textOf(messages[0]!);
        expect(prompt).toContain("2 段分段摘要");
        const leftAt = prompt.indexOf("=== 分段 1 ===\nLEFT");
        const rightAt = prompt.indexOf("=== 分段 2 ===\nRIGHT");
        expect(leftAt).toBeGreaterThanOrEqual(0);
        expect(rightAt).toBeGreaterThan(leftAt);
        return "MERGED";
      },
    });

    expect(result).toBe("MERGED");
    expect(seen).toHaveLength(3);
    expect(seen[0]!.map((m) => m)).toEqual(prefix.slice(0, 2));
    expect(seen[1]!.map((m) => m)).toEqual(prefix.slice(2));
    expect(chunks).toEqual([0, 1, 2]);
  });

  it("auto 递归拆分到默认深度：4 个叶子 + 3 次合并，chunk 编号全局顺序递增", async () => {
    const prefix = Array.from({ length: 8 }, (_, i) =>
      createUserMessage(`${i}:` + "x".repeat(400)),
    );
    const seen: Message[][] = [];
    const chunks: Array<number | undefined> = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "auto",
      singleCallBudgetTokens: 250,
      ctx,
      onDelta: (delta) => chunks.push(delta.chunk),
      summarize: (messages, _receivedCtx, onDelta) => {
        seen.push(messages);
        onDelta?.({ part: "content", delta: "x" });
        return `S${seen.length}`;
      },
    });

    expect(result).toBe("S7");
    expect(seen).toHaveLength(7);
    expect(chunks).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seen[0]).toHaveLength(2);
    expect(seen[3]).toHaveLength(2);
    expect(seen[2]).toHaveLength(1);
    expect(seen[5]).toHaveLength(1);
    expect(seen[6]).toHaveLength(1);
  });

  it("auto 模式使用自定义合并 prompt：左右子树合并与顶层汇编均生效且顺序正确", async () => {
    const prefix = Array.from({ length: 8 }, (_, i) =>
      createUserMessage(`${i}:` + "x".repeat(400)),
    );
    const seen: Message[][] = [];
    const mergeInputs: string[][] = [];
    const mergePrompts: string[] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "auto",
      singleCallBudgetTokens: 250,
      ctx,
      buildMergePrompt: (partials) => {
        mergeInputs.push([...partials]);
        return `CUSTOM-MERGE:${partials.join("|")}`;
      },
      summarize: (messages) => {
        seen.push(messages);
        const text = textOf(messages[0]!);
        if (text.startsWith("CUSTOM-MERGE:")) {
          mergePrompts.push(text);
          return `M${seen.length}`;
        }
        return `S${seen.length}`;
      },
    });

    expect(result).toBe("M7");
    expect(mergeInputs).toEqual([
      ["S1", "S2"],
      ["S4", "S5"],
      ["M3", "M6"],
    ]);
    expect(mergePrompts).toEqual([
      "CUSTOM-MERGE:S1|S2",
      "CUSTOM-MERGE:S4|S5",
      "CUSTOM-MERGE:M3|M6",
    ]);
    expect(seen).toHaveLength(7);
  });

  it("auto 优先选 user 边界，避免拆开 toolCall/toolResult", async () => {
    const prefix = [
      createUserMessage(sizedText("u")),
      assistantMessage(sizedText("a")),
      assistantMessage(sizedText("b")),
      createUserMessage(sizedText("c")),
    ];
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 1000,
      summaryMode: "auto",
      singleCallBudgetTokens: 350,
      ctx,
      summarize: (messages) => {
        seen.push(messages);
        return `S${seen.length}`;
      },
    });

    expect(result).toBe("S3");
    expect(seen).toHaveLength(3);
    expect(seen[0]).toHaveLength(3);
    expect(seen[1]).toHaveLength(1);
  });

  it("auto 到达最大拆分深度后用 chunked 叶子（summaryChunkTokens）", async () => {
    const prefix = fourChunkPrefix();
    const seen: Message[][] = [];
    const chunks: Array<number | undefined> = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "auto",
      singleCallBudgetTokens: 250,
      summaryMaxSplitDepth: 0,
      ctx,
      onDelta: (delta) => chunks.push(delta.chunk),
      summarize: (messages, _receivedCtx, onDelta) => {
        seen.push(messages);
        onDelta?.({ part: "content", delta: "x" });
        if (seen.length <= prefix.length) return `S${seen.length}`;
        expect(textOf(messages[0]!)).toContain("4 段分段摘要");
        return "MERGED";
      },
    });

    expect(result).toBe("MERGED");
    expect(seen).toHaveLength(5);
    expect(chunks).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < prefix.length; i++) {
      expect(seen[i]).toHaveLength(1);
      expect(seen[i]![0]).toBe(prefix[i]);
    }
  });

  it("auto 最大深度叶子失败即抛错，不调用合并、不返回部分结果", async () => {
    const prefix = fourChunkPrefix();
    let calls = 0;
    const { ctx } = createTestContext();

    await expect(
      summarizeCompactionPrefix({
        prefix,
        summaryChunkTokens: 150,
        summaryMode: "auto",
        singleCallBudgetTokens: 250,
        summaryMaxSplitDepth: 0,
        ctx,
        summarize: () => {
          calls++;
          if (calls === 2) throw new Error("leaf-failed");
          return `S${calls}`;
        },
      }),
    ).rejects.toThrow("leaf-failed");
    expect(calls).toBe(2);
  });

  it("auto 第二半失败时不调用合并并抛错", async () => {
    const prefix = fourChunkPrefix();
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    await expect(
      summarizeCompactionPrefix({
        prefix,
        summaryChunkTokens: 150,
        summaryMode: "auto",
        singleCallBudgetTokens: 250,
        ctx,
        summarize: (messages) => {
          seen.push(messages);
          if (seen.length === 2) throw new Error("right-half-failed");
          return "LEFT";
        },
      }),
    ).rejects.toThrow("right-half-failed");
    expect(seen).toHaveLength(2);
    expect(seen.every((messages) => !textOf(messages[0]!).includes("分段摘要"))).toBe(true);
  });

  it("水位消息在 chunked / single / auto 三种模式下都被过滤", async () => {
    const modes = [
      { summaryMode: "chunked" as const },
      { summaryMode: "single" as const, singleCallBudgetTokens: 1000 },
      { summaryMode: "auto" as const, singleCallBudgetTokens: 1000 },
    ];
    const { ctx } = createTestContext();

    for (const mode of modes) {
      const seen: Message[][] = [];
      const result = await summarizeCompactionPrefix({
        prefix: [
          createUserMessage(WATERMARK),
          createUserMessage(sizedText("p")),
          createUserMessage(sizedText("q")),
        ],
        summaryChunkTokens: 1000,
        ctx,
        ...mode,
        summarize: (messages) => {
          seen.push(messages);
          return "OK";
        },
      });

      expect(result).toBe("OK");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveLength(2);
      expect(seen[0]!.map((m) => textOf(m)).join("\n")).not.toContain("context-watermark:");
    }
  });

  it("summaryProjection 在模式选择前应用，且保持消息条数/顺序", async () => {
    const prefix = [
      createUserMessage(WATERMARK),
      createUserMessage(sizedText("A")),
      createUserMessage(sizedText("B")),
    ];
    const projected = [createUserMessage("p"), createUserMessage("q")];
    const projectionInputs: Message[][] = [];
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "auto",
      singleCallBudgetTokens: 20,
      ctx,
      summaryProjection: (messages) => {
        projectionInputs.push(messages);
        return projected;
      },
      summarize: (messages) => {
        seen.push(messages);
        return "PROJECTED";
      },
    });

    expect(result).toBe("PROJECTED");
    expect(projectionInputs).toHaveLength(1);
    expect(projectionInputs[0]).toHaveLength(2);
    expect(textOf(projectionInputs[0]![0]!)).not.toContain("context-watermark:");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]![0]).toBe(projected[0]);
    expect(seen[0]![1]).toBe(projected[1]);
  });

  it("显式 chunked 忽略预算并保持旧的分块 map-reduce 行为", async () => {
    const prefix = fourChunkPrefix();
    const seen: Message[][] = [];
    const { ctx } = createTestContext();

    const result = await summarizeCompactionPrefix({
      prefix,
      summaryChunkTokens: 150,
      summaryMode: "chunked",
      singleCallBudgetTokens: 100_000,
      ctx,
      summarize: (messages) => {
        seen.push(messages);
        if (seen.length <= prefix.length) return `S${seen.length}`;
        expect(textOf(messages[0]!)).toContain("4 段分段摘要");
        return "MERGED";
      },
    });

    expect(result).toBe("MERGED");
    expect(seen).toHaveLength(5);
  });

  it("空前缀在 single / auto 模式下仍只调用一次 summarize([])", async () => {
    const { ctx } = createTestContext();
    for (const summaryMode of ["single", "auto"] as const) {
      const seen: Message[][] = [];
      const result = await summarizeCompactionPrefix({
        prefix: [],
        summaryChunkTokens: 1000,
        summaryMode,
        singleCallBudgetTokens: 1000,
        ctx,
        summarize: (messages) => {
          seen.push(messages);
          return "EMPTY";
        },
      });
      expect(result).toBe("EMPTY");
      expect(seen).toEqual([[]]);
    }
  });
});
