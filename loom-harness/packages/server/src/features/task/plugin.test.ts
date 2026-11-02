import { describe, expect, it } from "vitest";

import { MemorySessionStore } from "@axeuh/loom-core";
import type { PluginContext } from "@axeuh/loom-plugin-sdk";

import { createTaskPlugin } from "./plugin.js";

const CTX: PluginContext = {
  plugin: { id: "task", version: "0.0.0", dataDir: "/tmp/loom-plugin-task" },
  config: {},
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  tools: { register: () => {} },
  hooks: { register: () => {} },
  routes: { register: () => {} },
  storage: {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  },
  events: { on: () => () => {}, emit: () => {} },
};

describe("task feature plugin", () => {
  it("manifest id 为 task，setup 只贡献 task_fetch 工具", async () => {
    const plugin = createTaskPlugin({ store: new MemorySessionStore() });
    expect(plugin.manifest.id).toBe("task");
    const contribution = await plugin.setup(CTX);
    expect(contribution.tools?.map((tool) => tool.name)).toEqual(["task_fetch"]);
  });
});
