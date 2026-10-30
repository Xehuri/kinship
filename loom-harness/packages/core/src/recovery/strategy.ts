/**
 * T13 追赶策略选择 —— 纯函数层（无副作用、无内存态）。
 *
 * 职责：把「同 workflow 的缺口集合」按策略折成「候选补跑集合 + 被跳过集合」。
 * 策略语义（docs/01 D15）：
 *   latest —— 只在候选中留最近一班（按 expected 时刻降序取首个），其余 skip(superseded)；
 *   all    —— 全部候选；
 *   none   —— 无候选，全部 skip(strategy-none)，纯 no-op。
 *
 * 排序稳定性：先按 `at` 降序，同 `at` 再按 run_id 字典序升序 —— 保证 latest 选择确定可复现。
 */

import type { RunRow } from "../run-engine/index.js";
import { RecoveryError, type CatchupStrategy, type GapRun, type SkipReason } from "./types.js";

/**
 * 重试级别判定（D19）：完全由账本已持久化的 trigger 决定，无内存状态。
 *   trigger === "auto-resume" → level 1（同 run 同会话 resume）；
 *   其余                       → level 2（新会话补跑）。
 */
export function retryLevelOf(run: RunRow): 1 | 2 {
  return run.trigger === "auto-resume" ? 1 : 2;
}

/** 缺口按「最近优先」排序：at 降序，同 at 按 run_id 升序（确定性 tie-break）。 */
export function orderGapsByRecency(gaps: readonly GapRun[]): GapRun[] {
  return [...gaps].sort((a, b) => {
    if (b.at !== a.at) return b.at - a.at;
    if (a.run.run_id < b.run.run_id) return -1;
    if (a.run.run_id > b.run.run_id) return 1;
    return 0;
  });
}

/** 策略选择结果：候选（要补跑）+ 被跳过（附原因）。 */
export interface CandidateSelection {
  readonly candidates: readonly GapRun[];
  readonly skipped: readonly { readonly gap: GapRun; readonly reason: SkipReason }[];
}

/**
 * 按策略折缺口 → 候选/跳过。空差集恒返回双空（no-op）。
 * `strategy` 为不可信边界值（配置热载），非法即响亮抛 RecoveryError。
 */
export function selectCandidates(
  gaps: readonly GapRun[],
  strategy: CatchupStrategy,
): CandidateSelection {
  if (gaps.length === 0) {
    return { candidates: [], skipped: [] };
  }
  switch (strategy) {
    case "none":
      return {
        candidates: [],
        skipped: gaps.map((gap) => ({ gap, reason: "strategy-none" as const })),
      };
    case "all":
      return { candidates: [...gaps], skipped: [] };
    case "latest": {
      const ordered = orderGapsByRecency(gaps);
      const newest = ordered[0];
      if (newest === undefined) {
        return { candidates: [], skipped: [] };
      }
      return {
        candidates: [newest],
        skipped: ordered
          .slice(1)
          .map((gap) => ({ gap, reason: "strategy-latest-superseded" as const })),
      };
    }
    default: {
      const unreachable: never = strategy;
      throw new RecoveryError(
        "run-row",
        `unhandled catchup strategy: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
