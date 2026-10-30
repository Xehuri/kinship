/**
 * commit body 预验（T14）—— v1 **不执行任何 git 操作**。
 *
 * 契约形状：验证器是**可注入断言函数**（CommitBodyAssertion）——装配层在切换日可换成
 * 真 git 探测；core 与测试用桩。本模块只定义契约 + 一个默认字段齐全性断言。
 *
 * 判定：
 *   - 未声明 commit body（null/undefined/纯空白）⇒ skipped；
 *   - 有声明 ⇒ 调断言，ok=false ⇒ fail（detail 列缺失字段）；
 *   - ok=true ⇒ pass。
 */

import type {
  CommitBodyAssertion,
  CommitBodyAssertionResult,
  VerificationCheck,
} from "./types.js";

/**
 * v1 默认必填字段（commit body 行首 `字段:` 声明）。
 * 冻结默认值；可被注入断言覆盖（本常量仅 defaultCommitBodyAssertion 消费）。
 */
export const COMMIT_BODY_REQUIRED_FIELDS = ["task", "verification", "tests"] as const;

/**
 * 默认断言：每个必填字段须以 `字段:` 形式出现（大小写不敏感、行首锚定、多行）。
 * 仅做字段齐全性检查 —— 不做 git 操作，符合 v1 边界。
 */
export function defaultCommitBodyAssertion(body: string): CommitBodyAssertionResult {
  const missing: string[] = [];
  for (const field of COMMIT_BODY_REQUIRED_FIELDS) {
    const re = new RegExp(`^\\s*${field}\\s*:`, "im");
    if (!re.test(body)) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

/** 对 commit body 跑注入断言（纯函数；不做 git）。 */
export function verifyCommitBody(
  body: string | null | undefined,
  assert: CommitBodyAssertion,
): VerificationCheck {
  if (body === null || body === undefined || body.trim() === "") {
    return { verdict: "skipped", detail: "未声明 commit body，跳过核验" };
  }
  const result = assert(body);
  if (!result.ok) {
    const fields = result.missing.length > 0 ? result.missing.join(", ") : "(断言未给出字段名)";
    return { verdict: "fail", detail: `commit body 缺必填字段：${fields}` };
  }
  return { verdict: "pass", detail: "commit body 必填字段齐全" };
}
