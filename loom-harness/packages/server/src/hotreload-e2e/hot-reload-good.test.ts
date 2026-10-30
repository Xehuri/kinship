// T36 E2E —— 热加载接受好配置（真 HotConfigStore + 真临时目录配置文件 + 真 jsonl 审计落盘）。
//
// 验证「运维改好 loom.yaml → 运行时重新加载 → 原子交换 + applied 审计行落盘（含 before/after sha256）」。
// 与 hot-reload-bad 互补：坏配置走拒载路径，本文件走成功交换路径。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileAuditSink,
  HotConfigStore,
  type ConfigAppliedEvent,
} from "../hotreload/index.js";
import { ENV_OK, FIXED_TS, sha, VALID_YAML_A, VALID_YAML_B } from "../hotreload/fixtures.js";

interface Harness {
  readonly dir: string;
  readonly configPath: string;
  readonly auditDir: string;
  readonly store: HotConfigStore;
}

function makeHarness(prefix: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(dir, "loom.yaml");
  const auditDir = join(dir, "audit");
  const store = new HotConfigStore({
    sink: createFileAuditSink(auditDir),
    env: ENV_OK,
    now: () => FIXED_TS,
  });
  return { dir, configPath, auditDir, store };
}

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

describe("T36 E2E / 热加载接受好配置（原子交换 + 审计留痕）", () => {
  it("首次加载好配置真文件：原子交换生效，applied 审计行落盘 before=null after=文本哈希", () => {
    const { dir, configPath, auditDir, store } = makeHarness("loom-e2e-good-");
    try {
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      const res = store.applyFile(configPath);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable：好配置应生效");

      // 生效值可读且与文件一致。
      expect(store.get().server.port).toBe(5097);
      expect(store.get().workspace).toBe("/srv/loom/fixture-workspace");
      expect(store.currentSha256()).toBe(sha(VALID_YAML_A));

      const events = readAudit(auditDir);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "config.applied",
        ts: FIXED_TS,
        source: configPath,
        status: "applied",
        beforeSha256: null,
        afterSha256: sha(VALID_YAML_A),
      });
    } finally {
      cleanup(dir);
    }
  });

  it("好配置 A→B 真文件交换：原子换到 B，applied 审计 before=A哈希 after=B哈希", () => {
    const { dir, configPath, auditDir, store } = makeHarness("loom-e2e-swap-");
    try {
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      const first = store.applyFile(configPath);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");

      // 运维改成另一份合法配置（端口/工作区/模型数均不同）。
      writeFileSync(configPath, VALID_YAML_B, "utf8");
      const second = store.applyFile(configPath);
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");

      // 原子交换：读到的就是 B，且不再是 A 的对象。
      expect(second.config).not.toBe(first.config);
      expect(store.get().server.port).toBe(5100);
      expect(store.get().workspace).toBe("/srv/loom/other-workspace");
      expect(store.get().models).toHaveLength(2);
      expect(store.currentSha256()).toBe(sha(VALID_YAML_B));

      const events = readAudit(auditDir);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        status: "applied",
        beforeSha256: null,
        afterSha256: sha(VALID_YAML_A),
      });
      expect(events[1]).toMatchObject({
        status: "applied",
        beforeSha256: sha(VALID_YAML_A),
        afterSha256: sha(VALID_YAML_B),
        source: configPath,
      });
    } finally {
      cleanup(dir);
    }
  });

  it("坏配置夹在好配置之间真文件：applied→rejected→applied，before 链只跟生效值", () => {
    const { dir, configPath, auditDir, store } = makeHarness("loom-e2e-mixed-");
    try {
      writeFileSync(configPath, VALID_YAML_A, "utf8");
      expect(store.applyFile(configPath).ok).toBe(true);

      writeFileSync(configPath, "server: [oops\n", "utf8");
      expect(store.applyFile(configPath).ok).toBe(false);
      expect(store.get().server.port).toBe(5097); // 拒载后仍是 A

      writeFileSync(configPath, VALID_YAML_B, "utf8");
      expect(store.applyFile(configPath).ok).toBe(true);

      const events = readAudit(auditDir);
      expect(events.map((e) => e.status)).toEqual(["applied", "rejected", "applied"]);
      // 第三行 before 指向真正生效过的 A，而非被拒文本（拒载不推进生效版本）。
      expect(events[2]).toMatchObject({ beforeSha256: sha(VALID_YAML_A) });
      expect(store.get().server.port).toBe(5100);
    } finally {
      cleanup(dir);
    }
  });
});
