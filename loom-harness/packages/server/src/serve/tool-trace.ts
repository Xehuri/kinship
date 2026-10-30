// T31 serve 装配 —— 工具 span 落 trace（工具面接线的观测侧，assembly-trace 同布局同纪律）。
//
// 口径：
//   - 每次被包装的工具调用完成后追加一行 kind:"span" stage:"tool" 到
//     `{stateRoot}/trace/{date}.jsonl`（T21 词表；GET /runs/:runID 的 trace join 消费面）。
//   - 副会话 run 的 runId 真源 = 账本 RunRow：boot 装配把 resolveBinding 组合成
//     「trace.sideAssemblySpan 登记 sessionId→run_id + 计时装配 + 落 assembly span，
//     内层再走 bindings.resolve」；assembly span 与 tool span 同 runId，
//     GET /runs/:id 的 traceSpansOf join 命中装配证据（attrs.injectedLines 硬证）。
//   - 主会话无 run 身份：与 assembly span 同款处置——每 span 生成观测用伪 runId
//     （`run_<hex16>`），sessionId 恒填（取证面不受影响）。
//   - 写失败只留 warn 日志，绝不把异常抛回工具执行路径（观测面反噬 = 缺陷）。

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  localDateKey,
  type HarnessTool,
  type HookContext,
  type RunSpan,
  type ToolExecResult,
} from "@axeuh/loom-core";
import type {
  RunLaunchContext,
  RunRow,
  SideBindingResolution,
} from "@axeuh/loom-core/run-engine";
import type {
  TaskEndEvent,
  TaskStartEvent,
} from "@axeuh/loom-core/subagent/task-tool";

type TraceLog = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => void;

/** sessionId → 账本 run 身份的登记表上限（FIFO 逐出；长跑服务不留无界 map）。 */
const MAX_TRACKED_SESSIONS = 64;

/** 一次工具调用的 span 现场（open 侧信息：close 时合成整行）。 */
interface SpanSite {
  readonly runId: string;
  readonly sessionId: string;
  readonly spanId: string;
  readonly toolName: string;
  readonly start: number;
}

export interface ServeToolTrace {
  /** 副会话 run 开跑登记（resolveBinding 组合点在会话创建前调用）。 */
  beginSideRun(row: Pick<RunRow, "run_id" | "session_id" | "workflow">): void;
  /**
   * 副会话装配组合（boot 的 resolveBinding 唯一入口）：登记身份 → 计时执行
   * resolve → 落 stage:"assembly" span（attrs.injectedLines = 注入清单非空行合计）
   * → 原样透传结果/异常。span 写失败 fail-soft，绝不反噬绑定解析路径。
   */
  sideAssemblySpan(
    ctx: RunLaunchContext,
    resolve: () => Promise<SideBindingResolution>,
  ): Promise<SideBindingResolution>;
  /** 包装一组工具：execute 前后计时 + 完成后落 tool span 行。 */
  wrapAll(tools: readonly HarnessTool[]): readonly HarnessTool[];
  /**
   * task 工具派发：子 session 造好瞬间登记父现场（childSessionFactory 同步调用）。
   * agentId → {父 sessionId、账本 runId（查不到=伪 runId）、派发起点}；FIFO 有界防泄漏。
   */
  beginSubagent(agentId: string, parentSessionId: string): void;
  /** 派发开始 span（attrs.phase="start"）；父现场取自 beginSubagent 登记，缺省 fail-soft 兜底。 */
  subagentStart(e: TaskStartEvent): void;
  /** 派发结束 span（attrs.phase="end" + reason/turns/summaryLen 取证）并注销登记。 */
  subagentEnd(e: TaskEndEvent): void;
}

export function createServeToolTrace(opts: {
  readonly stateRoot: string;
  readonly log?: TraceLog;
  readonly now?: () => number;
}): ServeToolTrace {
  const now = opts.now ?? Date.now;
  const dirPath = join(opts.stateRoot, "trace");
  /** sessionId → {runId, workflow}（Map 迭代序 = 插入序，逐出取首位）。 */
  const sideRuns = new Map<string, { runId: string; workflow: string }>();

  function beginSideRun(row: Pick<RunRow, "run_id" | "session_id" | "workflow">): void {
    if (sideRuns.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sideRuns.keys().next();
      if (!oldest.done) sideRuns.delete(oldest.value);
    }
    sideRuns.set(row.session_id, { runId: row.run_id, workflow: row.workflow });
  }

  /** span 行统一落盘（追加式 JSONL；写失败 fail-soft 留 warn 即止）。 */
  function appendSpan(span: RunSpan, at: number, what: string): void {
    try {
      mkdirSync(dirPath, { recursive: true });
      appendFileSync(join(dirPath, `${localDateKey(at)}.jsonl`), `${JSON.stringify(span)}\n`, "utf8");
    } catch (err) {
      opts.log?.("warn", `loom ${what} write failed`, {
        path: join(dirPath, `${localDateKey(at)}.jsonl`),
        stage: span.stage,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 副会话装配 span：runId=账本行（GET /runs/:id trace join 键）；error 形态带 failure 留证。 */
  function emitAssembly(ctx: RunLaunchContext, resolution: SideBindingResolution, start: number): void {
    const end = now();
    const failed = "error" in resolution;
    const sources = failed ? [] : resolution.memorySources;
    const injectedLines = sources.reduce((n, s) => n + textLineCount(s.content), 0);
    const span: RunSpan = {
      kind: "span",
      runId: ctx.row.run_id,
      sessionId: ctx.row.session_id,
      spanId: `spn_${randomBytes(8).toString("hex")}`,
      stage: "assembly",
      name: "assembly[0]",
      index: 0,
      start,
      end,
      durationMs: end - start,
      assemblyRowCount: sources.length,
      ...(failed ? { failure: { reason: resolution.error } } : {}),
      attrs: {
        result: failed ? "error" : "ok",
        workflow: ctx.row.workflow,
        ...(ctx.agent === undefined ? {} : { agent: ctx.agent }),
        injectedLines,
        ...(failed ? { error: resolution.error } : {}),
      },
    };
    appendSpan(span, start, "side assembly span");
  }

  async function sideAssemblySpan(
    ctx: RunLaunchContext,
    resolve: () => Promise<SideBindingResolution>,
  ): Promise<SideBindingResolution> {
    beginSideRun(ctx.row);
    const start = now();
    try {
      const resolution = await resolve();
      emitAssembly(ctx, resolution, start);
      return resolution;
    } catch (err) {
      // 端口抛错 = 引擎崩溃形状；观测面如实落一行 error 再原样上抛。
      emitAssembly(ctx, { error: err instanceof Error ? err.message : String(err) }, start);
      throw err;
    }
  }

  /** 合成并落一行 tool span；任何失败 fail-soft（留痕即可，不反噬执行路径）。 */
  function emit(site: SpanSite, end: number, result: "ok" | "error", detail: Record<string, string | boolean>): void {
    const span: RunSpan = {
      kind: "span",
      runId: site.runId,
      sessionId: site.sessionId,
      spanId: site.spanId,
      stage: "tool",
      name: site.toolName,
      start: site.start,
      end,
      durationMs: end - site.start,
      ...(result === "error" ? { failure: { reason: String(detail["error"] ?? "tool error") } } : {}),
      attrs: { result, ...detail },
    };
    appendSpan(span, site.start, "tool span");
  }

  function wrapTool(tool: HarnessTool): HarnessTool {
    return {
      ...tool,
      async execute(args: Record<string, unknown>, ctx: HookContext, signal: AbortSignal): Promise<ToolExecResult> {
        // run 身份：副会话查账本登记（resolveBinding 先于任何工具调用）；主会话 = 伪 runId（观测面）。
        const registered = sideRuns.get(ctx.sessionId);
        const site: SpanSite = {
          runId: registered?.runId ?? `run_${randomBytes(8).toString("hex")}`,
          sessionId: ctx.sessionId,
          spanId: `spn_${randomBytes(8).toString("hex")}`,
          toolName: tool.name,
          start: now(),
        };
        const workflowAttr: Record<string, string> = registered ? { workflow: registered.workflow } : {};
        try {
          const result = await tool.execute(args, ctx, signal);
          const isError = result.isError === true;
          emit(site, now(), isError ? "error" : "ok", {
            ...workflowAttr,
            ...(isError ? { error: firstTextOf(result) } : {}),
          });
          return result;
        } catch (err) {
          emit(site, now(), "error", {
            ...workflowAttr,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    };
  }

  // ───────────────────── subagent span 投影（task 工具派发的主/子桥接取证面） ─────────────────────

  /** agentId → 父现场。登记在 childSessionFactory（同步）、消费在 start/end 回调（同源同步链）；
   *  end 缺席的理论 orphan 由 FIFO 有界逐出兜底，不留无界 map。 */
  const subagentSites = new Map<string, SpanSite>();

  function rememberSubagent(agentId: string, parentSessionId: string): void {
    if (subagentSites.size >= MAX_TRACKED_SESSIONS) {
      const oldest = subagentSites.keys().next();
      if (!oldest.done) subagentSites.delete(oldest.value);
    }
    const registered = sideRuns.get(parentSessionId);
    subagentSites.set(agentId, {
      runId: registered?.runId ?? `run_${randomBytes(8).toString("hex")}`,
      sessionId: parentSessionId,
      spanId: `spn_${randomBytes(8).toString("hex")}`,
      toolName: "task.subagent",
      start: now(),
    });
  }

  /** subagent span 统一落盘：stage 沿用词表 "tool"（不动 T21 七阶段枚举），name 区分粒度。 */
  function emitSubagent(
    site: SpanSite,
    end: number,
    attrs: Record<string, string | number>,
    failureReason?: string,
  ): void {
    const span: RunSpan = {
      kind: "span",
      runId: site.runId,
      sessionId: site.sessionId,
      spanId: `spn_${randomBytes(8).toString("hex")}`,
      stage: "tool",
      name: site.toolName,
      start: site.start,
      end,
      durationMs: end - site.start,
      ...(failureReason === undefined ? {} : { failure: { reason: failureReason } }),
      attrs,
    };
    appendSpan(span, site.start, "subagent span");
  }

  function subagentStart(e: TaskStartEvent): void {
    const site = subagentSites.get(e.agentId);
    if (site === undefined) return; // 父现场缺失 = 理论不可达（factory 必先于回调），fail-soft 静默弃帧
    emitSubagent(site, now(), {
      phase: "start",
      agentId: e.agentId,
      agentType: e.agentType,
      depth: e.depth,
      task: truncate(e.task),
    });
  }

  function subagentEnd(e: TaskEndEvent): void {
    const at = now();
    const site: SpanSite = subagentSites.get(e.agentId) ?? {
      runId: `run_${randomBytes(8).toString("hex")}`,
      sessionId: e.agentId,
      spanId: `spn_${randomBytes(8).toString("hex")}`,
      toolName: "task.subagent",
      start: at,
    };
    const summaryText = e.summaryText ?? "";
    emitSubagent(site, at, {
      phase: "end",
      result: e.reason === "error" ? "error" : "ok",
      agentId: e.agentId,
      agentType: e.agentType,
      depth: e.depth,
      reason: e.reason,
      turns: e.turns,
      task: truncate(e.task),
      summaryLen: summaryText.length,
    }, e.reason === "error" ? (summaryText || "sub-agent error") : undefined);
    subagentSites.delete(e.agentId);
  }

  return {
    beginSideRun,
    sideAssemblySpan,
    wrapAll: (tools) => tools.map(wrapTool),
    beginSubagent: rememberSubagent,
    subagentStart,
    subagentEnd,
  };
}

/** trace attrs 单值防巨型行截断（与 firstTextOf 同口径 200 字符）。 */
function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 注入文本的非空行数（assembly span attrs.injectedLines 的统一口径，主/副会话共用）。 */
export function textLineCount(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") n += 1;
  }
  return n;
}

/** tool 错误结果的模型可见文本（span failure 取证，最长 200 字符防巨型行）。 */
function firstTextOf(result: ToolExecResult): string {
  const text = result.content.find((c) => c.type === "text");
  const raw = text && text.type === "text" ? text.text : "(no text)";
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}
