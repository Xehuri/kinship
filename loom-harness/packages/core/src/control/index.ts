// T25 控制面（docs/02 §T25；D5/D15/D19/D22/D25）。
// 消费方：T28 Task/run-domain API（cancel + rerun 两指令）、server 装配（注入 RunEngine + 审计）。
export {
  DEFAULT_CANCEL_REASON,
  ControlPlane,
  type ControlPlaneOptions,
} from "./plane.js";

export {
  CONTROL_ACTORS,
  CONTROL_ACTIONS,
  ControlPlaneError,
  MemoryControlAudit,
  assertCanSpawnSide,
  canSpawnSide,
  isControlActor,
  type CancelOutcome,
  type CancelRequest,
  type ControlActor,
  type ControlAction,
  type ControlAuditEntry,
  type ControlAuditSink,
  type ControlLaunchOutcome,
  type RerunRequest,
  type SpawnSideRequest,
} from "./types.js";
