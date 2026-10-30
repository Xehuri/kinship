/**
 * pty_read —— 读取/检索 PTY 环形缓冲区。
 *
 * 纯读工具：通过 manager.read / manager.search 取数后格式化为编号行；检索前做
 * ReDoS 防护（长度上限 + 嵌套量词/重复交替拒绝 + 原生 RegExp 语法校验）。
 */
import { Type, type HarnessTool } from "@axeuh/loom-core";
import { PTY_READ_DESCRIPTION } from "../labels.js";
import type { PtyManager } from "../pty-manager.js";
import type { PtySessionInfo } from "../types.js";

const MAX_LINE_LENGTH = 2000;
const MAX_PATTERN_LENGTH = 500;
const DEFAULT_READ_OFFSET = 0;
const DEFAULT_READ_LIMIT = 500;

// 组内部自带量词、组本身又被量词修饰：(.*)* / (.+)+ / (.*?){2,}
const NESTED_QUANTIFIER =
  /\((?:\?:)?[^()]*(?:[*+]|\{\s*\d+\s*(?:,\s*\d*\s*)?\})[^()]*\)\s*(?:[*+]|\{\s*\d+\s*(?:,\s*\d*\s*)?\})/;
// 反复修饰的交替组：(a|b)+ / (|){3,} / (foo|bar){2,}
const REPEATED_ALTERNATION =
  /\([^()]*\|[^()]*\)\s*(?:[*+]|\{\s*(?:[2-9]\d*|1\d+)\s*(?:,\s*\d*\s*)?\})/;

const NOTIFY_ON_EXIT_REMINDER = [
  "<system_reminder>",
  "This session was started with notifyOnExit=true.",
  "Completion signal is the future <pty_exited> message, not repeated pty_read calls.",
  "If you only need to know whether the command finished, stop polling and wait for <pty_exited>.",
  "Do not use sleep plus pty_read loops to check completion.",
  "Use pty_read only when you need live output now, the user explicitly asks for logs, or the exit notification reports a non-zero status and you need to investigate.",
  "</system_reminder>",
].join("\n");

function buildTimeoutReminder(session: PtySessionInfo): string {
  return [
    "<system_reminder>",
    `This session was auto-killed after reaching timeoutSeconds=${session.timeoutSeconds ?? "unknown"}.`,
    "Use pty_read to inspect the final output or pty_list to review other sessions.",
    "</system_reminder>",
  ].join("\n");
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function asOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, name);
}

function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function asOptionalNonNegativeInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function assertSafePattern(pattern: string, ignoreCase: boolean): void {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `Potentially dangerous regex pattern rejected: length ${pattern.length} exceeds ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  if (NESTED_QUANTIFIER.test(pattern) || REPEATED_ALTERNATION.test(pattern)) {
    throw new Error(
      `Potentially dangerous regex pattern rejected: '${pattern}'. Please use a safer pattern.`,
    );
  }
  try {
    new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`Invalid regex pattern '${pattern}': ${message}`);
  }
}

function formatLine(line: string, lineNumber: number): string {
  const numbered = String(lineNumber).padStart(5, "0");
  const text =
    line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
  return `${numbered}| ${text}`;
}

function appendReminders(
  output: string,
  session: PtySessionInfo,
): string {
  const reminders: string[] = [];
  if (session.status === "running" && session.notifyOnExit) {
    reminders.push(NOTIFY_ON_EXIT_REMINDER);
  }
  if (session.timedOut) {
    reminders.push(buildTimeoutReminder(session));
  }
  return reminders.length === 0 ? output : `${output}\n\n${reminders.join("\n\n")}`;
}

function formatPlainRead(
  result: {
    id: string;
    status: string;
    lines: string[];
    totalLines: number;
    offset: number;
    hasMore: boolean;
  },
  session: PtySessionInfo,
): string {
  const lines = [
    `<pty_output id="${result.id}" status="${result.status}">`,
  ];

  if (result.lines.length === 0) {
    lines.push("(No output available - buffer is empty)");
  } else {
    for (const [index, line] of result.lines.entries()) {
      lines.push(formatLine(line, result.offset + index + 1));
    }
    lines.push("");
    lines.push(
      result.hasMore
        ? `(Buffer has more lines. Use offset=${result.offset + result.lines.length} to read beyond line ${result.offset + result.lines.length})`
        : `(End of buffer - total ${result.totalLines} lines)`,
    );
  }

  lines.push("</pty_output>");
  return appendReminders(lines.join("\n"), session);
}

function formatSearchRead(
  result: {
    id: string;
    status: string;
    matches: Array<{ lineNumber: number; text: string }>;
    totalMatches: number;
    offset: number;
    hasMore: boolean;
  },
  pattern: string,
  session: PtySessionInfo,
): string {
  const lines = [
    `<pty_output id="${result.id}" status="${result.status}" pattern="${pattern}">`,
  ];

  if (result.matches.length === 0) {
    lines.push(`No lines matched the pattern '${pattern}'.`);
  } else {
    for (const match of result.matches) {
      lines.push(formatLine(match.text, match.lineNumber));
    }
    lines.push("");
    lines.push(
      result.hasMore
        ? `(${result.matches.length} of ${result.totalMatches} matches shown. Use offset=${result.offset + result.matches.length} to see more.)`
        : `(${result.totalMatches} match${result.totalMatches === 1 ? "" : "es"} shown)`,
    );
  }

  lines.push("</pty_output>");
  return appendReminders(lines.join("\n"), session);
}

export function createPtyReadTool(manager: PtyManager): HarnessTool {
  return {
    name: "pty_read",
    label: "pty_read",
    description: PTY_READ_DESCRIPTION,
    isReadOnly: true,
    isDestructive: false,
    isOpenWorld: false,
    parameters: Type.Object({
      id: Type.String({ description: "The PTY session ID (e.g., pty_a1b2c3d4)" }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Line number to start reading from (0-based, defaults to 0). With a pattern, applies to filtered matches",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Number of lines to read (defaults to 500). With a pattern, applies to filtered matches",
        }),
      ),
      pattern: Type.Optional(
        Type.String({
          description:
            "Regex pattern to filter lines (max 500 chars; unsafe nested quantifiers are rejected)",
        }),
      ),
      ignoreCase: Type.Optional(
        Type.Boolean({
          description: "Case-insensitive pattern matching (default: false)",
        }),
      ),
    }),
    isConcurrencySafe: () => false,
    async execute(args, ctx, signal) {
      signal.throwIfAborted();

      const id = asString(args["id"], "id");
      const offset =
        asOptionalNonNegativeInteger(args["offset"], "offset") ?? DEFAULT_READ_OFFSET;
      const limit =
        asOptionalNonNegativeInteger(args["limit"], "limit") ?? DEFAULT_READ_LIMIT;
      const pattern = asOptionalString(args["pattern"], "pattern");
      const ignoreCase = asOptionalBoolean(args["ignoreCase"], "ignoreCase") ?? false;

      const session = manager.get(id, ctx.sessionId);
      if (!session) throw new Error(`PTY session not found: ${id}`);

      if (pattern !== undefined) {
        assertSafePattern(pattern, ignoreCase);
        const search = manager.search(
          id,
          ctx.sessionId,
          pattern,
          offset,
          limit,
          ignoreCase,
        );
        return {
          content: [
            { type: "text", text: formatSearchRead(search, pattern, session) },
          ],
        };
      }

      const read = manager.read(id, ctx.sessionId, offset, limit);
      return {
        content: [{ type: "text", text: formatPlainRead(read, session) }],
      };
    },
  };
}
