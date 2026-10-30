/**
 * T23 MCP stdio 客户端 —— 类型化错误族。
 *
 * 合约：客户端所有失败路径都抛出 McpError 子类，调用方用 instanceof 区分，
 * 绝不抛裸字符串 / 裸 Error。reason 判别符供日志与上层（T39 shadow）分类统计。
 */

/** 错误大类判别符（与子类一一对应）。 */
export type McpErrorReason = "spawn" | "timeout" | "exited" | "rpc" | "protocol" | "closed";

/** 基类：所有 MCP 客户端错误。 */
export class McpError extends Error {
  readonly reason: McpErrorReason;

  constructor(message: string, reason: McpErrorReason) {
    super(message);
    this.name = "McpError";
    this.reason = reason;
  }
}

/** spawn 失败（命令不存在 / 权限问题 / OS 拒绝）。 */
export class McpSpawnError extends McpError {
  readonly cmd: string;
  readonly causeMessage: string;

  constructor(cmd: string, cause: Error) {
    super(`failed to spawn MCP server "${cmd}": ${cause.message}`, "spawn");
    this.name = "McpSpawnError";
    this.cmd = cmd;
    this.causeMessage = cause.message;
  }
}

/** 请求超时（服务端子进程可能仍活着，客户端可继续使用）。 */
export class McpTimeoutError extends McpError {
  readonly method: string;
  readonly requestId: number | string;
  readonly timeoutMs: number;

  constructor(method: string, requestId: number | string, timeoutMs: number) {
    super(`MCP request "${method}" (id=${String(requestId)}) timed out after ${String(timeoutMs)}ms`, "timeout");
    this.name = "McpTimeoutError";
    this.method = method;
    this.requestId = requestId;
    this.timeoutMs = timeoutMs;
  }
}

/** 子进程意外退出（含 handshake 前退出）；pending 请求全部以此失败。 */
export class McpProcessExitedError extends McpError {
  readonly exitCode: number | null;
  readonly signal: string | null;

  constructor(exitCode: number | null, signal: string | null) {
    super(
      `MCP server process exited (code=${String(exitCode)}, signal=${String(signal)})`,
      "exited",
    );
    this.name = "McpProcessExitedError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/** 对端返回 JSON-RPC error 响应（协议层错误，非工具内 isError 错误）。 */
export class McpRpcError extends McpError {
  readonly requestId: number | string;
  readonly method: string;
  readonly rpcCode: number;
  readonly rpcMessage: string;
  readonly data: unknown;

  constructor(
    method: string,
    requestId: number | string,
    rpcCode: number,
    rpcMessage: string,
    data: unknown,
  ) {
    super(`MCP rpc error on "${method}" (id=${String(requestId)}): [${String(rpcCode)}] ${rpcMessage}`, "rpc");
    this.name = "McpRpcError";
    this.method = method;
    this.requestId = requestId;
    this.rpcCode = rpcCode;
    this.rpcMessage = rpcMessage;
    this.data = data;
  }
}

/** 线格式 / 帧内容不合法（非法 JSON、缺 jsonrpc 版本、结构不符）。 */
export class McpProtocolError extends McpError {
  readonly detail: string;

  constructor(detail: string) {
    super(`MCP protocol violation: ${detail}`, "protocol");
    this.name = "McpProtocolError";
    this.detail = detail;
  }
}

/** 客户端已 close（或正在 close）后继续使用。 */
export class McpClosedError extends McpError {
  constructor(context: string) {
    super(`MCP client is closed (${context})`, "closed");
    this.name = "McpClosedError";
  }
}
