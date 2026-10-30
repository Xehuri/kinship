/**
 * Flow 提交信号槽（L2 写 / L3 读 / L4 消费）。
 *
 * 工具 execute 只写槽、不做终止决策；flow gate 在 onTurnEnd 用
 * `session_id + turn_idx` 双匹配确认「本回合的提交」，再决定是否终止。
 * 槽故意不随回合清除：过期槽由双匹配判据拒绝，影子并行期 converge gate
 * 也能读到同一信号决定让位。
 */

import { defineSlot } from "../hook.js";
import type { FlowState } from "./types.js";

/** 一次已受理 flow_commit 的最小公共投影；不含 notes 等大体量字段。 */
export interface FlowCommitSlot {
  readonly session_id: string;
  readonly subject_id: string;
  readonly subject_name: string;
  readonly state: FlowState;
  readonly next_decision_at: number | null;
  readonly version: number;
  readonly turn_idx: number;
}

export const FLOW_COMMIT_SLOT = defineSlot<FlowCommitSlot | null>("flow.committed", {
  owner: "flow",
});
