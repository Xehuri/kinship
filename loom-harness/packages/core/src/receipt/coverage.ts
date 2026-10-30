/**
 * coverage 预验（T14）—— check_coverage 类校验的通用形状。
 *
 * 声明 `{checked, total}`：覆盖率 = checked/total，达到阈值（默认 1）⇒ pass。
 * 判定：
 *   - 未声明                  ⇒ skipped；
 *   - 声明非法（非整数/负数/checked>total）⇒ fail（不可信输入响亮拒）；
 *   - total=0                 ⇒ skipped（无可核验项）；
 *   - 覆盖率 < 阈值            ⇒ fail（detail 给比值与阈值）；
 *   - 覆盖率 >= 阈值           ⇒ pass。
 */

import type { CoverageDeclaration, VerificationCheck } from "./types.js";

/** 默认覆盖率阈值：1 = 全部检查项必须通过。 */
export const DEFAULT_COVERAGE_THRESHOLD = 1;

export function verifyCoverage(
  decl: CoverageDeclaration | null | undefined,
  threshold: number = DEFAULT_COVERAGE_THRESHOLD,
): VerificationCheck {
  if (decl === null || decl === undefined) {
    return { verdict: "skipped", detail: "未声明 coverage，跳过核验" };
  }

  const { checked, total } = decl;
  if (
    !Number.isInteger(checked) ||
    !Number.isInteger(total) ||
    checked < 0 ||
    total < 0 ||
    checked > total
  ) {
    return {
      verdict: "fail",
      detail: `coverage 声明非法：checked=${checked}, total=${total}`,
    };
  }

  if (total === 0) {
    return { verdict: "skipped", detail: "coverage 总数为 0，无可核验项" };
  }

  const ratio = checked / total;
  if (ratio < threshold) {
    return {
      verdict: "fail",
      detail: `coverage 未达标：${checked}/${total}（阈值 ${threshold}）`,
    };
  }
  return { verdict: "pass", detail: `coverage 达标：${checked}/${total}` };
}
