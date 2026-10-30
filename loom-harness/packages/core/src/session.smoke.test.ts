/**
 * session.smoke.test.ts —— T03 移植验收冒烟（新增，非 vendor 拷贝）。
 *
 * 用 ./testing 的 createFakeModel 跑最小 AgentSession：
 * 一次纯文本回复即可收尾，锁定「包内相对导入 + pi-ai hoist」两条链路真实可用。
 */

import { describe, it, expect } from "vitest";
import { AgentSession } from "./session.js";
import { createFakeModel } from "./testing.js";

describe("loom-core session smoke (T03)", () => {
  it("minimal AgentSession run with fake model", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "hello from loom-core" }] },
    ]);

    const session = new AgentSession({ model, tools: [] });
    const summary = await session.run("ping");

    expect(summary.reason).toBe("done");
    expect(summary.turns).toBe(1);

    const last = session.messages.at(-1);
    expect(last?.role).toBe("assistant");
    if (last && last.role === "assistant") {
      const text = last.content.find((c) => c.type === "text");
      expect(text?.type === "text" && text.text).toBe("hello from loom-core");
    }
  });
});
