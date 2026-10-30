/**
 * T02 文件锁原语验收。
 *
 * 覆盖：20 并发 writer 严格串行、owner 诊断、pid 死亡/mtime 超龄两种接管、
 * 超时类型化错误、fn 抛错后释放锁。所有锁文件都在 mkdtemp 临时根。
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileLockTimeoutError, readLockOwner, withFileLock } from "./file-lock.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "file-lock-"));
  roots.push(root);
  return root;
}

function lockPathOf(root: string): string {
  return join(root, "store.lock");
}

function writeOwner(lockPath: string, pid: number, token: string): void {
  writeFileSync(lockPath, `${JSON.stringify({ pid, at: Date.now(), token })}\n`);
}

describe("withFileLock", () => {
  it("20 个并发 writer 严格串行，所有增量保留", async () => {
    const root = tempRoot();
    const lockPath = lockPathOf(root);
    const counterPath = join(root, "counter.txt");
    writeFileSync(counterPath, "0");

    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];
    const jobs = Array.from({ length: 20 }, (_, index) =>
      withFileLock(
        lockPath,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            const current = Number(readFileSync(counterPath, "utf8"));
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
            writeFileSync(counterPath, String(current + 1));
            completed.push(index);
          } finally {
            active -= 1;
          }
        },
        { timeoutMs: 10_000 },
      ),
    );

    await Promise.all(jobs);

    expect(Number(readFileSync(counterPath, "utf8"))).toBe(20);
    expect(maxActive).toBe(1);
    expect(new Set(completed).size).toBe(20);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.break`)).toBe(false);
  });

  it("持锁期间可读 owner，释放后 readLockOwner 返回 null", async () => {
    const root = tempRoot();
    const lockPath = lockPathOf(root);

    const result = await withFileLock(lockPath, async () => {
      const owner = await readLockOwner(lockPath);
      expect(owner).not.toBeNull();
      expect(owner?.pid).toBe(process.pid);
      expect(typeof owner?.token).toBe("string");
      return "done";
    });

    expect(result).toBe("done");
    expect(await readLockOwner(lockPath)).toBeNull();
  });

  it("owner pid 已死时允许接管", async () => {
    const root = tempRoot();
    const lockPath = lockPathOf(root);
    writeOwner(lockPath, 99_999_999, "dead");

    const result = await withFileLock(lockPath, () => "taken", { timeoutMs: 1_000 });

    expect(result).toBe("taken");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("mtime 超过 staleMs 时即便 pid 存活也允许接管", async () => {
    const root = tempRoot();
    const lockPath = lockPathOf(root);
    writeOwner(lockPath, process.pid, "old");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    const result = await withFileLock(lockPath, () => "stale-taken", {
      staleMs: 1_000,
      timeoutMs: 1_000,
      isPidAlive: () => true,
    });

    expect(result).toBe("stale-taken");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("锁新鲜且持有者存活时超时并抛 FileLockTimeoutError，不破坏原锁", async () => {
    const root = tempRoot();
    const lockPath = lockPathOf(root);
    writeOwner(lockPath, process.pid, "held");
    const started = Date.now();

    let error: unknown;
    try {
      await withFileLock(lockPath, () => "never", { timeoutMs: 100, staleMs: 60_000 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(FileLockTimeoutError);
    expect(error).toMatchObject({ lockPath, timeoutMs: 100 });
    expect((await readLockOwner(lockPath))?.token).toBe("held");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("fn 抛错时仍释放锁，后续调用可立即获取", async () => {
    const root = tempRoot();
    const lockPath = lockPathOf(root);
    const boom = new Error("boom");

    let error: unknown;
    try {
      await withFileLock(lockPath, () => {
        throw boom;
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBe(boom);
    expect(existsSync(lockPath)).toBe(false);
    expect(await withFileLock(lockPath, () => 42, { timeoutMs: 500 })).toBe(42);
  });
});
