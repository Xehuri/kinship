/**
 * Limits（D26）—— 收束机制全部阈值。热载可改：消费方注入一个可变对象，
 * gate/tool 在每个事件时刻现读字段（不快照），改字段即刻对下一次判定生效。
 * 默认值 = docs/01 D26 冻结值。
 */

export interface Limits {
  /** 空转/字段不齐催办上限：达到即升级强制分级收束。冻结值 5。 */
  nudgeLimit: number;
  /** 同工具同错误升级提示阈值。冻结值 3。 */
  escalateSameError: number;
  /** 单请求轮数硬顶：第 N turn 末未收束即强制分级收束。冻结值 60。 */
  turnHardCap: number;
  /** 跨请求自动续跑上限（T10/T13 消费；gate 仅透出预算校验）。冻结值 2。 */
  autoContinuations: number;
}

export const DEFAULT_LIMITS: Limits = {
  nudgeLimit: 5,
  escalateSameError: 3,
  turnHardCap: 60,
  autoContinuations: 2,
};

export function assertValidLimits(limits: Limits): void {
  if (
    !Number.isInteger(limits.nudgeLimit) ||
    limits.nudgeLimit < 1 ||
    !Number.isInteger(limits.escalateSameError) ||
    limits.escalateSameError < 1 ||
    !Number.isInteger(limits.turnHardCap) ||
    limits.turnHardCap < 1 ||
    !Number.isInteger(limits.autoContinuations) ||
    limits.autoContinuations < 0
  ) {
    throw new Error(`invalid convergence Limits: ${JSON.stringify(limits)}`);
  }
}
