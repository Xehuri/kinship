// T20 热加载四件套 —— 审计接收端实现：当日 jsonl 追加。
// AuditSink 接口注入（见 ./types.js），并行 T08 状态层就绪后可换共享实现，接口面不变。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AuditSink, ConfigAppliedEvent } from "./types.js";

/** 生产 sink：config.applied 事件 → {dir}/{date}.jsonl 单行追加（date 取事件 ts 的 UTC 日期）。 */
export function createFileAuditSink(dir: string): AuditSink {
  return {
    write(event: ConfigAppliedEvent): void {
      const path = join(dir, `${event.ts.slice(0, 10)}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
    },
  };
}
