// W9 切片 1 统一 spawn 内核（SpawnKernel/唯一 AgentSession 工厂/类型词表）。
// 消费入口：run-engine 门面（生命周期委托）、side-session-port（converge 工厂）、
// task-tool 与 serve tool-wiring（sub 工厂）、boot（进程单例装配）。

export {
  SpawnKernel,
  buildConvergeSession,
  buildSubSession,
  type SpawnKernelOptions,
} from "./kernel.js";
export {
  terminalProfileOf,
  type ConvergeSessionBundle,
  type ConvergeSessionProfile,
  type KernelHandle,
  type KernelRunRecord,
  type KernelSpawnResult,
  type SpawnPolicy,
  type SpawnRunPolicy,
  type SpawnSubBackgroundArgs,
  type SpawnSubPolicy,
  type SubBackgroundHandle,
  type SubBackgroundPort,
  type SubFanout,
  type SubSessionProfile,
  type SubTaskRecord,
  type TaskIndexPort,
  type TaskSurface,
  type TerminalProfile,
} from "./types.js";
