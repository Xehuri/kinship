/**
 * 移植自 vendor-snapshot/harness-pi/packages/tools/src/__tests__/pi-compat.test.ts（T04）。
 * 改动：core 包名改为 loom-core；schema 反射改用类型守卫（strict 无 as any）；
 * package.json 用 import.meta.url 定位本包目录，不依赖 process.cwd()。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HarnessTool } from "@axeuh/loom-core";
import {
  allTools,
  bashTool,
  codingTools,
  createAllTools,
  createBashTool,
  createCodingTools,
  createReadOnlyTools,
  createReadTool,
  createEditTool,
  createWriteTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  editTool,
  findTool,
  grepTool,
  lsTool,
  readOnlyTools,
  readTool,
  toolNames,
  writeTool,
} from "../index.js";

const PI_053_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

const PI_053_CODING_DEFAULTS = ["read", "bash", "edit", "write"] as const;
const PI_053_READ_ONLY_DEFAULTS = ["read", "grep", "find", "ls"] as const;

const PI_053_SCHEMA_KEYS = {
  // maxTokens 是 X3(#60) 的第一方扩展，有意超出上游 0.53 的 read schema。
  read: ["path", "offset", "limit", "maxTokens"],
  bash: ["command", "timeout"],
  edit: ["path", "oldText", "newText"],
  write: ["path", "content"],
  grep: [
    "pattern",
    "path",
    "glob",
    "ignoreCase",
    "literal",
    "context",
    "limit",
  ],
  find: ["pattern", "path", "limit"],
  ls: ["path", "limit"],
} as const;

const PI_053_REQUIRED = {
  read: ["path"],
  bash: ["command"],
  edit: ["path", "oldText", "newText"],
  write: ["path", "content"],
  grep: ["pattern"],
  find: ["pattern"],
  ls: [],
} as const;

/** TypeBox Object schema 的结构子集（TSchema 是空接口，只能靠收窄读取）。 */
interface ObjectSchemaShape {
  type?: string;
  properties?: Record<string, unknown>;
  required?: unknown;
}

function objectSchema(parameters: unknown): ObjectSchemaShape {
  if (typeof parameters !== "object" || parameters === null) {
    throw new Error("tool.parameters must be an object");
  }
  // TSchema 无可索引成员；这里只按 JSON-Schema 形状读取，非类型逃逸。
  return parameters as ObjectSchemaShape;
}

function schemaKeys(tool: HarnessTool): string[] {
  const shape = objectSchema(tool.parameters);
  return Object.keys(shape.properties ?? {});
}

function requiredKeys(tool: HarnessTool): string[] {
  const shape = objectSchema(tool.parameters);
  const required = shape.required;
  return Array.isArray(required) ? required.map((key) => String(key)) : [];
}

describe("pi-coding-agent 0.53 compatibility", () => {
  it("exports the same first-party tool names", () => {
    const all = createAllTools("/tmp");
    expect(Object.keys(all)).toEqual([...PI_053_TOOL_NAMES]);
    expect([...toolNames]).toEqual([...PI_053_TOOL_NAMES]);
    expect(Object.keys(allTools)).toEqual([...PI_053_TOOL_NAMES]);
  });

  it("keeps composite factory defaults aligned", () => {
    expect(createCodingTools("/tmp").map((t) => t.name)).toEqual([
      ...PI_053_CODING_DEFAULTS,
    ]);
    expect(createReadOnlyTools("/tmp").map((t) => t.name)).toEqual([
      ...PI_053_READ_ONLY_DEFAULTS,
    ]);
    expect(codingTools.map((t) => t.name)).toEqual([...PI_053_CODING_DEFAULTS]);
    expect(readOnlyTools.map((t) => t.name)).toEqual([
      ...PI_053_READ_ONLY_DEFAULTS,
    ]);
  });

  it("supports disabling defaults from composite factories", () => {
    expect(
      createCodingTools("/tmp", { disabled: ["bash", "write"] }).map(
        (t) => t.name,
      ),
    ).toEqual(["read", "edit"]);
    expect(
      createReadOnlyTools("/tmp", { disabled: ["grep"] }).map((t) => t.name),
    ).toEqual(["read", "find", "ls"]);
  });

  it("keeps TypeBox schema property names aligned", () => {
    const tools = {
      read: createReadTool("/tmp"),
      bash: createBashTool("/tmp"),
      edit: createEditTool("/tmp"),
      write: createWriteTool("/tmp"),
      grep: createGrepTool("/tmp"),
      find: createFindTool("/tmp"),
      ls: createLsTool("/tmp"),
    } satisfies Record<(typeof PI_053_TOOL_NAMES)[number], HarnessTool>;
    for (const name of PI_053_TOOL_NAMES) {
      expect(schemaKeys(tools[name])).toEqual([...PI_053_SCHEMA_KEYS[name]]);
      expect(requiredKeys(tools[name])).toEqual([...PI_053_REQUIRED[name]]);
    }
  });

  it("keeps labels and concurrency-safety aligned", () => {
    const all = createAllTools("/tmp");
    expect(PI_053_TOOL_NAMES.map((name) => all[name].label)).toEqual([
      ...PI_053_TOOL_NAMES,
    ]);
    const readOnlyNames: typeof PI_053_READ_ONLY_DEFAULTS = [
      "read",
      "grep",
      "find",
      "ls",
    ];
    expect(
      readOnlyNames.map((name) => all[name].isConcurrencySafe?.({})),
    ).toEqual([true, true, true, true]);
    const unsafeNames = ["bash", "edit", "write"] as const;
    expect(
      unsafeNames.map((name) => all[name].isConcurrencySafe?.({})),
    ).toEqual([false, false, false]);
  });

  it("exports per-tool default constants without pi-coding-agent dependency", () => {
    expect([
      readTool.name,
      bashTool.name,
      editTool.name,
      writeTool.name,
      grepTool.name,
      findTool.name,
      lsTool.name,
    ]).toEqual([...PI_053_TOOL_NAMES]);

    // 根 vitest 的 cwd 是 monorepo 根，必须从模块 URL 定位本包 package.json。
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // 第一方实现，不把 coding-agent 拉进 tools runtime——两个命名空间都不许。
    expect(pkg.dependencies).not.toHaveProperty(
      "@mariozechner/pi-coding-agent",
    );
    expect(pkg.dependencies).not.toHaveProperty(
      "@earendil-works/pi-coding-agent",
    );
  });
});
