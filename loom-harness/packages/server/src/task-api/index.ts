// T28 任务/运行域 API 出口（dispatch/list/detail/cancel/rerun + pause 只读开关查询）。
// 消费者：T31 serve 装配（registerTaskRoutes）、T38 契约验收。
export { registerTaskRoutes } from "./routes.js";
export { detailOf, pauseStateOf, toRunView, type DetailSources } from "./views.js";
export { normalizeRunID, paramRunID, toHttpError } from "./helpers.js";
export type {
  LedgerJoin,
  LedgerRowsSource,
  PauseStateView,
  RunDetailView,
  RunView,
  RunViewStatus,
  TaskApiDeps,
  TaskApiTraceOptions,
} from "./types.js";
