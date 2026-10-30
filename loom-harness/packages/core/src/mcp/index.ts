/**
 * T23 MCP stdio 客户端 —— 包内 barrel。
 * 供 T39 shadow run 以 config-driven spec 拉起 loom-local ai-mcp。
 */
export { McpClient } from "./client.js";
export * from "./errors.js";
export type {
  McpClientOptions,
  McpContentBlock,
  McpServerInfo,
  McpServerSpec,
  McpStderrSink,
  McpToolCallResult,
  McpToolInfo,
} from "./types.js";
