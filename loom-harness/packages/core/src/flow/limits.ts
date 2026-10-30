/**
 * Flow 台账阈值（D1-D9 Wave 1 冻结值）。
 *
 * 计数口径（按 **session** 隔离，closed 不计入 active/waiting）：
 * - maxActive：state === "active" 的主体数上限；
 * - maxWaiting：state ∈ {waiting_user, waiting_event} 的主体数上限；
 * - maxSubjects：session 内全部主体（含 closed）行数上限；
 * - maxNotesBytes：notes 累计 UTF-8 字节数（不含分隔符）；
 * - maxNoteChars：单条 note 的 Unicode 码点数上限（与 deriveDigest 同口径）；
 * - maxEnvelopeBytes：工具结果信封上限，供 L2 截断使用；store 不据此限制提交输入，
 *   因为 notes 合法总量（16384B）大于信封上限。
 */
export interface FlowLimits {
  readonly maxSubjects: number;
  readonly maxActive: number;
  readonly maxWaiting: number;
  readonly maxNotesBytes: number;
  readonly maxNoteChars: number;
  readonly maxEnvelopeBytes: number;
  readonly minWakeLeadMs: number;
  readonly maxWakeHorizonMs: number;
}

export const FLOW_LIMITS: FlowLimits = Object.freeze({
  maxSubjects: 32,
  maxActive: 10,
  maxWaiting: 8,
  maxNotesBytes: 16384,
  maxNoteChars: 500,
  maxEnvelopeBytes: 4096,
  minWakeLeadMs: 5_000,
  maxWakeHorizonMs: 30 * 24 * 60 * 60 * 1000,
});
