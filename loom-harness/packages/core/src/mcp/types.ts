/**
 * T23 MCP stdio 客户端 —— 协议数据形状。
 *
 * 线格式 = newline-delimited JSON-RPC 2.0（MCP stdio transport）：
 * 每帧一行 UTF-8 JSON，initialize → initialized 通知 → tools/list → tools/call。
 * 这里只定义客户端消费的最小子集，不引第三方 SDK。
 */

/** 启动一个 MCP 子进程所需的东西（config-driven，供 T39 从 loom.yaml 注入）。 */
export interface McpServerSpec {
  /** 可执行文件（如 "node" / "python3"）。 */
  readonly cmd: string;
  /** 参数列表。 */
  readonly args?: readonly string[];
  /** 工作目录；省略则继承父进程。 */
  readonly cwd?: string;
  /** 追加环境变量（合并到 process.env）。 */
  readonly env?: Readonly<Record<string, string>>;
}

/** tools/list 响应里的单个工具描述（inputSchema 原样透传，客户端不解释）。 */
export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: unknown;
}

/** tools/call 结果内容块（text 块有便捷读取；其余字段原样透传）。 */
export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/** tools/call 响应 result 部分。 */
export interface McpToolCallResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
}

/** initialize 响应里客户端需要记住的最小字段。 */
export interface McpServerInfo {
  readonly name: string;
  readonly version?: string;
}

/** stderr 透传回调（每整行一次）。 */
export type McpStderrSink = (line: string) => void;

/** 客户端构造选项。 */
export interface McpClientOptions {
  /** 单次请求超时（毫秒），默认 30_000。 */
  readonly requestTimeoutMs?: number;
  /** 子进程 stderr 行回调（日志透传，不做解析）。 */
  readonly onStderr?: McpStderrSink;
}
