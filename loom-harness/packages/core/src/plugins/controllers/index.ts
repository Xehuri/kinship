// loom 控制器层（T06 vendoring）：仅导出已移植集；
// fork/lifecycle/gap/orchestrate/compact-restart/compact-resume/persist-boundary 未移植（未引用即丢弃）。
export {
  subAgentTool,
  routedSubAgentTool,
  subAgentResult,
} from "./sub-agent-tool.js";
export type {
  SubAgentToolOptions,
  AgentSpec,
  RoutedSubAgentToolOptions,
} from "./sub-agent-tool.js";

export { SubAgentRegistry } from "./sub-agent-registry.js";
export type { SubAgentRegistryOptions } from "./sub-agent-registry.js";

export { WorkPool } from "./work-pool.js";
export type {
  WorkPoolOptions,
  WorkPoolResult,
  WorkItem,
  WorkGroup,
} from "./work-pool.js";

export { LeaseQueue } from "./lease-queue.js";
export type {
  LeaseQueueAttemptBackoffOptions,
  LeaseQueueOptions,
  LeaseQueueResult,
  QueueItem,
  QueueLease,
  LeaseStatus,
} from "./lease-queue.js";
