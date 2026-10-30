// T20 热加载四件套 —— 类型面：应用结果、config.applied 审计事件、AuditSink 接口。
// 设计约束（D10/D28）：坏配置只返回类型化失败、绝不抛穿调用方（不崩）；
// 事件可整体 JSON 序列化落 jsonl；审计 sink 接口注入，等并行 T08 就绪后可换共享实现。

import type { LoomConfig } from "../config/loom-config.js";

/** 失败阶段：read=文件读不到；schema=T07 validator 拒载；reference=引用存在性拒载；audit=审计写失败（留痕是硬性要求，拒记不交换）。 */
export type FailureStage = "read" | "schema" | "reference" | "audit";

/** config.applied 审计事件（state/config/{date}.jsonl 的单行，含前后版本 sha256）。 */
export type ConfigAppliedEvent =
  | {
      readonly type: "config.applied";
      readonly ts: string;
      readonly source: string;
      readonly status: "applied";
      /** 交换前生效配置的文本哈希；启动基线（无旧配置）为 null。 */
      readonly beforeSha256: string | null;
      readonly afterSha256: string;
    }
  | {
      readonly type: "config.applied";
      readonly ts: string;
      readonly source: string;
      readonly status: "rejected";
      readonly stage: FailureStage;
      /** 拒载时旧配置仍在服务，故 before 即当前生效版本哈希（空库为 null）。 */
      readonly beforeSha256: string | null;
      /** 被拒文本的哈希；read 阶段取不到文本时为 null。 */
      readonly afterSha256: string | null;
      readonly errors: readonly string[];
    };

/** 审计接收端：生产 = FileAuditSink（当日 jsonl 追加），测试 = 内存数组。写失败即抛，由上层循环兜底。 */
export interface AuditSink {
  write(event: ConfigAppliedEvent): void;
}

/** apply / applyFile 的返回：ok=true 时新配置已原子生效；ok=false 时旧配置继续服务。 */
export type ApplyResult =
  | { readonly ok: true; readonly config: LoomConfig; readonly event: ConfigAppliedEvent }
  | {
      readonly ok: false;
      readonly stage: FailureStage;
      readonly errors: readonly string[];
      readonly event: ConfigAppliedEvent;
    };
