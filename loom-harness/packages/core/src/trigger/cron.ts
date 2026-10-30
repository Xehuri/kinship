/**
 * T15 cron 表达式解析 —— 零依赖手写子集实现（docs/02 §T15；决策 docs/01 D14/D15/D24）。
 *
 * 为什么手写：T15 MUST DO 明确「零依赖手写 cron parser（不引第三方）」，且本 harness
 * 只消费一个**受控子集**——五字段（分 时 日 月 周）+ 四个元字符（`*` `,` `-` `/`），
 * 不做 vixie 的月份/星期英文别名、不做 @daily 宏、不做秒字段。够用即止，行为可审计。
 *
 * 语义契约（冻结，测试逐条断言）：
 *   - 字段序：minute hour day-of-month month day-of-week；
 *   - 取值域：分 0-59 / 时 0-23 / 日 1-31 / 月 1-12 / 周 0-7（7 归一为 0=周日）；
 *   - `*` 全量；`a` 单值；`a-b` 闭区间；`a/b`（从 a 起每 b 步，缺 a 视 `*`）；
 *   - `a-b/c` 区间步进；逗号并列多段（`1,15`、`1-5/2,30`）；
 *   - 日/周 OR 语义（vixie 惯例）：两字段都非 `*` 开头时满足其一即命中；
 *     任一以 `*` 开头时按 AND 处理（`*` 字段恒真，退化为另一字段单独判定）。
 *
 * 时钟语义：**只读 Date 的本地字段**（getMinutes/getHours/...），不碰时区库。
 * 注入时钟由 Scheduler 提供（假时钟快进），本模块纯函数、无状态、可表驱动。
 */

/** 五字段名（顺序即位置）。 */
export type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

/** 各字段取值域（dayOfWeek 上界 7 仅作输入别名，归一后不会留下 7）。 */
const FIELD_BOUNDS: Readonly<Record<CronFieldName, { readonly min: number; readonly max: number }>> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

/** 字段位置顺序（与 cron 文本一致）。 */
const FIELD_ORDER: readonly CronFieldName[] = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"];

/** 类型化解析错误（fail-loud；message 带字段标签便于定位，照 RunEngineError 惯例）。 */
export class CronParseError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[cron:${field}] ${message}`);
    this.name = "CronParseError";
    this.field = field;
  }
}

/** 解析后的单个字段：原始文本 + 展开后的值集合（匹配只查集合，O(1)）。 */
export interface CronField {
  readonly name: CronFieldName;
  readonly raw: string;
  readonly values: ReadonlySet<number>;
}

/** 解析后的完整表达式（对外只读；matches 系列消费）。 */
export interface CronExpression {
  /** 规范化后的五字段文本（trim + 单空格分隔）。 */
  readonly source: string;
  readonly fields: {
    readonly minute: CronField;
    readonly hour: CronField;
    readonly dayOfMonth: CronField;
    readonly month: CronField;
    readonly dayOfWeek: CronField;
  };
  /** 日字段是否受限（非 `*` 开头）——OR 语义判定用。 */
  readonly domRestricted: boolean;
  /** 周字段是否受限（非 `*` 开头）——OR 语义判定用。 */
  readonly dowRestricted: boolean;
}

/** 单个数值 token 解析（必须是纯十进制，拒绝 `+1`/`1.0`/空）。 */
function parseNum(token: string | undefined, field: CronFieldName, raw: string): number {
  if (token === undefined || token === "") {
    throw new CronParseError(field, `字段 "${raw}" 含空数值段`);
  }
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(field, `字段 "${raw}" 的 "${token}" 非十进制整数`);
  }
  return Number(token);
}

/**
 * 解析单字段为值集合。支持 `*` `a` `a-b` `a/b` `a-b/c` 及逗号并列；
 * 越界/倒序/零步长/非法 token 一律抛 CronParseError。
 */
function parseField(raw: string, name: CronFieldName): CronField {
  if (raw === "") {
    throw new CronParseError(name, "字段为空");
  }
  const bounds = FIELD_BOUNDS[name];
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    if (part === "") {
      throw new CronParseError(name, `字段 "${raw}" 含空列表段（多余逗号）`);
    }
    const segments = part.split("/");
    if (segments.length > 2) {
      throw new CronParseError(name, `字段 "${raw}" 的 "${part}" 含多个 "/"`);
    }
    const rangePart = segments[0] ?? "";
    const stepPart = segments[1];

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new CronParseError(name, `字段 "${raw}" 的步长 "${stepPart}" 非十进制整数`);
      }
      step = Number(stepPart);
      if (step < 1) {
        throw new CronParseError(name, `字段 "${raw}" 的步长必须 >= 1（得 ${step}）`);
      }
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = bounds.min;
      end = bounds.max;
    } else if (rangePart.includes("-")) {
      const halves = rangePart.split("-");
      if (halves.length !== 2) {
        throw new CronParseError(name, `字段 "${raw}" 的区间 "${rangePart}" 形状非法`);
      }
      start = parseNum(halves[0], name, raw);
      end = parseNum(halves[1], name, raw);
      if (start > end) {
        throw new CronParseError(name, `字段 "${raw}" 的区间 "${rangePart}" 起止倒序`);
      }
    } else {
      start = parseNum(rangePart, name, raw);
      // 无步长=单值；有步长=从该值起跨到字段上界（cron 惯例 `n/step`）。
      end = stepPart !== undefined ? bounds.max : start;
    }

    if (start < bounds.min || start > bounds.max || end < bounds.min || end > bounds.max) {
      throw new CronParseError(
        name,
        `字段 "${raw}" 取值超出 [${bounds.min},${bounds.max}]（得 ${start}..${end}）`,
      );
    }

    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }

  // 周日别名归一：7 → 0（输入侧容忍 0-7，匹配侧 Date.getDay() 恒 0-6）。
  if (name === "dayOfWeek" && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  if (values.size === 0) {
    throw new CronParseError(name, `字段 "${raw}" 未展开出任何值`);
  }
  return { name, raw, values };
}

/** 解析五字段 cron 表达式；非法即抛 CronParseError（绝不静默降级）。 */
export function parseCron(source: string): CronExpression {
  if (typeof source !== "string" || source.trim() === "") {
    throw new CronParseError("expression", "表达式为空");
  }
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      "expression",
      `需要恰好 5 个字段（分 时 日 月 周），得 ${parts.length}：${JSON.stringify(source)}`,
    );
  }

  const byName = new Map<CronFieldName, CronField>();
  for (let i = 0; i < FIELD_ORDER.length; i += 1) {
    const name = FIELD_ORDER[i];
    const raw = parts[i];
    if (name === undefined || raw === undefined) {
      throw new CronParseError("expression", `表达式 "${source}" 字段数不符`);
    }
    byName.set(name, parseField(raw, name));
  }

  const minute = byName.get("minute");
  const hour = byName.get("hour");
  const dayOfMonth = byName.get("dayOfMonth");
  const month = byName.get("month");
  const dayOfWeek = byName.get("dayOfWeek");
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new CronParseError("expression", "内部错误：字段装配不完整");
  }

  return {
    source: parts.join(" "),
    fields: { minute, hour, dayOfMonth, month, dayOfWeek },
    domRestricted: !dayOfMonth.raw.startsWith("*"),
    dowRestricted: !dayOfWeek.raw.startsWith("*"),
  };
}

/** 周字段匹配（容忍传入 7，归一为 0）。 */
function dayOfWeekMatches(field: CronField, value: number): boolean {
  return field.values.has(value === 7 ? 0 : value);
}

/**
 * 判定某时刻是否命中表达式。**本地时间**字段判定，无时区换算。
 * 日/周 OR 语义见文件头（vixie 惯例）。
 */
export function matchesCron(expr: CronExpression, at: Date): boolean {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = expr.fields;

  if (!minute.values.has(at.getMinutes())) return false;
  if (!hour.values.has(at.getHours())) return false;
  if (!month.values.has(at.getMonth() + 1)) return false;

  const domHit = dayOfMonth.values.has(at.getDate());
  const dowHit = dayOfWeekMatches(dayOfWeek, at.getDay());

  // 两字段都受限 → 满足其一（OR）；否则按 AND（未受限字段恒真）。
  if (expr.domRestricted && expr.dowRestricted) {
    return domHit || dowHit;
  }
  return domHit && dowHit;
}

/** `matchesCron` 的便捷别名（表驱动测试读起来更顺）。 */
export function cronMatches(expr: CronExpression, at: Date): boolean {
  return matchesCron(expr, at);
}
