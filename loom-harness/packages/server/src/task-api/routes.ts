/**
 * T28 任务/运行域 —— HTTP 路由注册（照 T26/T27 的 register* 模式）。
 *
 * 鉴权由 Router 前置（无未鉴权路径，见 ../http/router.ts）；本模块只做边界解析、
 * 命令映射（ControlPlane / RunEngine / PauseSwitchSource）与响应投影。
 *
 * 端点（任务域，docs/02 §T28）：
 *   POST /runs                —— 手动 dispatch（经 plane.spawnSide，actor 落账）
 *   GET  /runs                —— run 列表（?workflow= 过滤）
 *   GET  /runs/:runID         —— run 详情（ledger + trace join + attempt 链）
 *   POST /runs/:runID/cancel  —— 取消（plane.cancel）
 *   POST /runs/:runID/rerun   —— 重派（plane.rerun：新 run、parent_run=源、attempt+1）
 *   GET  /pause               —— 暂停开关只读（写=配置文件，T20；API 无写端点）
 *
 * 响应统一含 run_id / attempt / trigger / status（验收冻结）。
 * DispatchResult 消费先 `kind` 收窄（launched 有 completion，paused 有 reason）。
 */

import { HttpError, readJsonBody, sendJson } from "../http/index.js";
import type { Router } from "../http/router.js";
import type { HandlerCtx } from "../http/types.js";
import type { ServerResponse } from "node:http";
import type { DispatchResult, RunRecord } from "@axeuh/loom-core/run-engine";
import { paramRunID, asObject, parseActor, parseTrigger, requireString, optionalString, toHttpError } from "./helpers.js";
import { detailOf, pauseStateOf, toRunView, taskDetailOf } from "./views.js";
import { mergeTaskViews, taskDetailFromLedger } from "./ledger-sub-views.js";
import type { TaskApiDeps } from "./types.js";

/** launched=202 已开火；paused=409 准入被拒（账本零痕迹，D31）。响应含四必含字段。 */
function respondLaunch(res: ServerResponse, outcome: DispatchResult): void {
  if (outcome.kind === "launched") {
    // completion 恒 resolve（T12 契约），不 await：开火受理即回 202，终态走 GET。
    void outcome.completion;
    sendJson(res, 202, {
      run_id: outcome.row.run_id,
      attempt: outcome.row.attempt,
      trigger: outcome.row.trigger,
      status: "running",
      parent_run: outcome.row.parent_run,
      session_id: outcome.row.session_id,
    });
    return;
  }
  sendJson(res, 409, {
    run_id: outcome.row.run_id,
    attempt: outcome.row.attempt,
    trigger: outcome.row.trigger,
    status: "paused",
    reason: outcome.reason,
  });
}

/** cancel/rerun 端点共用的错误包装：内核类型化错误 → 稳定 HTTP 码。 */
async function guard(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw toHttpError(err);
  }
}

/** 把任务域全部端点注册到 Router。 */
export function registerTaskRoutes(router: Router, deps: TaskApiDeps): void {
  const { engine, plane, pauseSwitches, ledgerRows } = deps;
  const traceStateRoot = deps.trace?.stateRoot;

  router.add("POST", "/runs", async (req, res) => {
    await guard(async () => {
      const body = asObject(await readJsonBody(req));
      const workflow = requireString(body, "workflow");
      const prompt = requireString(body, "prompt");
      const actor = parseActor(body);
      const trigger = parseTrigger(body);
      const runId = optionalString(body, "runId");
      const sessionId = optionalString(body, "sessionId");
      const agent = optionalString(body, "agent");
      // W12 归属旁路：发起主会话 sid（可选，仅派发时刻登记，不进账本行）。
      const parentSessionId = optionalString(body, "parentSessionId");
      const outcome = await plane.spawnSide({
        workflow,
        prompt,
        actor,
        trigger,
        ...(agent === undefined ? {} : { agent }),
        ...(runId === undefined ? {} : { runId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      if (outcome.kind === "launched" && parentSessionId !== undefined) {
        deps.noteRunParent?.(outcome.row.run_id, parentSessionId);
      }
      respondLaunch(res, outcome);
    });
  });

  router.add("GET", "/runs", (_req, res, ctx: HandlerCtx) => {
    const workflow = ctx.url.searchParams.get("workflow");
    const recs: RunRecord[] = engine.listRuns(workflow ?? undefined);
    const runs = recs.map(toRunView);
    sendJson(res, 200, { runs, count: runs.length });
  });

  router.add("GET", "/runs/:runID", (_req, res, ctx) => {
    const runId = paramRunID(ctx.params);
    const detail = detailOf(runId, (id) => engine.get(id), {
      rows: ledgerRows,
      ...(traceStateRoot === undefined ? {} : { traceStateRoot }),
    });
    if (detail === null) {
      throw new HttpError(404, "run_not_found", `no run ${runId} in engine registry or ledger`);
    }
    sendJson(res, 200, detail);
  });

  router.add("POST", "/runs/:runID/cancel", async (req, res, ctx) => {
    const runId = paramRunID(ctx.params);
    await guard(async () => {
      const body = asObject((await readJsonBody(req)) ?? {});
      const actor = parseActor(body);
      const reason = optionalString(body, "reason");
      const outcome = plane.cancel({
        runId,
        actor,
        ...(reason === undefined ? {} : { reason }),
      });
      const rec = engine.get(runId);
      sendJson(res, 200, {
        run_id: outcome.run_id,
        actor: outcome.actor,
        accepted: outcome.accepted,
        reason: outcome.reason,
        at: outcome.at,
        attempt: rec?.row.attempt ?? null,
        trigger: rec?.row.trigger ?? null,
        status: rec?.state ?? "unknown",
      });
    });
  });

  router.add("POST", "/runs/:runID/rerun", async (req, res, ctx) => {
    const parentRunId = paramRunID(ctx.params);
    await guard(async () => {
      const body = asObject(await readJsonBody(req));
      const prompt = requireString(body, "prompt");
      const actor = parseActor(body);
      const triggerRaw = body["trigger"];
      const trigger = triggerRaw === undefined || triggerRaw === null ? undefined : parseTrigger(body);
      const runId = optionalString(body, "runId");
      const sessionId = optionalString(body, "sessionId");
      const agent = optionalString(body, "agent");
      const outcome = await plane.rerun({
        parentRunId,
        prompt,
        actor,
        ...(trigger === undefined ? {} : { trigger }),
        ...(agent === undefined ? {} : { agent }),
        ...(runId === undefined ? {} : { runId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      respondLaunch(res, outcome);
    });
  });

  router.add("GET", "/pause", (_req, res) => {
    sendJson(res, 200, pauseStateOf(pauseSwitches()));
  });

  // ── W9 切片 3：后台任务三面（/tasks 数据源未接 = 404 not_wired，旧调用面零扰动） ──
  // 契约纯度（定稿点名）：只投 kind:"sub" 的 durable 后台册——/runs 列表/详情与本页互不渗入。
  // W23-C：list/单查 = 内核在飞册 ∪ 账本 kind:"sub" 历史（run_id 并集、live 优先、
  // 不可导出字段 null 如实）——子任务账重启不丢（合流器见 ledger-sub-views.ts）。
  const tasksSrc = deps.tasks;

  router.add("GET", "/tasks", (_req, res) => {
    if (tasksSrc === undefined) {
      throw new HttpError(404, "tasks_not_wired", "task ledger surface not wired in this assembly");
    }
    const tasks = mergeTaskViews(tasksSrc.list(), ledgerRows());
    sendJson(res, 200, { tasks, count: tasks.length });
  });

  router.add("GET", "/tasks/:taskID", (_req, res, ctx) => {
    if (tasksSrc === undefined) {
      throw new HttpError(404, "tasks_not_wired", "task ledger surface not wired in this assembly");
    }
    const taskId = ctx.params["taskID"] ?? "";
    const detail = taskDetailOf(taskId, tasksSrc, {
      rows: ledgerRows,
      ...(traceStateRoot === undefined ? {} : { traceStateRoot }),
    });
    if (detail !== null) {
      sendJson(res, 200, detail);
      return;
    }
    // W23-C 账本-only 回落（重启后内核册空，durable 盖棺行仍可查）。
    const fromLedger = taskDetailFromLedger(taskId, ledgerRows(), traceStateRoot);
    if (fromLedger === null) {
      throw new HttpError(404, "task_not_found", `no task ${taskId} in kernel task ledger`);
    }
    sendJson(res, 200, fromLedger);
  });

  router.add("POST", "/tasks/:taskID/cancel", async (req, res, ctx) => {
    if (tasksSrc === undefined) {
      throw new HttpError(404, "tasks_not_wired", "task ledger surface not wired in this assembly");
    }
    const taskId = ctx.params["taskID"] ?? "";
    await guard(async () => {
      const body = asObject((await readJsonBody(req)) ?? {});
      const reason = optionalString(body, "reason");
      const accepted = tasksSrc.cancel(taskId, reason ?? "cancel requested");
      const rec = tasksSrc.get(taskId);
      sendJson(res, 200, {
        task_id: taskId,
        accepted,
        ...(reason === undefined ? {} : { reason }),
        status: rec?.state ?? "unknown",
        run_id: rec?.row.run_id ?? null,
        session_id: rec?.row.session_id ?? null,
      });
    });
  });
}
