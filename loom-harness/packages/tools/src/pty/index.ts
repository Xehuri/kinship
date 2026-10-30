/**
 * PTY 工具子路径入口（`@axeuh/loom-tools/pty`）。
 *
 * 一个 factory 创建一个共享的 PtyManager，并返回五个模型可见工具：
 * pty_spawn / pty_write / pty_read / pty_list / pty_kill。
 * 所有工具的归属会话一律取 HookContext.sessionId，绝不从工具参数接收。
 */
import type { HarnessTool } from "@axeuh/loom-core";
import { PtyManager } from "./pty-manager.js";
import { createPtyKillTool } from "./tools/kill.js";
import { createPtyListTool } from "./tools/list.js";
import { createPtyReadTool } from "./tools/read.js";
import { createPtySpawnTool } from "./tools/spawn.js";
import { createPtyWriteTool } from "./tools/write.js";
import type { PtyManagerOptions, PtyToolOptions } from "./types.js";

export function createPtyTools(opts: PtyToolOptions): HarnessTool[] {
  const managerOptions: PtyManagerOptions = {
    ...(opts.caps !== undefined ? { caps: opts.caps } : {}),
    ...(opts.spawnPty !== undefined ? { spawnPty: opts.spawnPty } : {}),
    ...(opts.onExit !== undefined ? { onExit: opts.onExit } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
  const manager = new PtyManager(managerOptions);
  const notifyOnExitDefault = opts.notifyOnExitDefault ?? true;

  return [
    createPtySpawnTool(manager, { ...opts, notifyOnExitDefault }),
    createPtyWriteTool(manager),
    createPtyReadTool(manager),
    createPtyListTool(manager),
    createPtyKillTool(manager),
  ];
}

export type {
  PtyCaps,
  PtyExitNotifier,
  PtyManagerOptions,
  PtyProcessHandle,
  PtyReadResult,
  PtySearchResult,
  PtySession,
  PtySessionInfo,
  PtySpawnOptions,
  PtyStatus,
  PtyToolOptions,
  SpawnPtyFn,
} from "./types.js";
