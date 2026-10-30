/**
 * `loom plan master ...` CLI 子命令。
 *
 * 与 cli.ts 的 serve 解析解耦：本文件只处理 plan master 段，退出码沿用
 * 0=成功、1=运行期/数据错误、2=用法错误。不读写默认生产根——--root 必须是
 * 显式绝对路径。
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { UsageError } from "./commands.js";
import { FileLockTimeoutError } from "../plan/file-lock.js";
import { JsonMasterPlanStore } from "../plan/json-master-plan-store.js";
import {
  MasterPlanConflictError,
  MasterPlanCorruptError,
  MasterPlanNotFoundError,
  MasterPlanValidationError,
} from "../plan/master-plan.js";

export const PLAN_USAGE = [
  "用法：loom plan master validate --root <abs>",
  "      loom plan master show --root <abs>",
  "      loom plan master edit --root <abs> --ops <json|@file> --expected-version <n> [--reason TEXT]",
].join("\n");

interface ParsedPlanArgs {
  readonly action: "validate" | "show" | "edit";
  readonly root: string;
  readonly ops: string | null;
  readonly expectedVersion: number | null;
  readonly reason: string;
}

function takeValue(queue: string[], flag: string): string {
  const value = queue.shift();
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} 缺少值`);
  }
  return value;
}

function parseMasterArgs(args: readonly string[]): ParsedPlanArgs {
  if (args[0] !== "master") {
    throw new UsageError(`未知 plan 子命令：${args[0] ?? "(空)"}`);
  }
  const action = args[1];
  if (action !== "validate" && action !== "show" && action !== "edit") {
    throw new UsageError(`未知 plan master 子命令：${action ?? "(空)"}`);
  }
  const queue = args.slice(2);
  const seen = new Set<string>();
  let root: string | null = null;
  let ops: string | null = null;
  let expectedVersion: number | null = null;
  let reason = "loom plan master edit";

  while (queue.length > 0) {
    const flag = queue.shift() ?? "";
    if (seen.has(flag)) throw new UsageError(`${flag} 重复给定`);
    seen.add(flag);
    switch (flag) {
      case "--root": {
        const value = takeValue(queue, flag);
        if (!isAbsolute(value)) throw new UsageError(`--root 必须是绝对路径: ${value}`);
        root = resolve(value);
        break;
      }
      case "--ops":
        ops = takeValue(queue, flag);
        break;
      case "--expected-version": {
        const raw = takeValue(queue, flag);
        if (!/^\d+$/.test(raw)) throw new UsageError(`--expected-version 需要正整数，实际为 "${raw}"`);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new UsageError(`--expected-version 需要 >=1 的整数，实际为 "${raw}"`);
        }
        expectedVersion = parsed;
        break;
      }
      case "--reason":
        reason = takeValue(queue, flag);
        break;
      default:
        throw new UsageError(`未知选项：${flag}`);
    }
  }

  if (root === null) throw new UsageError("缺少 --root");
  if (action === "edit") {
    if (ops === null) throw new UsageError("edit 缺少 --ops");
    if (expectedVersion === null) throw new UsageError("edit 缺少 --expected-version");
  } else if (ops !== null || expectedVersion !== null) {
    throw new UsageError(`${action} 不接受 --ops/--expected-version`);
  }
  return { action, root, ops, expectedVersion, reason };
}

function readOps(value: string): unknown {
  let text = value;
  if (value.startsWith("@")) {
    try {
      text = readFileSync(value.slice(1), "utf8");
    } catch (error) {
      throw new UsageError(`--ops 文件读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`--ops 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function isDataError(error: unknown): boolean {
  return (
    error instanceof MasterPlanNotFoundError ||
    error instanceof MasterPlanConflictError ||
    error instanceof MasterPlanCorruptError ||
    error instanceof MasterPlanValidationError ||
    error instanceof FileLockTimeoutError
  );
}

export async function runPlanCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedPlanArgs;
  try {
    parsed = parseMasterArgs(args);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${PLAN_USAGE}`);
      return 2;
    }
    throw error;
  }

  const store = new JsonMasterPlanStore({ planRoot: parsed.root });
  try {
    switch (parsed.action) {
      case "validate": {
        const doc = await store.read();
        console.log(`master-plan OK version=${String(doc.version)} entries=${String(doc.entries.length)}`);
        return 0;
      }
      case "show": {
        const doc = await store.read();
        console.log(JSON.stringify(doc, null, 2));
        return 0;
      }
      case "edit": {
        const ops = readOps(parsed.ops ?? "");
        const doc = await store.edit(ops, parsed.expectedVersion ?? 0, parsed.reason);
        console.log(JSON.stringify(doc, null, 2));
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${PLAN_USAGE}`);
      return 2;
    }
    if (isDataError(error)) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    throw error;
  }
}
