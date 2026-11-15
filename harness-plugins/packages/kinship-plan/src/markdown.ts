/**
 * Human-readable rendering of the JSON truth file. The markdown is derived:
 * it is never parsed back and a failed markdown write can be healed by the
 * next successful write.
 *
 * @module kinship-plan/markdown
 */

import type { PlanDocument, PlanItem } from './schema.js'

function bullet(label: string, value: string): string {
  return `- ${label}: ${value}`
}

function renderItem(lines: string[], item: PlanItem): void {
  lines.push(`### ${item.id} [${item.kind}] ${item.intent}`, '')
  lines.push(bullet('状态', item.status))
  if (item.target_date !== undefined) lines.push(bullet('目标日期', item.target_date))
  if (item.window !== undefined) lines.push(bullet('时间窗口', item.window))
  if (item.checkpoint_id !== undefined) lines.push(bullet('检查点', item.checkpoint_id))
  if (item.done_when !== undefined) lines.push(bullet('完成条件', item.done_when))
  if (item.not_do !== undefined) lines.push(bullet('不做', item.not_do.join(' | ')))
  if (item.source !== undefined) lines.push(bullet('来源', item.source))
  if (item.note !== undefined) lines.push(bullet('备注', item.note))
  if (item.done_at !== undefined) lines.push(bullet('完成时间', item.done_at))
  if (item.evidence !== undefined) lines.push(bullet('证据', item.evidence))
  lines.push('')
}

/** Render one plan document as human-readable Markdown. */
export function renderPlanMarkdown(plan: PlanDocument): string {
  const lines: string[] = []
  lines.push(`# ${plan.date} 计划`, '')
  lines.push(bullet('状态', plan.status))
  lines.push(bullet('版本', String(plan.version)))
  if (plan.review_at !== undefined) lines.push(bullet('复查', plan.review_at))
  const intent = plan.extra['user_intent']
  if (typeof intent === 'string' && intent !== '') lines.push(bullet('用户意图', intent))
  lines.push('', '## 条目', '')
  if (plan.items.length === 0) {
    lines.push('（空计划）', '')
  } else {
    for (const item of plan.items) renderItem(lines, item)
  }
  lines.push('## 笔记', '')
  if (plan.notes.length === 0) {
    lines.push('（无）')
  } else {
    for (const note of plan.notes) lines.push(`- ${note}`)
  }
  if (plan.carry_over !== undefined) {
    lines.push('', '## carry_over', '')
    lines.push(bullet('结转日期', plan.carry_over.to))
    lines.push(bullet('生成时间', String(plan.carry_over.created_at)))
    lines.push('')
    for (const item of plan.carry_over.items) {
      lines.push(bullet(item.id, `${item.status} ${item.intent}`))
    }
  }
  return `${lines.join('\n')}\n`
}
