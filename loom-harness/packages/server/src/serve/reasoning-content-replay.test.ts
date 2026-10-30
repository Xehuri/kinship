import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/openai-completions";
import { markDeepSeekReasoningContent } from "@axeuh/loom-core";
import { describe, expect, it } from "vitest";

import { parseLoomConfig } from "../config/loom-config.js";
import { resolveServeModel } from "./model-source.js";

const SECRET = "sk-CANARY-replay-secret-4c1d";

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const YAML = [
  "server:",
  "  port: 5100",
  "  hostname: 127.0.0.1",
  "workspace: /srv/loom/ws",
  "providers:",
  "  - provider: eflowcode",
  "    baseUrl: https://e-flowcode.cc/v1",
  "models:",
  "  - id: deepseek-flash",
  "    provider: eflowcode",
  "    contextWindow: 262144",
  "    maxOutput: 32768",
  "    vision: true",
  "    timeout: 120000",
  "    reasoningContentReplay: true",
  "pricing:",
  "  eflowcode:",
  "    input: 0",
  "    output: 0",
  "credentials:",
  "  eflowcode: ${LOOM_KEY_EFLOWCODE}",
].join("\n");

function resolvedCompat(
  model: Model<"openai-completions">,
): Parameters<typeof convertMessages>[2] {
  const compat = model.compat;
  return {
    supportsStore: true,
    supportsDeveloperRole: compat?.supportsDeveloperRole ?? true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages:
      compat?.requiresReasoningContentOnAssistantMessages ?? false,
    thinkingFormat: compat?.thinkingFormat ?? "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    zaiToolStream: false,
    supportsStrictMode: true,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: true,
  };
}

function assistantFixture(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "reasoning text" },
      { type: "text", text: "answer" },
    ],
    api: "openai-completions",
    provider: "eflowcode",
    model: "deepseek-flash",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("reasoningContentReplay: true", () => {
  it("无 signature 的 thinking 块经 mark + convertMessages 回传真实 reasoning_content", () => {
    const config = parseLoomConfig(YAML, "<reasoning-content-replay-test>", {
      env: { LOOM_KEY_EFLOWCODE: SECRET },
    });
    const handle = resolveServeModel(config, {});
    expect(handle.model.reasoning).toBe(true);
    expect(handle.model.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });

    const model = handle.model as Model<"openai-completions">;
    const prior: AssistantMessage = assistantFixture();
    const context: Context = {
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        prior,
      ],
    };

    const marked = markDeepSeekReasoningContent(context.messages, model);
    const outbound = convertMessages(model, { messages: marked }, resolvedCompat(model));
    const outboundAssistant = outbound.find((message) => message.role === "assistant");

    expect(outboundAssistant).toMatchObject({
      role: "assistant",
      reasoning_content: "reasoning text",
    });
  });
});
