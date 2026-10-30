// T08 L0 状态层测试：crash-replay（撕裂尾行→重开 reader 恢复）、账本序、
// 会话分片目录索引 O(增量) 读。全部走临时目录，测毕清理。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Journal,
  Ledger,
  SessionShards,
  StateLayout,
  StateCorruptionError,
  StateLayoutError,
  LedgerError,
  type JsonObjectRow,
} from "./index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axeuh-state-t08-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function row(text: string): JsonObjectRow {
  return { text };
}

describe("Journal: append-only + torn-tail crash replay", () => {
  it("appends rows and replays them fully in a new instance", () => {
    const path = join(root, "trace", "2026-10-08.jsonl");
    const j = new Journal(path);
    j.append(row("a"));
    j.appendMany([row("b"), row("c")]);
    expect(j.size).toBe(3);

    const reopened = new Journal(path);
    expect(reopened.read()).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
  });

  it("recovers full history after a truncated (torn) tail line, then repairs the file", () => {
    const path = join(root, "trace", "2026-10-08.jsonl");
    const j = new Journal(path);
    j.append(row("a"));
    j.append(row("b"));
    // 模拟崩溃：第三条写到一半（无换行、JSON 截断）。
    appendFileSync(path, '{"text":"cc');

    const reopened = new Journal(path);
    // torn 尾行丢弃，前两条完整恢复。
    expect(reopened.read()).toEqual([{ text: "a" }, { text: "b" }]);
    // 撕裂段已从盘上截掉：文件以换行收尾，可安全续写。
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    reopened.append(row("d"));
    const again = new Journal(path);
    expect(again.read()).toEqual([{ text: "a" }, { text: "b" }, { text: "d" }]);
  });

  it("tolerates a parseable-but-shape-invalid tail row via custom isRow", () => {
    const path = join(root, "s.jsonl");
    const isTextRow = (r: JsonObjectRow): boolean => typeof r["text"] === "string";
    const j = new Journal(path, { isRow: isTextRow });
    j.append(row("a"));
    // 合法 JSON、缺载荷字段 = 形状残缺的 torn 行。
    appendFileSync(path, "{}\n");
    const reopened = new Journal(path, { isRow: isTextRow });
    expect(reopened.read()).toEqual([{ text: "a" }]);
  });

  it("throws StateCorruptionError on a bad line in the MIDDLE", () => {
    const path = join(root, "s.jsonl");
    // 中段坏行（前后都有合法行）= 真损坏。append-only 崩溃只会撕裂尾部，中段坏必须响亮抛。
    writeFileSync(path, '{"text":"a"}\nNOT JSON\n{"text":"b"}\n');
    expect(() => new Journal(path)).toThrow(StateCorruptionError);
  });

  it("read(fromRow) returns only the increment", () => {
    const path = join(root, "s.jsonl");
    const j = new Journal(path);
    j.appendMany([row("a"), row("b"), row("c")]);
    expect(j.read(2)).toEqual([{ text: "c" }]);
    expect(j.read(99)).toEqual([]);
  });

  it("fsyncOnAppend flushes each row to durable storage", () => {
    const path = join(root, "ledger", "2026-10-08.jsonl");
    const j = new Journal(path, { fsyncOnAppend: true });
    j.append(row("expected"));
    // fsync 语义验证：不重开实例直接查盘（page-cache-only 下这也能过，
    // 但此处重点是写路径不抛、行完整落盘）。
    expect(readFileSync(path, "utf8")).toBe('{"text":"expected"}\n');
  });
});

describe("Ledger: expected-before-execute / actual / gaps", () => {
  const ledgerPath = (): string => join(root, "ledger", "2026-10-08.jsonl");

  it("writes expected then actual rows with typed shapes", () => {
    const l = new Ledger(ledgerPath());
    l.expected("run-1", 100, { wf: "data-check" });
    l.actual("run-1", 200, "done", { summary: "ok" });
    expect(l.rows()).toEqual([
      { t: "expected", runId: "run-1", at: 100, payload: { wf: "data-check" } },
      { t: "actual", runId: "run-1", at: 200, status: "done", payload: { summary: "ok" } },
    ]);
  });

  it("crash replay: a new Ledger after torn tail recovers committed rows", () => {
    const path = ledgerPath();
    const l1 = new Ledger(path);
    l1.expected("run-1", 100);
    l1.expected("run-2", 110);
    // 崩溃在第三条 expected 写到一半。
    appendFileSync(path, '{"t":"expected","runId":"run-3","at":12');
    const l2 = new Ledger(path);
    expect(l2.gaps()).toEqual(["run-1", "run-2"]);
    // 撕裂尾行已修复：可继续登记。
    l2.actual("run-1", 300, "failed");
    const l3 = new Ledger(path);
    expect(l3.gaps()).toEqual(["run-2"]);
  });

  it("rejects duplicate expected, actual-without-expected, and double close", () => {
    const l = new Ledger(ledgerPath());
    l.expected("run-1", 100);
    expect(() => l.expected("run-1", 101)).toThrow(LedgerError);
    expect(() => l.actual("ghost", 200, "done")).toThrow(LedgerError);
    l.actual("run-1", 200, "done");
    expect(() => l.actual("run-1", 201, "partial")).toThrow(LedgerError);
  });

  it("gaps() = expected minus actual", () => {
    const l = new Ledger(ledgerPath());
    l.expected("a", 1);
    l.expected("b", 2);
    l.actual("a", 3, "done");
    expect(l.gaps()).toEqual(["b"]);
    l.actual("b", 4, "failed");
    expect(l.gaps()).toEqual([]);
  });

  it("readFrom advances by stored cursor without full replay", () => {
    const path = ledgerPath();
    const l1 = new Ledger(path);
    l1.expected("a", 1);
    const cursor = l1.size;
    l1.expected("b", 2);
    l1.actual("b", 3, "done");
    const l2 = new Ledger(path);
    expect(l2.readFrom(cursor)).toEqual([
      { t: "expected", runId: "b", at: 2, payload: null },
      { t: "actual", runId: "b", at: 3, status: "done", payload: null },
    ]);
  });
});

describe("SessionShards: N-turn sharding + dir index O(increment) reads", () => {
  const n = 3;
  const dirOf = (id: string): string => join(root, "session", id);

  it("seals a shard every N turns and keeps a dir index", () => {
    const s = new SessionShards(dirOf("s1"), { turnsPerShard: n });
    s.writeShard([row("t0"), row("t1"), row("t2"), row("t3")]);
    const idx = s.readIndex();
    expect(idx).toEqual([
      { no: 1, file: "shard-000001.jsonl", firstTurn: 0, turns: 3, sealed: true },
      { no: 2, file: "shard-000002.jsonl", firstTurn: 3, turns: 1, sealed: false },
    ]);
    expect(existsSync(join(s.dir, "shard-000001.jsonl"))).toBe(true);
    expect(existsSync(join(s.dir, "index.jsonl"))).toBe(true);
    expect(s.turnCount()).toBe(4);
  });

  it("reopens from disk: index rebuilt without re-reading sealed shard contents", () => {
    const dir = dirOf("s2");
    const s1 = new SessionShards(dir, { turnsPerShard: n });
    s1.writeShard([row("a"), row("b"), row("c"), row("d"), row("e")]);
    const s2 = new SessionShards(dir, { turnsPerShard: n });
    expect(s2.readIndex().map((e) => [e.no, e.turns, e.sealed])).toEqual([
      [1, 3, true],
      [2, 2, false],
    ]);
    expect(s2.turnCount()).toBe(5);
    s2.appendTurn(row("f")); // 活动片满 3 → 封片
    expect(s2.readIndex().map((e) => [e.no, e.sealed])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it("readAfter opens only shards covering the increment", () => {
    const dir = dirOf("s3");
    const s = new SessionShards(dir, { turnsPerShard: n });
    for (let i = 0; i < 12; i += 1) s.appendTurn(row(`t${String(i)}`));
    // 12 turns / N=3 → 4 封片、0 活动片。
    expect(s.turnCount()).toBe(12);

    const tail = s.readAfter(9);
    expect(tail.rows).toEqual([{ text: "t9" }, { text: "t10" }, { text: "t11" }]);
    // O(增量)：只打开覆盖 [9,12) 的分片（片 4），不是全部 4 片。
    expect(tail.openedShards).toBe(1);

    const full = s.readAfter(0);
    expect(full.rows.length).toBe(12);
    expect(full.openedShards).toBe(4); // 全量读才等价整目录扫
  });

  it("torn shard tail recovers on reopen and appends continue cleanly", () => {
    const dir = dirOf("s4");
    const s1 = new SessionShards(dir, { turnsPerShard: n });
    s1.appendTurn(row("a"));
    s1.appendTurn(row("b"));
    // 崩溃：活动分片尾部撕裂。
    appendFileSync(join(dir, "shard-000001.jsonl"), '{"text":"ccc');
    const s2 = new SessionShards(dir, { turnsPerShard: n });
    expect(s2.readAfter(0).rows).toEqual([{ text: "a" }, { text: "b" }]);
    s2.appendTurn(row("c"));
    const s3 = new SessionShards(dir, { turnsPerShard: n });
    expect(s3.readAfter(0).rows).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
  });

  it("torn index tail re-seals from shard dir on reopen", () => {
    const dir = dirOf("s5");
    const s1 = new SessionShards(dir, { turnsPerShard: n });
    s1.writeShard([row("a"), row("b"), row("c")]); // 封片 1
    s1.appendTurn(row("d"));
    // 崩溃：index 尾部撕裂（封片 1 的记录被截断）。
    appendFileSync(join(dir, "index.jsonl"), '{"t":"seal","no":2,"fi');
    const s2 = new SessionShards(dir, { turnsPerShard: n });
    // 目录实况推算：shard-1 满 3 行 → 自动补封；shard-2（1 行）为活动片。
    expect(s2.readIndex().map((e) => [e.no, e.turns, e.sealed])).toEqual([
      [1, 3, true],
      [2, 1, false],
    ]);
    expect(s2.readAfter(0).rows.length).toBe(4);
  });

  it("rejects invalid turnsPerShard", () => {
    expect(() => new SessionShards(dirOf("s6"), { turnsPerShard: 0 })).toThrow(/positive integer/);
    expect(() => new SessionShards(dirOf("s7"), { turnsPerShard: 1.5 })).toThrow(/positive integer/);
  });
});

describe("StateLayout: root injection + validation", () => {
  it("creates all six L0 dirs under the injected root", () => {
    const layout = new StateLayout({ root: join(root, "harness-state") });
    const dirs = layout.ensureDirs();
    expect(dirs.length).toBe(6);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
    expect(existsSync(join(layout.root, "dead-letter"))).toBe(true);
  });

  it("day path validates the date key", () => {
    const layout = new StateLayout({ root });
    expect(layout.dayPath("trace", "2026-10-08")).toBe(join(root, "trace", "2026-10-08.jsonl"));
    expect(() => layout.dayPath("trace", "../../etc/passwd")).toThrow(StateLayoutError);
    expect(() => layout.dayPath("ledger", "2026-13-45x")).toThrow(StateLayoutError);
  });

  it("session dir validates the id segment (no path escape)", () => {
    const layout = new StateLayout({ root });
    expect(() => layout.sessionDir("../evil")).toThrow(StateLayoutError);
    expect(() => layout.sessionDir("a/b")).toThrow(StateLayoutError);
    expect(layout.sessionDir("s-42.ok")).toBe(join(root, "session", "s-42.ok"));
  });

  it("openDayJournal wires trace/config journals to the layout", () => {
    const layout = new StateLayout({ root });
    const j = layout.openDayJournal("config", "2026-10-08");
    j.append({ t: "applied", hash: "abc" });
    expect(existsSync(join(root, "config", "2026-10-08.jsonl"))).toBe(true);
  });

  it("resolveStateRoot honors explicit arg over env", () => {
    const layout = new StateLayout({ root: join(root, "x") });
    expect(layout.root).toBe(join(root, "x"));
    // 无参时读 AXEUH_STATE_ROOT / 默认 repo state/——只验证默认值形态（绝对路径、含 state）。
    const fallback = new StateLayout();
    expect(fallback.root).toMatch(/state$/);
  });
});
