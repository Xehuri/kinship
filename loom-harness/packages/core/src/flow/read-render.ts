/**
 * flow_list / flow_get 的模型可见渲染与信封裁剪（内部模块）。
 *
 * 所有时间一律经 formatFlowTime 渲染成本地时区 + 显式偏移，禁止 toISOString 的 UTC「Z」；
 * 文本严格控制在 FLOW_LIMITS.maxEnvelopeBytes 内，超出时丢行/丢笔记并显式标注截断。
 */

import { FLOW_LIMITS } from "./limits.js";
import { FLOW_DISPLAY_TIME_ZONE, formatFlowTime } from "./time.js";
import type { FlowSubject } from "./types.js";

/** 列表行里 latest note 的码点上限（与 FLOW_LIMITS.maxNoteChars 无关，纯展示口径）。 */
export const FLOW_LIST_NOTE_CODEPOINTS = 120;

export interface RenderedNote {
  /** 1-based 绝对序号（在 subject.notes 里的位置）。 */
  readonly index: number;
  readonly text: string;
}

export interface FittedListText {
  readonly text: string;
  readonly shown: number;
  readonly truncated: boolean;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 按 Unicode 码点截断；只有真的超长才补省略号。 */
export function truncateCodepoints(text: string, max: number): string {
  const codepoints = Array.from(text);
  if (codepoints.length <= max) return text;
  return `${codepoints.slice(0, max).join("")}…`;
}

export function latestNoteOf(subject: FlowSubject): string | null {
  const last = subject.notes[subject.notes.length - 1];
  if (last === undefined) return null;
  return truncateCodepoints(
    collapseWhitespace(last),
    FLOW_LIST_NOTE_CODEPOINTS,
  );
}

export function formatInstant(
  at: number | null,
  timeZone: string | null | undefined,
): string {
  if (at === null) return "-";
  return formatFlowTime(at, timeZone ?? FLOW_DISPLAY_TIME_ZONE);
}

export function listHeader(
  total: number,
  active: number,
  waiting: number,
): string {
  if (total === 0) return "flow_list: 0 subjects";
  return `flow_list: ${total} subjects (active=${active}, waiting=${waiting})`;
}

export function subjectLine(
  subject: FlowSubject,
  latestNote: string | null,
): string {
  const next =
    subject.next_decision_at === null
      ? ""
      : ` next=${formatInstant(subject.next_decision_at, subject.timezone)}`;
  const notes =
    subject.notes.length === 0
      ? " notes=0"
      : ` notes=${subject.notes.length}${latestNote === null ? "" : ` · ${latestNote}`}`;
  return (
    `[${subject.focus}] ${subject.subject_name} (${subject.subject_id}) ` +
    `${subject.kind} ${subject.state} v${subject.version}${next}${notes}`
  );
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function fitsEnvelope(text: string): boolean {
  return byteLength(text) <= FLOW_LIMITS.maxEnvelopeBytes;
}

/**
 * 信封兜底：极端长的主体名可能让固定头部本身超限，此时按码点安全截断并补标记，
 * 保证任何路径下模型可见文本都不超过 maxEnvelopeBytes。
 */
export function enforceEnvelope(text: string): string {
  if (fitsEnvelope(text)) return text;
  const marker = "\n（输出已截断）";
  const budget = FLOW_LIMITS.maxEnvelopeBytes - byteLength(marker);
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out}${marker}`;
}

/**
 * 列表信封裁剪：先按行贪心装填，超出上限则丢队尾行并标注截断；
 * 分页脚注也参与字节预算（脚注变化后可能再丢一行）。
 */
export function fitListText(
  header: string,
  lines: readonly string[],
  total: number,
  offset: number,
): FittedListText {
  const included = [...lines];
  let truncated = false;
  const body = (): string => [header, ...included].join("\n");

  while (
    included.length > 0 &&
    byteLength(body()) > FLOW_LIMITS.maxEnvelopeBytes
  ) {
    included.pop();
    truncated = true;
  }

  for (;;) {
    const shown = included.length;
    const remaining = Math.max(total - offset - shown, 0);
    const parts: string[] = [];
    if (truncated) parts.push("（输出已截断）");
    if (remaining > 0) {
      parts.push(`其余 ${remaining} 个未显示，offset=${offset + shown} 继续`);
    }
    const text = parts.length === 0 ? body() : `${body()}\n${parts.join("；")}`;
    if (
      byteLength(text) <= FLOW_LIMITS.maxEnvelopeBytes ||
      included.length === 0
    ) {
      return { text, shown, truncated };
    }
    included.pop();
    truncated = true;
  }
}

function notesSummary(
  notes: readonly RenderedNote[],
  notesTotal: number,
  includeNotes: boolean,
  notesTruncated: boolean,
): string {
  if (!includeNotes) return "（未显示）";
  if (notesTotal === 0) return "";
  const first = notes[0];
  const last = notes[notes.length - 1];
  if (first === undefined || last === undefined) {
    return notesTruncated
      ? `（原 ${notesTotal} 条因长度未显示，已截断）`
      : "（无可显示笔记）";
  }
  const suffix = notesTruncated ? "，已截断" : "";
  return `（第 ${first.index}-${last.index} 条，按时间正序${suffix}）`;
}

/** 单主体文本：元数据四行 + 选中的笔记行（含 1-based 绝对序号）。 */
export function renderGetText(
  subject: FlowSubject,
  notes: readonly RenderedNote[],
  notesTotal: number,
  includeNotes: boolean,
  notesTruncated: boolean,
): string {
  const lastCommit = subject.last_commit;
  const lines = [
    `flow_get: ${subject.subject_name} (${subject.subject_id})`,
    `kind=${subject.kind} state=${subject.state} focus=${subject.focus} v${subject.version}`,
    `next=${formatInstant(subject.next_decision_at, subject.timezone)}` +
      ` updated=${formatInstant(subject.updated_at, subject.timezone)}` +
      ` last_commit=${formatInstant(lastCommit === null ? null : lastCommit.at, subject.timezone)}` +
      `${lastCommit === null ? "" : ` turn=${lastCommit.turn_idx}`}`,
    `notes=${notesTotal}${notesSummary(notes, notesTotal, includeNotes, notesTruncated)}`,
  ];
  for (const note of notes) {
    lines.push(`[${note.index}] ${collapseWhitespace(note.text)}`);
  }
  return lines.join("\n");
}
