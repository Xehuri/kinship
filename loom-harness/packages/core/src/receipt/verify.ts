/**
 * T14 回执验证编排 —— runVerification / 降级映射 / buildReceipt。
 *
 * 职责分工（docs/02 §T14）：
 *   - runVerification：把三项预验（manifest / commit_body / coverage）跑成一个
 *     VerificationBlock（纯函数，依赖全部注入）；
 *   - applyVerificationDowngrade：验证不通过 ⇒ **status 降级**（映射表见下）；
 *   - buildReceipt：把账本 RunRow（identity 真源）+ 引擎终态 + 预验块组装成
 *     持久化 HarnessReceipt（D23 冻结字面键名）。
 *
 * 降级映射表（写死、表驱动测试，见 receipt.test.ts）：
 *   verification 无 fail ⇒ 原样；
 *   done    + 有 fail ⇒ partial（产物/契约有瑕，非全败）；
 *   partial + 有 fail ⇒ failed；
 *   failed  + 有 fail ⇒ failed（已最低，幂等）。
 *
 * 「有 fail」= 三项中任一项 verdict === "fail"；skipped 不算失败（无声明≠失败）。
 */

import type { SideStatus } from "../convergence/index.js";
import type {
  HarnessReceipt,
  ReceiptBuildInput,
  VerificationBlock,
  VerificationCheck,
  VerificationDeps,
  VerificationInput,
} from "./types.js";
import { manifestFromPointers, verifyManifest } from "./manifest.js";
import { verifyCommitBody } from "./commit-body.js";
import { verifyCoverage } from "./coverage.js";

/** 三项预验全跑（纯函数）。manifest 缺省时从 `file:` pointers 派生。 */
export function runVerification(
  input: VerificationInput,
  deps: VerificationDeps,
): VerificationBlock {
  const entries = input.manifest ?? manifestFromPointers(input.pointers);
  const manifest = verifyManifest(entries, deps.artifactProbe);
  const commit_body = verifyCommitBody(input.commitBody ?? null, deps.commitBodyAssertion);
  const coverage = verifyCoverage(input.coverage ?? null, input.coverageThreshold);
  return { manifest, commit_body, coverage };
}

/** 三项中是否有 fail（skipped 不算）。 */
export function verificationFailed(block: VerificationBlock): boolean {
  const checks: readonly VerificationCheck[] = [block.manifest, block.commit_body, block.coverage];
  return checks.some((c): boolean => c.verdict === "fail");
}

/**
 * status 降级（映射表见文件头）。
 * 注意：**绝不**静默把 fail 升格为成功；只做「更保守」的单向降级。
 */
export function applyVerificationDowngrade(
  status: SideStatus,
  block: VerificationBlock,
): SideStatus {
  if (!verificationFailed(block)) return status;
  switch (status) {
    case "done":
      return "partial";
    case "partial":
      return "failed";
    case "failed":
      return "failed";
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled SideStatus: ${String(unreachable)}`);
    }
  }
}

/**
 * 组装持久化回执。identity（run_id/workflow/attempt）以账本 RunRow 为真源；
 * digest/pointers/dispositions 取引擎终态（T12 RunLaunchResult）；
 * status 经验证降级后落定。
 */
export function buildReceipt(input: ReceiptBuildInput): HarnessReceipt {
  const { row, result, verification } = input;
  const status = applyVerificationDowngrade(result.status, verification);
  return {
    run_id: row.run_id,
    workflow: row.workflow,
    status,
    attempt: row.attempt,
    verification,
    digest: result.digest,
    dispositions: [...result.blockers],
    pointers: [...result.pointers],
  };
}
