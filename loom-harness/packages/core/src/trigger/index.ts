// T15 cron 触发器（docs/02 §T15；D14/D15/D24/D31）。
// 消费方：T28 任务/运行域 API（排班定义读写）、server 装配（Scheduler → RunEngine.dispatch）。
//
// 分层：
//   cron.ts     —— 零依赖 cron 子集 parser + 本地时间匹配（纯函数）；
//   trigger.ts  —— fixture workflows 声明口径 → 强类型 TriggerDefinition + canonical cron；
//   scheduler.ts—— 注入时钟/提交端口的 tick 驱动调度器（无内部定时器）。
export {
  CronParseError,
  cronMatches,
  matchesCron,
  parseCron,
  type CronExpression,
  type CronField,
  type CronFieldName,
} from "./cron.js";

export {
  TriggerConfigError,
  asTriggerConfigError,
  compileSchedule,
  parseClockTime,
  parseTriggerDefinition,
  type TriggerDefinition,
  type TriggerScheduleSpec,
} from "./trigger.js";

export {
  TriggerScheduler,
  type RunSubmitSpec,
  type TriggerLog,
  type TriggerSchedulerOptions,
  type TriggerSubmitPort,
} from "./scheduler.js";
