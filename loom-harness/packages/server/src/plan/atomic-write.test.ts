/**
 * T02 原子写原语验收。
 *
 * 覆盖：同目录 temp 清理、失败不碰目标、稳定 JSON、并发读侧永远只看到完整文件。
 * 所有落盘都在 mkdtemp 临时根，不碰真实数据目录。
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AtomicWriteError, writeJsonAtomic, writeTextAtomic } from "./atomic-write.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atomic-write-"));
  roots.push(root);
  return root;
}

function tmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("writeTextAtomic", () => {
  it("写入完整文本并创建缺失父目录，不留下 temp", () => {
    const root = tempRoot();
    const target = join(root, "nested", "note.txt");

    writeTextAtomic(target, "hello\nworld");

    expect(readFileSync(target, "utf8")).toBe("hello\nworld");
    expect(tmpFiles(join(root, "nested"))).toEqual([]);
  });

  it("父目录无法创建时抛类型化错误且不残留 temp", () => {
    const root = tempRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a dir");

    let error: unknown;
    try {
      writeTextAtomic(join(blocker, "note.txt"), "x");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AtomicWriteError);
    expect(error).toMatchObject({ phase: "mkdir" });
    expect(existsSync(join(blocker, "note.txt"))).toBe(false);
    expect(tmpFiles(root)).toEqual([]);
  });
});

describe("writeJsonAtomic", () => {
  it("输出键字典序稳定的 JSON 并以换行结尾", () => {
    const root = tempRoot();
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    const value = { b: 1, a: { d: 2, c: [1, { z: 3, a: 4 }] } };

    writeJsonAtomic(first, value);
    writeJsonAtomic(second, { a: { c: [1, { a: 4, z: 3 }], d: 2 }, b: 1 });

    const text = readFileSync(first, "utf8");
    expect(text).toBe(readFileSync(second, "utf8"));
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(value);
  });

  it("序列化失败时目标保持原样且不残留 temp", () => {
    const root = tempRoot();
    const target = join(root, "stable.json");
    writeJsonAtomic(target, { ok: true });
    const before = readFileSync(target, "utf8");

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    let error: unknown;
    try {
      writeJsonAtomic(target, circular);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AtomicWriteError);
    expect(error).toMatchObject({ target, phase: "serialize" });
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(tmpFiles(root)).toEqual([]);
  });

  it("并发读取只会看到完整文件（old 或 new，绝无半截）", async () => {
    const root = tempRoot();
    const target = join(root, "data.json");
    const chunk = 16 * 1024;
    const values = Array.from({ length: 24 }, (_, index) => ({
      id: index,
      payload: `${String(index)}:`.repeat(chunk),
    }));
    writeJsonAtomic(target, values[0]);

    const stop = { value: false };
    const readers = [0, 1, 2].map(async () => {
      let reads = 0;
      while (!stop.value) {
        const text = await readFile(target, "utf8");
        const parsed = JSON.parse(text) as { id: number; payload: string };
        expect(parsed.payload).toBe(`${String(parsed.id)}:`.repeat(chunk));
        reads += 1;
      }
      return reads;
    });

    try {
      for (const value of values) {
        writeJsonAtomic(target, value);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      stop.value = true;
    }

    const counts = await Promise.all(readers);
    expect(counts.every((count) => count > 0)).toBe(true);
    expect(tmpFiles(root)).toEqual([]);
  });
});
