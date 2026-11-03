/**
 * PluginHost：依赖顺序、逆序停止、失败策略、冲突、禁用、状态与贡献生命周期。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@axeuh/loom-core";
import type { HarnessTool } from "@axeuh/loom-core";
import {
  LOOM_PLUGIN_API_VERSION,
  definePlugin,
  type LoomFeaturePlugin,
  type LoomPluginManifest,
  type PluginContext,
  type PluginContribution,
} from "@axeuh/loom-plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PluginHost,
  PluginHostError,
  type PluginHostOptions,
} from "./index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-plugin-host-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tool(name: string): HarnessTool {
  return {
    name,
    description: `tool ${name}`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: name }] };
    },
  };
}

interface PluginOptions {
  readonly manifest?: Partial<LoomPluginManifest>;
  readonly setup?: (ctx: PluginContext) => PluginContribution | Promise<PluginContribution>;
}

function makePlugin(id: string, options: PluginOptions = {}): LoomFeaturePlugin {
  const manifest: LoomPluginManifest = {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: LOOM_PLUGIN_API_VERSION,
    permissions: [],
    ...options.manifest,
  };
  return definePlugin({
    manifest,
    setup: options.setup ?? (() => ({})),
  });
}

function makeHost(overrides: Partial<PluginHostOptions> = {}): PluginHost {
  return new PluginHost({ dataRoot: root, ...overrides });
}

function stateOf(host: PluginHost, id: string): string | undefined {
  return host.status().find((status) => status.id === id)?.state;
}

async function rejectionOf(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("PluginHost lifecycle", () => {
  it("setup 顺序遵循依赖图，同层按注册顺序；status 保持注册顺序", async () => {
    const order: string[] = [];
    const a = makePlugin("a", {
      setup: () => {
        order.push("a");
        return {};
      },
    });
    const b = makePlugin("b", {
      manifest: { requires: ["a"] },
      setup: () => {
        order.push("b");
        return {};
      },
    });

    const host = makeHost();
    host.register(b);
    host.register(a);
    await host.start();

    expect(order).toEqual(["a", "b"]);
    expect(host.status().map((status) => status.id)).toEqual(["b", "a"]);
    expect(host.status().map((status) => status.state)).toEqual(["running", "running"]);
  });

  it("stop 按依赖逆序调用 contribution.stop", async () => {
    const calls: string[] = [];
    const a = makePlugin("a", {
      setup: () => ({
        start: () => {
          calls.push("start:a");
        },
        stop: () => {
          calls.push("stop:a");
        },
      }),
    });
    const b = makePlugin("b", {
      manifest: { requires: ["a"] },
      setup: () => ({
        start: () => {
          calls.push("start:b");
        },
        stop: () => {
          calls.push("stop:b");
        },
      }),
    });

    const host = makeHost();
    host.register(a);
    host.register(b);
    await host.start();
    await host.stop();

    expect(calls).toEqual(["start:a", "start:b", "stop:b", "stop:a"]);
    expect(host.status().map((status) => status.state)).toEqual(["stopped", "stopped"]);
  });

  it("非 critical contribution.start 失败标记 failed 且不贡献", async () => {
    const host = makeHost();
    host.register(
      makePlugin("bad-start", {
        setup: () => ({
          tools: [tool("bad-start-tool")],
          start: () => {
            throw new Error("start boom");
          },
        }),
      }),
    );
    host.register(makePlugin("good"));
    await host.start();

    expect(stateOf(host, "bad-start")).toBe("failed");
    expect(stateOf(host, "good")).toBe("running");
    expect(host.contributions().tools).toEqual([]);
    expect(host.status().find((status) => status.id === "bad-start")?.error).toContain(
      "start boom",
    );
  });

  it("stop 抛错只记录，不阻断其余插件的逆序停止", async () => {
    const calls: string[] = [];
    const log = vi.fn(
      (
        _level: "debug" | "info" | "warn" | "error",
        _msg: string,
        _fields?: Record<string, unknown>,
      ) => {
        // capture only
      },
    );
    const host = makeHost({ log });
    host.register(
      makePlugin("a", {
        setup: () => ({
          stop: () => {
            throw new Error("stop boom");
          },
        }),
      }),
    );
    host.register(
      makePlugin("b", {
        manifest: { requires: ["a"] },
        setup: () => ({
          stop: () => {
            calls.push("stop:b");
          },
        }),
      }),
    );
    await host.start();
    await host.stop();

    expect(calls).toEqual(["stop:b"]);
    expect(host.status().map((status) => status.state)).toEqual(["stopped", "stopped"]);
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("stop failed"),
      expect.objectContaining({ pluginId: "a" }),
    );
  });

  it("缺失依赖导致 start 抛 PluginHostError", async () => {
    const host = makeHost();
    host.register(makePlugin("needs-missing", { manifest: { requires: ["missing"] } }));
    const error = await rejectionOf(host.start());
    expect(error).toBeInstanceOf(PluginHostError);
    expect(error).toMatchObject({ code: "missing-dependency", pluginId: "needs-missing" });
  });

  it("依赖环导致 start 抛 PluginHostError", async () => {
    const host = makeHost();
    host.register(makePlugin("cycle-a", { manifest: { requires: ["cycle-b"] } }));
    host.register(makePlugin("cycle-b", { manifest: { requires: ["cycle-a"] } }));
    const error = await rejectionOf(host.start());
    expect(error).toBeInstanceOf(PluginHostError);
    expect(error).toMatchObject({ code: "dependency-cycle" });
    expect(messageOf(error)).toContain("cycle-a");
    expect(messageOf(error)).toContain("cycle-b");
  });

  it("critical setup 失败抛错并标记 failed", async () => {
    const host = makeHost();
    host.register(
      makePlugin("critical-boom", {
        manifest: { critical: true },
        setup: () => {
          throw new Error("setup boom");
        },
      }),
    );
    const error = await rejectionOf(host.start());
    expect(error).toBeInstanceOf(PluginHostError);
    expect(messageOf(error)).toContain("setup boom");
    expect(stateOf(host, "critical-boom")).toBe("failed");
    expect(host.status()[0]?.error).toContain("setup boom");
  });

  it("非 critical setup 失败标记 failed，其他插件继续启动", async () => {
    const goodSetup = vi.fn(() => ({}));
    const host = makeHost();
    host.register(
      makePlugin("bad", {
        manifest: { permissions: ["tools:register"] },
        setup: (ctx) => {
          ctx.tools.register(tool("should-not-leak"));
          throw new Error("bad setup");
        },
      }),
    );
    host.register(makePlugin("good", { setup: goodSetup }));
    await host.start();

    expect(goodSetup).toHaveBeenCalledOnce();
    expect(stateOf(host, "bad")).toBe("failed");
    expect(stateOf(host, "good")).toBe("running");
    expect(host.contributions()).toEqual({ tools: [], hooks: [], routes: [] });
  });

  it("重复 plugin id 在 register 时抛错", () => {
    const host = makeHost();
    host.register(makePlugin("dup"));
    let caught: unknown;
    try {
      host.register(makePlugin("dup"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PluginHostError);
    expect(caught).toMatchObject({ code: "duplicate-id", pluginId: "dup" });
  });

  it("非法 apiVersion / id / version 的 manifest 使插件 failed", async () => {
    const host = makeHost();
    host.register(makePlugin("bad-api", { manifest: { apiVersion: 99 } }));
    host.register(makePlugin("Bad-ID"));
    host.register(makePlugin("bad-version", { manifest: { version: "1.0" } }));
    await host.start();

    expect(stateOf(host, "bad-api")).toBe("failed");
    expect(stateOf(host, "Bad-ID")).toBe("failed");
    expect(stateOf(host, "bad-version")).toBe("failed");
    expect(host.status().every((status) => status.error !== undefined)).toBe(true);
  });

  it("工具名冲突：非 critical 只让后注册插件 failed 且不贡献", async () => {
    const host = makeHost();
    host.register(makePlugin("a", { setup: () => ({ tools: [tool("shared")] }) }));
    host.register(
      makePlugin("b", {
        setup: () => ({ tools: [tool("shared"), tool("b-only")] }),
      }),
    );
    await host.start();

    expect(stateOf(host, "a")).toBe("running");
    expect(stateOf(host, "b")).toBe("failed");
    expect(host.contributions().tools.map((item) => item.name)).toEqual(["shared"]);
    expect(host.status().find((status) => status.id === "b")?.error).toContain(
      'tool name "shared" is already registered',
    );
  });

  it("工具名冲突：critical 抛错并保留此前已运行插件", async () => {
    const host = makeHost();
    host.register(makePlugin("a", { setup: () => ({ tools: [tool("shared")] }) }));
    host.register(
      makePlugin("b", {
        manifest: { critical: true },
        setup: () => ({ tools: [tool("shared")] }),
      }),
    );
    const error = await rejectionOf(host.start());

    expect(error).toBeInstanceOf(PluginHostError);
    expect(messageOf(error)).toContain('tool name "shared" is already registered');
    expect(stateOf(host, "a")).toBe("running");
    expect(stateOf(host, "b")).toBe("failed");
    expect(host.contributions().tools.map((item) => item.name)).toEqual(["shared"]);
  });

  it("路由路径不在 /plugins/<id>/ 下时插件 failed", async () => {
    const host = makeHost();
    host.register(
      makePlugin("router", {
        setup: () => ({
          routes: [
            {
              method: "GET",
              path: "/elsewhere/status",
              handler: () => undefined,
            },
          ],
        }),
      }),
    );
    await host.start();

    expect(stateOf(host, "router")).toBe("failed");
    expect(host.status()[0]?.error).toContain('must start with "/plugins/router/"');
    expect(host.contributions().routes).toEqual([]);
  });

  it("禁用插件不调用 setup，并报告 disabled", async () => {
    const setup = vi.fn(() => ({}));
    const host = makeHost();
    host.register(makePlugin("off", { setup }), { enabled: false });
    host.register(makePlugin("on"));
    await host.start();

    expect(setup).not.toHaveBeenCalled();
    expect(stateOf(host, "off")).toBe("disabled");
    expect(stateOf(host, "on")).toBe("running");
    expect(host.status().find((status) => status.id === "off")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
  });

  it("Hook 重名不导致失败（Host 不做 Hook 冲突校验）", async () => {
    const hook = {
      name: "same-hook",
      onSessionStart: () => undefined,
    };
    const host = makeHost();
    host.register(makePlugin("a", { setup: () => ({ hooks: [hook] }) }));
    host.register(makePlugin("b", { setup: () => ({ hooks: [hook] }) }));
    await host.start();

    expect(host.status().map((status) => status.state)).toEqual(["running", "running"]);
    expect(host.contributions().hooks.map((item) => item.name)).toEqual([
      "same-hook",
      "same-hook",
    ]);
  });

  it("status 转换 registered -> running -> stopped，stop 后贡献清空且幂等", async () => {
    const timestamp = Date.parse("2026-01-02T03:04:05.000Z");
    const now = vi.fn(() => timestamp);
    const host = makeHost({ now });
    host.register(makePlugin("alpha", { setup: () => ({ tools: [tool("alpha")] }) }));

    expect(host.status()[0]).toMatchObject({
      id: "alpha",
      version: "1.0.0",
      source: "builtin",
      trust: "builtin",
      enabled: true,
      state: "registered",
    });
    expect(host.contributions()).toEqual({ tools: [], hooks: [], routes: [] });

    await host.start();
    expect(host.status()[0]).toMatchObject({
      state: "running",
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(host.contributions().tools.map((item) => item.name)).toEqual(["alpha"]);
    expect(now).toHaveBeenCalledTimes(1);

    await host.stop();
    expect(host.status()[0]).toMatchObject({
      state: "stopped",
      stoppedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(host.contributions()).toEqual({ tools: [], hooks: [], routes: [] });
    expect(now).toHaveBeenCalledTimes(2);

    const stoppedAt = host.status()[0]?.stoppedAt;
    await host.stop();
    expect(host.status()[0]?.state).toBe("stopped");
    expect(host.status()[0]?.stoppedAt).toBe(stoppedAt);
    expect(now).toHaveBeenCalledTimes(2);
  });
});
