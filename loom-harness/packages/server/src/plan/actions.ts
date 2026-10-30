/**
 * 统一唤醒队列的动作词表。
 *
 * 每个唤醒条目只带一个动作，动作同时决定两件事：
 *   - 是否必须核对当天覆盖（coverage）；
 *   - 是否允许在唤醒后向用户发通知。
 *
 * 条目缺省动作按来源与条目 id 兜底；id 若本身就是动作名，优先采用 id。
 */

export const WAKE_ACTIONS = [
  "plan.build",
  "plan.review",
  "coverage.run",
  "review.daily",
  "review.weekly",
  "review.biweekly",
  "audit.night",
  "weather.morning",
  "session.compact",
  "probe.run",
  "fleet.run",
  "longterm.due",
  "flow.check",
  "special.continue",
] as const;

export type WakeAction = (typeof WAKE_ACTIONS)[number];

export const WAKE_SOURCES = ["master", "anchor", "long_term", "flow", "special"] as const;

export type WakeSource = (typeof WAKE_SOURCES)[number];

const ACTION_SET: ReadonlySet<string> = new Set(WAKE_ACTIONS);
const SOURCE_SET: ReadonlySet<string> = new Set(WAKE_SOURCES);

export function isWakeAction(value: unknown): value is WakeAction {
  return typeof value === "string" && ACTION_SET.has(value);
}

export function isWakeSource(value: unknown): value is WakeSource {
  return typeof value === "string" && SOURCE_SET.has(value);
}

/** 来源兜底：条目没写动作时按来源取一个保守动作。 */
const SOURCE_DEFAULT_ACTIONS: Readonly<Record<WakeSource, WakeAction>> = {
  master: "plan.build",
  anchor: "coverage.run",
  long_term: "longterm.due",
  flow: "flow.check",
  special: "special.continue",
};

/** 已知历史任务 id 的显式映射；未知 id 仍回落到来源兜底。 */
const ID_ACTION_OVERRIDES: ReadonlyMap<string, WakeAction> = new Map([
  ["05-plan-wake", "plan.build"],
  ["07-plan-review", "plan.review"],
  ["12-daily-review", "review.daily"],
  ["13-biweekly-review", "review.biweekly"],
  ["14-weekly-summary", "review.weekly"],
  ["15-night-audit", "audit.night"],
]);

export function defaultActionFor(source: WakeSource, id: string): WakeAction {
  if (isWakeAction(id)) return id;
  const override = ID_ACTION_OVERRIDES.get(id);
  if (override !== undefined) return override;
  return SOURCE_DEFAULT_ACTIONS[source];
}

function assertNever(value: never): never {
  throw new Error(`unhandled wake action: ${String(value)}`);
}

/** 该动作完成后是否必须核对当天覆盖。 */
export function actionRequiresCoverage(action: WakeAction): boolean {
  switch (action) {
    case "plan.build":
      return false;
    case "plan.review":
      return false;
    case "coverage.run":
      return true;
    case "review.daily":
      return true;
    case "review.weekly":
      return true;
    case "review.biweekly":
      return true;
    case "audit.night":
      return true;
    case "weather.morning":
      return false;
    case "session.compact":
      return false;
    case "probe.run":
      return false;
    case "fleet.run":
      return false;
    case "longterm.due":
      return false;
    case "flow.check":
      return false;
    case "special.continue":
      return false;
    default:
      return assertNever(action);
  }
}

/** 该动作是否属于静默动作（唤醒轮不向用户发通知）。 */
export function actionIsSilent(action: WakeAction): boolean {
  switch (action) {
    case "plan.build":
      return true;
    case "plan.review":
      return true;
    case "coverage.run":
      return true;
    case "review.daily":
      return false;
    case "review.weekly":
      return false;
    case "review.biweekly":
      return false;
    case "audit.night":
      return true;
    case "weather.morning":
      return false;
    case "session.compact":
      return true;
    case "probe.run":
      return true;
    case "fleet.run":
      return true;
    case "longterm.due":
      return false;
    case "flow.check":
      return true;
    case "special.continue":
      return false;
    default:
      return assertNever(action);
  }
}
