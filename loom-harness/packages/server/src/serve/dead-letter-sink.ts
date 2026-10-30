// T31 serve 装配 —— 死信落盘（D26 观测面的 C 半边）。
//
// 引擎在 failed 盖棺处经 DeadLetterSink 吐死信形状（含 gate forceEnded deadLetter=true 的
// 副会话收束）；本 sink 把该形状经 StateLayout 的 Journal 通道追加进
// `{stateRoot}/dead-letter/{YYYY-MM-DD}.jsonl`（L0 六子目录之一，日分片按 payload.at
// 的 UTC 日期键——layout/stateDateKey 统一口径，与 ledger/config 分片同律）。
// 写失败只 warn：死信投递（投主）是 T13 消费面的事，落盘留证失败绝不反噬账本盖棺路径。

import { StateLayout, stateDateKey, type JsonObjectRow, type Journal } from "@axeuh/loom-adapters";
import type { DeadLetterPayload, DeadLetterSink } from "@axeuh/loom-core/run-engine";

type SinkLog = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => void;

export function createDeadLetterSink(opts: {
  readonly stateRoot: string;
  readonly log?: SinkLog;
}): DeadLetterSink {
  const layout = new StateLayout({ root: opts.stateRoot });
  const journals = new Map<string, Journal>();

  function journalFor(date: string): Journal {
    const existing = journals.get(date);
    if (existing !== undefined) return existing;
    const opened = layout.openDayJournal("dead-letter", date);
    journals.set(date, opened);
    return opened;
  }

  return {
    emit(payload: DeadLetterPayload): void {
      const date = stateDateKey(payload.at);
      const path = layout.dayPath("dead-letter", date);
      try {
        journalFor(date).append(payload as unknown as JsonObjectRow);
      } catch (err) {
        opts.log?.("warn", "loom dead-letter write failed", {
          path,
          run_id: payload.run_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
