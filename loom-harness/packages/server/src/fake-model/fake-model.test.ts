/**
 * fake-model.test.ts —— T32 验收核心：
 * 离线（无网络、无真 key）经 loom.yaml `models[].provider: fake` 声明的假模型
 * 驱动一个**含工具调用的完整 turn**：
 *   脚本 1：assistant（text + toolCall）→ kernel 真执行 echo 工具 → toolResult 回灌
 *   脚本 2：assistant 收束文本 → reason "done"
 * 断言：终态 / 工具真执行 / 第二发 LLM context 含 toolResult / 全程零 fetch。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
} from "@axeuh/loom-core";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import {
  FAKE_PROVIDER,
  createFakeModelFromConfig,
  isFakeModelConfig,
  partitionModelConfigs,
} from "./fake-provider.js";
import { installNoNetworkGuard } from "./no-network.js";

/** 最小 loom.yaml：models[] 声明一个 fake provider（credentials 段缺省 → 空表，离线可用）。 */
const FAKE_YAML = [
  "server:",
  "  port: 5097",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-fake-test-workspace",
  "models:",
  "  - id: fake-scripted",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    vision: true",
  "    timeout: 60000",
].join("\n");

/** echo 工具：真执行、把入参加工后回给模型（kernel 会把 toolResult 回灌进下一发 context）。 */
function makeEchoTool(executed: Array<Record<string, unknown>>): HarnessTool {
  return {
    name: "echo",
    description: "echo back the message",
    parameters: Type.Object({ msg: Type.String() }),
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async execute(args) {
      executed.push(args);
      return { content: [{ type: "text", text: `echoed: ${String(args["msg"])}` }] };
    },
  };
}

describe("T32 fake model provider —— loom.yaml provider:fake 接线", () => {
  it("config 解析出的 fake 条目：判别 / 分区 / 数据面对齐声明", () => {
    const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
    const entry = cfg.models[0];
    expect(entry).toBeDefined();
    if (!entry) return; // 类型收窄守卫，下方断言真实执行

    expect(isFakeModelConfig(entry)).toBe(true);
    const { fake, real } = partitionModelConfigs(cfg.models);
    expect(fake).toHaveLength(1);
    expect(real).toHaveLength(0);

    const model = createFakeModelFromConfig(entry, []);
    try {
      // loom.yaml 声明就地映射到注入 Model 的数据面
      expect(model.id).toBe("fake-scripted");
      expect(model.provider).toBe(FAKE_PROVIDER);
      expect(model.contextWindow).toBe(200000);
      expect(model.maxTokens).toBe(4096);
      expect(model.input).toEqual(["text", "image"]);
    } finally {
      model.teardown();
    }
  });

  it("非 fake provider 条目传入 createFakeModelFromConfig → fail-loud", () => {
    const cfg = parseLoomConfig(
      FAKE_YAML.replace(`provider: ${FAKE_PROVIDER}`, "provider: eflowcode"),
      "test:real-provider",
      { env: {} },
    );
    const entry = cfg.models[0]!;
    expect(isFakeModelConfig(entry)).toBe(false);
    expect(() => createFakeModelFromConfig(entry)).toThrow(/eflowcode/);
  });

  it("脚本化完整 turn：toolCall 真执行 + 收束文本 + 零网络（fetch 桩炸出即 fail）", async () => {
    const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
    const entry = cfg.models[0]!;

    // 离线守卫先装：本测试任何真实网络调用 = hits 非空 + throw = 测试红
    const guard = installNoNetworkGuard();
    try {
      const script: FakeAssistantResponse[] = [
        // 发 1：先说话再调工具（stopReason 由 fake 依内容推断为 toolUse）
        {
          content: [
            { type: "text", text: "我先复述一下" },
            { type: "toolCall", id: "tc-1", name: "echo", arguments: { msg: "hi" } },
          ],
          textDeltas: ["我先", "复述一下"],
        },
        // 发 2：看到 toolResult 后收束
        { content: [{ type: "text", text: "工具说：echoed: hi，任务完成" }] },
      ];

      const model = createFakeModelFromConfig(entry, script);
      const executed: Array<Record<string, unknown>> = [];
      const deltas: string[] = [];
      const session = new AgentSession({ model, tools: [makeEchoTool(executed)] });
      session.on("text_delta", (e) => deltas.push(e.delta));

      const summary = await session.run("跑一个带工具的回合");

      // ── 终态 ──
      expect(summary.reason).toBe("done");
      expect(summary.turns).toBe(2);

      // ── 工具被真执行（echo 语义）──
      expect(executed).toEqual([{ msg: "hi" }]);
      const toolResult = session.messages.find((m) => m.role === "toolResult");
      expect(toolResult?.role).toBe("toolResult");
      if (toolResult && toolResult.role === "toolResult") {
        expect(toolResult.toolCallId).toBe("tc-1");
        expect(toolResult.isError).toBe(false);
        const text = toolResult.content.find((c) => c.type === "text");
        expect(text?.type === "text" && text.text).toBe("echoed: hi");
      }

      // ── 收束文本进 transcript 终态 ──
      const last = session.messages.at(-1);
      expect(last?.role).toBe("assistant");
      if (last && last.role === "assistant") {
        const text = last.content.find((c) => c.type === "text");
        expect(text?.type === "text" && text.text).toBe("工具说：echoed: hi，任务完成");
      }

      // ── toolResult 回灌证明：第二发 LLM context 含工具结果 ──
      const calls = model.getCalls();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.messages.some((m) => m.role === "toolResult")).toBe(true);

      // ── 流式 delta 走 live track（fake 的 textDeltas → session.on）──
      expect(deltas.join("")).toBe("我先复述一下");

      // ── 无网络：脚本回放全程没碰 fetch ──
      expect(guard.hits).toEqual([]);

      model.teardown();
    } finally {
      guard.uninstall();
    }
  });

  it("离线守卫本身是活雷：fetch 一调用即炸（防止上一条的零断言假绿）", async () => {
    const guard = installNoNetworkGuard();
    try {
      await expect(globalThis.fetch("https://example.invalid/v1/chat")).rejects.toThrow(/离线守卫/);
      expect(guard.hits).toEqual(["https://example.invalid/v1/chat"]);
    } finally {
      guard.uninstall();
    }
    // 卸载后恢复原 fetch
    expect(typeof globalThis.fetch).toBe("function");
  });
});
