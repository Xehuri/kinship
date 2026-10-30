// T36 E2E —— 热加载拒坏配置（真 HotConfigStore + 真临时目录配置文件 + 真 jsonl 审计落盘）。
//
// 与 T20 单测的分工：T20 用内存字符串直接 apply 验证语义；本 E2E 走 applyFile 真文件路径，
// 端到端验证「运维把 loom.yaml 改坏 → 运行时重新加载 → 拒载、旧配置继续 serve、审计落盘」。
// fs.watch 触发时序不做断言（NTFS 事件 flaky），与 T20 约定一致：配置面语义经 applyFile 真文件直测。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConfigNotLoadedError,
  createFileAuditSink,
  HotConfigStore,
  type ConfigAppliedEvent,
} from "../hotreload/index.js";
import {
  BROKEN_YAML,
  CRED_DANGLING_YAML,
  ENV_OK,
  FIXED_TS,
  REF_MISSING_YAML,
  sha,
  VALID_YAML_A,
} from "../hotreload/fixtures.js";

/** E2E 夹具：独立临时目录 + 真 config 文件路径 + 真文件审计 sink。 */
interface Harness {
  readonly dir: string;
  readonly configPath: string;
  readonly auditDir: string;
  readonly store: HotConfigStore;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "loom-e2e-bad-"));
  const configPath = join(dir, "loom.yaml");
  const auditDir = join(dir, "audit");
  // now 固定 → 审计文件名固定为 {FIXED_TS 的 UTC 日期}.jsonl，便于回读断言。
  const store = new HotConfigStore({
    sink: createFileAuditSink(auditDir),
    env: ENV_OK,
    now: () => FIXED_TS,
  });
  return { dir, configPath, auditDir, store };
}

/** 回读当日审计 jsonl（每行一个 config.applied 事件）。 */
function readAudit(auditDir: string): ConfigAppliedEvent[] {
  const text = readFileSync(join(auditDir, "2026-10-08.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ConfigAppliedEvent);
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("T36 E2E / 热加载拒坏配置（红线：拒载 + 旧配置继续 serve + 不崩）", () => {
  it("坏 yaml 覆盖真文件：applyFile 拒载 stage=schema，旧配置同一对象继续 serve，rejected 审计行落盘", () => {
    const { dir, configPath, auditDir, store } = makeHarness();
    try {
      // 基线：先让一份有效配置真文件生效。
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      const seeded = store.applyFile(configPath);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) throw new Error("unreachable：基线配置应生效");

      // 运维把同一文件改坏（真写入），运行时重新加载。
      writeFileSync(configPath, BROKEN_YAML, "utf8");
      const res = store.applyFile(configPath);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable：坏配置应被拒");
      expect(res.stage).toBe("schema");
      expect(res.errors.length).toBeGreaterThan(0);

      // 旧配置继续 serve：引用相等 = 未被换掉；端口与哈希都不变。
      expect(store.get()).toBe(seeded.config);
      expect(store.get().server.port).toBe(5097);
      expect(store.currentSha256()).toBe(sha(VALID_YAML_A));

      // 审计落盘：applied 一行 + rejected 一行，rejected 含 before/after sha256。
      const events = readAudit(auditDir);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        status: "applied",
        beforeSha256: null,
        afterSha256: sha(VALID_YAML_A),
      });
      expect(events[1]).toMatchObject({
        type: "config.applied",
        status: "rejected",
        stage: "schema",
        beforeSha256: sha(VALID_YAML_A),
        afterSha256: sha(BROKEN_YAML),
        source: configPath,
        ts: FIXED_TS,
      });
    } finally {
      cleanup(dir);
    }
  });

  it("连续多次改坏真文件：每次都拒载、绝不崩，旧配置始终 serve，逐次落 rejected 审计行", () => {
    const { dir, configPath, auditDir, store } = makeHarness();
    try {
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      const seeded = store.applyFile(configPath);
      if (!seeded.ok) throw new Error("unreachable：基线配置应生效");

      // 三种坏法：YAML 语法坏、端口越界(D32)、缺必填段。
      const badTexts = [BROKEN_YAML, "server:\n  port: 1\n  hostname: 127.0.0.1\n", "workspace: ''\n"];
      for (const bad of badTexts) {
        writeFileSync(configPath, bad, "utf8");
        const res = store.applyFile(configPath);
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("unreachable：坏配置应被拒");
        expect(res.stage).toBe("schema");
        // 每次拒载后旧配置仍在服务。
        expect(store.get()).toBe(seeded.config);
        expect(store.get().server.port).toBe(5097);
      }

      const rejected = readAudit(auditDir).filter((e) => e.status === "rejected");
      expect(rejected).toHaveLength(badTexts.length);
    } finally {
      cleanup(dir);
    }
  });

  it("引用缺失（provider 无计价条目）真文件：stage=reference，旧配置继续 serve", () => {
    const { dir, configPath, auditDir, store } = makeHarness();
    try {
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      const seeded = store.applyFile(configPath);
      if (!seeded.ok) throw new Error("unreachable：基线配置应生效");

      writeFileSync(configPath, REF_MISSING_YAML, "utf8");
      const res = store.applyFile(configPath);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable：引用缺失应被拒");
      expect(res.stage).toBe("reference");
      expect(res.errors.some((e) => e.includes("ghost"))).toBe(true);
      expect(store.get()).toBe(seeded.config);
      expect(store.get().server.port).toBe(5097);

      const last = readAudit(auditDir).at(-1);
      expect(last).toMatchObject({
        status: "rejected",
        stage: "reference",
        beforeSha256: sha(VALID_YAML_A),
        afterSha256: sha(REF_MISSING_YAML),
      });
    } finally {
      cleanup(dir);
    }
  });

  it("悬空凭据 key 真文件：stage=reference（schema 放行、跨段一致性拒载），旧配置继续 serve", () => {
    const { dir, configPath, store } = makeHarness();
    try {
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      const seeded = store.applyFile(configPath);
      if (!seeded.ok) throw new Error("unreachable：基线配置应生效");

      writeFileSync(configPath, CRED_DANGLING_YAML, "utf8");
      const res = store.applyFile(configPath);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable：悬空凭据应被拒");
      expect(res.stage).toBe("reference");
      expect(res.errors.some((e) => e.includes('credentials key "openai"'))).toBe(true);
      expect(store.get()).toBe(seeded.config);
    } finally {
      cleanup(dir);
    }
  });

  it("空库直接加载坏文件：不崩，rejected 审计 beforeSha256=null，get() 抛 ConfigNotLoadedError", () => {
    const { dir, configPath, auditDir, store } = makeHarness();
    try {
      writeFileSync(configPath, BROKEN_YAML, "utf8");
      const res = store.applyFile(configPath);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable：坏配置应被拒");
      expect(res.event.beforeSha256).toBeNull();
      expect(res.event.afterSha256).toBe(sha(BROKEN_YAML));
      // 空库未被污染：读取生效配置应抛类型化错误，而非返回坏值。
      expect(() => store.get()).toThrow(ConfigNotLoadedError);
      expect(store.currentSha256()).toBeNull();

      const events = readAudit(auditDir);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "rejected", beforeSha256: null });
    } finally {
      cleanup(dir);
    }
  });

  it("配置文件被删除：stage=read、afterSha256=null，旧配置继续 serve、不抛", () => {
    const { dir, configPath, auditDir, store } = makeHarness();
    try {
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      const seeded = store.applyFile(configPath);
      if (!seeded.ok) throw new Error("unreachable：基线配置应生效");

      rmSync(configPath, { force: true });
      const res = store.applyFile(configPath);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable：文件缺失应被拒");
      expect(res.stage).toBe("read");
      expect(res.event.beforeSha256).toBe(sha(VALID_YAML_A));
      expect(res.event.afterSha256).toBeNull();
      expect(store.get()).toBe(seeded.config);
      expect(store.get().server.port).toBe(5097);

      const last = readAudit(auditDir).at(-1);
      expect(last).toMatchObject({ status: "rejected", stage: "read", afterSha256: null });
    } finally {
      cleanup(dir);
    }
  });
});
