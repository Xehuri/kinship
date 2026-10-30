// T20 验收测试（TDD 顺序：先 reject-bad-config）。
// 契约：坏配置被拒且旧配置继续服务（原子交换、不崩）；
// config.applied 审计事件含 before/after sha256；有效配置原子交换。
// fs.watch 不做自动化触发测试（NTFS 事件时序 flaky），配置面语义一律直接 apply。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseLoomConfig } from "../config/loom-config.js";
import {
  checkReferences,
  ConfigNotLoadedError,
  createFileAuditSink,
  HotConfigStore,
  type ApplyResult,
  type AuditSink,
} from "./index.js";
import {
  BROKEN_YAML,
  CRED_DANGLING_YAML,
  ENV_OK,
  FIXED_TS,
  MemoryAuditSink,
  REF_MISSING_YAML,
  sha,
  VALID_YAML_A,
  VALID_YAML_B,
} from "./fixtures.js";

function freshStore(): { store: HotConfigStore; sink: MemoryAuditSink } {
  const sink = new MemoryAuditSink();
  const store = new HotConfigStore({ sink, env: ENV_OK, now: () => FIXED_TS });
  return { store, sink };
}

/** 施加 text 并断言拒载，收窄返回 ok:false 分支。 */
function rejectWith(
  store: HotConfigStore,
  text: string,
  source: string,
): Extract<ApplyResult, { ok: false }> {
  const res = store.apply(text, source);
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable：应已拒载");
  return res;
}

describe("HotConfigStore / reject-bad-config（红线）", () => {
  it("schema 坏配置被拒：stage=schema，旧配置同一对象继续服务，哈希不变", () => {
    const { store, sink } = freshStore();
    const seeded = store.apply(VALID_YAML_A, "a.yaml");
    expect(seeded.ok).toBe(true);
    sink.events.length = 0;

    const res = rejectWith(store, BROKEN_YAML, "bad.yaml");
    expect(res.stage).toBe("schema");
    expect(res.errors.length).toBeGreaterThan(0);
    if (!seeded.ok) throw new Error("unreachable");
    expect(store.get()).toBe(seeded.config); // 引用相等 = 未被换掉
    expect(store.currentSha256()).toBe(sha(VALID_YAML_A));
  });

  it("引用缺失（provider 无计价条目）被拒：stage=reference，旧配置继续服务", () => {
    const { store } = freshStore();
    store.apply(VALID_YAML_A, "a.yaml");
    const res = rejectWith(store, REF_MISSING_YAML, "ref-bad.yaml");
    expect(res.stage).toBe("reference");
    expect(res.errors.some((e) => e.includes("ghost"))).toBe(true);
    expect(store.get().server.port).toBe(5097);
  });

  it("checkReferences 单元：credentials 悬空 key 判引用缺失（T07 schema 放行，属独立校验维度）", () => {
    const cfg = parseLoomConfig(CRED_DANGLING_YAML, "<t>", { env: ENV_OK });
    const errs = checkReferences(cfg);
    expect(errs.some((e) => e.includes('credentials key "openai"'))).toBe(true);

    const { store } = freshStore();
    store.apply(VALID_YAML_A, "a.yaml");
    expect(rejectWith(store, CRED_DANGLING_YAML, "dangling.yaml").stage).toBe("reference");
    expect(store.get().server.port).toBe(5097);
  });

  it("拒载写 config.applied 审计事件：status=rejected，before=旧哈希，after=坏文本哈希", () => {
    const { store, sink } = freshStore();
    store.apply(VALID_YAML_A, "a.yaml");
    sink.events.length = 0;

    rejectWith(store, BROKEN_YAML, "bad.yaml");
    expect(sink.events).toHaveLength(1);
    // toMatchObject：events[0] 为 undefined 时同样失败，无需非空断言。
    expect(sink.events[0]).toMatchObject({
      type: "config.applied",
      status: "rejected",
      stage: "schema",
      beforeSha256: sha(VALID_YAML_A),
      afterSha256: sha(BROKEN_YAML),
      ts: FIXED_TS,
      source: "bad.yaml",
    });
  });

  it("空库施加坏配置：不崩，事件 beforeSha256=null，get() 抛 ConfigNotLoadedError", () => {
    const { store } = freshStore();
    const res = rejectWith(store, BROKEN_YAML, "bad.yaml");
    expect(res.event.beforeSha256).toBeNull();
    expect(res.event.afterSha256).toBe(sha(BROKEN_YAML));
    expect(() => store.get()).toThrow(ConfigNotLoadedError);
  });

  it("sink 首写即故障：applied 事件写不进 → stage=audit 拒载；恢复后可正常交换", () => {
    const sink = new MemoryAuditSink();
    let failNextWrite = true;
    const flaky: AuditSink = {
      write(ev) {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("disk full");
        }
        sink.write(ev);
      },
    };
    const store = new HotConfigStore({ sink: flaky, env: ENV_OK, now: () => FIXED_TS });

    const first = store.apply(VALID_YAML_A, "a.yaml");
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("unreachable");
    expect(first.stage).toBe("audit");
    expect(sink.events).toHaveLength(1); // 只有兜底的 rejected 事件入账
    expect(sink.events[0]).toMatchObject({ status: "rejected", stage: "audit" });

    const second = store.apply(VALID_YAML_A, "a.yaml");
    expect(second.ok).toBe(true); // sink 恢复 → 交换成功
  });

  it("sink 中途故障：A 已生效后 B 因审计失败被拒，A 继续服务（旧值不受威胁）", () => {
    let armed = false;
    const firstWriteOkThenThrow: AuditSink = {
      write() {
        if (armed) throw new Error("boom");
        armed = true;
      },
    };
    const s = new HotConfigStore({ sink: firstWriteOkThenThrow, env: ENV_OK, now: () => FIXED_TS });
    expect(s.apply(VALID_YAML_A, "a.yaml").ok).toBe(true); // 基线生效
    const res = s.apply(VALID_YAML_B, "b.yaml");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.stage).toBe("audit");
    expect(s.get().server.port).toBe(5097); // 旧配置继续服务
  });
});

describe("HotConfigStore / 有效配置原子交换", () => {
  it("首次 apply：ok:true，beforeSha256=null（启动基线），afterSha256=文本哈希", () => {
    const { store, sink } = freshStore();
    const res = store.apply(VALID_YAML_A, "a.yaml");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.event).toEqual({
      type: "config.applied",
      ts: FIXED_TS,
      source: "a.yaml",
      status: "applied",
      beforeSha256: null,
      afterSha256: sha(VALID_YAML_A),
    });
    expect(sink.events).toEqual([res.event]);
    expect(store.currentSha256()).toBe(sha(VALID_YAML_A));
  });

  it("A→B 交换：get() 返回 B，事件 before=A哈希 after=B哈希", () => {
    const { store } = freshStore();
    store.apply(VALID_YAML_A, "a.yaml");
    const res = store.apply(VALID_YAML_B, "b.yaml");
    expect(res.ok).toBe(true);
    expect(store.get().server.port).toBe(5100);
    expect(store.get().workspace).toBe("/srv/loom/other-workspace");
    expect(res.event.beforeSha256).toBe(sha(VALID_YAML_A));
    expect(res.event.afterSha256).toBe(sha(VALID_YAML_B));
  });

  it("坏配置夹在两次有效交换之间：审计序列 applied→rejected→applied，before 链只跟生效值", () => {
    const { store, sink } = freshStore();
    store.apply(VALID_YAML_A, "a.yaml");
    store.apply(BROKEN_YAML, "bad.yaml");
    const b = store.apply(VALID_YAML_B, "b.yaml");
    expect(b.ok).toBe(true);
    expect(store.get().models).toHaveLength(2);
    expect(sink.events.map((e) => e.status)).toEqual(["applied", "rejected", "applied"]);
    // 拒载不推进生效版本：第三事件 before 仍指向真正生效过的 A，而非被拒文本。
    expect(sink.events[2]).toMatchObject({ beforeSha256: sha(VALID_YAML_A) });
  });

  it("applyFile 文件不存在：stage=read、afterSha256=null、旧值保留、不抛", () => {
    const { store, sink } = freshStore();
    store.apply(VALID_YAML_A, "a.yaml");
    sink.events.length = 0;
    const res = store.applyFile(join(tmpdir(), "loom-no-such-file-9f3a.yaml"));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.stage).toBe("read");
    expect(res.event.beforeSha256).toBe(sha(VALID_YAML_A));
    expect(res.event.afterSha256).toBeNull();
    expect(sink.events).toHaveLength(1);
    expect(store.get().server.port).toBe(5097);
  });

  it("applyFile 有效文件：交换成功且事件 source=文件路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-hotfile-"));
    try {
      const path = join(dir, "loom.yaml");
      const { store } = freshStore();
      writeFileSync(path, VALID_YAML_A, "utf8");
      const res = store.applyFile(path);
      expect(res.ok).toBe(true);
      expect(res.event.source).toBe(path);
      expect(store.get().server.port).toBe(5097);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watch 生命周期 smoke：可注册可停止，不抛（触发时序不做断言，防 NTFS flaky）", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-hotwatch-"));
    try {
      const path = join(dir, "loom.yaml");
      writeFileSync(path, VALID_YAML_A, "utf8");
      const { store } = freshStore();
      const stop = store.watch({ file: path, debounceMs: 20 });
      stop(); // 立即停止：不依赖任何 fs 事件到达，只证明接线本身不崩。
      expect(store.applyFile(path).ok).toBe(true); // watch 停后 apply 路径仍完好
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createFileAuditSink / 真实文件 smoke", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-hotaudit-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applied/rejected 各落一行 JSON 到 {dir}/{date}.jsonl，与内存 sink 事件逐字段一致", () => {
    const store = new HotConfigStore({
      sink: createFileAuditSink(dir),
      env: ENV_OK,
      now: () => FIXED_TS,
    });
    const mem = new MemoryAuditSink();
    const twin = new HotConfigStore({ sink: mem, env: ENV_OK, now: () => FIXED_TS });

    expect(store.apply(VALID_YAML_A, "a.yaml").ok).toBe(true);
    expect(store.apply(BROKEN_YAML, "bad.yaml").ok).toBe(false);
    twin.apply(VALID_YAML_A, "a.yaml");
    twin.apply(BROKEN_YAML, "bad.yaml");

    const lines = readFileSync(join(dir, "2026-10-08.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed: unknown[] = lines.map((l) => JSON.parse(l) as unknown);
    expect(parsed).toEqual(mem.events);
    expect(parsed[0]).toMatchObject({ status: "applied", afterSha256: sha(VALID_YAML_A) });
    expect(parsed[1]).toMatchObject({ status: "rejected", afterSha256: sha(BROKEN_YAML) });
  });
});
