/**
 * T15 触发定义 schema —— 逐字对齐 fixture 的 workflows 声明口径
 * （docs/02 §T15：`ai/config/triggers/*.yaml`，由 `ai/data/tasks/*.yaml` 形状迁移）。
 *
 * 真源样本（只读参照，运行时由 server 读盘后传入已解析对象/JSON，本模块不做 IO）：
 *   fixture-workspace/data/tasks/12-daily-review.yaml   → schedule: { daily: "00:30" }
 *   fixture-workspace/data/tasks/13-biweekly-review.yaml → schedule: { monthly: { 1: "18:30", 15: "18:30" } }
 *   fixture-workspace/data/tasks/14-weekly-summary.yaml  → schedule: { weekly: { days: mon, at: "03:00" } }
 *   fixture-workspace/data/tasks/15-night-audit.yaml     → schedule: { daily: "02:00" }
 *
 * 职责边界：把「声明口径」（daily/weekly/monthly 简写，或直写 5 字段 cron）
 * **归一化**成一条 canonical cron 表达式，交给 cron.ts 的 parser。
 * 校验 fail-loud（缺字段/非法时间/空 days → 抛 TriggerConfigError），
 * 与 D28「契约缺失或非法要 fail-fast，不静默降级」一致。
 *
 * 不做（T15 边界）：不读文件（core 无 fs/yaml 依赖）；不排班补跑（漏班归 T13）；
 * 不接暂停开关（经 run-engine 同一 AdmissionControl 自动生效，见 scheduler.ts 注释）。
 */

import { CronParseError, parseCron } from "./cron.js";

/** 周名词 → 序数（0=周日，与 Date.getDay() 对齐；兼容 7 别名在编译期归一）。 */
const DOW_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** 配置形状错误（fail-loud；与 CronParseError 同为类型化错误）。 */
export class TriggerConfigError extends Error {
  constructor(message: string) {
    super(`[trigger:config] ${message}`);
    this.name = "TriggerConfigError";
  }
}

/* ────────────── 归一化后的声明形状 ────────────── */

/**
 * 触发排班声明（归一化后的强类型表示）。
 * kind 判别避免 `daily` vs `monthly` 字段歧义；四处形状覆盖 fixture 全部样本。
 */
export type TriggerScheduleSpec =
  | { readonly kind: "daily"; readonly at: string }
  | { readonly kind: "weekly"; readonly days: readonly string[]; readonly at: string }
  | { readonly kind: "monthly"; readonly days: readonly number[]; readonly at: string }
  | { readonly kind: "cron"; readonly expr: string };

/** 一条 workflow 触发定义（schema 类型化后的边界产物）。 */
export interface TriggerDefinition {
  /** 工作流名（原 yaml `name`；账本 row.workflow 即用它）。 */
  readonly name: string;
  /** 开关；缺省 true（fixture 均显式声明）。 */
  readonly enabled: boolean;
  /** 投递给副会话的 prompt 正文（首行场景前缀由装配层按 D16 补，这里原样）。 */
  readonly prompt: string;
  /** 归一化后的排班声明（审计/展示用）。 */
  readonly schedule: TriggerScheduleSpec;
  /** 编译出的 5 字段 cron 表达式（Scheduler 匹配真源）。 */
  readonly cron: string;
  /** 来源文件路径（可空；审计溯源用，由调用方传入）。 */
  readonly source: string | null;
  /** catchup 策略声明（D15 latest/all/none）；T13 消费，T15 仅透传类型化。 */
  readonly catchup: string | null;
  /**
   * 副会话角色文件引用（task yaml `agent:`，B 面设计）：agents/ 下文件名/stem/相对路径。
   * 缺省 = 无角色 → 副会话走缺省语义（AGENTS.md 基础集）。
   */
  readonly agent?: string;
}

/* ────────────── 基础校验工具 ────────────── */

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** 解析 "HH:MM"（容忍单位数小时/分钟，如 "3:00"）；越界/非法即抛。 */
export function parseClockTime(at: unknown, context: string): { hour: number; minute: number } {
  if (typeof at !== "string") {
    throw new TriggerConfigError(`${context}: 时间必须是 "HH:MM" 字符串（得 ${typeof at}）`);
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (m === null) {
    throw new TriggerConfigError(`${context}: 时间 "${at}" 形状非法，应为 "HH:MM"`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new TriggerConfigError(`${context}: 时间 "${at}" 超出 00:00-23:59`);
  }
  return { hour, minute };
}

/** 周名词/数字 → 序数（0-7，7 允许但调用方归一为 0）。 */
function toDow(token: string, context: string): number {
  const key = token.trim().toLowerCase();
  const named = DOW_NAMES[key];
  if (named !== undefined) return named;
  if (/^[0-7]$/.test(key)) return Number(key);
  throw new TriggerConfigError(`${context}: 星期 "${token}" 非法（应为 sun..sat 或 0-7）`);
}

/** 归一化周序数：7 → 0（周日）。 */
function normalizeDow(v: number): number {
  return v === 7 ? 0 : v;
}

/* ────────────── 声明 → canonical cron ────────────── */

/**
 * 把声明形状编译为 canonical cron 表达式。
 * 返回 `{ spec, cron }`：spec 为强类型声明，cron 已过 parseCron 校验。
 */
export function compileSchedule(
  raw: unknown,
  context = "schedule",
): { spec: TriggerScheduleSpec; cron: string } {
  if (!isRecord(raw)) {
    throw new TriggerConfigError(`${context}: 必须是对象（daily/weekly/monthly/cron 之一）`);
  }

  if (typeof raw.cron === "string") {
    const expr = parseCron(raw.cron).source; // 复用 parser 做合法性校验 + 规范化
    return { spec: { kind: "cron", expr }, cron: expr };
  }

  if (raw.daily !== undefined) {
    const at = raw.daily;
    if (typeof at !== "string") {
      throw new TriggerConfigError(`${context}.daily: 时间必须是 "HH:MM" 字符串`);
    }
    const { hour, minute } = parseClockTime(at, `${context}.daily`);
    return { spec: { kind: "daily", at }, cron: `${minute} ${hour} * * *` };
  }

  if (raw.weekly !== undefined) {
    return compileWeekly(raw.weekly, context);
  }

  if (raw.monthly !== undefined) {
    return compileMonthly(raw.monthly, context);
  }

  throw new TriggerConfigError(
    `${context}: 未识别的排班形状（键 ${Object.keys(raw).join(",") || "空"}）`,
  );
}

function compileWeekly(raw: unknown, context: string): { spec: TriggerScheduleSpec; cron: string } {
  if (!isRecord(raw)) {
    throw new TriggerConfigError(`${context}.weekly: 必须是 { days, at } 对象`);
  }
  const { hour, minute } = parseClockTime(raw.at, `${context}.weekly.at`);

  const rawDays = raw.days;
  let dayTokens: string[];
  if (typeof rawDays === "string") {
    dayTokens = [rawDays];
  } else if (Array.isArray(rawDays)) {
    dayTokens = rawDays.map((d) => {
      if (typeof d !== "string") {
        throw new TriggerConfigError(`${context}.weekly.days: 元素必须是字符串`);
      }
      return d;
    });
  } else {
    throw new TriggerConfigError(`${context}.weekly.days: 必须是字符串或字符串数组`);
  }
  if (dayTokens.length === 0) {
    throw new TriggerConfigError(`${context}.weekly.days: 不能为空`);
  }

  const dows = dayTokens.map((d) => normalizeDow(toDow(d, `${context}.weekly.days`)));
  const unique = [...new Set(dows)].sort((a, b) => a - b);
  const cron = `${minute} ${hour} * * ${unique.join(",")}`;
  parseCron(cron); // 双保险：编译结果必须可解析
  return { spec: { kind: "weekly", days: dayTokens, at: String(raw.at) }, cron };
}

function compileMonthly(raw: unknown, context: string): { spec: TriggerScheduleSpec; cron: string } {
  if (!isRecord(raw)) {
    throw new TriggerConfigError(`${context}.monthly: 必须是对象`);
  }

  // 兼容两种口径：
  //   A) fixture 迁移形状：{ "1": "18:30", "15": "18:30" }（日 → 时间 映射）
  //   B) 显式形状：{ days: [1, 15], at: "18:30" }
  let days: number[];
  let at: string;

  if (Array.isArray(raw.days)) {
    at = String(raw.at ?? "");
    days = raw.days.map((d) => {
      if (typeof d !== "number" || !Number.isInteger(d)) {
        throw new TriggerConfigError(`${context}.monthly.days: 元素必须是整数日`);
      }
      return d;
    });
    if (days.length === 0) {
      throw new TriggerConfigError(`${context}.monthly.days: 不能为空`);
    }
  } else {
    // 映射形状 A：键=日，值=时间；要求所有时间一致（本子集不做一日多时段）
    const entries = Object.entries(raw).filter(([k]) => k !== "days" && k !== "at");
    if (entries.length === 0) {
      throw new TriggerConfigError(`${context}.monthly: 空映射或缺少 days/at`);
    }
    const times = new Set<string>();
    days = entries.map(([k]) => {
      if (!/^\d{1,2}$/.test(k)) {
        throw new TriggerConfigError(`${context}.monthly: 键 "${k}" 不是合法日（1-31）`);
      }
      const d = Number(k);
      if (d < 1 || d > 31) {
        throw new TriggerConfigError(`${context}.monthly: 日 "${k}" 超出 1-31`);
      }
      if (typeof entries.find(([kk]) => kk === k)?.[1] !== "string") {
        throw new TriggerConfigError(`${context}.monthly: 日 "${k}" 的时间必须是字符串`);
      }
      times.add(String(raw[k]));
      return d;
    });
    if (times.size !== 1) {
      throw new TriggerConfigError(`${context}.monthly: 所有日必须共用同一时刻（本子集限制）`);
    }
    at = [...times][0] ?? "";
  }

  const { hour, minute } = parseClockTime(at, `${context}.monthly.at`);
  const unique = [...new Set(days)].sort((a, b) => a - b);
  for (const d of unique) {
    if (d < 1 || d > 31) {
      throw new TriggerConfigError(`${context}.monthly: 日 ${d} 超出 1-31`);
    }
  }
  const cron = `${minute} ${hour} ${unique.join(",")} * *`;
  parseCron(cron);
  return { spec: { kind: "monthly", days: unique, at }, cron };
}

/* ────────────── 边界解析：不可信 raw → TriggerDefinition ────────────── */

/**
 * 把一条不可信的触发原始对象（来自 YAML/JSON 解析）解析为 `TriggerDefinition`。
 * 非法即抛 TriggerConfigError（fail-loud，绝不静默降级）。
 *
 * @param source 可选来源路径（写进定义，审计溯源用；缺省 null）。
 */
export function parseTriggerDefinition(raw: unknown, source: string | null = null): TriggerDefinition {
  if (!isRecord(raw)) {
    throw new TriggerConfigError(`顶层必须是对象（得 ${Array.isArray(raw) ? "数组" : typeof raw}）`);
  }

  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TriggerConfigError(`name 必须是非空字符串（得 ${JSON.stringify(name)}）`);
  }

  const prompt = raw.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new TriggerConfigError(`${name}: prompt 必须是非空字符串`);
  }

  const enabledRaw = raw.enabled;
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    throw new TriggerConfigError(`${name}: enabled 必须是布尔（得 ${typeof enabledRaw}）`);
  }
  const enabled = enabledRaw ?? true;

  const catchupRaw = raw.catchup;
  if (catchupRaw !== undefined && typeof catchupRaw !== "string") {
    throw new TriggerConfigError(`${name}: catchup 必须是字符串（得 ${typeof catchupRaw}）`);
  }

  const agentRaw = raw.agent;
  if (agentRaw !== undefined && (typeof agentRaw !== "string" || agentRaw.trim() === "")) {
    throw new TriggerConfigError(`${name}: agent 必须是非空字符串（得 ${JSON.stringify(agentRaw)}）`);
  }

  if (raw.schedule === undefined) {
    throw new TriggerConfigError(`${name}: 缺少 schedule`);
  }
  const { spec, cron } = compileSchedule(raw.schedule, `${name}.schedule`);

  return {
    name,
    enabled,
    prompt,
    schedule: spec,
    cron,
    source,
    catchup: catchupRaw ?? null,
    ...(typeof agentRaw === "string" ? { agent: agentRaw.trim() } : {}),
  };
}

/** CronParseError → TriggerConfigError 的统一包装（供调用方需要时使用）。 */
export function asTriggerConfigError(err: unknown, context: string): TriggerConfigError {
  if (err instanceof TriggerConfigError) return err;
  if (err instanceof CronParseError) return new TriggerConfigError(`${context}: ${err.message}`);
  const msg = err instanceof Error ? err.message : String(err);
  return new TriggerConfigError(`${context}: ${msg}`);
}
