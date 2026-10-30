// T20 测试夹具（非 *.test.ts 命名故不被 vitest 当作测试文件；供 hotreload 测试与后续
// T36 契约测试复用）。两份合法配置必须互可区分（端口/工作区/模型数），before/after 哈希断言才有效。

import { createHash } from "node:crypto";

import type { AuditSink, ConfigAppliedEvent } from "./types.js";

export const FIXED_TS = "2026-10-08T04:00:00.000Z";

export const ENV_OK = {
  LOOM_KEY_EFLOWCODE: "sk-secret-value-123",
  LOOM_KEY_OPENAI: "sk-another-secret-456",
};

// 普通双引号串：${} 是字面量（env-ref），不做模板插值；拼装/replace 共用同一锚点。
export const CRED_LINE = "credentials:\n  eflowcode: ${LOOM_KEY_EFLOWCODE}";

export const VALID_YAML_A = `
server:
  port: 5097
  hostname: 127.0.0.1
workspace: /srv/loom/fixture-workspace
models:
  - id: qwen3.8-flash
    provider: eflowcode
    contextWindow: 262144
    maxOutput: 32768
    timeout: 120000
pricing:
  eflowcode:
    input: 0.5
    output: 2.5
${CRED_LINE}
`;

/** 与 A 合法且可区分：端口/工作区不同、多一个模型。 */
export const VALID_YAML_B = `
server:
  port: 5100
  hostname: 0.0.0.0
workspace: /srv/loom/other-workspace
models:
  - id: qwen3.8-flash
    provider: eflowcode
    contextWindow: 262144
    maxOutput: 32768
    timeout: 120000
  - id: gpt-4o
    provider: eflowcode
    contextWindow: 128000
    maxOutput: 16384
    timeout: 60000
pricing:
  eflowcode:
    input: 0.5
    output: 2.5
${CRED_LINE}
`;

/** schema 合法但引用缺失：provider "ghost" 在 pricing 段无计价条目。 */
export const REF_MISSING_YAML = VALID_YAML_A.replace("provider: eflowcode", "provider: ghost");

/** schema 合法但悬空引用：openai 凭据 key 不对应任何模型 provider。 */
export const CRED_DANGLING_YAML = VALID_YAML_A.replace(
  CRED_LINE,
  CRED_LINE + "\n  openai: ${LOOM_KEY_OPENAI}",
);

export const BROKEN_YAML = "server: [oops\n";

export function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class MemoryAuditSink implements AuditSink {
  readonly events: ConfigAppliedEvent[] = [];

  write(event: ConfigAppliedEvent): void {
    this.events.push(event);
  }
}
