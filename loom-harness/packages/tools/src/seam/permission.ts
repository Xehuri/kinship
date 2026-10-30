/**
 * seam 权限引擎（T22，D25 权限部分）——纯函数、零依赖。
 *
 * 语义对齐 core/src/plugins/permission-gate.ts（fallback 默认 deny /
 * ask 无解析器 = fail-closed deny），但**不 import 其 Hook 形态**：缝求值发生在
 * tool 包装层，没有现成 HookContext，按任务要求以注入谓词方式接线，
 * 避免对 core-plugins 造成包依赖。
 *
 * 作用域：规则可带 {agent, workflow} 限定（"*" 为通配）。求值按 deny > ask >
 * allow 全局优先（deny 优先，fail-closed：泛化 deny 不被特定 allow 翻案），
 * 同级按特异性（全精确 > 单精确 > 全通配/缺省）再按声明顺序取首条。
 *
 * default-deny：无规则命中 → fallback（缺省 deny）。破坏性操作无规则时走
 * 「默认 ask」路径（docs/02 T22：ask(default deny for destructive)）：
 * 配了审批解析器 → 问人；没配（无人值守）→ 拒。
 */

import type {
  AskResolver,
  SeamCall,
  SeamDecision,
  SeamPermissionRule,
  ScopeKey,
} from "./types.js";

/** 求值上下文（由 executor 注入）。 */
export interface PermissionEvalOptions {
  readonly rules: readonly SeamPermissionRule[];
  /** 无命中兜底。缺省 "deny"（default-deny，fail-closed）。 */
  readonly fallback?: SeamDecision | undefined;
  /** ask 解析器；缺省 = 无人值守，ask → deny。 */
  readonly askResolver?: AskResolver | undefined;
  /** 无规则命中且操作破坏性时是否走默认 ask（缺省 true）。 */
  readonly destructiveDefaultAsk?: boolean | undefined;
}

/** 求值结果：verdict + 理由 + 命中规则名（审计用）。 */
export interface PermissionVerdict {
  readonly decision: SeamDecision;
  readonly reason: string;
  readonly ruleName?: string | undefined;
}

function ruleMatches(rule: SeamPermissionRule, call: SeamCall): boolean {
  if (typeof rule.match === "string") return rule.match === call.tool;
  return rule.match(call);
}

/** 规则作用域是否覆盖调用作用域。"*" 通配任一维；缺省 scope 视为全通配。 */
export function scopeCovers(ruleScope: ScopeKey | undefined, call: ScopeKey): boolean {
  if (!ruleScope) return true;
  const agentOk = ruleScope.agent === "*" || ruleScope.agent === call.agent;
  const workflowOk = ruleScope.workflow === "*" || ruleScope.workflow === call.workflow;
  return agentOk && workflowOk;
}

/** 特异性分层（数值越小越特定）：全精确=0，单维通配=1，全通配/缺省=2；不覆盖=Infinity。 */
function specificity(rule: SeamPermissionRule, call: SeamCall): number {
  if (!scopeCovers(rule.scope, call.scope)) return Number.POSITIVE_INFINITY;
  if (!rule.scope) return 2;
  const agentExact = rule.scope.agent !== "*";
  const workflowExact = rule.scope.workflow !== "*";
  if (agentExact && workflowExact) return 0;
  if (agentExact || workflowExact) return 1;
  return 2;
}

interface EvalHit {
  readonly rule: SeamPermissionRule;
  readonly idx: number;
  readonly tier: number;
}

const DECISION_RANK: Record<SeamDecision, number> = { deny: 0, ask: 1, allow: 2 };

/** 求值一条调用，语义见模块头。 */
export async function evaluatePermission(
  call: SeamCall,
  opts: PermissionEvalOptions,
): Promise<PermissionVerdict> {
  const hits: EvalHit[] = [];
  opts.rules.forEach((rule, idx) => {
    const tier = specificity(rule, call);
    if (tier < Number.POSITIVE_INFINITY && ruleMatches(rule, call)) {
      hits.push({ rule, idx, tier });
    }
  });

  const fallback: SeamDecision = opts.fallback ?? "deny";
  const noRuleVerdict: PermissionVerdict = {
    decision: fallback,
    reason: `no rule matched "${call.tool}" (default-deny)`,
  };

  if (hits.length === 0) {
    if (call.isDestructive && (opts.destructiveDefaultAsk ?? true)) {
      return resolveAsk(
        call,
        opts.askResolver,
        `no rule matched destructive tool "${call.tool}" (default ask)`,
      );
    }
    return noRuleVerdict;
  }

  // deny > ask > allow 全局优先；同级取最特异、再取声明序首条。
  hits.sort(
    (a, b) =>
      DECISION_RANK[a.rule.decision] - DECISION_RANK[b.rule.decision] ||
      a.tier - b.tier ||
      a.idx - b.idx,
  );
  const winner = hits[0];
  if (!winner) return noRuleVerdict;

  const rule = winner.rule;
  const label = rule.name ?? call.tool;
  const nameField = rule.name !== undefined ? { ruleName: rule.name } : {};

  if (rule.decision === "deny") {
    return { decision: "deny", reason: rule.reason ?? `rule "${label}" denied`, ...nameField };
  }
  if (rule.decision === "allow") {
    return { decision: "allow", reason: rule.reason ?? `rule "${label}" allowed`, ...nameField };
  }
  return resolveAsk(
    call,
    opts.askResolver,
    rule.reason ?? `rule "${label}" requires approval`,
    rule.name,
  );
}

async function resolveAsk(
  call: SeamCall,
  askResolver: AskResolver | undefined,
  reason: string,
  ruleName?: string | undefined,
): Promise<PermissionVerdict> {
  const nameField = ruleName !== undefined ? { ruleName } : {};
  if (!askResolver) {
    return { decision: "deny", reason: `${reason}; unattended (no approver)`, ...nameField };
  }
  const approved = await askResolver(call);
  return approved
    ? { decision: "allow", reason: `approved: ${reason}`, ...nameField }
    : { decision: "deny", reason: `approval denied: ${reason}`, ...nameField };
}
