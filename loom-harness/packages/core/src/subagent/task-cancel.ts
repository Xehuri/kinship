/**
 * W37 task_cancel —— 模型面「中止在飞后台任务」工具（委托件，零取消实现）。
 *
 * 一句话职责：主/副/子会话（同一工具面）按 task 工具 background 派发返回的 task_id
 * 取消内核后台账本里的子智能体任务。取消语义的**唯一真源 = 注入账本口的 cancel**
 * （boot 装配传的就是 HTTP `POST /tasks/:taskID/cancel` 路由同一适配器——
 * kernel.cancelSub：running 才命中、记原因、abort signal 协作式收尾；见
 * kernel.ts:409-419 与 task-api/routes.ts:202-221）。本文件只做三件事：
 *   1. **参数边界解析**（task_id 空/坏 = 诚实文案，不 throw——对齐 task_fetch
 *      「sid 不存在回文本」的读侧先例；kernel 契约 throw=异常路径，误用会污染 isError 面）；
 *   2. **寻址诚实**（get 先行：账本无此条 = not_found + 来源指引，**绝不触 cancel**——
 *      一个 id 只属于一个域，不做双源静默双消；副会话 run 的取消面属 run-engine/plane，
 *      本会话轮中断属 /sessions/:id/abort，都不在工具面，文案如实说明选择面）；
 *   3. **终态整形**（get 现读三向分流：running → 委托 cancel；done/partial/failed →
 *      诚实终态行、零改动（cancel 不被调用，账本逐字节不动）；cancel 竞态 false →
 *      复查账本按实况整形，绝不谎报受理）。
 *
 * 决策（单缝）：终态词表本地常数仅用于**文案分流**，取消命中规则全权交 source.cancel
 * 返回值（内核 `rec.state !== "running"` 闸是判定真源，kernel.ts:116-118 TERMINALS
 * 为私有常数不可 import——词表同形三态，漂移由本包 task-cancel.test.ts 假口镜像钉住）。
 */

import type { HookContext } from "../hook.js";
import type { HarnessTool, ToolExecResult } from "../types.js";
import { Type } from "../index.js";
import type { SubTaskRecord } from "../kernel/types.js";
import type { RunState } from "../run-engine/types.js";

/**
 * 取消账本窄接口（boot 注入 = /tasks HTTP 路由同款适配器，结构面 SpawnKernel 满足：
 * get=getSub / cancel=cancelSub）。工具只消费这两个方法——list 不进窄口（防越权枚举面）。
 */
export interface TaskCancelSource {
  get(taskId: string): SubTaskRecord | undefined;
  cancel(taskId: string, reason?: string): boolean;
}

export interface TaskCancelToolOptions {
  readonly source: TaskCancelSource;
}

/** 工具判定结果（类型化分流；渲染为模型面文本，测试直钉 kind 语义走文本关键词）。 */
export type TaskCancelOutcome =
  | { readonly kind: "accepted"; readonly taskId: string; readonly reason: string; readonly state: RunState }
  | { readonly kind: "already_terminal"; readonly taskId: string; readonly state: RunState; readonly cancelRequested: string | null }
  | { readonly kind: "not_found"; readonly taskId: string }
  | { readonly kind: "refused"; readonly taskId: string; readonly state: RunState }
  | { readonly kind: "vanished"; readonly taskId: string };

/** 终态词表（仅文案分流用；取消命中真源=source.cancel 返回值，见模块头决策）。 */
const TERMINAL_STATES: readonly RunState[] = ["done", "partial", "failed"];

function isTerminalState(s: RunState): boolean {
  return TERMINAL_STATES.includes(s);
}

/** 判定 → 模型面文本（snake 词表对齐 /tasks 视图：status= 直投账本现读态）。 */
function renderOutcome(o: TaskCancelOutcome): string {
  switch (o.kind) {
    case "accepted":
      return (
        `task_cancel: 任务 ${o.taskId} 取消请求已受理（reason=${o.reason}）。` +
        `账本已记 cancel_requested，当前状态 status=${o.state}——子会话协作式收尾后落终态` +
        `（通常 failed）。这不是已完成：核验用 GET /tasks/${o.taskId}，取件用 task_fetch(task_id="${o.taskId}")。`
      );
    case "already_terminal":
      return (
        `task_cancel: 任务 ${o.taskId} 已是终态 status=${o.state}` +
        `${o.cancelRequested === null ? "" : `（cancel_requested=${o.cancelRequested}）`}，无需取消（账本未改动）。` +
        `成果核验用 GET /tasks/${o.taskId} 或 task_fetch(task_id="${o.taskId}")。`
      );
    case "not_found":
      return (
        `task_cancel: 任务 ${o.taskId} 不存在（后台任务账本无此条）。` +
        `task_id 只来自 task 工具 background=true 派发返回的状态块（run_ 形状）。` +
        `本工具不承接：副会话运行（POST /runs 派发的 run 走各自收束纪律与 GET /runs/<run_id>）、` +
        `以及当前会话自身轮次中断（走会话 abort 面）——一个 id 只属于一个域，勿混投。`
      );
    case "refused":
      return (
        `task_cancel: 任务 ${o.taskId} 取消请求未受理（账本在册但状态 status=${o.state}：` +
        `非 running 在飞窗口不可取消——准入前瞬间态/竞态窗口）。稍后重试或用 GET /tasks/${o.taskId} 核实现状。`
      );
    case "vanished":
      return (
        `task_cancel: 任务 ${o.taskId} 核验时已从内存账本消失（在册→消失，重启清册或撤册竞态）。` +
        `取消未受理；历史盖棺行可用 GET /tasks/${o.taskId} 回落账本核实。`
      );
  }
}

function textOnly(text: string): ToolExecResult {
  return { content: [{ type: "text", text }] };
}

/**
 * 判定核心（纯读 + 恰好一次 cancel 委托；导出给 execute，单测经工具面覆盖）。
 * 分流序即纪律：先 get 寻址（防对未知 id 触 cancel）→ 终态短路（防零改动被破坏）→
 * 委托 cancel → 复查整形（竞态不谎报）。
 */
function decideCancel(
  source: TaskCancelSource,
  taskId: string,
  reason: string | undefined,
): TaskCancelOutcome {
  const before = source.get(taskId);
  if (before === undefined) {
    return { kind: "not_found", taskId };
  }
  if (isTerminalState(before.state)) {
    return { kind: "already_terminal", taskId, state: before.state, cancelRequested: before.cancelRequested };
  }
  // 恰好一次委托：reason 缺省不物化（内核签名默认值 "cancel requested" = 与 HTTP 路由同词，
  // 工具不造第二个缺省文案）。
  const accepted = source.cancel(taskId, reason);
  const after = source.get(taskId);
  if (after === undefined) {
    // 理论不可达兜底（sub 册不删行）；竞态撤册 = 如实「未受理」，绝不沿用受理文案。
    return { kind: "vanished", taskId };
  }
  if (accepted) {
    return { kind: "accepted", taskId, reason: after.cancelRequested ?? reason ?? "cancel requested", state: after.state };
  }
  // cancel=false：get 与 cancel 之间刚盖棺 → 终态文案；否则 = 非 running 窗口，如实 refused。
  if (isTerminalState(after.state)) {
    return { kind: "already_terminal", taskId, state: after.state, cancelRequested: after.cancelRequested };
  }
  return { kind: "refused", taskId, state: after.state };
}

/** 装配 task_cancel 工具（纯工厂：无 I/O 副作用，账本操作全权委托注入口）。 */
export function createTaskCancelTool(opts: TaskCancelToolOptions): HarnessTool {
  const source = opts.source;
  return {
    name: "task_cancel",
    description:
      "中止在飞的后台子智能体任务：按 task 工具 background=true 派发返回的状态块里的 task_id（run_ 形状）" +
      "向内核后台账本提交取消请求；受理后任务记 cancel_requested 并协作式收尾落终态，非即时终止" +
      "（核验用 GET /tasks/<task_id>）。本工具只承接后台任务账本，不承接：副会话运行（POST /runs 的 run " +
      "走各自收束纪律）与当前会话自身轮次中断（走会话 abort 面）——一个 id 只属于一个域。",
    parameters: Type.Object({
      task_id: Type.String({
        description: "要中止的后台任务号（task 工具 background=true 派发返回的 run_ 形状 task_id）。",
      }),
      reason: Type.Optional(
        Type.String({ description: "取消原因（入账本 cancel_requested 留痕；缺省=cancel requested）。" }),
      ),
    }),
    // 委托 cancelSub 幂等（running 才命中；重复调用第二次=already_terminal/refused 分流）。
    isConcurrencySafe: () => true,

    async execute(args: Record<string, unknown>, _ctx: HookContext, _signal: AbortSignal): Promise<ToolExecResult> {
      // 参数边界（对齐 task_fetch「不存在回文本」先例：坏输入不 throw，会话继续）。
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      if (taskId === "") {
        return textOnly(
          "task_cancel: task_id 为空或非法——请传 task 工具 background=true 派发返回的状态块里的 task_id（run_ 形状）。",
        );
      }
      const reason = typeof args.reason === "string" && args.reason.trim() !== "" ? args.reason.trim() : undefined;
      return textOnly(renderOutcome(decideCancel(source, taskId, reason)));
    },
  };
}
