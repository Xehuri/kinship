// T10 主会话长循环（abort/steer/resume + 孤尾修复 + deliver 边界消费 + 收束终止接线）。
// 下游消费：T27 session-domain API / T33 golden-path / T38 前端契约。

export { MainSessionLoop } from "./loop.js";
export type { MainSessionLoopResumeOptions } from "./loop.js";

export { TurnBoundary } from "./boundary.js";

export {
  budgetExhaustedReceipt,
  classifyOutcome,
  classifyTerminal,
  forceMarker,
} from "./outcome.js";
export type { TerminalDecision } from "./outcome.js";

export type {
  AssemblyPlanRefreshResult,
  ForceEndCause,
  LoopEvent,
  MainAssemblyOptions,
  MainLoopResult,
  MainSessionLoopOptions,
  OutcomeDisposition,
} from "./types.js";
