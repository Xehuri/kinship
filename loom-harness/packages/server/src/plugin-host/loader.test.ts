/**
 * P2a 外部插件 loader：模块契约、manifest 校验与路径拒绝。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadExternalPlugin } from "./loader.js";
import { PluginHostError } from "./validate.js";

let root: string;
let seq = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-plugin-loader-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BASE_MANIFEST = {
  id: "ext",
  name: "Ext",
  version: "1.0.0",
  apiVersion: 1,
  permissions: [],
};

function writeModule(source: string): string {
  seq += 1;
  const file = join(root, `fixture-${String(seq)}.mjs`);
  writeFileSync(file, source);
  return file;
}

function goodModule(overrides: Record<string, unknown> = {}): string {
  const manifest = { ...BASE_MANIFEST, ...overrides };
  return [
    `const manifest = ${JSON.stringify(manifest)};`,
    "export default { manifest, setup: () => ({}) };",
    "",
  ].join("\n");
}

async function rejectionOf(promise: Promise<unknown>): Promise<PluginHostError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PluginHostError) return error;
    throw error;
  }
  throw new Error("expected promise to reject");
}

describe("loadExternalPlugin", () => {
  it("加载合法模块：source=external、trust=trusted、critical 缺省 true", async () => {
    const plugin = await loadExternalPlugin({
      id: "ext",
      path: writeModule(goodModule()),
    });
    expect(plugin.manifest).toMatchObject({
      id: "ext",
      name: "Ext",
      version: "1.0.0",
      apiVersion: 1,
      source: "external",
      trust: "trusted",
      critical: true,
    });
    expect(typeof plugin.setup).toBe("function");
  });

  it("manifest.critical:false 时保留显式退出", async () => {
    const plugin = await loadExternalPlugin({
      id: "ext",
      path: writeModule(goodModule({ critical: false })),
    });
    expect(plugin.manifest.critical).toBe(false);
  });

  it("manifest.id 与配置 id 不一致：invalid-manifest", async () => {
    const error = await rejectionOf(
      loadExternalPlugin({
        id: "ext",
        path: writeModule(goodModule({ id: "other" })),
      }),
    );
    expect(error.code).toBe("invalid-manifest");
    expect(error.message).toContain('must match configured plugin id "ext"');
  });

  it("相对路径：load-failed", async () => {
    const error = await rejectionOf(
      loadExternalPlugin({ id: "ext", path: "./ext.mjs" }),
    );
    expect(error.code).toBe("load-failed");
    expect(error.message).toContain("absolute path");
  });

  it("文件不存在：load-failed", async () => {
    const error = await rejectionOf(
      loadExternalPlugin({ id: "ext", path: join(root, "missing.mjs") }),
    );
    expect(error.code).toBe("load-failed");
    expect(error.message).toContain("cannot resolve plugin module path");
  });

  it("apiVersion 不匹配：invalid-manifest", async () => {
    const error = await rejectionOf(
      loadExternalPlugin({
        id: "ext",
        path: writeModule(goodModule({ apiVersion: 2 })),
      }),
    );
    expect(error.code).toBe("invalid-manifest");
    expect(error.message).toContain("manifest.apiVersion must be 1");
  });

  it("source=builtin：invalid-manifest", async () => {
    const error = await rejectionOf(
      loadExternalPlugin({
        id: "ext",
        path: writeModule(goodModule({ source: "builtin" })),
      }),
    );
    expect(error.code).toBe("invalid-manifest");
    expect(error.message).toContain('"builtin" is not allowed');
  });

  it("trust=sandboxed：invalid-manifest 且点名 P2b", async () => {
    const error = await rejectionOf(
      loadExternalPlugin({
        id: "ext",
        path: writeModule(goodModule({ trust: "sandboxed" })),
      }),
    );
    expect(error.code).toBe("invalid-manifest");
    expect(error.message).toContain("P2b only");
  });

  it("缺少 default export：invalid-manifest", async () => {
    const source = [
      `const manifest = ${JSON.stringify(BASE_MANIFEST)};`,
      "const setup = () => ({});",
      "export { manifest, setup };",
      "",
    ].join("\n");
    const error = await rejectionOf(
      loadExternalPlugin({ id: "ext", path: writeModule(source) }),
    );
    expect(error.code).toBe("invalid-manifest");
    expect(error.message).toContain("default-export");
  });

  it("setup 不是函数：invalid-manifest", async () => {
    const source = [
      `const manifest = ${JSON.stringify(BASE_MANIFEST)};`,
      "export default { manifest, setup: 42 };",
      "",
    ].join("\n");
    const error = await rejectionOf(
      loadExternalPlugin({ id: "ext", path: writeModule(source) }),
    );
    expect(error.code).toBe("invalid-manifest");
    expect(error.message).toContain("setup function");
  });

  it("模块顶层抛错：load-failed", async () => {
    const source = [
      'throw new Error("top-level boom");',
      `const manifest = ${JSON.stringify(BASE_MANIFEST)};`,
      "export default { manifest, setup: () => ({}) };",
      "",
    ].join("\n");
    const error = await rejectionOf(
      loadExternalPlugin({ id: "ext", path: writeModule(source) }),
    );
    expect(error.code).toBe("load-failed");
    expect(error.message).toContain("top-level boom");
  });
});
