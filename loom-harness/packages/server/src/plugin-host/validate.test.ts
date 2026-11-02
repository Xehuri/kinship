/**
 * manifest / contribution 校验：id、version、apiVersion、permissions、requires、
 * critical/source/trust、工具名冲突、路由前缀与路由冲突。
 */

import { Type } from "@axeuh/loom-core";
import type { HarnessTool } from "@axeuh/loom-core";
import { LOOM_PLUGIN_API_VERSION } from "@axeuh/loom-plugin-sdk";
import { describe, expect, it } from "vitest";

import {
  PLUGIN_ID_RE,
  PLUGIN_VERSION_RE,
  isRouteWithinPlugin,
  validateContribution,
  validateManifest,
  type PluginContributionView,
} from "./validate.js";

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

function view(
  tools: readonly unknown[] = [],
  routes: readonly unknown[] = [],
): PluginContributionView {
  return { tools, routes };
}

function validManifest(): Record<string, unknown> {
  return {
    id: "todo",
    name: "Todo",
    version: "1.2.3",
    apiVersion: LOOM_PLUGIN_API_VERSION,
    permissions: ["tools:register"],
  };
}

describe("validateManifest", () => {
  it("合法 manifest 解析出带默认值的快照", () => {
    const result = validateManifest(validManifest());
    expect(result.errors).toEqual([]);
    expect(result.manifest).toEqual({
      id: "todo",
      name: "Todo",
      version: "1.2.3",
      apiVersion: LOOM_PLUGIN_API_VERSION,
      permissions: ["tools:register"],
      requires: [],
      critical: false,
      source: "builtin",
      trust: "builtin",
    });
  });

  it("id 必须匹配小写插件 id 规则", () => {
    for (const id of ["", "-bad", "Bad", "a b", "a/b"]) {
      const result = validateManifest({ ...validManifest(), id });
      expect(result.errors.join("\n")).toContain(`id must match ${PLUGIN_ID_RE.source}`);
      expect(result.manifest).toBeUndefined();
    }
  });

  it("version 必须是 semver-like", () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0.0"]) {
      const result = validateManifest({ ...validManifest(), version });
      expect(result.errors.join("\n")).toContain("version must be semver-like");
    }
    expect(validateManifest({ ...validManifest(), version: "1.0.0-beta.1" }).errors).toEqual([]);
    expect(validateManifest({ ...validManifest(), version: "1.0.0+build.2" }).errors).toEqual([]);
  });

  it("apiVersion 必须等于 SDK 版本", () => {
    const result = validateManifest({
      ...validManifest(),
      apiVersion: LOOM_PLUGIN_API_VERSION + 1,
    });
    expect(result.errors.join("\n")).toContain(
      `apiVersion must be ${String(LOOM_PLUGIN_API_VERSION)}`,
    );
  });

  it("permissions 必须是已知权限数组", () => {
    expect(
      validateManifest({ ...validManifest(), permissions: ["bogus"] }).errors.join("\n"),
    ).toContain("permissions contains unknown values: bogus");
    expect(
      validateManifest({ ...validManifest(), permissions: "tools:register" }).errors.join("\n"),
    ).toContain("permissions must be an array");
  });

  it("requires 必须是字符串数组且不能包含自身", () => {
    expect(
      validateManifest({ ...validManifest(), requires: "todo" }).errors.join("\n"),
    ).toContain("requires must be an array of strings");
    expect(
      validateManifest({ ...validManifest(), requires: [42] }).errors.join("\n"),
    ).toContain("requires[0] must be a string");
    expect(
      validateManifest({ ...validManifest(), requires: ["todo"] }).errors.join("\n"),
    ).toContain("requires must not include the plugin itself");
  });

  it("critical/source/trust 类型或枚举非法时报错", () => {
    expect(
      validateManifest({ ...validManifest(), critical: "yes" }).errors.join("\n"),
    ).toContain("critical must be a boolean");
    expect(
      validateManifest({ ...validManifest(), source: "npm" }).errors.join("\n"),
    ).toContain('source must be "builtin" or "external"');
    expect(
      validateManifest({ ...validManifest(), trust: "root" }).errors.join("\n"),
    ).toContain('trust must be "builtin", "trusted", or "sandboxed"');
  });

  it("非对象 manifest 返回确定性错误", () => {
    expect(validateManifest(null)).toEqual({ errors: ["manifest must be an object"] });
    expect(validateManifest([])).toEqual({ errors: ["manifest must be an object"] });
  });
});

describe("validateContribution", () => {
  it("工具名在已运行插件与自身范围内必须唯一", () => {
    const errors = validateContribution({
      pluginId: "a",
      contribution: view([tool("echo"), tool("echo")]),
      existing: view([tool("echo")]),
    });
    expect(errors).toEqual([
      'tool name "echo" is already registered',
      'tool name "echo" is already registered',
    ]);
  });

  it("路由必须位于 /plugins/<plugin-id>/ 且是合法绝对路径", () => {
    const errors = validateContribution({
      pluginId: "todo",
      contribution: view([], [
        { method: "GET", path: "/plugins/other/run", handler: () => undefined },
        { method: "GET", path: "/plugins/todo/../run", handler: () => undefined },
        { method: "GET", path: "/plugins/todo//run", handler: () => undefined },
      ]),
      existing: view(),
    });
    expect(errors.join("\n")).toContain(
      'route path "/plugins/other/run" must start with "/plugins/todo/"',
    );
    expect(errors.join("\n")).toContain("must be a valid absolute path");
  });

  it("路由方法、auth、handler 非法时报错", () => {
    const errors = validateContribution({
      pluginId: "todo",
      contribution: view([], [
        { method: "TRACE", path: "/plugins/todo/run", auth: "public" },
      ]),
      existing: view(),
    });
    expect(errors.join("\n")).toContain("routes[0].method is not supported");
    expect(errors.join("\n")).toContain('routes[0].auth must be "required", "admin", or "none"');
    expect(errors.join("\n")).toContain("routes[0].handler must be a function");
  });

  it("路由 method/path 在插件之间必须唯一", () => {
    const route = {
      method: "GET",
      path: "/plugins/a/run",
      auth: "admin",
      handler: () => undefined,
    };
    const errors = validateContribution({
      pluginId: "a",
      contribution: view([], [route]),
      existing: view([], [route]),
    });
    expect(errors).toEqual(["route GET /plugins/a/run is already registered"]);
  });

  it("合法工具/路由通过，isRouteWithinPlugin 与校验器同口径", () => {
    const route = {
      method: "POST",
      path: "/plugins/a/run",
      handler: () => undefined,
    };
    expect(
      validateContribution({
        pluginId: "a",
        contribution: view([tool("alpha")], [route]),
        existing: view([tool("beta")]),
      }),
    ).toEqual([]);
    expect(
      isRouteWithinPlugin("a", {
        method: "POST",
        path: "/plugins/a/run",
        handler: () => undefined,
      }),
    ).toBe(true);
    expect(
      isRouteWithinPlugin("a", {
        method: "POST",
        path: "/plugins/b/run",
        handler: () => undefined,
      }),
    ).toBe(false);
  });
});

describe("regex constants", () => {
  it("id / version 正则与文档一致", () => {
    expect(PLUGIN_ID_RE.test("my.plugin-1")).toBe(true);
    expect(PLUGIN_ID_RE.test("MyPlugin")).toBe(false);
    expect(PLUGIN_VERSION_RE.test("0.0.0")).toBe(true);
    expect(PLUGIN_VERSION_RE.test("1.2")).toBe(false);
  });
});
