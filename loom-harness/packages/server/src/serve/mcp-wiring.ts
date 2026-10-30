// W5-B serve 装配 —— 外部 MCP stdio server 接线（T23 client 的调用方，client 本体不动）。
//
// 映射合约：每个 server 的每个 tools/list 工具做成 HarnessTool 进 D7 单缝共用工具面，
// 命名 `mcp_<server>_<tool>`（server 名已被 config schema 限定 [a-z][a-z0-9_-]{0,31}）。
//   - execute：模型 args（JSON）原样透传 callTool；结果 content 块回灌 ToolExecResult
//     （text 块直取，其余块转紧凑描述符兜文本；isError 透传，语义同 HarnessTool 合约）。
//   - inputSchema 直通：MCP 声明是标准 JSON Schema，Type.Unsafe 原样进 parameters，
//     pi-ai validateToolCall 按 schema 校验模型入参——装配层不猜参数形状。
//   - spawn/握手/listTools 失败 = 响亮 warn + 该 server 工具面缺席（degrade，绝不 crash boot）；
//     server 起后子进程死亡由 client 的 exit 路径把在途调用转异常 → kernel isError。
//   - closeAll 挂 boot 既有停机序列（SIGTERM 排水内 SIGTERM/SIGKILL 收尸，不留孤儿）。

import {
  Type,
  type HarnessTool,
  type TSchema,
  type ToolExecResult,
} from "@axeuh/loom-core";
import {
  McpClient,
  type McpContentBlock,
  type McpToolCallResult,
  type McpToolInfo,
} from "@axeuh/loom-core/mcp";

import type { McpServerEntryConfig } from "../config/loom-config.js";

type WiringLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;

/** 单个 server 的装配结局（/config 视图与测试断言的观测形状）。 */
export interface McpServerWiringStatus {
  readonly name: string;
  readonly cmd: string;
  /** 握手 + listTools 成功 = true（工具已映射）；false = 该 server 工具面缺席。 */
  readonly ok: boolean;
  readonly toolNames: readonly string[];
  /** ok=false 时的响亮原因（已同时 warn 落日志）。 */
  readonly error?: string;
  /** serverInfo.name（握手成功时）。 */
  readonly serverInfoName?: string;
}

export interface ServeMcpWiring {
  /** 映射进工具面的全部工具（含重名/超长被跳过的过滤结果）。 */
  readonly tools: readonly HarnessTool[];
  readonly statuses: readonly McpServerWiringStatus[];
  /** 幂等关停全部子进程（boot shutdown 序列消费）。 */
  closeAll(): Promise<void>;
}

export interface ServeMcpWiringOptions {
  readonly servers: readonly McpServerEntryConfig[];
  readonly log?: WiringLog;
  /**
   * 已被基础工具面占用的名字（重名 = 装配层跳过映射 + warn，不拖垮 server）。
   * 缺省视为空集。
   */
  readonly reservedToolNames?: readonly string[];
}

/** provider 工具名长度预算（各家普遍 ≤64，Anthropic 字符集口径）；超长跳过并 warn。 */
const MAPPED_NAME_BUDGET = 64;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * MCP inputSchema → TypeBox 参数面。标准 JSON Schema 直通（Type.Unsafe 不改字节，
 * validateToolCall 按原 schema 校验）；非 object 形/缺失 → 空对象 schema 兜底 + 由调用方 warn。
 */
function toParamsSchema(inputSchema: unknown): { schema: TSchema; fallbackUsed: boolean } {
  if (isRecord(inputSchema) && inputSchema["type"] === "object") {
    return { schema: Type.Unsafe<TSchema>(inputSchema), fallbackUsed: false };
  }
  return {
    schema: Type.Unsafe<TSchema>({ type: "object", properties: {} }),
    fallbackUsed: true,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 非 text 内容块 → 紧凑描述符文本（避免把整块 JSON 倒进模型上下文）。 */
export function describeMcpBlock(block: McpContentBlock): string {
  const type = nonEmptyString(block.type);
  if (type === undefined) return "[unknown block]";

  switch (type) {
    case "image": {
      const mime = nonEmptyString(block["mimeType"]);
      return mime === undefined ? "[image]" : `[image: ${mime}]`;
    }
    case "audio": {
      const mime = nonEmptyString(block["mimeType"]);
      return mime === undefined ? "[audio]" : `[audio: ${mime}]`;
    }
    case "resource": {
      const raw = block["resource"];
      const uri =
        nonEmptyString(block["uri"]) ??
        (isRecord(raw) ? nonEmptyString(raw["uri"]) : undefined);
      return uri === undefined ? "[resource]" : `[resource: ${uri}]`;
    }
    case "resource_link": {
      const uri = nonEmptyString(block["uri"]);
      return uri === undefined ? "[resource_link]" : `[resource_link: ${uri}]`;
    }
    default:
      return `[${type} block]`;
  }
}

/** MCP tools/call 结果 → ToolExecResult（text 块直取，其余块转描述符兜文本）。 */
export function mcpResultToToolResult(result: McpToolCallResult): ToolExecResult {
  const content = result.content.map((block) =>
    block.type === "text" && typeof block.text === "string"
      ? { type: "text" as const, text: block.text }
      : { type: "text" as const, text: describeMcpBlock(block) },
  );
  const out: ToolExecResult = {
    content: content.length > 0 ? content : [{ type: "text", text: "(mcp empty result)" }],
  };
  if (result.isError === true) out.isError = true;
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 单 server 映射出的工具名（纯函数，测试可直接钉命名规则）。 */
export function mcpMappedToolName(serverName: string, tool: string): string {
  return `mcp_${serverName}_${tool}`;
}

export async function createServeMcpWiring(
  opts: ServeMcpWiringOptions,
): Promise<ServeMcpWiring> {
  const log = opts.log ?? (() => {});
  const reserved = new Set(opts.reservedToolNames ?? []);
  const taken = new Set<string>();
  const tools: HarnessTool[] = [];
  const statuses: McpServerWiringStatus[] = [];
  const clients: McpClient[] = [];

  for (const server of opts.servers) {
    let client: McpClient;
    try {
      client = await McpClient.start(
        {
          cmd: server.cmd,
          args: server.args,
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
          ...(server.env === undefined ? {} : { env: server.env }),
        },
        {
          ...(server.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: server.requestTimeoutMs }),
          onStderr: (line) => log("debug", "loom mcp stderr", { server: server.name, line }),
        },
      );
    } catch (err) {
      log("warn", "loom mcp server start failed (degrade: tools absent)", {
        server: server.name,
        cmd: server.cmd,
        error: errText(err),
      });
      statuses.push({
        name: server.name,
        cmd: server.cmd,
        ok: false,
        toolNames: [],
        error: errText(err),
      });
      continue;
    }

    let listed: McpToolInfo[];
    try {
      listed = await client.listTools();
    } catch (err) {
      await client.close().catch(() => {});
      log("warn", "loom mcp tools/list failed (degrade: tools absent)", {
        server: server.name,
        cmd: server.cmd,
        error: errText(err),
      });
      statuses.push({
        name: server.name,
        cmd: server.cmd,
        ok: false,
        toolNames: [],
        error: `tools/list: ${errText(err)}`,
      });
      continue;
    }

    clients.push(client);
    const mappedNames: string[] = [];
    for (const tool of listed) {
      const mapped = mcpMappedToolName(server.name, tool.name);
      if (mapped.length > MAPPED_NAME_BUDGET) {
        log("warn", "loom mcp tool skipped (name over budget)", {
          server: server.name, tool: tool.name, mapped, budget: MAPPED_NAME_BUDGET,
        });
        continue;
      }
      if (reserved.has(mapped) || taken.has(mapped)) {
        log("warn", "loom mcp tool skipped (duplicate tool name)", {
          server: server.name, tool: tool.name, mapped,
        });
        continue;
      }
      const { schema, fallbackUsed } = toParamsSchema(tool.inputSchema);
      if (fallbackUsed) {
        log("warn", "loom mcp tool inputSchema not object-shaped (empty schema fallback)", {
          server: server.name, tool: tool.name,
        });
      }
      taken.add(mapped);
      mappedNames.push(mapped);
      tools.push(
        makeMappedTool({
          mappedName: mapped,
          serverName: server.name,
          remoteTool: tool.name,
          description: tool.description,
          schema,
          call: (args) =>
            client.callTool(tool.name, args).catch((err: unknown) => {
              // 合约：抛错上抛（kernel 转 isError），但错误消息带 server 现场便于取证。
              throw new Error(`mcp ${server.name}/${tool.name} call failed: ${errText(err)}`);
            }),
        }),
      );
    }
    log("info", "loom mcp server wired", {
      server: server.name,
      serverInfo: client.serverInfo.name,
      pid: client.pid ?? null,
      tools: mappedNames,
    });
    statuses.push({
      name: server.name,
      cmd: server.cmd,
      ok: true,
      toolNames: mappedNames,
      serverInfoName: client.serverInfo.name,
    });
  }

  return {
    tools,
    statuses,
    async closeAll(): Promise<void> {
      await Promise.all(
        clients.map(async (c) => {
          try {
            await c.close();
          } catch (err) {
            // 关停失败只响亮留痕：停机路径不吃异常（5s 保险丝兜底）。
            log("warn", "loom mcp close failed", { error: errText(err) });
          }
        }),
      );
    },
  };
}

/** 单工具映射体（闭包持 client 调用通路；execute 的 JSON args 原样进 callTool）。 */
function makeMappedTool(spec: {
  readonly mappedName: string;
  readonly serverName: string;
  readonly remoteTool: string;
  readonly description: string | undefined;
  readonly schema: TSchema;
  readonly call: (args: Record<string, unknown>) => Promise<McpToolCallResult>;
}): HarnessTool {
  return {
    name: spec.mappedName,
    description:
      spec.description !== undefined && spec.description.length > 0
        ? `[mcp:${spec.serverName}] ${spec.description}`
        : `[mcp:${spec.serverName}] Remote MCP tool ${spec.remoteTool}.`,
    parameters: spec.schema,
    // 外部 server 副作用不可知——保守顺序化，与 skill/bash 同纪律。
    isConcurrencySafe: () => false,
    async execute(args, _ctx, signal): Promise<ToolExecResult> {
      // client 无中途取消通道（T23 冻结）：入口处尊重已置位的 abort，在途请求由
      // client 超时/进程退出兜底——绝不假装能掐断已发出的 JSON-RPC。
      if (signal.aborted) {
        throw new Error(`mcp ${spec.serverName}/${spec.remoteTool} aborted before call`);
      }
      const record: Record<string, unknown> = isRecord(args) ? { ...args } : {};
      return mcpResultToToolResult(await spec.call(record));
    },
  };
}
