/**
 * pty_list —— 列出当前 Loom session 名下的全部 PTY 会话。
 */
import { Type, type HarnessTool } from "@axeuh/loom-core";
import { PTY_LIST_DESCRIPTION } from "../labels.js";
import type { PtyManager } from "../pty-manager.js";
import type { PtySessionInfo } from "../types.js";

function commandLine(session: PtySessionInfo): string {
  return [session.command, ...session.args].join(" ");
}

function statusLine(session: PtySessionInfo): string {
  if (session.status === "running") return "running";
  if (session.exitCode !== undefined) return `exit: ${session.exitCode}`;
  return session.status;
}

function formatSession(session: PtySessionInfo): string[] {
  const timeout =
    session.timeoutSeconds !== undefined ? ` | timeout: ${session.timeoutSeconds}s` : "";
  return [
    `[${session.id}] ${session.title}`,
    `  Command: ${commandLine(session)}`,
    `  Status: ${statusLine(session)}`,
    `  PID: ${session.pid}${timeout}`,
    `  Lines: ${session.lineCount}`,
    `  Workdir: ${session.workdir}`,
    `  Created: ${new Date(session.createdAt).toISOString()}`,
  ];
}

export function createPtyListTool(manager: PtyManager): HarnessTool {
  return {
    name: "pty_list",
    label: "pty_list",
    description: PTY_LIST_DESCRIPTION,
    isReadOnly: true,
    isDestructive: false,
    isOpenWorld: false,
    parameters: Type.Object({}),
    isConcurrencySafe: () => false,
    async execute(_args, ctx, signal) {
      signal.throwIfAborted();

      const sessions = manager.list(ctx.sessionId);
      const lines = ["<pty_list>"];

      if (sessions.length === 0) {
        lines.push("No active PTY sessions.");
      } else {
        for (const session of sessions) {
          lines.push(...formatSession(session));
        }
      }

      lines.push(`Total: ${sessions.length} session(s)`);
      lines.push("</pty_list>");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { total: sessions.length },
      };
    },
  };
}
