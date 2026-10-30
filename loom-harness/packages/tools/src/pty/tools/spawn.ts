/**
 * pty_spawn —— 创建一个后台交互式 PTY 会话。
 *
 * 归属永远取 ctx.sessionId（绝不从工具参数接收 session id）；workdir 先按
 * defaultWorkdir 解析，再交给注入的 validateSpawn 做授权；环境变量统一经
 * scrubPtyEnv 净化后显式传给 manager（避免 manager 侧回退到不同的 env 策略）。
 */
import path from "node:path";
import { Type, type HarnessTool } from "@axeuh/loom-core";
import { scrubPtyEnv } from "../env-guard.js";
import { PTY_SPAWN_DESCRIPTION } from "../labels.js";
import type { PtyManager } from "../pty-manager.js";
import type { PtyToolOptions } from "../types.js";

const NOTIFY_ON_EXIT_INSTRUCTIONS = [
  "<system_reminder>",
  "Completion signal for this session is the future <pty_exited> message.",
  "If you only need to know whether the command finished, do not call pty_read; wait for <pty_exited>.",
  "Never use sleep plus pty_read loops to check completion.",
  "Call pty_read before exit only if you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.",
  "</system_reminder>",
].join("\n");

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function asOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, name);
}

function asStringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  return value.map((entry, index) => asString(entry, `${name}[${index}]`));
}

function asStringRecord(
  value: unknown,
  name: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object with string values`);
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = asString(entry, `${name}.${key}`);
  }
  return record;
}

function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function asOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolveWorkdir(raw: string | undefined, defaultWorkdir: string): string {
  if (raw === undefined || raw.length === 0) return defaultWorkdir;
  return path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(defaultWorkdir, raw);
}

/** scrubPtyEnv 的 ProcessEnv 值可能 undefined；manager 契约要求纯 string 记录。 */
function toSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function createPtySpawnTool(
  manager: PtyManager,
  opts: PtyToolOptions,
): HarnessTool {
  const notifyOnExitDefault = opts.notifyOnExitDefault ?? true;

  return {
    name: "pty_spawn",
    label: "pty_spawn",
    description: PTY_SPAWN_DESCRIPTION,
    isReadOnly: false,
    isDestructive: true,
    isOpenWorld: true,
    parameters: Type.Object({
      command: Type.String({ description: "The command/executable to run" }),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description: "Arguments to pass to the command",
        }),
      ),
      workdir: Type.Optional(
        Type.String({
          description:
            "Working directory for the PTY session; relative paths resolve against the workspace root",
        }),
      ),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Additional environment variables (credential-looking keys and LOOM_/AXEUH_/OPENCODE_/MI_/MOP_ prefixes are scrubbed)",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Human-readable title for the session" }),
      ),
      description: Type.String({
        description: "Clear, concise description of what this PTY session is for in 5-10 words",
      }),
      notifyOnExit: Type.Optional(
        Type.Boolean({
          description:
            "If true (default), sends a <pty_exited> message to the session when the process exits",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Optional per-session timeout in seconds; the PTY is killed automatically when it elapses",
        }),
      ),
    }),
    isConcurrencySafe: () => false,
    async execute(args, ctx, signal) {
      signal.throwIfAborted();

      const command = asString(args["command"], "command");
      const commandArgs = asStringArray(args["args"], "args");
      const workdir = resolveWorkdir(
        asOptionalString(args["workdir"], "workdir"),
        opts.defaultWorkdir,
      );

      await opts.validateSpawn?.(command, commandArgs, workdir);

      const env = toSpawnEnv(
        scrubPtyEnv(asStringRecord(args["env"], "env")),
      );
      const title = asOptionalString(args["title"], "title");
      const timeoutSeconds = asOptionalPositiveInteger(
        args["timeoutSeconds"],
        "timeoutSeconds",
      );

      const info = manager.spawn(ctx.sessionId, {
        command,
        args: commandArgs,
        workdir,
        env,
        description: asString(args["description"], "description"),
        notifyOnExit:
          asOptionalBoolean(args["notifyOnExit"], "notifyOnExit") ??
          notifyOnExitDefault,
        ...(title !== undefined ? { title } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      });

      const lines = [
        "<pty_spawned>",
        `ID: ${info.id}`,
        `Title: ${info.title}`,
        `Command: ${[info.command, ...info.args].join(" ")}`,
        `Workdir: ${info.workdir}`,
        `PID: ${info.pid}`,
        `Status: ${info.status}`,
        `NotifyOnExit: ${info.notifyOnExit}`,
        `TimeoutSeconds: ${info.timeoutSeconds ?? "none"}`,
        "</pty_spawned>",
      ];
      if (info.notifyOnExit) {
        lines.push("", NOTIFY_ON_EXIT_INSTRUCTIONS);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          id: info.id,
          pid: info.pid,
          status: info.status,
          notifyOnExit: info.notifyOnExit,
        },
      };
    },
  };
}
