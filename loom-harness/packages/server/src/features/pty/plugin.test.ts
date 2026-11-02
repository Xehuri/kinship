import { describe, expect, it } from "vitest";

import type { PluginContext } from "@axeuh/loom-plugin-sdk";

import { createPtyPlugin } from "./plugin.js";

const CTX: PluginContext = {
  plugin: { id: "pty", version: "0.0.0", dataDir: "/tmp/loom-plugin-pty" },
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

const PTY_NAMES = ["pty_kill", "pty_list", "pty_read", "pty_spawn", "pty_write"] as const;

describe("pty feature plugin", () => {
  it("manifest id 为 pty，setup 贡献五件套与 dispose 停止函数", async () => {
    const plugin = createPtyPlugin({
      defaultWorkdir: "/tmp",
      workspaceRoot: "/tmp",
      validateSpawn: () => {},
    });
    expect(plugin.manifest.id).toBe("pty");
    const contribution = await plugin.setup(CTX);
    expect(contribution.tools?.map((tool) => tool.name).sort()).toEqual([...PTY_NAMES].sort());
    expect(contribution.stop).toBeTypeOf("function");
    contribution.stop?.();
  });
});
