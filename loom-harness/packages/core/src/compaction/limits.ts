/**
 * CompactionLimits（T19，docs/01 D21「压缩定形」）—— 压缩例程全部阈值。
 *
 * 模式完全对齐 `convergence/limits.ts`（D26）：消费方注入一个**可变对象**，
 * `CompactionRoutine` 在每次判定时刻**现读**字段（不快照），热载改字段即刻对
 * 下一次 `evaluate` 生效。与收束 Limits（催办/同错/硬顶）正交：那是「单会话
 * 终止」阈值，这是「context 压力 → 压缩档位」阈值。
 *
 * 档位带（对估算 tokens，w = contextWindow）：
 *   - tokens <= w*watermarkRatio            → "none"（水位下**永不重压**，D21 触发=85% 水位）
 *   - w*watermarkRatio < tokens <= w*fullRatio → "micro"（先试廉价微压缩）
 *   - tokens > w*fullRatio                  → "full"（微压缩大概率救不动，规划直接压缩）
 * 注：即便规划为 "full"，执行仍**微压缩先行**（D21「分级微压缩先行」），
 * 清理后已回落到水位下就不再花 summarize 的钱（见 routine.compact）。
 */

export interface CompactionLimits {
  /** 有效 context 窗口（tokens）。须 > 0。默认 200_000（对齐测试 config 视图惯例）。 */
  contextWindow: number;
  /** 触发水位比例（D21 冻结 0.85）。须 ∈ (0, 1]。 */
  watermarkRatio: number;
  /** 规划直接 full 的比例（须 > watermarkRatio 且 ≤ 1）。默认 0.95。 */
  fullRatio: number;
  /**
   * 微压缩清理目标比例（vendor `microcompact.targetTokens` = w*本值）。
   * 须 ∈ (0, watermarkRatio]：清完即回落到水位以下，避免「压了又压」的反复。默认 0.75。
   */
  microTargetRatio: number;
  /** full 压缩后原样保留的最近消息条数（recent tail）。须 ≥ 1。默认 6（对齐 autoCompaction）。 */
  keepRecent: number;
  /** 微压缩永远保留原样的最近 N 条 toolResult（vendor `microcompact.keepRecent`）。须 ≥ 0。默认 5。 */
  microKeepRecent: number;
}

export const DEFAULT_COMPACTION_LIMITS: CompactionLimits = {
  contextWindow: 200_000,
  watermarkRatio: 0.85,
  fullRatio: 0.95,
  microTargetRatio: 0.75,
  keepRecent: 6,
  microKeepRecent: 5,
};

export function assertValidCompactionLimits(limits: CompactionLimits): void {
  if (
    !(limits.contextWindow > 0) ||
    !(limits.watermarkRatio > 0 && limits.watermarkRatio <= 1) ||
    !(limits.fullRatio > limits.watermarkRatio && limits.fullRatio <= 1) ||
    !(limits.microTargetRatio > 0 && limits.microTargetRatio <= limits.watermarkRatio) ||
    !Number.isInteger(limits.keepRecent) ||
    limits.keepRecent < 1 ||
    !Number.isInteger(limits.microKeepRecent) ||
    limits.microKeepRecent < 0
  ) {
    throw new Error(`invalid compaction Limits: ${JSON.stringify(limits)}`);
  }
}
