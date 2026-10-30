/**
 * Regression: a persisted compaction boundary can leave a `toolResult` at the head of the
 * retained tail (its assistant toolCall was folded into the summary). The provider rejects
 * that wire shape with 400 "Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'". The main LLM path must sanitize the outgoing messages with
 * `filterIncompleteToolCalls` before capture/send, without mutating `_messages`.
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";

const zeroUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const toolResult = (toolCallId: string, text: string): Message => ({
  role: "toolResult",
  toolCallId,
  toolName: "echo",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});

const assistantToolCall = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "echo", arguments: {} }],
  api: "fake" as never,
  provider: "fake",
  model: "fake-model",
  usage: zeroUsage,
  stopReason: "toolUse",
  timestamp: 0,
});

describe("main wire sanitization", () => {
  it("drops an orphan toolResult from the provider-bound messages", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    let messagesText: string | null = null;
    const session = new AgentSession({
      model: fake,
      tools: [],
      consoleSink: () => {},
      initialMessages: [
        createUserMessage("[auto-compacted summary of 2 earlier messages]\nSUMMARY"),
        toolResult("orphan", "ghost"),
        assistantToolCall("valid"),
        toolResult("valid", "ok"),
      ],
      onWireSnapshot: (snapshot) => {
        messagesText = snapshot.messagesText;
      },
    });

    const summary = await session.run("go");

    expect(summary.reason).toBe("done");
    expect(messagesText).not.toBeNull();
    if (messagesText === null) {
      throw new Error("wire snapshot missing");
    }
    const messages = JSON.parse(messagesText) as Array<Record<string, unknown>>;
    expect(
      messages.some((message) => message["role"] === "toolResult" && message["toolCallId"] === "orphan"),
    ).toBe(false);
    expect(
      messages.some((message) => message["role"] === "toolResult" && message["toolCallId"] === "valid"),
    ).toBe(true);
    expect(session.messages.some((message) => message.role === "toolResult" && message.toolCallId === "orphan")).toBe(
      true,
    );
    fake.teardown();
  });
});
