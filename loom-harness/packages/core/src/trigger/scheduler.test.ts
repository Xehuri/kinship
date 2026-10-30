/**
 * T15 调度器验收（docs/02 §T15 TDD：clock-injected schedule test first）。
 *
 * 本文件冻结 **注入时钟下的排班触发**（无真定时器、无 sleep）：
 *   1. 定义口径：fixture 四条 tasks/*.yaml 形状（daily / monthly 映射 / weekly）解析出正确 cron；
 *   2. 表驱动触发时刻：假时钟序列逐个 tick，命中分钟才提交，其他分钟不提交；
 *   3. disabled schedules skipped；
 *   4. 同分钟幂等：重复 tick 同一时刻只提交一次；
 *   5. 漏触发不补：跳过中间班次后不产生补跑意图（只声明当下命中）；
 *   6. 提交端口抛错 fail-soft：留痕且不拖垮同刻其他触发；
 *   7. **run-engine 集成**：onSubmit → RunEngine.dispatch，账本行 trigger=cron，
 *      admission 拦截时 cron 不落地（T17 单点拦截，cron 侧零特殊处理）。
 */

import { describe, expect, it } from "vitest";
import { RunEngine } from "../run-engine/engine.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import {
  type AdmissionControl,
  type RunLaunchContext,
  type RunLaunchResult,
  type RunRow,
  type RunSessionPort,
} from "../run-engine/types.js";
import { TriggerScheduler, type RunSubmitSpec } from "./scheduler.js";
import { parseTriggerDefinition, type TriggerDefinition } from "./trigger.js";

/* ────────────── helpers ────────────── */

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

/** 本地时刻（matches 只读本地 getter）。 */
function at(y: number, mo: number, d: number, h: number, mi: number, sec = 0): Date {
  return new Date(y, mo - 1, d, h, mi, sec, 0);
}

/** 收集型提交端口：记下每次提交的 runSpec。 */
class CollectingSubmit {
  readonly specs: RunSubmitSpec[] = [];
  submit = (spec: RunSubmitSpec): void => {
    this.specs.push(spec);
  };
}

/** 固定时钟（tick() 不传参时读它）。 */
function fixedClock(t: Date): () => Date {
  return () => t;
}

/** 常开假端口：run 立即 done。 */
class AlwaysDonePort implements RunSessionPort {
  calls = 0;
  async run(_ctx: RunLaunchContext): Promise<RunLaunchResult> {
    this.calls += 1;
    return { status: "done", digest: "ok", pointers: [], blockers: [] };
  }
}

/* fixture 四条任务的声明原文（与 fixture-workspace/data/tasks/*.yaml 逐字一致）。 */
const DAILY_REVIEW = {
  name: "今日复盘",
  schedule: { daily: "00:30" },
  enabled: true,
  prompt: "【今日复盘】 按复盘子智能体调度流程执行。",
};
const BIWEEKLY_REVIEW = {
  name: "双周深度回顾",
  schedule: { monthly: { "1": "18:30", "15": "18:30" } },
  enabled: true,
  prompt: "【双周深度回顾】 按子智能体调度流程执行。",
};
const WEEKLY_SUMMARY = {
  name: "周报总结",
  enabled: true,
  schedule: { weekly: { days: "mon", at: "03:00" } },
  prompt: "【周报总结】 按子智能体调度流程执行。",
};
const NIGHT_AUDIT = {
  name: "夜间审计",
  schedule: { daily: "02:00" },
  enabled: true,
  prompt: "【夜间审计】 按审计子智能体调度流程执行。",
};

function defOf(raw: unknown, source: string | null = null): TriggerDefinition {
  return parseTriggerDefinition(raw, source);
}

/* ────────────── 1：定义口径 ────────────── */

describe("fixture 声明口径 → canonical cron", () => {
  it("daily 00:30 → `30 0 * * *`", () => {
    expect(defOf(DAILY_REVIEW).cron).toBe("30 0 * * *");
  });

  it("daily 02:00 → `0 2 * * *`", () => {
    expect(defOf(NIGHT_AUDIT).cron).toBe("0 2 * * *");
  });

  it("monthly 映射 {1,15}@18:30 → `30 18 1,15 * *`", () => {
    expect(defOf(BIWEEKLY_REVIEW).cron).toBe("30 18 1,15 * *");
  });

  it("weekly days:mon at 03:00 → `0 3 * * 1`", () => {
    expect(defOf(WEEKLY_SUMMARY).cron).toBe("0 3 * * 1");
  });

  it("enabled 缺省 true；显式 false 保留；prompt 原样", () => {
    const d = defOf({ name: "x", prompt: "p", schedule: { daily: "01:00" } });
    expect(d.enabled).toBe(true);
    expect(d.prompt).toBe("p");
    expect(defOf({ ...NIGHT_AUDIT, enabled: false }).enabled).toBe(false);
  });

  it("非法声明 fail-loud", () => {
    expect(() => defOf({ name: "x", prompt: "p", schedule: { daily: "25:00" } })).toThrow();
    expect(() => defOf({ name: "x", prompt: "p", schedule: { weekly: { days: [], at: "03:00" } } })).toThrow();
    expect(() => defOf({ name: "x", prompt: "p" })).toThrow();
    expect(() => defOf({ name: "", prompt: "p", schedule: { daily: "01:00" } })).toThrow();
    expect(() => defOf({ name: "x", prompt: "", schedule: { daily: "01:00" } })).toThrow();
  });
});

/* ────────────── 2：表驱动触发时刻（假时钟） ────────────── */

describe("注入时钟表驱动触发时刻", () => {
  it("四条 fixture 定义：只在命中分钟提交，其余分钟静默", async () => {
    const submit = new CollectingSubmit();
    const sched = new TriggerScheduler({
      clock: fixedClock(at(2026, 1, 5, 0, 0)),
      onSubmit: submit.submit,
      definitions: [
        defOf(DAILY_REVIEW),
        defOf(BIWEEKLY_REVIEW),
        defOf(WEEKLY_SUMMARY),
        defOf(NIGHT_AUDIT),
      ],
    });

    // 时刻序列（2026-01-05 是周一）
    const times = [
      at(2026, 1, 5, 0, 0), // 无命中
      at(2026, 1, 5, 0, 30), // 今日复盘
      at(2026, 1, 5, 0, 31), // 无
      at(2026, 1, 5, 2, 0), // 夜间审计
      at(2026, 1, 5, 3, 0), // 周报总结（周一）
      at(2026, 1, 5, 3, 1), // 无
      at(2026, 1, 5, 18, 30), // 无（1 号不是今天，且非 15 号）
      at(2026, 1, 15, 18, 30), // 双周深度回顾
    ];

    const fired = await sched.tickAll(times);

    expect(fired.map((s) => s.workflow)).toEqual(["今日复盘", "夜间审计", "周报总结", "双周深度回顾"]);
    expect(fired.every((s) => s.trigger === "cron")).toBe(true);
    expect(nth(fired, 0).at).toBe(times[1]?.getTime());
    expect(nth(fired, 0).cron).toBe("30 0 * * *");
  });

  it("秒级抖动不影响（同一分钟多次 tick 视为同一班）", async () => {
    const submit = new CollectingSubmit();
    const sched = new TriggerScheduler({ onSubmit: submit.submit, definitions: [defOf(NIGHT_AUDIT)] });
    const fired = await sched.tickAll([
      at(2026, 1, 5, 2, 0, 0),
      at(2026, 1, 5, 2, 0, 30),
      at(2026, 1, 5, 2, 0, 59),
    ]);
    expect(fired).toHaveLength(1);
  });
});

/* ────────────── 3：disabled 跳过 ────────────── */

describe("disabled schedules skipped", () => {
  it("enabled=false 的定义即使命中也不提交", async () => {
    const submit = new CollectingSubmit();
    const sched = new TriggerScheduler({
      onSubmit: submit.submit,
      definitions: [defOf({ ...DAILY_REVIEW, enabled: false }), defOf(NIGHT_AUDIT)],
    });
    const fired = await sched.tickAll([at(2026, 1, 5, 0, 30), at(2026, 1, 5, 2, 0)]);
    expect(fired.map((s) => s.workflow)).toEqual(["夜间审计"]);
    expect(submit.specs).toHaveLength(1);
  });
});

/* ────────────── 4：同分钟幂等 ────────────── */

describe("同分钟幂等", () => {
  it("重复 tick 同一时刻只提交一次", async () => {
    const submit = new CollectingSubmit();
    const sched = new TriggerScheduler({ onSubmit: submit.submit, definitions: [defOf(DAILY_REVIEW)] });
    const t = at(2026, 1, 5, 0, 30);
    await sched.tick(t);
    await sched.tick(t);
    await sched.tick(t);
    expect(submit.specs).toHaveLength(1);
  });
});

/* ────────────── 5：漏触发不补 ────────────── */

describe("漏触发不补（latest 策略归 T13）", () => {
  it("跳过中间班次不产生补跑意图，只声明当下命中", async () => {
    const submit = new CollectingSubmit();
    const sched = new TriggerScheduler({ onSubmit: submit.submit, definitions: [defOf(DAILY_REVIEW)] });
    // 1/5 00:30 后直接跳到 1/8 00:30：中间 1/6、1/7 的班次被「漏掉」
    const fired = await sched.tickAll([at(2026, 1, 5, 0, 30), at(2026, 1, 8, 0, 30)]);
    expect(fired).toHaveLength(2); // 只两次：当下命中，各一次
    expect(fired.map((s) => new Date(s.at).getDate())).toEqual([5, 8]);
    // 没有任何 1/6、1/7 的补跑意图
    expect(fired.some((s) => new Date(s.at).getDate() === 6)).toBe(false);
    expect(fired.some((s) => new Date(s.at).getDate() === 7)).toBe(false);
  });
});

/* ────────────── 6：提交端口 fail-soft ────────────── */

describe("提交端口抛错 fail-soft", () => {
  it("一条提交失败留痕，同刻其他触发照常提交", async () => {
    const ok: RunSubmitSpec[] = [];
    const sched = new TriggerScheduler({
      onSubmit: (spec) => {
        if (spec.workflow === "夜间审计") throw new Error("boom");
        ok.push(spec);
      },
      definitions: [defOf(NIGHT_AUDIT), defOf({ name: "另一个", prompt: "p", schedule: { daily: "02:00" } })],
    });
    const fired = await sched.tick(at(2026, 1, 5, 2, 0));
    expect(fired.map((s) => s.workflow)).toEqual(["另一个"]);
    expect(ok).toHaveLength(1);
    expect(sched.errors).toHaveLength(1);
    expect(nth(sched.errors, 0).workflow).toBe("夜间审计");
  });
});

/* ────────────── 7：run-engine 集成 ────────────── */

describe("TriggerScheduler × RunEngine 集成", () => {
  it("命中 → dispatch：账本 expected 行 payload.trigger=cron，workflow 正确", async () => {
    const ledger = new MemoryLedger();
    const port = new AlwaysDonePort();
    const engine = new RunEngine({ ledger, sessionPort: port, now: () => at(2026, 1, 5, 0, 30).getTime() });

    const sched = new TriggerScheduler({
      onSubmit: async (spec) => {
        await engine.dispatch({ workflow: spec.workflow, prompt: spec.prompt, trigger: spec.trigger });
      },
      definitions: [defOf(DAILY_REVIEW), defOf(NIGHT_AUDIT)],
    });

    const fired = await sched.tickAll([at(2026, 1, 5, 0, 30), at(2026, 1, 5, 2, 0)]);

    expect(fired).toHaveLength(2);
    expect(port.calls).toBe(2);
    expect(ledger.entries.filter((e) => e.t === "expected")).toHaveLength(2);

    const rows = ledger.entries
      .filter((e) => e.t === "expected")
      .map((e) => e.payload as RunRow);
    expect(rows.map((r) => r.workflow)).toEqual(["今日复盘", "夜间审计"]);
    expect(rows.every((r) => r.trigger === "cron")).toBe(true);
    expect(rows.every((r) => r.attempt === 1 && r.parent_run === null)).toBe(true);
  });

  it("admission 拦截 → cron 不落地（T17 单点拦截，cron 侧零特殊处理）", async () => {
    const ledger = new MemoryLedger();
    const port = new AlwaysDonePort();
    const admission: AdmissionControl = {
      admit: (row) =>
        row.workflow === "夜间审计" ? { kind: "paused", reason: "paused" } : { kind: "admit" },
    };
    const engine = new RunEngine({ ledger, sessionPort: port, admission, now: () => 0 });

    const sched = new TriggerScheduler({
      onSubmit: async (spec) => {
        await engine.dispatch({ workflow: spec.workflow, prompt: spec.prompt, trigger: spec.trigger });
      },
      definitions: [defOf(NIGHT_AUDIT), defOf({ name: "放行流", prompt: "p", schedule: { daily: "02:00" } })],
    });

    const fired = await sched.tick(at(2026, 1, 5, 2, 0));

    // 提交端口被调两次（cron 只管声明意图），但只有放行的那条落账本
    expect(fired.map((s) => s.workflow)).toEqual(["夜间审计", "放行流"]);
    const rows = ledger.entries.filter((e) => e.t === "expected").map((e) => e.payload as RunRow);
    expect(rows.map((r) => r.workflow)).toEqual(["放行流"]);
    expect(engine.get("run_x")).toBeUndefined();
    expect(port.calls).toBe(1);
  });
});
