/**
 * T23 —— newline-delimited JSON-RPC 2.0 帧的解析/构造（纯函数，无 IO）。
 *
 * 解析严格：非法 JSON / 缺 jsonrpc:"2.0" / 结构不符 → McpProtocolError，
 * 错误文本携带原始帧前缀，方便 stderr/日志定位对端实现问题。
 */

import { McpProtocolError } from "./errors.js";
import type { McpContentBlock, McpToolCallResult, McpToolInfo, McpServerInfo } from "./types.js";

const PROTOCOL_LINE_LIMIT = 10 * 1024 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(raw: string): string {
  const clipped = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
  return clipped.replace(/\s+/g, " ");
}

/** 对端可能用数字或字符串 id；统一成可作 Map key 的类型。 */
export type RequestId = number | string;

export interface RpcResponseFrame {
  readonly id: RequestId;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** 把累计 buffer 切出完整行（以 \n 分割，容忍 \r\n）；返回剩余残行。 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const lines: string[] = [];
  for (const p of parts) {
    const line = p.endsWith("\r") ? p.slice(0, -1) : p;
    if (line.length > 0) lines.push(line);
  }
  return { lines, rest };
}

/** 一行 → JSON 对象（不做 RPC 语义检查）。 */
export function parseLine(line: string): Record<string, unknown> {
  if (line.length > PROTOCOL_LINE_LIMIT) {
    throw new McpProtocolError(`frame exceeds ${String(PROTOCOL_LINE_LIMIT)} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new McpProtocolError(`invalid JSON frame: ${msg} | line="${truncate(line)}"`);
  }
  if (!isRecord(raw)) {
    throw new McpProtocolError(`frame is not a JSON object | line="${truncate(line)}"`);
  }
  if (raw["jsonrpc"] !== "2.0") {
    throw new McpProtocolError(`missing jsonrpc:"2.0" | line="${truncate(line)}"`);
  }
  return raw;
}

function requestIdOf(raw: unknown, ctx: string): RequestId {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new McpProtocolError(`response id invalid (${ctx}) | id=${truncate(String(raw))}`);
}

/** 判定并解析响应帧；非响应（含通知）返回 undefined。 */
export function tryParseResponse(line: string): RpcResponseFrame | undefined {
  const obj = parseLine(line);
  if (!("id" in obj) || !("result" in obj || "error" in obj)) return undefined;
  const id = requestIdOf(obj["id"], "response");
  const err = obj["error"];
  if (err !== undefined) {
    if (!isRecord(err) || typeof err["code"] !== "number" || typeof err["message"] !== "string") {
      throw new McpProtocolError(`malformed error object | line="${truncate(line)}"`);
    }
    return { id, error: { code: err["code"], message: err["message"], data: err["data"] } };
  }
  return { id, result: obj["result"] };
}

/** 构造请求帧（单行 JSON，含尾随换行）。 */
export function encodeRequest(id: RequestId, method: string, params?: unknown): string {
  const obj: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) obj["params"] = params;
  return `${JSON.stringify(obj)}\n`;
}

/** 构造通知帧（无 id）。 */
export function encodeNotification(method: string, params?: unknown): string {
  const obj: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) obj["params"] = params;
  return `${JSON.stringify(obj)}\n`;
}

function strField(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new McpProtocolError(`${ctx}: field "${key}" is not a string`);
  }
  return v;
}

/** result.tools → McpToolInfo[]（形状校验，多余字段透传）。 */
export function decodeTools(result: unknown): McpToolInfo[] {
  if (!isRecord(result) || !Array.isArray(result["tools"])) {
    throw new McpProtocolError("tools/list result missing \"tools\" array");
  }
  return result["tools"].map((t, i) => {
    if (!isRecord(t)) {
      throw new McpProtocolError(`tools[${String(i)}] is not an object`);
    }
    const name = strField(t, "name", `tools[${String(i)}]`);
    const info: {
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: unknown;
    } = { name };
    if (typeof t["description"] === "string") info.description = t["description"];
    if ("inputSchema" in t) info.inputSchema = t["inputSchema"];
    if ("annotations" in t) info.annotations = t["annotations"];
    return info;
  });
}

/** result.content/isError → McpToolCallResult。 */
export function decodeToolCallResult(result: unknown): McpToolCallResult {
  if (!isRecord(result) || !Array.isArray(result["content"])) {
    throw new McpProtocolError("tools/call result missing \"content\" array");
  }
  const content: McpContentBlock[] = result["content"].map((c, i): McpContentBlock => {
    if (!isRecord(c)) {
      throw new McpProtocolError(`content[${String(i)}] is not an object`);
    }
    const type = strField(c, "type", `content[${String(i)}]`);
    if (type === "text") {
      return { type, text: strField(c, "text", `content[${String(i)}](text)`) };
    }
    return { ...c, type };
  });
  const isError = result["isError"];
  if (typeof isError === "boolean") {
    return { content, isError };
  }
  return { content };
}

/** initialize result → serverInfo（缺失时给占位名）。 */
export function decodeServerInfo(result: unknown): McpServerInfo {
  if (!isRecord(result)) {
    throw new McpProtocolError("initialize result is not an object");
  }
  const si = result["serverInfo"];
  if (isRecord(si) && typeof si["name"] === "string") {
    const name = si["name"];
    if (typeof si["version"] === "string") {
      return { name, version: si["version"] };
    }
    return { name };
  }
  return { name: "unknown" };
}
