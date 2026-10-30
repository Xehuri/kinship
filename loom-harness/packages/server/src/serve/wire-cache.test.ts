/**
 * W23-A wire-cache 单测 —— 原子覆盖写 / 读侧 fail-soft / **写前脱敏密钥不落盘**。
 *
 * 给定/当/则：
 *  - 落盘 roundtrip：save → read 字段全等（savedAt 用注入时钟定值）；
 *  - 覆盖写：同 sid 二次 save 后盘上只有一份、内容为末次（文件数恒 1）；
 *  - seed-key grep 零命中：optionsText 带 apiKey 明文的快照 save 后，**原始文件文本**
 *    对明文 key 零命中，params 位为 "***"（脱敏发生在写盘前，不是出口前）；
 *  - providerPayload 原样透传（真通道面）；
 *  - 坏文件（JSON 坏 / 版本不合 / 形状缺）→ read null（fail-soft，绝不半截上屏）；
 *  - 文件名安全化：读写两侧同函数（含连字符 sid 与 "_" 归一后同键，路径注入不可行）。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WireRequestSnapshot } from "@axeuh/loom-core";

import { WIRE_CACHE_VERSION, WireCacheStore, wireCacheFileName } from "./wire-cache.js";

const SEEDED_KEY = "sk-seed-1234567890-DO-NOT-PERSIST";

function fixtureSnapshot(optionsText?: string): WireRequestSnapshot {
  return {
    capturedAt: 111,
    turnIdx: 3,
    model: { id: "m-1", api: "openai-completions", baseUrl: "https://x", provider: "p-1" },
    systemPrompt: "sys",
    messagesText: '[{"content":"hi","role":"user","timestamp":1}]',
    tools: [{ name: "t", description: "d", schemaText: '{"type":"object"}' }],
    optionsText:
      optionsText ?? `{"apiKey":"${SEEDED_KEY}","temperature":0.5,"timeoutMs":60000}`,
    transientCount: 1,
  };
}

let dir = "";
let warnFields: Array<Record<string, unknown>> = [];

function makeStore(): WireCacheStore {
  return new WireCacheStore({
    dir,
    warn: (_msg, fields) => warnFields.push(fields),
    now: () => 999,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loom-wire-cache-"));
  warnFields = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("W23-A WireCacheStore 落盘面", () => {
  it("roundtrip：save → read 字段全等（savedAt=注入时钟；providerPayload null 如实）", () => {
    const store = makeStore();
    const snap = fixtureSnapshot();
    store.save("sid_a", snap, null);
    const rec = store.read("sid_a");
    expect(rec).not.toBeNull();
    expect(rec!.savedAt).toBe(999);
    expect(rec!.providerPayload).toBeNull();
    // 快照其余字段逐字保留；optionsText 只 apiKey 值被换 ***（脱敏不改非凭据键）。
    expect(rec!.snapshot.capturedAt).toBe(111);
    expect(rec!.snapshot.turnIdx).toBe(3);
    expect(rec!.snapshot.systemPrompt).toBe("sys");
    expect(rec!.snapshot.messagesText).toBe(snap.messagesText);
    expect(rec!.snapshot.tools).toEqual(snap.tools);
    expect(rec!.snapshot.transientCount).toBe(1);
    expect(rec!.snapshot.model).toEqual(snap.model);
    expect(JSON.parse(rec!.snapshot.optionsText)).toEqual({
      apiKey: "***",
      temperature: 0.5,
      timeoutMs: 60000,
    });
  });

  it("seed-key grep 零命中：盘上原始文本不含明文 apiKey（写前脱敏，非出口遮羞）", () => {
    const store = makeStore();
    store.save("sid_grep", fixtureSnapshot(), null);
    const path = join(dir, wireCacheFileName("sid_grep"));
    const raw = readFileSync(path, "utf8");
    expect(raw.includes(SEEDED_KEY)).toBe(false);
    // optionsText 是字符串字段：盘上为转义形（apiKey 值位 = ***）。
    const onDisk = JSON.parse(raw) as { snapshot: { optionsText: string } };
    expect(onDisk.snapshot.optionsText).toContain('"apiKey":"***"');
    expect(warnFields.length).toBe(0);
  });

  it("providerPayload 字符串原样透传（真通道面逐字节）", () => {
    const store = makeStore();
    const payload = '{"model":"m-1","messages":[{"role":"user"}]}';
    store.save("sid_p", fixtureSnapshot(), payload);
    expect(store.read("sid_p")!.providerPayload).toBe(payload);
  });

  it("覆盖写：同 sid 二次 save 后目录仍一份文件、内容为末次", () => {
    const store = makeStore();
    store.save("sid_c", fixtureSnapshot('{"apiKey":"first-key-secret-1"}'), "p1");
    store.save("sid_c", fixtureSnapshot('{"apiKey":"second-key-secret-2"}'), "p2");
    const files = readdirSync(dir).filter((f) => f.startsWith("sid_c"));
    expect(files.length).toBe(1);
    const rec = store.read("sid_c")!;
    expect(rec.providerPayload).toBe("p2");
    // 首次明文也已被覆盖：盘上两份 key 都零命中。
    const raw = readFileSync(join(dir, wireCacheFileName("sid_c")), "utf8");
    expect(raw).not.toContain("first-key-secret-1");
    expect(raw).not.toContain("second-key-secret-2");
  });

  it("写前脱敏失败（optionsText 非 JSON 对象）= 整条拒写 fail-closed + warn", () => {
    const store = makeStore();
    store.save("sid_bad", fixtureSnapshot("not-json"), null);
    expect(store.read("sid_bad")).toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith("sid_bad"))).toEqual([]);
    expect(warnFields.length).toBe(1);
  });

  it("读侧 fail-soft：JSON 坏 / 版本不合 / 形状缺 → null（不抛、warn 留痕）", () => {
    const store = makeStore();
    const path = join(dir, wireCacheFileName("sid_r"));
    writeFileSync(path, "{oops", "utf8");
    expect(store.read("sid_r")).toBeNull();
    const badVersion = {
      version: WIRE_CACHE_VERSION + 99,
      savedAt: 1,
      snapshot: fixtureSnapshot(),
      providerPayload: null,
    };
    writeFileSync(path, JSON.stringify(badVersion), "utf8");
    expect(store.read("sid_r")).toBeNull();
    const badShape = { version: WIRE_CACHE_VERSION, savedAt: 1, snapshot: { capturedAt: 1 }, providerPayload: null };
    writeFileSync(path, JSON.stringify(badShape), "utf8");
    expect(store.read("sid_r")).toBeNull();
    expect(warnFields.length).toBeGreaterThanOrEqual(3);
  });

  it("文件缺失 = null 静默（常态缺席面，不刷 warn）", () => {
    const store = makeStore();
    expect(store.read("never_saved")).toBeNull();
    expect(warnFields.length).toBe(0);
  });

  it("文件名安全化：连字符 sid 与下划线 sid 同键；注入字符夹平", () => {
    expect(wireCacheFileName("a-b")).toBe(wireCacheFileName("a_b"));
    const hostile = wireCacheFileName("../../etc/passwd");
    expect(hostile).not.toContain("/");
    // 唯一允许的 "." = 扩展名点（基名无点 ⇒ 无相对路径段可言）。
    expect(hostile.slice(0, -".json".length)).not.toContain(".");
    expect(hostile).toBe("______etc_passwd.json");
  });

  it("盘上手改明文回潮也不放行为第二口径：read 只校验形状（出口闸在 buildWireView 再脱敏）", () => {
    const store = makeStore();
    const path = join(dir, wireCacheFileName("sid_tamper"));
    // 模拟运维手改：optionsText 塞回明文（读侧不二次脱敏不拒读，但 wire-view 出网闸会拦）。
    const rec = {
      version: WIRE_CACHE_VERSION,
      savedAt: 1,
      snapshot: { ...fixtureSnapshot(), optionsText: `{"apiKey":"${SEEDED_KEY}"}` },
      providerPayload: null,
    };
    writeFileSync(path, JSON.stringify(rec), "utf8");
    const read = store.read("sid_tamper");
    expect(read).not.toBeNull();
  });
});
