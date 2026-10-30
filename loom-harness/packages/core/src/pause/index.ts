// T17 排班暂停开关（docs/02 §T17；D31）。
// 消费方：server 装配（RunEngineOptions.admission = new PauseAdmission(...)）、
// T28 API（暂停开关读写）、T15 cron（尊重开关=经同一准入钩子即自动生效）。
export {
  PAUSE_REASON,
  MemoryPauseAudit,
  PauseAdmission,
  PauseSwitchBoard,
  type PauseAdmissionOptions,
  type PauseAuditEntry,
  type PauseAuditSink,
  type PauseSwitches,
  type PauseSwitchSource,
} from "./pause.js";
