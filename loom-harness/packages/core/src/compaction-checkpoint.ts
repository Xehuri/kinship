/**
 * Compaction checkpoint schema —— resume 压缩边界的可恢复元数据（schema / guard / 坐标 helper）。
 *
 * 设计边界：
 *   - `summary` 仍是重放的替换物；`checkpoint` 元数据现在**参与重放决策**：
 *     `tailIncluded` 决定 summary 之后是否保留未覆盖的 recent tail，不再是纯信息性字段。
 *   - 覆盖条数 / 锚点时间 / summary id / 来源等供 resume 恢复 live boundary 坐标 /
 *     累计 rehydrate 计数 / trace 去重使用。
 *   - 没有 checkpoint 的旧 entry 仍然合法（legacy），由 `legacyCheckpointCoveredCount` 按
 *     boundary 坐标换算覆盖条数。
 */

import type { Message } from "@earendil-works/pi-ai";

/** checkpoint schema 版本；未知版本按 legacy / 不可恢复处理。 */
export const COMPACTION_CHECKPOINT_VERSION = 1;

/** legacy boundary summary 内嵌 recent tail 时的分隔线；重放侧据此推断 tailIncluded。 */
export const COMPACTION_TAIL_SEPARATOR = "\n\n--- recent verbatim tail ---\n";

/** `compaction_boundary` 携带的可恢复元数据（`tailIncluded` 参与重放尾巴保留决策）。 */
export interface CompactionCheckpointMeta {
  version: 1;
  /** summary 覆盖的消息条数（以边界坐标计）。 */
  coveredCount: number;
  /** 未覆盖尾巴第一条消息的时间戳；无锚点（空尾巴 / legacy）时为 null。 */
  anchorTimestampMs: number | null;
  /** 生成该 summary 的稳定 id（trace / 去重）。 */
  summaryId: string;
  /** checkpoint 创建时间（epoch ms）。 */
  createdAt: number;
  /** checkpoint 来源：自动压缩 / 手工压缩 / 救援压缩。 */
  source: "auto" | "manual" | "rescue";
  /** 该 checkpoint 之前已经 rehydrate 的条数（累计坐标；可选）。 */
  rehydratedCount?: number;
  /**
   * summary 是否已内嵌 recent tail：true = 内嵌（legacy boundary hook），false = 只覆盖
   * 前缀（worker），缺省 = legacy checkpoint，由重放侧按 summary 分隔符判定。
   */
  tailIncluded?: boolean;
}

/** hook 可返回的 checkpoint payload：boundary summary + 可恢复元数据。 */
export interface CompactionCheckpointPayload {
  summary: Message;
  checkpoint: CompactionCheckpointMeta;
}

const CHECKPOINT_SOURCES: ReadonlySet<string> = new Set([
  "auto",
  "manual",
  "rescue",
]);

const MESSAGE_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "toolResult",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/** summary 的 role/content 形状守卫（只做结构校验，不校验 provider 专有字段）。 */
function isSummaryMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { role?: unknown; content?: unknown };
  if (
    typeof candidate.role !== "string" ||
    !MESSAGE_ROLES.has(candidate.role)
  ) {
    return false;
  }
  if (typeof candidate.content === "string") {
    // 只有 user message 允许 string content；assistant / toolResult 必须是内容块数组。
    return candidate.role === "user";
  }
  if (!Array.isArray(candidate.content)) return false;
  return candidate.content.every(
    (part) => typeof part === "object" && part !== null && !Array.isArray(part),
  );
}

function isCheckpointMeta(value: unknown): value is CompactionCheckpointMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== COMPACTION_CHECKPOINT_VERSION) return false;
  if (!isNonNegativeFiniteNumber(candidate.coveredCount)) return false;
  if (
    candidate.anchorTimestampMs !== null &&
    !isFiniteNumber(candidate.anchorTimestampMs)
  ) {
    return false;
  }
  if (
    typeof candidate.summaryId !== "string" ||
    candidate.summaryId.length === 0
  ) {
    return false;
  }
  if (!isFiniteNumber(candidate.createdAt)) return false;
  if (
    typeof candidate.source !== "string" ||
    !CHECKPOINT_SOURCES.has(candidate.source)
  ) {
    return false;
  }
  if (
    candidate.rehydratedCount !== undefined &&
    !isNonNegativeFiniteNumber(candidate.rehydratedCount)
  ) {
    return false;
  }
  if (
    candidate.tailIncluded !== undefined &&
    typeof candidate.tailIncluded !== "boolean"
  ) {
    return false;
  }
  return true;
}

/**
 * 解析 checkpoint 的 tailIncluded：显式布尔优先；缺省时按 summary 是否含 legacy 分隔线
 * 推断（true），否则 undefined（legacy checkpoint，由重放侧按 boundary 位置决定）。
 */
export function resolveCheckpointTailIncluded(
  checkpoint: CompactionCheckpointMeta | undefined,
  summaryText: string,
): boolean | undefined {
  if (checkpoint === undefined) return undefined;
  if (checkpoint.tailIncluded !== undefined) return checkpoint.tailIncluded;
  return summaryText.includes(COMPACTION_TAIL_SEPARATOR) ? true : undefined;
}

/** 运行时守卫：payload 的 summary 形状与 checkpoint 元数据均合法才放行。 */
export function isCompactionCheckpointPayload(
  value: unknown,
): value is CompactionCheckpointPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { summary?: unknown; checkpoint?: unknown };
  return (
    isSummaryMessage(candidate.summary) &&
    isCheckpointMeta(candidate.checkpoint)
  );
}

/**
 * legacy checkpoint 坐标换算：给定**上一条边界**与**本条边界**处已持久化的 message 条数，
 * 返回本条 boundary 实际覆盖的条数。
 *
 * - 第一条边界（`previous === null`）：覆盖全部已持久化前缀 = `boundaryMessageCount`。
 * - 后续边界：边界自身也占一条 message 坐标，故 `1 + (boundary - previous)`。
 */
export function legacyCheckpointCoveredCount(
  previousBoundaryMessageCount: number | null,
  boundaryMessageCount: number,
): number {
  return previousBoundaryMessageCount === null
    ? boundaryMessageCount
    : 1 + (boundaryMessageCount - previousBoundaryMessageCount);
}
