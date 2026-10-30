/**
 * C2 压缩历史聚合。
 *
 * 历史摘要有两个真源：
 *   1) durable store 的 `compaction_boundary` entry —— persistent compression 路径写的边界
 *      （summary 替换其之前的前缀）；
 *   2) C1 的 append-only 事件日志 —— view-only autoCompaction 每次推进后记录的快照。
 *
 * 本模块把两者与当前 live/cache 观察面归并成一条**时间升序**的事件流：
 *   - boundary 永远先出现（canonical，同摘要优先保留 store id / summary.timestamp）；
 *   - auto log 次之；live/cache 最后（seed-on-read 的当前值）；
 *   - 摘要全文 sha256 去重（跨来源只留首见）；
 *   - 排序键 = (anchorTimestampMs ?? recordedAt) 再 recordedAt；anchor 为 null 的事件
 *     按 recordedAt 落位，绝不因缺 anchor 被丢弃。
 */

import {
  legacyCheckpointCoveredCount,
  type SessionStore,
  type StoredEntry,
} from "@axeuh/loom-core";

import { compactionEventKey, type CompactionEvent } from "./compaction-events.js";

/** live 压缩视图/cache 体与事件共有的摘要字段（结构类型，避免 core ↔ server 反向依赖）。 */
export interface CompactionSnapshot {
  readonly coveredCount: number;
  readonly summaryText: string;
  readonly anchorMessageId: string | null;
  readonly anchorTimestampMs: number | null;
}

/**
 * 从 store 路径提取全部 `compaction_boundary` 事件。
 *
 * coveredCount 口径：entry 携带 checkpoint 时优先用它记录的 `coveredCount`；legacy entry
 * 则用 `legacyCheckpointCoveredCount` 按相邻 boundary 的消息坐标换算（首条 = 已持久化前缀
 * 条数，后续 = 1 + 与上一条 boundary 的差）。anchor 的 message id = 该 boundary 之后
 * 第一条 message entry（跨过相邻 boundary/terminal 继续找）；若 checkpoint 存在则锚点时间
 * 以 checkpoint 为准，否则取该 anchor message 的 timestamp；没有后续 message = 双 null。
 * summary.content 非 string（块数组等）按"无法诚实呈现"跳过，不猜不拼。
 */
export async function boundaryEventsFromStore(
  store: SessionStore,
  sessionID: string,
): Promise<CompactionEvent[]> {
  const path = await store.getPathToLeaf(sessionID);
  const events: CompactionEvent[] = [];
  let messageCount = 0;
  let previousBoundaryMessageCount: number | null = null;
  for (let i = 0; i < path.length; i += 1) {
    const stored = path[i]!;
    if (stored.entry.kind === "message") {
      messageCount += 1;
      continue;
    }
    if (stored.entry.kind !== "compaction_boundary") continue; // terminal = 元数据，跳过
    const boundaryMessageCount = messageCount;
    const previousCount = previousBoundaryMessageCount;
    previousBoundaryMessageCount = boundaryMessageCount;
    const summary = stored.entry.summary;
    if (typeof summary.content !== "string") continue;
    const checkpoint = stored.entry.checkpoint;
    const anchor = nextMessageEntry(path, i + 1);
    events.push({
      id: stored.id,
      kind: "boundary",
      coveredCount:
        checkpoint?.coveredCount ??
        legacyCheckpointCoveredCount(previousCount, boundaryMessageCount),
      summaryText: summary.content,
      anchorMessageId: anchor?.id ?? null,
      anchorTimestampMs:
        checkpoint !== undefined
          ? checkpoint.anchorTimestampMs
          : anchor?.entry.kind === "message"
            ? anchor.entry.message.timestamp
            : null,
      recordedAt: checkpoint?.createdAt ?? summary.timestamp,
    });
  }
  return events;
}

/** boundary 之后第一条 message entry（跳过 terminal/嵌套 boundary）。 */
function nextMessageEntry(path: readonly StoredEntry[], start: number): StoredEntry | null {
  for (let i = start; i < path.length; i += 1) {
    const candidate = path[i]!;
    if (candidate.entry.kind === "message") return candidate;
  }
  return null;
}

/** live view / cache 体 → auto 事件（id 由摘要哈希派生，天然幂等）。 */
export function compactionEventFromSnapshot(
  snapshot: CompactionSnapshot,
  recordedAt: number,
): CompactionEvent {
  return {
    id: `auto:${compactionEventKey(snapshot.summaryText)}`,
    kind: "auto",
    coveredCount: snapshot.coveredCount,
    summaryText: snapshot.summaryText,
    anchorMessageId: snapshot.anchorMessageId,
    anchorTimestampMs: snapshot.anchorTimestampMs,
    recordedAt,
  };
}

/**
 * 合并 boundary → auto log → live/cache，按摘要哈希去重（首见 = boundary canonical），
 * 再按 (anchorTimestampMs ?? recordedAt), recordedAt 升序排序。
 */
export function mergeCompactionEvents(
  boundaries: readonly CompactionEvent[],
  autoLog: readonly CompactionEvent[],
  liveOrCache: readonly CompactionEvent[] | CompactionEvent | null | undefined,
): CompactionEvent[] {
  const tail: readonly CompactionEvent[] =
    liveOrCache === null || liveOrCache === undefined
      ? []
      : Array.isArray(liveOrCache)
        ? liveOrCache
        : [liveOrCache];
  const merged: CompactionEvent[] = [];
  const seen = new Set<string>();
  for (const event of [...boundaries, ...autoLog, ...tail]) {
    const key = compactionEventKey(event.summaryText);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.sort(compareCompactionEvents);
}

function compareCompactionEvents(a: CompactionEvent, b: CompactionEvent): number {
  const aKey = a.anchorTimestampMs ?? a.recordedAt;
  const bKey = b.anchorTimestampMs ?? b.recordedAt;
  return aKey - bKey || a.recordedAt - b.recordedAt;
}
