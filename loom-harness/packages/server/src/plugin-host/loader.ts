/**
 * P2a trusted local external plugin loader。
 *
 * SECURITY：本加载器不做沙箱、不做权限隔离、不做网络/文件系统围栏。模块顶层代码与
 * setup() 都在 Loom 进程内执行，拥有与 Loom 进程完全相同的权限。只加载用户自己编写
 * 或完全信任的本地模块；路径必须由配置显式给出且为绝对路径。
 *
 * 加载一次、无 cache-busting query：同一模块在 boot 期间只 import 一次。
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LOOM_PLUGIN_API_VERSION,
  type LoomFeaturePlugin,
  type LoomPluginManifest,
} from "@axeuh/loom-plugin-sdk";

import {
  PluginHostError,
  describeError,
  isRecord,
  validateManifest,
} from "./validate.js";

/** 外部插件声明：id 与配置键一致，path 是该模块的绝对路径。 */
export interface ExternalPluginSpec {
  readonly id: string;
  readonly path: string;
  readonly trust?: "trusted";
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

function optionalConfigSchema(
  raw: Record<string, unknown>,
): string | Record<string, unknown> | undefined {
  const value = raw["configSchema"];
  if (typeof value === "string") return value;
  return isRecord(value) ? value : undefined;
}

function isSetup(value: unknown): value is LoomFeaturePlugin["setup"] {
  return typeof value === "function";
}

function invalidManifest(id: string, message: string): PluginHostError {
  return new PluginHostError("invalid-manifest", message, id);
}

function loadFailed(id: string, message: string, error?: unknown): PluginHostError {
  return new PluginHostError(
    "load-failed",
    error === undefined ? message : `${message}: ${describeError(error)}`,
    id,
  );
}

/**
 * 从绝对本地路径加载一个 trusted 外部插件。
 *
 * 模块契约：default export 一个对象，包含 `manifest`（对象）与 `setup`（函数）；不支持
 * named export 兜底。manifest.id 必须等于 spec.id，apiVersion 必须等于当前 SDK 版本；
 * source 只允许 external，trust 只允许 trusted（sandboxed 属 P2b）。返回值强制
 * source=external、trust=trusted，critical 缺省 true（可用 critical:false 显式退出
 * “失败即 boot 失败”语义）。
 */
export async function loadExternalPlugin(
  spec: ExternalPluginSpec,
): Promise<LoomFeaturePlugin> {
  const id = spec.id;

  if (spec.trust !== undefined && spec.trust !== "trusted") {
    throw invalidManifest(
      id,
      `trust ${JSON.stringify(spec.trust)} is not supported in P2a (sandboxed is P2b only)`,
    );
  }
  if (typeof spec.path !== "string" || spec.path.length === 0) {
    throw loadFailed(id, "path must be a non-empty absolute path");
  }
  if (!isAbsolute(spec.path)) {
    throw loadFailed(id, "path must be an absolute path");
  }

  let real: string;
  try {
    real = realpathSync(spec.path);
  } catch (error) {
    throw loadFailed(id, "cannot resolve plugin module path", error);
  }
  let regularFile = false;
  try {
    regularFile = statSync(real).isFile();
  } catch (error) {
    throw loadFailed(id, "cannot stat plugin module path", error);
  }
  if (!regularFile) {
    throw loadFailed(id, "plugin module path must point to an existing regular file");
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(real).href);
  } catch (error) {
    throw loadFailed(id, "plugin module import failed", error);
  }

  const exported = isRecord(imported) ? imported["default"] : undefined;
  if (!isRecord(exported)) {
    throw invalidManifest(
      id,
      "module must default-export an object with { manifest, setup }",
    );
  }
  const rawManifest = exported["manifest"];
  if (!isRecord(rawManifest)) {
    throw invalidManifest(id, "default export must include a manifest object");
  }
  const setup = exported["setup"];
  if (!isSetup(setup)) {
    throw invalidManifest(id, "default export must include a setup function");
  }

  const manifestId = rawManifest["id"];
  if (manifestId !== id) {
    throw invalidManifest(
      id,
      `manifest.id ${JSON.stringify(manifestId)} must match configured plugin id "${id}"`,
    );
  }
  const apiVersion = rawManifest["apiVersion"];
  if (apiVersion !== LOOM_PLUGIN_API_VERSION) {
    throw invalidManifest(
      id,
      `manifest.apiVersion must be ${String(LOOM_PLUGIN_API_VERSION)} (got ${JSON.stringify(apiVersion)})`,
    );
  }
  const source = rawManifest["source"];
  if (source !== undefined) {
    if (source === "builtin") {
      throw invalidManifest(id, 'manifest.source "builtin" is not allowed for external plugins');
    }
    if (source !== "external") {
      throw invalidManifest(id, 'manifest.source must be "external" when provided');
    }
  }
  const trust = rawManifest["trust"];
  if (trust !== undefined) {
    if (trust === "sandboxed") {
      throw invalidManifest(
        id,
        'manifest.trust "sandboxed" is not supported in P2a (P2b only)',
      );
    }
    if (trust !== "trusted") {
      throw invalidManifest(id, 'manifest.trust must be "trusted" when provided');
    }
  }

  const validation = validateManifest(rawManifest);
  if (validation.manifest === undefined) {
    throw invalidManifest(id, validation.errors.join("; "));
  }
  const resolved = validation.manifest;

  const entry = optionalString(rawManifest, "entry");
  const minLoomVersion = optionalString(rawManifest, "minLoomVersion");
  const description = optionalString(rawManifest, "description");
  const author = optionalString(rawManifest, "author");
  const license = optionalString(rawManifest, "license");
  const configSchema = optionalConfigSchema(rawManifest);

  const manifest: LoomPluginManifest = {
    id: resolved.id,
    name: resolved.name,
    version: resolved.version,
    apiVersion: resolved.apiVersion,
    permissions: [...resolved.permissions],
    requires: [...resolved.requires],
    critical: rawManifest["critical"] === undefined ? true : resolved.critical,
    source: "external",
    trust: "trusted",
    ...(entry === undefined ? {} : { entry }),
    ...(minLoomVersion === undefined ? {} : { minLoomVersion }),
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(license === undefined ? {} : { license }),
    ...(configSchema === undefined ? {} : { configSchema }),
  };

  return { manifest, setup };
}
