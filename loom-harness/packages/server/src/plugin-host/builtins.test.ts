/**
 * P0 builtin feature plugin manifests：五个唯一 id、契约字段合法、空 setup。
 */

import { describe, expect, it } from "vitest";

import {
  LOOM_PLUGIN_API_VERSION,
  PLUGIN_PERMISSIONS,
  type PluginContext,
} from "@axeuh/loom-plugin-sdk";

import { BUILTIN_PLUGINS } from "./builtins.js";

const CTX: PluginContext = {
  plugin: { id: "test", version: "0.0.0", dataDir: "/tmp/loom-plugin-test" },
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

describe("builtin feature plugins", () => {
  it("导出五个唯一 id（按登记顺序）", () => {
    const ids = BUILTIN_PLUGINS.map((plugin) => plugin.manifest.id);
    expect(ids).toEqual(["todo", "pty", "task", "plan", "inbox"]);
    expect(new Set(ids).size).toBe(5);
  });

  it("每个插件声明约定的能力集", () => {
    const actual = Object.fromEntries(
      BUILTIN_PLUGINS.map((plugin) => [plugin.manifest.id, plugin.manifest.permissions]),
    );
    expect(actual).toEqual({
      todo: ["tools:register", "storage:own", "config:own"],
      pty: ["tools:register", "config:own"],
      task: ["tools:register", "routes:register", "config:own"],
      plan: ["tools:register", "routes:register", "storage:own", "config:own"],
      inbox: [
        "tools:register",
        "routes:register",
        "storage:own",
        "config:own",
        "events:own",
      ],
    });
  });

  it("manifest 契约字段合法", () => {
    for (const plugin of BUILTIN_PLUGINS) {
      const manifest = plugin.manifest;
      expect(manifest.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.apiVersion).toBe(LOOM_PLUGIN_API_VERSION);
      expect(manifest.source).toBe("builtin");
      expect(manifest.trust).toBe("builtin");
      expect(manifest.critical).toBe(true);
      expect(manifest.permissions.length).toBeGreaterThan(0);
      for (const permission of manifest.permissions) {
        expect(PLUGIN_PERMISSIONS).toContain(permission);
      }
    }
  });

  it("setup 返回空 contribution（P0 不接管 feature 构造）", async () => {
    for (const plugin of BUILTIN_PLUGINS) {
      expect(await plugin.setup(CTX)).toEqual({});
    }
  });
});
