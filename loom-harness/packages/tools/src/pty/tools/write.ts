/**
 * pty_write —— 向运行中的 PTY 会话发送输入。
 *
 * 支持常用转义序列（\n / \r / \t / \\ / \xNN / \uNNNN）；\e 不做解释，
 * 与原样输入保持一致。写操作对手柄失败直接抛错（由 Loom 映射成错误结果）。
 */
import { Type, type HarnessTool } from "@axeuh/loom-core";
import { PTY_WRITE_DESCRIPTION } from "../labels.js";
import type { PtyManager } from "../pty-manager.js";

const ETX = String.fromCharCode(3);
const EOT = String.fromCharCode(4);
const PREVIEW_LIMIT = 50;

function parseEscapeSequences(input: string): string {
  return input.replace(
    /\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[nrt\\])/g,
    (match, sequence: string) => {
      if (sequence.startsWith("x")) {
        return String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
      }
      if (sequence.startsWith("u")) {
        return String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
      }
      switch (sequence) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "\\":
          return "\\";
        default:
          return match;
      }
    },
  );
}

function buildPreview(data: string): string {
  const truncated =
    data.length > PREVIEW_LIMIT ? `${data.slice(0, PREVIEW_LIMIT)}...` : data;
  return truncated
    .replace(/\x03/g, "^C")
    .replace(/\x04/g, "^D")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export function createPtyWriteTool(manager: PtyManager): HarnessTool {
  return {
    name: "pty_write",
    label: "pty_write",
    description: PTY_WRITE_DESCRIPTION,
    isReadOnly: false,
    isDestructive: true,
    isOpenWorld: true,
    parameters: Type.Object({
      id: Type.String({ description: "The PTY session ID (e.g., pty_a1b2c3d4)" }),
      data: Type.String({
        description:
          "The input data to send to the PTY; supports \\n, \\r, \\t, \\\\, \\xNN and \\uNNNN escapes",
      }),
    }),
    isConcurrencySafe: () => false,
    async execute(args, ctx, signal) {
      signal.throwIfAborted();

      const id = asString(args["id"], "id");
      const data = asString(args["data"], "data");
      const parsed = parseEscapeSequences(data);

      manager.write(id, ctx.sessionId, parsed);

      const bytes = Buffer.byteLength(parsed, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Sent ${bytes} bytes to ${id}: "${buildPreview(parsed)}"`,
          },
        ],
        details: { id, bytes },
      };
    },
  };
}
