/**
 * compact_context —— 主会话手动压缩工具（W57 P4）。
 *
 * 工具只负责启动 worker 并立即返回；当前 turn 在下一个 LLM 调用前由
 * AgentSession._prepareCompactionForLlm 挂起，压缩成功后再继续。
 * worker 从 live boundary 的 coveredCount 起算（不传 floor，与
 * POST /sessions/:id/compact 手动入口一致）；重试与 boundary 写入在 core worker/coordinator。
 */

import { Type } from "@axeuh/loom-core";
import type {
  AgentSession,
  HarnessTool,
  HookContext,
  ToolExecResult,
} from "@axeuh/loom-core";

export interface CompactContextToolOptions {
  readonly resolveSession: (sessionID: string) => AgentSession | undefined;
}

export function createCompactContextTool(
  opts: CompactContextToolOptions,
): HarnessTool {
  return {
    name: "compact_context",
    description:
      "Start compacting this session's older context. Returns immediately; the current turn " +
      "suspends at the next LLM call until compaction succeeds. Use only when there is no " +
      "higher-priority unfinished work.",
    parameters: Type.Object({}),
    isConcurrencySafe: () => false,
    async execute(
      _args: Record<string, unknown>,
      ctx: HookContext,
    ): Promise<ToolExecResult> {
      const session = opts.resolveSession(ctx.sessionId);
      if (session === undefined) {
        throw new Error(`compact_context: session ${ctx.sessionId} is not available`);
      }
      const started = session.startCompaction("tool");
      return {
        content: [
          {
            type: "text",
            text: `Compaction started (attempt ${started.attemptId}).`,
          },
        ],
      };
    },
  };
}
