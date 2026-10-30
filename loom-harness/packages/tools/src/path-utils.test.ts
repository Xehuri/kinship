/**
 * path-utils 安全咽喉点测试（T04，先测试后实现）。
 *
 * 核心验收：resolveToolPath 的 realpath 包含性检查必须拒绝 `../` 逃逸，
 * 并且能识破「词法上在 cwd 内、realpath 后在 cwd 外」的 symlink 逃逸。
 */
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  escapeRegExp,
  globToRegExp,
  hasGlobMagic,
  isPathInside,
  normalizeDisplayPath,
  resolveToolPath,
  toDisplayPath,
} from "./path-utils.js";

let dir = "";
let outsideDir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-path-utils-"));
  outsideDir = await mkdtemp(path.join(tmpdir(), "loom-path-outside-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("resolveToolPath：cwd 包含性", () => {
  it("解析 cwd 内的相对路径", () => {
    expect(resolveToolPath(dir, "notes.txt")).toBe(path.resolve(dir, "notes.txt"));
  });

  it("解析 cwd 内、词法含 .. 回环的路径", () => {
    expect(resolveToolPath(dir, "docs/../notes.txt")).toBe(
      path.resolve(dir, "notes.txt"),
    );
  });

  it("拒绝 ../ 逃逸出 cwd", () => {
    expect(() => resolveToolPath(dir, "../outside.txt")).toThrow(/escapes cwd/i);
    expect(() => resolveToolPath(dir, "sub/../../outside.txt")).toThrow(
      /escapes cwd/i,
    );
  });

  it("拒绝指向 cwd 外的绝对路径", () => {
    const target = path.join(outsideDir, "secret.txt");
    expect(() => resolveToolPath(dir, target)).toThrow(/escapes cwd/i);
  });

  it("realpath 识破 symlink 逃逸（词法在 cwd 内、真实路径在 cwd 外）", async () => {
    const secret = path.join(outsideDir, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, path.join(dir, "link.txt"));
    // 纯词法检查会放行 link.txt；realpath 检查必须拒绝。
    expect(() => resolveToolPath(dir, "link.txt")).toThrow(/escapes cwd/i);
  });

  it("允许指向 cwd 内的 symlink", async () => {
    await writeFile(path.join(dir, "real.txt"), "ok");
    await symlink(path.join(dir, "real.txt"), path.join(dir, "alias.txt"));
    expect(resolveToolPath(dir, "alias.txt")).toBe(path.resolve(dir, "alias.txt"));
  });

  it("空输入按 cwd 处理", async () => {
    expect(resolveToolPath(dir, undefined)).toBe(path.resolve(dir));
    expect(resolveToolPath(dir, "   ")).toBe(path.resolve(dir));
  });

  it("allowOutsideCwd=true 时放行逃逸路径（词法解析原样返回）", () => {
    const target = path.join(outsideDir, "out.txt");
    expect(resolveToolPath(dir, target, { allowOutsideCwd: true })).toBe(target);
  });

  it("对不存在的路径按最近的已存在祖先做 realpath 检查", () => {
    // new/dir/file.txt 都不存在，但祖先 dir 在 cwd 内 → 允许（write 场景）。
    expect(resolveToolPath(dir, "new/dir/file.txt")).toBe(
      path.resolve(dir, "new/dir/file.txt"),
    );
    // ../new/file.txt 不存在但词法已在 cwd 外 → 仍拒绝。
    expect(() => resolveToolPath(dir, "../new/file.txt")).toThrow(/escapes cwd/i);
  });
});

describe("isPathInside", () => {
  it("判定包含与逃逸", () => {
    expect(isPathInside(dir, path.join(dir, "a", "b.ts"))).toBe(true);
    expect(isPathInside(dir, dir)).toBe(true);
    expect(isPathInside(dir, path.join(dir, "..", "sibling"))).toBe(false);
    expect(isPathInside(dir, "/etc/passwd")).toBe(false);
  });
});

describe("展示路径与 glob 工具", () => {
  it("toDisplayPath：cwd 内给相对、cwd 外给绝对", () => {
    expect(toDisplayPath(dir, path.join(dir, "src", "a.ts"))).toBe("src/a.ts");
    expect(toDisplayPath(dir, dir)).toBe(".");
    const outside = path.join(outsideDir, "x.ts");
    expect(toDisplayPath(dir, outside)).toBe(outside);
  });

  it("normalizeDisplayPath 把系统分隔符归一为 /", () => {
    expect(normalizeDisplayPath(path.join("a", "b", "c"))).toBe("a/b/c");
  });

  it("hasGlobMagic 识别 glob 元字符", () => {
    expect(hasGlobMagic("*.ts")).toBe(true);
    expect(hasGlobMagic("plain/name")).toBe(false);
  });

  it("globToRegExp：* 不跨 /，**/ 可选前缀，? 单字符", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("dir/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("dir/a.ts")).toBe(true);
    expect(globToRegExp("a?c.ts").test("abc.ts")).toBe(true);
    expect(globToRegExp("a?c.ts").test("abbc.ts")).toBe(false);
  });

  it("globToRegExp：字符类与花括号展开", () => {
    expect(globToRegExp("[abc].ts").test("b.ts")).toBe(true);
    expect(globToRegExp("[abc].ts").test("d.ts")).toBe(false);
    expect(globToRegExp("*.{ts,md}").test("x.md")).toBe(true);
    expect(globToRegExp("*.{ts,md}").test("x.rs")).toBe(false);
  });

  it("escapeRegExp 转义正则元字符", () => {
    expect(escapeRegExp("1.5+2")).toBe("1\\.5\\+2");
    expect(new RegExp(escapeRegExp("a[bc]")).test("a[bc]")).toBe(true);
  });
});
