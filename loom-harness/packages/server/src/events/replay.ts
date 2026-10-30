/**
 * T29 事件域 —— 当日 trace 记录 → 运行状态/告警帧草案（Last-Event-ID 重连补发用）。
 *
 * 纯函数、不碰 ProjectionState：补发流与 live 流的消息序号互不污染。
 * 语义 = **粗粒度重放当日运行轨迹**（run.status 逐 span + 终态）；消息级 live 增量
 * 不可从 trace 复原——前端靠 part id splice 幂等 + 历史分页（x-next-cursor，T27）兜底。
 * 权衡记入 T38 验收。
 */

import type { TraceRecord } from "@axeuh/loom-core";
import { sanitizeId } from "./types.js";
import type { FrameDraft } from "./project.js";

export function projectTraceRecord(rec: TraceRecord): FrameDraft[] {
  if (rec.kind === "nudge") {
    // nudge 行 schema（T21）不带会话归属：以 runId 作 sessionID 外发（hub 按会话补发时不取 nudge）。
    const sessionID = sanitizeId(rec.runId);
    return [
      {
        type: "watchdog.alarm",
        sessionID,
        properties: { sessionID, runID: sessionID, event: rec.event, at: rec.at },
      },
    ];
  }
  const sessionID = sanitizeId(rec.sessionId ?? rec.runId);
  if (rec.kind === "run_end") {
    return [
      {
        type: "run.status",
        sessionID,
        properties: {
          sessionID,
          runID: sanitizeId(rec.runId),
          status: rec.status,
          terminal: true,
          durationMs: rec.durationMs,
          tokens: { input: rec.totals.input, output: rec.totals.output, cache: { read: rec.totals.cacheRead } },
        },
      },
    ];
  }
  return [
    {
      type: "run.status",
      sessionID,
      properties: {
        sessionID,
        runID: sanitizeId(rec.runId),
        stage: rec.stage,
        spanID: sanitizeId(rec.spanId),
        durationMs: rec.durationMs,
        ...(rec.tokens !== undefined ? { tokens: rec.tokens } : {}),
        ...(rec.failure !== undefined ? { failure: rec.failure } : {}),
      },
    },
  ];
}
