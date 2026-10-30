/**
 * SubagentLimits（T11）—— 子智能体派发的横/纵两闸阈值。
 *
 * 模式完全对齐 `convergence/limits.ts`（D26）：消费方注入一个**可变对象**，
 * task 工具在每次派发时刻**现读**字段（不快照），热载改字段即刻对下一次派发生效。
 * 与收束 Limits（催办/同错/硬顶）正交：那是「单会话终止」阈值，这是「派发扇出/嵌套」阈值。
 */

export interface SubagentLimits {
  /**
   * **横向**闸：同一 task 工具实例上，同时在飞的子智能体上限（并发扇出）。
   * 到顶即拒绝新派发（throw → isError 回灌模型，绝不排队静默等）。冻结默认 8
   * （对齐 vendored subAgentTool maxSubAgents 默认值）。
   */
  maxFanout: number;
  /**
   * **纵向**闸：从主会话（depth 0）算起，最多允许「在第几层的会话上再 spawn」。
   * 语义同 vendored #45：`depth >= maxDepth` 即拒绝。默认 2 → 主(0) spawn 子(1)、
   * 子 spawn 孙(2) 允许；孙再 spawn（其 ctx depth=2）被挡。
   */
  maxDepth: number;
  /**
   * W9 切片 3 **总量**闸：后台 sub 账本册的非终态总数上限（跨所有门面合计）。
   * 到顶 fail-loud 不排队（同 maxFanout 裁决文案风格）。可选——缺省读
   * DEFAULT_MAX_INFLIGHT_TOTAL（16）；**不进 DEFAULT_SUBAGENT_LIMITS 对象**
   * （旧对象形状逐字节 = 既有 toEqual 测试零扰动），显式给值=热载覆盖。
   */
  maxInflightTotal?: number;
  /**
   * W9 切片 3 后台 deadline：每个后台任务强制超时（内核定时器到点 cancel(reason:"deadline")
   * = 既有 failed+cancelRequested 形状，零新状态）。缺省 DEFAULT_BACKGROUND_DEADLINE_MS（15min）。
   */
  backgroundDeadlineMs?: number;
}

/** 总量闸缺省（后台账本在册非终态上限）。 */
export const DEFAULT_MAX_INFLIGHT_TOTAL = 16;

/** 后台 deadline 缺省：15 分钟。 */
export const DEFAULT_BACKGROUND_DEADLINE_MS = 15 * 60 * 1000;

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxFanout: 8,
  maxDepth: 2,
};

export function assertValidSubagentLimits(limits: SubagentLimits): void {
  if (
    !Number.isInteger(limits.maxFanout) ||
    limits.maxFanout < 1 ||
    !Number.isInteger(limits.maxDepth) ||
    limits.maxDepth < 1
  ) {
    throw new Error(`invalid subagent Limits: ${JSON.stringify(limits)}`);
  }
  // W9 切片 3：新闸给值才校验（缺省走常量，旧对象形状不动）。
  if (limits.maxInflightTotal !== undefined && (!Number.isInteger(limits.maxInflightTotal) || limits.maxInflightTotal < 1)) {
    throw new Error(`invalid subagent Limits: maxInflightTotal must be integer >= 1 (got ${String(limits.maxInflightTotal)})`);
  }
  if (limits.backgroundDeadlineMs !== undefined && (!Number.isInteger(limits.backgroundDeadlineMs) || limits.backgroundDeadlineMs < 1)) {
    throw new Error(`invalid subagent Limits: backgroundDeadlineMs must be integer >= 1 (got ${String(limits.backgroundDeadlineMs)})`);
  }
}
