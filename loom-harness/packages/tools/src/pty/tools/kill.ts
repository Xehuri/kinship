/**
 * pty_kill —— 终止 PTY 会话，可选清理缓冲区。
 *
 * 只对“本次调用确实终止了运行中的进程”使用 Killed 措辞；对已退出会话执行
 * cleanup 时返回 Cleaned up，并始终带上快照状态便于模型判断。
 */
import { Type, type HarnessTool } from "@axeuh/loom-core";
import { PTY_KILL_DESCRIPTION } from "../labels.js";
import type { PtyManager } from "../pty-manager.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function createPtyKillTool(manager: PtyManager): HarnessTool {
  return {
    name: "pty_kill",
    label: "pty_kill",
    description: PTY_KILL_DESCRIPTION,
    isReadOnly: false,
    isDestructive: true,
    isOpenWorld: true,
    parameters: Type.Object({
      id: Type.String({ description: "The PTY session ID (e.g., pty_a1b2c3d4)" }),
      cleanup: Type.Optional(
        Type.Boolean({
          description:
            "If true, removes the session and frees the buffer (default: false)",
        }),
      ),
    }),
    isConcurrencySafe: () => false,
    async execute(args, ctx, signal) {
      signal.throwIfAborted();

      const id = asString(args["id"], "id");
      const cleanup = asOptionalBoolean(args["cleanup"], "cleanup") ?? false;

      const before = manager.get(id, ctx.sessionId);
      if (!before) throw new Error(`PTY session not found: ${id}`);

      const wasRunning = before.status === "running";
      const killed = manager.kill(id, ctx.sessionId, cleanup);
      const action = wasRunning ? "Killed" : "Cleaned up";
      const cleanupNote = cleanup
        ? " (session removed)"
        : " (session retained for log access)";

      const text = [
        "<pty_killed>",
        `${action}: ${id}${cleanupNote}`,
        `Title: ${killed.title}`,
        `Command: ${[killed.command, ...killed.args].join(" ")}`,
        `Final line count: ${killed.lineCount}`,
        `Status: ${killed.status}`,
        "</pty_killed>",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          id,
          action,
          cleanup,
          status: killed.status,
          finalLineCount: killed.lineCount,
        },
      };
    },
  };
}
