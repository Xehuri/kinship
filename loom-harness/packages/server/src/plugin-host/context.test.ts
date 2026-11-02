/**
 * PluginContext：storage 隔离/持久化/原子写、事件总线、配置命名空间、
 * 只增注册表与 logger 命名空间。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@axeuh/loom-core";
import type { HarnessTool, Hook } from "@axeuh/loom-core";
import {
  LOOM_PLUGIN_API_VERSION,
  type LoomFeaturePlugin,
  type PluginRoute,
} from "@axeuh/loom-plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPluginContext,
  type PluginContributionSink,
  type PluginLogFn,
} from "./context.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-plugin-context-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function plugin(id: string): LoomFeaturePlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      apiVersion: LOOM_PLUGIN_API_VERSION,
      permissions: [],
    },
    setup: () => ({}),
  };
}

interface CapturedContribution {
  readonly tools: HarnessTool[];
  readonly hooks: Hook[];
  readonly routes: PluginRoute[];
}

function sink(captured: CapturedContribution): PluginContributionSink {
  return {
    registerTool(tool): void {
      captured.tools.push(tool);
    },
    registerHook(hook): void {
      captured.hooks.push(hook);
    },
    registerRoute(route): void {
      captured.routes.push(route);
    },
  };
}

function emptyCaptured(): CapturedContribution {
  return { tools: [], hooks: [], routes: [] };
}

const tool: HarnessTool = {
  name: "probe",
  description: "probe tool",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
};

const hook: Hook = {
  name: "probe-hook",
  onSessionStart() {
    return undefined;
  },
};

const route: PluginRoute = {
  method: "GET",
  path: "/plugins/probe/status",
  handler: () => undefined,
};

describe("createPluginContext", () => {
  it("storage get/set/delete/list 按插件隔离且可重新加载", async () => {
    const contextA = createPluginContext({
      plugin: plugin("alpha"),
      dataRoot: root,
      sink: sink(emptyCaptured()),
    });
    const contextB = createPluginContext({
      plugin: plugin("beta"),
      dataRoot: root,
      sink: sink(emptyCaptured()),
    });

    await contextA.storage.set("profile", { name: "alpha", count: 1 });
    await contextA.storage.set("other", "value");
    await contextB.storage.set("profile", { name: "beta" });

    expect(await contextA.storage.get("profile")).toEqual({ name: "alpha", count: 1 });
    expect(await contextB.storage.get("profile")).toEqual({ name: "beta" });
    expect(await contextA.storage.list()).toEqual(["other", "profile"]);
    expect(await contextA.storage.list("pro")).toEqual(["profile"]);
    expect(await contextB.storage.list()).toEqual(["profile"]);

    await contextA.storage.delete("profile");
    expect(await contextA.storage.get("profile")).toBeUndefined();
    expect(await contextB.storage.get("profile")).toEqual({ name: "beta" });

    // 写通过 tmp + rename 落盘，目录里只应有 storage.json。
    expect(readdirSync(join(root, "alpha"))).toEqual(["storage.json"]);

    const reloaded = createPluginContext({
      plugin: plugin("alpha"),
      dataRoot: root,
      sink: sink(emptyCaptured()),
    });
    expect(await reloaded.storage.get("other")).toBe("value");
  });

  it("拒绝非 JSON 可序列化值与非法 key", async () => {
    const context = createPluginContext({
      plugin: plugin("alpha"),
      dataRoot: root,
      sink: sink(emptyCaptured()),
    });
    await expect(context.storage.set("bad", { value: 1n })).rejects.toThrow(
      /not JSON-serializable/,
    );
    await expect(context.storage.set("", 1)).rejects.toThrow(/non-empty string/);
  });

  it("events on/emit/unsubscribe 生效，listener 抛错不打断 emit", () => {
    const logs: string[] = [];
    const log: PluginLogFn = (level, msg, fields) => {
      logs.push(`${level}:${msg}:${String(fields?.["pluginId"])}`);
    };
    const context = createPluginContext({
      plugin: plugin("alpha"),
      dataRoot: root,
      sink: sink(emptyCaptured()),
      log,
    });

    const seen: unknown[] = [];
    const off = context.events.on("tick", (payload) => {
      seen.push(payload);
    });
    context.events.emit("tick", 1);
    off();
    context.events.emit("tick", 2);
    expect(seen).toEqual([1]);

    context.events.on("tick", () => {
      throw new Error("listener boom");
    });
    context.events.on("tick", (payload) => {
      seen.push(payload);
    });
    expect(() => context.events.emit("tick", 3)).not.toThrow();
    expect(seen).toEqual([1, 3]);
    expect(logs.some((entry) => entry.startsWith("error:event listener failed"))).toBe(true);
  });

  it("config 只暴露本插件命名空间且被冻结", () => {
    const context = createPluginContext({
      plugin: plugin("alpha"),
      dataRoot: root,
      sink: sink(emptyCaptured()),
      config: {
        alpha: { mode: "fast" },
        beta: { mode: "slow" },
      },
    });
    expect(context.config).toEqual({ mode: "fast" });
    expect(Object.isFrozen(context.config)).toBe(true);
    expect(existsSync(context.plugin.dataDir)).toBe(true);
  });

  it("tools/hooks/routes 注册只汇入 sink，不直接生效", () => {
    const captured = emptyCaptured();
    const context = createPluginContext({
      plugin: plugin("alpha"),
      dataRoot: root,
      sink: sink(captured),
    });
    context.tools.register(tool);
    context.hooks.register(hook);
    context.routes.register(route);
    expect(captured).toEqual({ tools: [tool], hooks: [hook], routes: [route] });
  });
});
