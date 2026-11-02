import { describe, expect, it } from "vitest";

import type { PluginContext } from "@axeuh/loom-plugin-sdk";

import { createTodoPlugin } from "./plugin.js";

const CTX: PluginContext = {
  plugin: { id: "todo", version: "0.0.0", dataDir: "/tmp/loom-plugin-todo" },
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

describe("todo feature plugin", () => {
  it("manifest id 为 todo，setup 贡献唯一 todowrite 工具", async () => {
    const plugin = createTodoPlugin({ onUpdated: () => {} });
    expect(plugin.manifest.id).toBe("todo");
    const contribution = await plugin.setup(CTX);
    expect(contribution.tools?.map((tool) => tool.name)).toEqual(["todowrite"]);
  });
});
