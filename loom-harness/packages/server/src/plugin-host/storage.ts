/**
 * 每插件一个 JSON 对象文件：`<dataRoot>/<pluginId>/storage.json`。
 *
 * 值必须可 JSON 序列化（undefined、BigInt、循环引用会被拒绝）。写盘在进程内串行，
 * 用 tmp 文件 + rename 保证原子替换。
 */

import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

import type { PluginStorage } from "@axeuh/loom-plugin-sdk";

import { PluginHostError, describeError, isRecord } from "./validate.js";

let tmpCounter = 0;

function loadStorage(pluginId: string, storagePath: string): Record<string, unknown> {
  if (!existsSync(storagePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storagePath, "utf8"));
  } catch (error) {
    throw new PluginHostError(
      "invalid-storage",
      `storage.json is not valid JSON: ${describeError(error)}`,
      pluginId,
    );
  }
  if (!isRecord(parsed)) {
    throw new PluginHostError(
      "invalid-storage",
      "storage.json must contain a JSON object",
      pluginId,
    );
  }
  return parsed;
}

function assertStorageKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new PluginHostError("invalid-storage", "storage key must be a non-empty string");
  }
}

function assertJsonSerializable(value: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new PluginHostError(
      "invalid-storage",
      `storage value is not JSON-serializable: ${describeError(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new PluginHostError(
      "invalid-storage",
      "storage value is not JSON-serializable (undefined or unsupported type)",
    );
  }
}

export class FilePluginStorage implements PluginStorage {
  private readonly data: Record<string, unknown>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly pluginId: string,
    private readonly storagePath: string,
  ) {
    this.data = loadStorage(pluginId, storagePath);
  }

  async get(key: string): Promise<unknown> {
    assertStorageKey(key);
    return this.data[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    assertStorageKey(key);
    assertJsonSerializable(value);
    this.data[key] = value;
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    if (!(key in this.data)) return;
    delete this.data[key];
    await this.persist();
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = Object.keys(this.data);
    const filtered =
      prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
    return filtered.sort();
  }

  private persist(): Promise<void> {
    // 每次 set/delete 都拍快照；队列保证磁盘写入顺序，读路径直接看内存最新值。
    const snapshot = JSON.stringify(this.data);
    const write = this.writeChain.then(() => this.writeSnapshot(snapshot));
    this.writeChain = write.catch(() => {
      // 失败不阻塞后续写入；错误已经通过返回的 promise 交给本次调用者。
    });
    return write;
  }

  private async writeSnapshot(content: string): Promise<void> {
    tmpCounter += 1;
    const tempPath = `${this.storagePath}.${process.pid}.${tmpCounter}.tmp`;
    try {
      await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.storagePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {
        // 清理失败不掩盖原始错误。
      });
      throw error;
    }
  }
}
