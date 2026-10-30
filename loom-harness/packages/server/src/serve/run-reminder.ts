/**
 * W12 副会话终态提醒 —— 提醒生成纯函数 + 投递路由（"side 完成→主会话注入"闭环的 server 半边）。
 *
 * 触发缝（决策，复用 run-trace 接线模式）：RunEngine.onRunTerminal（boot.ts 中
 * `onRunTerminal: (rec) => { runTrace.finishRun(rec); reminders.onTerminal(rec); }`）。
 * 崩溃形状（crashed=true、terminal=null）也到该缝——同样盖棺提醒，但状态词如实标 crashed，
 * 取件提示仍走 GET /runs/:id（缺口形状本身即详情，T13 会补对账）。
 *
 * 提醒行纪律（决策）：**digest 正文绝不进提醒**——提醒只带身份与状态
 * （run_id / workflow / status / attempt / trigger / 副会话 sid）+ 一句取件指引；
 * 内容取件走工具（task_fetch / GET /runs/:id），保持提醒轻量、transient 注入面小。
 * 行形状单行、键值 token 前缀可 parse（reminderNotifyProps 反解出 toast 字段，
 * 与 formatRunReminder 同文件=形状唯一真源）。
 *
 * 目标会话解析（决策）：账本行形状冻结（run_id/workflow/attempt/trigger/parent_run/
 * session_id），run 面**无 parentSessionId 字段**；归属两路：
 *  - **后台 sub（task 工具派发）**：parentSessionId 是**结构事实**——派发时 task-tool 传
 *    ctx.sessionId 进 SpawnSubPolicy.parentSessionId（task-tool.ts:375），内核登记 SubTaskRecord
 *    带该字段（kernel.ts:343），盖棺经 onRunTerminal 原样回传（kernel.ts:459/534 `_requireSub`）；
 *    resolveTarget 直取 `rec.parentSessionId`（在册即投它）。
 *  - **POST /runs 副会话**：无该字段，走 server 侧旁路登记：body 可选 parentSessionId →
 *    task-api noteRunParent → router.noteParent(runId, parentSessionId)（派发登记、终态消费）。
 * 解析序：parentSessionId 且已在 registry → 投它；否则 undefined → registry 缺省主会话（首注册 sid）；
 * registry 无会话 → registry 内部滞留，首个会话注册即冲刷。W21 实证校正：task 工具后台派发父归属
 * 本就接通（①非缺陷），真正缺陷是②拉取语义（见下），故此处**不改接线、只补端到端测试钉**。
 * 路由本身 fail-soft：任何异常只 warn，绝不反噬引擎盖棺路径（观测/通知面全仓纪律）。
 *
 * W21 推送语义（决策，用户判词"完成即通知 NOW"）：onTerminal 不再走 `queueReminder` 拉取入队
 * （transient 滞留到主会话**下一轮**才随边界注入、且 delivery.notify 帧只在 drain 时刻发——空闲
 * 父会话永不触发 = 用户实测"什么都没发生"），改调 `registry.deliverReminder`，由 registry 在
 * **发射时刻**统一投递，且**每个终态恰一个 delivery.notify 帧**（单点：drain 时刻发帧路径下线，
 * 见 registry#ensure 注释；避免"发射一帧 + drain 一帧"双弹）。deliverReminder 内部分派规则：
 *  - 目标在册 + 空闲（running===null 且 SEND 队列空）→ **起唤醒轮**：提醒行即该轮 durable user 消息
 *    （模型即刻见、可 task_fetch），**不再进边界队列**（行即 prompt，杜绝双份）；
 *  - 目标在册但忙/有排队 → `queueReminder` transient 边界注入（W12 busy 路径逐字节不变）；
 *  - 目标未在册/无会话（外部代投、重启、cron）→ `queueReminder` 三层滞留设计不变（无在册 hub
 *    即发射时刻无 toast 落点，冲刷后随其首轮边界注入）。
 * 唤醒轮是主会话 loop 轮（非内核 run/sub 记录）→ 其终态不再经 onRunTerminal → 无唤醒递归。
 */

import type { RunRecord } from "@axeuh/loom-core/run-engine";
import type { SubTaskRecord } from "@axeuh/loom-core/kernel";

type ReminderLog = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => void;

/** 提醒行前缀（transient 注入与测试 grep 的锚点；格式变此值即破契约）。 */
export const RUN_REMINDER_PREFIX = "[run-reminder]";

/** delivery.notify 的 toast 字段（形状对齐 harness-ui 既有消费：title/message/variant）。
 *  type 别名而非 interface：hub.publish 的 properties 形参是 Record<string, unknown>，
 *  只有 type 自带隐式索引签名（TS 规则），调用点零 cast。 */
export type ReminderNotifyProps = {
  readonly title: string;
  readonly message: string;
  readonly variant: "info" | "success" | "warning" | "error";
};

/** 终态状态词（run-trace statusOf 同词表口径：done/partial/cancelled/crashed/failed）。 */
function statusToken(rec: RunRecord): string | null {
  switch (rec.state) {
    case "done":
      return "done";
    case "partial":
      return "partial";
    case "failed":
      if (rec.crashed) return "crashed";
      return rec.cancelRequested !== null ? "cancelled" : "failed";
    case "queued":
    case "admitted":
    case "running":
      return null;
    default: {
      const unreachable: never = rec.state;
      throw new Error(`statusToken: unhandled run state ${String(unreachable)}`);
    }
  }
}

/** 类型守卫：内核后台 sub 账本记录（kind:"sub" 判别；SubTaskRecord extends RunRecord）。 */
function isSubRecord(rec: RunRecord): rec is SubTaskRecord {
  return (rec as { kind?: string }).kind === "sub";
}

/**
 * 终态提醒行（纯函数）。非终态输入返回 null（onTerminal 防御性消费，不猜状态）。
 * 行内不含 digest/blockers——取件走工具。
 *
 * W9 切片 3 sub 分支（决策）：后台任务行以 task_id 为主键（三面 join 纪律）、带
 * kind=sub 标注与 task_fetch 取件指引；run 面行形状逐字节不变（旧提醒测试零扰动）。
 */
export function formatRunReminder(rec: RunRecord): string | null {
  const status = statusToken(rec);
  if (status === null) return null;
  if (isSubRecord(rec)) {
    const { run_id, session_id } = rec.row;
    return (
      `${RUN_REMINDER_PREFIX} kind=sub task=${run_id} agent_type=${rec.agentType} status=${status} ` +
      `side_session=${session_id}；后台子会话已终态，取件用 task_fetch(task_id="${run_id}")。`
    );
  }
  const { run_id, workflow, attempt, trigger, session_id } = rec.row;
  return (
    `${RUN_REMINDER_PREFIX} run=${run_id} workflow=${workflow} status=${status} ` +
    `attempt=${String(attempt)} trigger=${trigger} side_session=${session_id}；` +
    `副会话已终态，取件用 task_fetch(session_id="${session_id}") 或 GET /runs/${run_id}。`
  );
}

/** 状态词 → toast variant 映射（done 绿；partial/cancelled 黄；failed/crashed 红；余量 info）。 */
function variantOf(status: string): ReminderNotifyProps["variant"] {
  switch (status) {
    case "done":
      return "success";
    case "partial":
    case "cancelled":
      return "warning";
    case "failed":
    case "crashed":
      return "error";
    default:
      return "info";
  }
}

/**
 * 提醒行 → delivery.notify toast 字段（reminderNotifyProps 与 formatRunReminder 互逆的
 * parse 面；行不合规回落 info 兜底，绝不抛——通知面 fail-soft）。
 */
export function reminderNotifyProps(line: string): ReminderNotifyProps {
  const status = /(?:^|\s)status=([a-z]+)/.exec(line)?.[1] ?? "";
  const workflow = /(?:^|\s)workflow=(\S+)/.exec(line)?.[1] ?? "";
  const runId = /(?:^|\s)run=(\S+)/.exec(line)?.[1] ?? /(?:^|\s)task=(\S+)/.exec(line)?.[1] ?? "";
  const done = status === "done";
  const sub = line.includes(`${RUN_REMINDER_PREFIX} kind=sub`);
  return {
    title: sub ? (done ? "后台任务完成" : "后台任务终态") : done ? "副会话完成" : "副会话终态提醒",
    message: [workflow !== "" ? workflow : null, runId !== "" ? runId : null, status !== "" ? status : null]
      .filter((x): x is string => x !== null)
      .join(" · "),
    variant: variantOf(status),
  };
}

/** router 消费的 registry 侧写面（SessionRegistry 结构满足；测试注入 fake）。 */
export interface ReminderRegistryView {
  has(sessionID: string): boolean;
  /**
   * W21 推送投递（发射时刻单点）：target=在册主会话 sid → 发 delivery.notify 帧 +
   * 空闲起唤醒轮 / 忙则 transient 边界注入；target=undefined → registry 内部走缺省主会话/滞留。
   * 每个终态恰一帧（drain 时刻发帧路径已下线，见 registry#ensure）。
   */
  deliverReminder(target: string | undefined, line: string): void;
}

export interface RunReminderRouter {
  /** 引擎 onRunTerminal 接线点（非终态/无提醒形状 = 静默放行）。 */
  onTerminal(record: RunRecord): void;
  /** 派发时刻的归属登记（POST /runs parentSessionId 旁路；不进账本行）。 */
  noteParent(runId: string, parentSessionId: string): void;
}

export function createRunReminderRouter(opts: {
  readonly registry: ReminderRegistryView;
  readonly log?: ReminderLog;
  readonly now?: () => number;
}): RunReminderRouter {
  const now = opts.now ?? Date.now;
  /** run_id → parentSessionId（FIFO 有界，同 run-trace tracker 纪律——长跑不留无界 map）。 */
  const parents = new Map<string, string>();
  const MAX_PARENTS = 256;

  function resolveTarget(rec: RunRecord): string | undefined {
    // W9 切片 3：后台 sub 的归属是**结构事实**（派发时父会话 sid 就在账本记录里），
    // 优先直投派发方；父不在册（重启/销毁）回落缺省主会话路径——不猜、不滞留到他主。
    if (isSubRecord(rec)) {
      const parent = rec.parentSessionId;
      if (opts.registry.has(parent)) return parent;
    }
    const parent = parents.get(rec.row.run_id);
    if (parent !== undefined && opts.registry.has(parent)) return parent;
    // parent 未登记 / 不是在册主会话（含外部代投、cron/script 触发）→ 缺省主会话路径。
    return undefined;
  }

  return {
    onTerminal(record: RunRecord): void {
      let line: string | null;
      try {
        line = formatRunReminder(record);
      } catch (err) {
        opts.log?.("warn", "loom run reminder format failed", {
          run_id: record.row.run_id,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (line === null) return;
      try {
        opts.registry.deliverReminder(resolveTarget(record), line);
        parents.delete(record.row.run_id);
      } catch (err) {
        opts.log?.("warn", "loom run reminder delivery failed", {
          run_id: record.row.run_id,
          at: now(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    noteParent(runId: string, parentSessionId: string): void {
      if (parents.size >= MAX_PARENTS) {
        const oldest = parents.keys().next();
        if (!oldest.done) parents.delete(oldest.value);
      }
      parents.set(runId, parentSessionId);
    },
  };
}
