/**
 * W12 提醒生成纯函数 + 路由验收。
 * Given: 引擎 RunRecord 各终态形状（done/partial/failed/cancelled/crashed/非终态）
 * When:  formatRunReminder / reminderNotifyProps / createRunReminderRouter（fake registry 侧写）
 * Then:  提醒行含 run_id/workflow/status/attempt/trigger/副会话 sid + task_fetch 与
 *        GET /runs/:id 两句取件提示，**digest/blockers 正文绝不出现在行内**（取件走工具）；
 *        状态词 = run-trace statusOf 同口径（failed+cancelRequested=cancelled，crashed=crashed）；
 *        notify props 形状对齐 harness-ui toast 消费（title/message/variant）；
 *        router 目标解析 = parentSessionId 在册投它、否则 undefined（registry 走缺省主会话）；
 *        router 全路径 fail-soft（view 抛错只 warn，绝不反噬引擎盖棺）。
 */

import { describe, expect, it } from "vitest";
import type { RunRecord, RunRow } from "@axeuh/loom-core/run-engine";
import {
  RUN_REMINDER_PREFIX,
  createRunReminderRouter,
  formatRunReminder,
  reminderNotifyProps,
  type ReminderRegistryView,
} from "./run-reminder.js";

const RUN_ID = "run_" + "a".repeat(16);
const SIDE_SID = "ses_" + "b".repeat(16);
const MAIN_SID = "ses_" + "c".repeat(16);
const DIGEST_MARK = "DIGEST-正文绝不进提醒-巡检37项通过";

function row(over: Partial<RunRow> = {}): RunRow {
  return {
    run_id: RUN_ID,
    workflow: "w-health",
    attempt: 2,
    trigger: "manual",
    parent_run: null,
    session_id: SIDE_SID,
    ...over,
  };
}

function rec(over: Partial<RunRecord> & { rowOver?: Partial<RunRow> } = {}): RunRecord {
  const { rowOver, ...rest } = over;
  return {
    row: row(rowOver ?? {}),
    state: "done",
    dispatchedAt: 1_700_000_000_000,
    terminalAt: 1_700_000_010_000,
    terminal: {
      at: 1_700_000_010_000,
      status: "done",
      digest: DIGEST_MARK,
      pointers: ["file:out/x.md"],
      blockers: [],
    },
    error: null,
    crashed: false,
    cancelRequested: null,
    ...rest,
  } as RunRecord;
}

describe("formatRunReminder：提醒行形状（纯函数）", () => {
  it("done 终态：行含全部身份 token + 两句取件提示；digest 正文不在行内", () => {
    const line = formatRunReminder(rec());
    expect(line).not.toBeNull();
    const text = line!;
    expect(text.startsWith(RUN_REMINDER_PREFIX)).toBe(true);
    expect(text).toContain(`run=${RUN_ID}`);
    expect(text).toContain("workflow=w-health");
    expect(text).toContain("status=done");
    expect(text).toContain("attempt=2");
    expect(text).toContain("trigger=manual");
    expect(text).toContain(`side_session=${SIDE_SID}`);
    expect(text).toContain(`task_fetch(session_id="${SIDE_SID}")`);
    expect(text).toContain(`GET /runs/${RUN_ID}`);
    expect(text.split("\n")).toHaveLength(1); // 单行纪律（transient 注入面小）
    expect(text).not.toContain(DIGEST_MARK); // 取件走工具，提醒保持轻量
    expect(text).not.toContain("file:out/x.md"); // pointers 也不进提醒
  });

  it("状态词表穷尽：done/partial/failed/cancelled/crashed 如实标注；非终态返回 null", () => {
    expect(formatRunReminder(rec())).toContain("status=done");
    expect(formatRunReminder(rec({ state: "partial" }))).toContain("status=partial");
    expect(formatRunReminder(rec({ state: "failed", crashed: false }))).toContain("status=failed");
    expect(formatRunReminder(rec({ state: "failed", cancelRequested: "shutdown" }))).toContain(
      "status=cancelled",
    );
    expect(formatRunReminder(rec({ state: "failed", crashed: true, terminal: null }))).toContain(
      "status=crashed",
    );
    for (const state of ["queued", "admitted", "running"] as const) {
      expect(formatRunReminder(rec({ state, terminal: null, terminalAt: null }))).toBeNull();
    }
  });
});

describe("reminderNotifyProps：行反解 → delivery.notify toast 字段", () => {
  it("variant 映射：done=success / partial=cancelled=warning / failed=crashed=error", () => {
    const cases: Array<[ReturnType<typeof formatRunReminder>, string, string]> = [
      [formatRunReminder(rec()), "success", "副会话完成"],
      [formatRunReminder(rec({ state: "partial" })), "warning", "副会话终态提醒"],
      [formatRunReminder(rec({ state: "failed", cancelRequested: "x" })), "warning", "副会话终态提醒"],
      [formatRunReminder(rec({ state: "failed" })), "error", "副会话终态提醒"],
      [formatRunReminder(rec({ state: "failed", crashed: true, terminal: null })), "error", "副会话终态提醒"],
    ];
    for (const [line, variant, title] of cases) {
      const props = reminderNotifyProps(line!);
      expect(props.variant).toBe(variant);
      expect(props.title).toBe(title);
      expect(props.message).toContain("w-health");
      expect(props.message).toContain(RUN_ID);
      expect(line).not.toContain(DIGEST_MARK);
    }
  });

  it("坏行兜底 info 不抛（通知面 fail-soft）", () => {
    const props = reminderNotifyProps("不是提醒行");
    expect(props.variant).toBe("info");
    expect(typeof props.title).toBe("string");
    expect(typeof props.message).toBe("string");
  });
});

/** registry 侧写 fake：记录 deliverReminder 调用 + 在册名单。 */
function fakeView(knownSids: readonly string[] = []) {
  const calls: Array<{ target: string | undefined; line: string }> = [];
  const view: ReminderRegistryView = {
    has: (sid) => knownSids.includes(sid),
    deliverReminder: (target, line) => {
      calls.push({ target, line });
    },
  };
  return { view, calls };
}

describe("createRunReminderRouter：目标解析 + fail-soft", () => {
  it("parentSessionId 已登记且在册 → 投 parent；未登记 → undefined（registry 缺省主会话路径）", () => {
    const { view, calls } = fakeView([MAIN_SID]);
    const router = createRunReminderRouter({ registry: view });
    router.noteParent(RUN_ID, MAIN_SID);
    router.onTerminal(rec());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe(MAIN_SID);
    expect(calls[0]!.line).toContain(RUN_REMINDER_PREFIX);

    // 终态消费后登记注销：同 run 重复盖棺不再投 parent（幂等回落缺省面）。
    router.onTerminal(rec());
    expect(calls[1]!.target).toBeUndefined();
  });

  it("parent 登记了但不在册（外部代投/重启后）→ undefined 回落缺省主会话", () => {
    const { view, calls } = fakeView([]);
    const router = createRunReminderRouter({ registry: view });
    router.noteParent(RUN_ID, "ses_ghost000000000");
    router.onTerminal(rec());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBeUndefined();
  });

  it("非终态记录 = 静默放行（零调用）；view 抛错只 warn 不反噬", () => {
    const { view, calls } = fakeView();
    const warns: Record<string, unknown>[] = [];
    const router = createRunReminderRouter({
      registry: view,
      log: (level, msg, fields) => warns.push({ level, msg, ...fields }),
    });
    router.onTerminal(rec({ state: "running", terminalAt: null, terminal: null }));
    expect(calls).toHaveLength(0);

    const boom: ReminderRegistryView = {
      has: () => {
        throw new Error("registry 坏了");
      },
      deliverReminder: () => {
        throw new Error("registry 坏了");
      },
    };
    const router2 = createRunReminderRouter({ registry: boom, log: (level, msg, fields) => warns.push({ level, msg, ...fields }) });
    expect(() => router2.onTerminal(rec())).not.toThrow();
    expect(warns.some((w) => String(w["msg"]).includes("reminder"))).toBe(true);
  });

  it("parent 登记 FIFO 有界（256 上限，长跑不留无界 map）", () => {
    const { view, calls } = fakeView([MAIN_SID]);
    const router = createRunReminderRouter({ registry: view });
    const kid = (i: number): string => `run_${String(i).padStart(16, "0").slice(0, 16)}`;
    for (let i = 0; i < 300; i++) {
      router.noteParent(kid(i), MAIN_SID);
    }
    // 首位逐出后其盖棺回落缺省面（target=undefined），最新登记仍投 parent。
    router.onTerminal(rec({ rowOver: { run_id: kid(0) } }));
    router.onTerminal(rec({ rowOver: { run_id: kid(299) } }));
    expect(calls[0]!.target).toBeUndefined();
    expect(calls[1]!.target).toBe(MAIN_SID);
  });

  // W21 ① 结构归属：后台 sub 终态记录自带 parentSessionId（kernel 派发时写入），
  // router 直投派发方、不经 noteParent 旁路。派发方非首注册（非缺省面）时尤其关键。
  it("sub 记录（kind=sub, parentSessionId 在册）→ 投派发方，行带 kind=sub；每终态恰一投递", () => {
    const dispatchSid = "ses_" + "d".repeat(16); // 非首注册 younger 会话
    const { view, calls } = fakeView([dispatchSid]);
    const router = createRunReminderRouter({ registry: view });
    const subRec = {
      ...rec(),
      kind: "sub",
      taskId: RUN_ID,
      agentType: "explore",
      parentSessionId: dispatchSid,
      task: "读一句话",
      depth: 1,
    } as unknown as RunRecord;
    router.onTerminal(subRec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe(dispatchSid);
    expect(calls[0]!.line).toContain("[run-reminder] kind=sub");
    expect(calls[0]!.line).toContain(`task_fetch(task_id="${RUN_ID}")`);
    // 结构归属不依赖 noteParent：即便旁路 map 空，sub 仍投派发方。
  });
});
