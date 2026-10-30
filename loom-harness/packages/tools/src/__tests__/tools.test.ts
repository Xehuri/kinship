/**
 * 移植自 vendor-snapshot/harness-pi/packages/tools/src/__tests__/tools.test.ts（T04）。
 * 改动：core 包名改为 loom-core；`{} as any` 的 ctx 参数改用
 * loom-core/testing 的 createTestContext；details 断言用 assertRecord 收窄，
 * 全程 strict 无抑制。
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentSession,
  type HarnessTool,
  type ToolExecResult,
} from "@axeuh/loom-core";
import { createFakeModel, createTestContext } from "@axeuh/loom-core/testing";
import { readImageDimensions } from "../image-size.js";
import {
  allTools,
  bashTool,
  createAllTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  editTool,
  findTool,
  grepTool,
  lsTool,
  readTool,
  toolNames,
  type ToolName,
  writeTool,
} from "../index.js";

let dir = "";

const TOOL_DANGER_METADATA = {
  read: { isReadOnly: true, isDestructive: false, isOpenWorld: false },
  bash: { isReadOnly: false, isDestructive: true, isOpenWorld: true },
  edit: { isReadOnly: false, isDestructive: true, isOpenWorld: false },
  write: { isReadOnly: false, isDestructive: true, isOpenWorld: false },
  grep: { isReadOnly: true, isDestructive: false, isOpenWorld: false },
  find: { isReadOnly: true, isDestructive: false, isOpenWorld: false },
  ls: { isReadOnly: true, isDestructive: false, isOpenWorld: false },
} satisfies Record<
  ToolName,
  Pick<HarnessTool, "isReadOnly" | "isDestructive" | "isOpenWorld">
>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-tools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** details 是 unknown 契约字段；断言前用断言函数收窄，避免 any。 */
function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a plain object");
  }
}

async function runTool(
  tool: HarnessTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecResult> {
  const active = signal ?? new AbortController().signal;
  return tool.execute(args, createTestContext({ signal: active }).ctx, active);
}

function text(result: ToolExecResult): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text result");
  return first.text;
}

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(29);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

function jpegHeader(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x07, 0x01, 0x02, 0x03, 0x04, 0x05,
    0xff, 0xff, 0xff, 0xc0, 0x00, 0x07, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ]);
}

function gifHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(22, 4);
  header.write("WEBP", 8, "ascii");
  header.write("VP8X", 12, "ascii");
  header.writeUInt32LE(10, 16);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return header;
}

function webpVp8Header(width: number, height: number): Buffer {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(22, 4);
  header.write("WEBP", 8, "ascii");
  header.write("VP8 ", 12, "ascii");
  header.writeUInt32LE(10, 16);
  header[23] = 0x9d;
  header[24] = 0x01;
  header[25] = 0x2a;
  header.writeUInt16LE(width, 26);
  header.writeUInt16LE(height, 28);
  return header;
}

function webpVp8lHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(25);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(17, 4);
  header.write("WEBP", 8, "ascii");
  header.write("VP8L", 12, "ascii");
  header.writeUInt32LE(5, 16);
  header[20] = 0x2f;
  header.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return header;
}

function dangerMetadata(tool: HarnessTool) {
  return {
    isReadOnly: tool.isReadOnly,
    isDestructive: tool.isDestructive,
    isOpenWorld: tool.isOpenWorld,
  };
}

describe("tool danger metadata", () => {
  for (const name of toolNames) {
    it(`declares exact danger metadata for ${name}`, () => {
      expect(dangerMetadata(createAllTools(dir)[name])).toEqual(
        TOOL_DANGER_METADATA[name],
      );
    });
  }

  it("exposes danger metadata on exported tool objects", () => {
    const individualExports = {
      read: readTool,
      bash: bashTool,
      edit: editTool,
      write: writeTool,
      grep: grepTool,
      find: findTool,
      ls: lsTool,
    } satisfies Record<ToolName, HarnessTool>;

    for (const name of toolNames) {
      expect(dangerMetadata(individualExports[name])).toEqual(
        TOOL_DANGER_METADATA[name],
      );
      expect(dangerMetadata(allTools[name])).toEqual(TOOL_DANGER_METADATA[name]);
    }
  });
});

describe("read tool", () => {
  it("reads text files with cwd-relative paths and offset/limit", async () => {
    await writeFile(
      path.join(dir, "notes.txt"),
      ["one", "two", "three", "four"].join("\n"),
    );
    const result = await runTool(createReadTool(dir), {
      path: "notes.txt",
      offset: 2,
      limit: 2,
    });
    expect(text(result)).toContain("two");
    expect(text(result)).toContain("three");
    expect(text(result)).not.toContain("one");
    expect(text(result)).toContain("1 more lines in file");
    expect(result.details).toBeUndefined();
  });

  it("uses read operations override", async () => {
    const tool = createReadTool(dir, {
      operations: {
        readFile: async () => Buffer.from("from override"),
        access: async () => undefined,
      },
    });
    const result = await runTool(tool, { path: "virtual.txt" });
    expect(text(result)).toBe("from override");
  });

  it("returns text note and image content for image files", async () => {
    await writeFile(path.join(dir, "pixel.png"), pngHeader(1, 1));
    const result = await runTool(createReadTool(dir), { path: "pixel.png" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Read image file [image/png]",
    });
    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    const image = result.content[1];
    if (image?.type !== "image") throw new Error("expected image content");
    expect(Buffer.from(image.data, "base64")).toEqual(pngHeader(1, 1));
  });

  it("rejects tall images before base64 enters model context", async () => {
    await writeFile(path.join(dir, "tall.png"), pngHeader(1027, 15000));
    const promise = runTool(createReadTool(dir), { path: "tall.png" });
    await expect(promise).rejects.toThrow(/1027x15000/);
    await expect(promise).rejects.toThrow(/4096/);
    await expect(promise).rejects.toThrow(/切段或降采样/);
  });

  it("rejects images over the configured pixel limit", async () => {
    await writeFile(path.join(dir, "square.png"), pngHeader(20, 20));
    const promise = runTool(createReadTool(dir, { maxImagePixels: 100 }), {
      path: "square.png",
    });
    await expect(promise).rejects.toThrow(/像素总数 400 超过上限 100/);
  });

  it("rejects corrupt images whose dimensions cannot be parsed", async () => {
    await writeFile(
      path.join(dir, "broken.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await expect(
      runTool(createReadTool(dir), { path: "broken.png" }),
    ).rejects.toThrow(/无法读取图片尺寸/);
  });

  it("rejects images over the configured byte limit", async () => {
    await writeFile(path.join(dir, "heavy.png"), pngHeader(1, 1));
    const promise = runTool(createReadTool(dir, { maxImageBytes: 8 }), {
      path: "heavy.png",
    });
    await expect(promise).rejects.toThrow(/图片文件过大/);
    await expect(promise).rejects.toThrow(/29 字节/);
    await expect(promise).rejects.toThrow(/上限 8 字节/);
  });

  it("truncates large text files by default", async () => {
    await writeFile(path.join(dir, "large.txt"), "x".repeat(60 * 1024));
    const result = await runTool(createReadTool(dir), { path: "large.txt" });
    expect(text(result).length).toBeLessThanOrEqual(50 * 1024);
    expect(result.details).toMatchObject({
      truncation: { totalBytes: 60 * 1024, firstLineExceedsLimit: true },
    });
  });

  it("throws for unreadable files", async () => {
    await expect(
      runTool(createReadTool(dir), { path: "missing.txt" }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });

  it("throws when offset is beyond end of file", async () => {
    await writeFile(path.join(dir, "notes.txt"), "one\ntwo\n");
    await expect(
      runTool(createReadTool(dir), { path: "notes.txt", offset: 9 }),
    ).rejects.toThrow(/beyond end/i);
  });

  it("rejects paths outside cwd unless explicitly allowed", async () => {
    const outside = path.join(
      path.dirname(dir),
      `${path.basename(dir)}-outside.txt`,
    );
    await writeFile(outside, "outside");
    await expect(
      runTool(createReadTool(dir), { path: outside }),
    ).rejects.toThrow(/escapes cwd/i);
    const result = await runTool(createReadTool(dir, { allowOutsideCwd: true }), {
      path: outside,
    });
    expect(text(result)).toBe("outside");
  });

  it("behaves identically to default truncation when maxTokens is unset", async () => {
    await writeFile(
      path.join(dir, "notes.txt"),
      ["one", "two", "three"].join("\n"),
    );
    const withoutCap = await runTool(createReadTool(dir), { path: "notes.txt" });
    expect(text(withoutCap)).toBe("one\ntwo\nthree");
    expect(withoutCap.details).toBeUndefined();
  });

  it("returns content when estimated tokens are within maxTokens", async () => {
    await writeFile(path.join(dir, "notes.txt"), "x".repeat(40));
    // 40 bytes / 4 = 10 estimated tokens, under the cap.
    const result = await runTool(createReadTool(dir), {
      path: "notes.txt",
      maxTokens: 100,
    });
    expect(text(result)).toBe("x".repeat(40));
  });

  it("returns a short error guiding offset+limit when maxTokens is exceeded", async () => {
    await writeFile(path.join(dir, "big.txt"), "x".repeat(4_000));
    // 4000 bytes / 4 = 1000 estimated tokens, over the cap of 100.
    const promise = runTool(createReadTool(dir), {
      path: "big.txt",
      maxTokens: 100,
    });
    await expect(promise).rejects.toThrow(/exceeds maxTokens=100/);
    await expect(promise).rejects.toThrow(/~1000 tokens/);
    await expect(promise).rejects.toThrow(/offset\+limit/i);
    let err: Error | undefined;
    try {
      await promise;
    } catch (e) {
      if (e instanceof Error) err = e;
      else throw e;
    }
    if (err === undefined) throw new Error("expected maxTokens rejection");
    expect(Buffer.byteLength(err.message, "utf8")).toBeLessThan(200);
    // 错误信息不泄漏被截断的文件内容。
    expect(err.message).not.toContain("xxxx");
  });

  it("estimates denser bytesPerToken for json/jsonl than other extensions", async () => {
    const payload = "x".repeat(300);
    await writeFile(path.join(dir, "data.json"), payload);
    await writeFile(path.join(dir, "data.txt"), payload);
    // 300 bytes: json -> ceil(300/2)=150 tokens, txt -> ceil(300/4)=75 tokens.
    // A cap of 100 trips the .json file but not the .txt file.
    await expect(
      runTool(createReadTool(dir), { path: "data.json", maxTokens: 100 }),
    ).rejects.toThrow(/~150 tokens/);
    const txtResult = await runTool(createReadTool(dir), {
      path: "data.txt",
      maxTokens: 100,
    });
    expect(text(txtResult)).toBe(payload);
  });

  it("estimates tokens on the offset+limit slice so a smaller range succeeds", async () => {
    await writeFile(
      path.join(dir, "lines.txt"),
      Array.from({ length: 20 }, () => "x".repeat(40)).join("\n"),
    );
    // Whole file ~20*41/4 ≈ 205 tokens > 100, but a 5-line slice is well under.
    await expect(
      runTool(createReadTool(dir), { path: "lines.txt", maxTokens: 100 }),
    ).rejects.toThrow(/exceeds maxTokens=100/);
    const sliced = await runTool(createReadTool(dir), {
      path: "lines.txt",
      offset: 1,
      limit: 5,
      maxTokens: 100,
    });
    // 切片成功路径要精确钉住窗口大小:以 5 行原文开头、且不含第 6 行
    // (read 对部分读会追加续读页脚,故不能整串相等;但"恰好 5 行"必须钉死)。
    const fiveLines = Array.from({ length: 5 }, () => "x".repeat(40)).join("\n");
    const sixLines = Array.from({ length: 6 }, () => "x".repeat(40)).join("\n");
    expect(text(sliced).startsWith(fiveLines)).toBe(true);
    expect(text(sliced).startsWith(sixLines)).toBe(false);
  });

  it("treats an estimate exactly equal to maxTokens as within the cap (boundary, not off-by-one)", async () => {
    // 阈值判定 `estimated > maxTokens`:把临界点两侧都钉死,
    // 防 `>` 被改成 `>=` 这类回归在边界静默改变行为。
    await writeFile(path.join(dir, "exact.txt"), "x".repeat(40)); // 40B / 4 = 10 === cap
    const atCap = await runTool(createReadTool(dir), {
      path: "exact.txt",
      maxTokens: 10,
    });
    expect(text(atCap)).toBe("x".repeat(40)); // 恰好等于 → 返回完整内容,不 throw

    await writeFile(path.join(dir, "over.txt"), "x".repeat(41)); // 41B / 4 → ceil = 11 > cap
    await expect(
      runTool(createReadTool(dir), { path: "over.txt", maxTokens: 10 }),
    ).rejects.toThrow(/exceeds maxTokens=10/); // 超 1 token → throw
  });

  it("rejects a negative maxTokens via the shared positive-integer validator", async () => {
    await writeFile(path.join(dir, "notes.txt"), "hi");
    await expect(
      runTool(createReadTool(dir), { path: "notes.txt", maxTokens: -1 }),
    ).rejects.toThrow(/must be a non-negative number/);
  });

  it("still applies normal byte truncation when content is within maxTokens", async () => {
    // token 检查跑在 truncateHead 之前的 selected 上;未超 cap 时不干扰既有截断。
    await writeFile(path.join(dir, "big.txt"), "x".repeat(400)); // 400B / 4 = 100 估算
    const result = await runTool(createReadTool(dir, { maxBytes: 100 }), {
      path: "big.txt",
      maxTokens: 200, // 100 <= 200 → 不 throw,落到字节截断
    });
    expect(result.details).toBeDefined();
    expect(Buffer.byteLength(text(result), "utf8")).toBeLessThan(400);
  });

  it("rejects symlink escapes and bounded default exports reject outside cwd", async () => {
    const outside = path.join(
      path.dirname(dir),
      `${path.basename(dir)}-secret.txt`,
    );
    await writeFile(outside, "secret");
    await symlink(outside, path.join(dir, "link.txt"));

    await expect(
      runTool(createReadTool(dir), { path: "link.txt" }),
    ).rejects.toThrow(/escapes cwd/i);
    await expect(runTool(readTool, { path: outside })).rejects.toThrow(
      /escapes cwd/i,
    );
  });
});

describe("write and edit tools", () => {
  it("writes files under cwd and creates parent directories", async () => {
    const result = await runTool(createWriteTool(dir), {
      path: "nested/output.txt",
      content: "hello",
    });
    expect(text(result)).toContain("File written successfully");
    await expect(
      readFile(path.join(dir, "nested/output.txt"), "utf8"),
    ).resolves.toBe("hello");
  });

  it("honors write operations override", async () => {
    const calls: string[] = [];
    const result = await runTool(
      createWriteTool(dir, {
        operations: {
          mkdir: async (target) => {
            calls.push(`mkdir:${path.basename(target)}`);
          },
          writeFile: async (target, content) => {
            calls.push(`write:${path.basename(target)}:${content}`);
          },
        },
      }),
      { path: "fake/output.txt", content: "hello" },
    );
    expect(text(result)).toContain("File written successfully");
    expect(calls).toEqual(["mkdir:fake", "write:output.txt:hello"]);
  });

  it("propagates write operation failures", async () => {
    await expect(
      runTool(
        createWriteTool(dir, {
          operations: {
            mkdir: async () => {
              throw new Error("mkdir failed");
            },
          },
        }),
        { path: "nested/output.txt", content: "hello" },
      ),
    ).rejects.toThrow(/mkdir failed/);
  });

  it("rejects writes through symlinked directories outside cwd", async () => {
    const outsideDir = path.join(
      path.dirname(dir),
      `${path.basename(dir)}-outside-dir`,
    );
    await mkdir(outsideDir);
    await symlink(outsideDir, path.join(dir, "link-dir"));
    await expect(
      runTool(createWriteTool(dir), {
        path: "link-dir/secret.txt",
        content: "nope",
      }),
    ).rejects.toThrow(/escapes cwd/i);
  });

  it("edits a unique text range and returns diff details", async () => {
    await writeFile(path.join(dir, "file.txt"), "alpha\nbeta\ngamma\n");
    const result = await runTool(createEditTool(dir), {
      path: "file.txt",
      oldText: "beta",
      newText: "BETA",
    });
    expect(text(result)).toContain("File edited successfully");
    await expect(readFile(path.join(dir, "file.txt"), "utf8")).resolves.toContain(
      "BETA",
    );
    expect(result.details).toMatchObject({ firstChangedLine: 2 });
    assertRecord(result.details);
    const diff = result.details["diff"];
    expect(typeof diff === "string" ? diff : "").toContain("-beta");
    expect(typeof diff === "string" ? diff : "").toContain("+BETA");
  });

  it("honors edit operations override", async () => {
    let written = "";
    const result = await runTool(
      createEditTool(dir, {
        operations: {
          access: async () => undefined,
          readFile: async () => Buffer.from("hello old"),
          writeFile: async (_target, content) => {
            written = content;
          },
        },
      }),
      { path: "virtual.txt", oldText: "old", newText: "new" },
    );
    expect(text(result)).toContain("File edited successfully");
    expect(written).toBe("hello new");
  });

  it("throws when oldText is empty or not found", async () => {
    await writeFile(path.join(dir, "file.txt"), "alpha\n");
    await expect(
      runTool(createEditTool(dir), {
        path: "file.txt",
        oldText: "",
        newText: "x",
      }),
    ).rejects.toThrow(/must not be empty/i);
    await expect(
      runTool(createEditTool(dir), {
        path: "file.txt",
        oldText: "missing",
        newText: "x",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("throws when edit target is not unique", async () => {
    await writeFile(path.join(dir, "file.txt"), "same\nsame\n");
    await expect(
      runTool(createEditTool(dir), {
        path: "file.txt",
        oldText: "same",
        newText: "other",
      }),
    ).rejects.toThrow(/multiple/i);
  });
});

describe("grep, find, and ls tools", () => {
  beforeEach(async () => {
    await writeFile(path.join(dir, "alpha.txt"), "needle\nline two\n");
    await writeFile(path.join(dir, "omega.txt"), "tail\n");
    await writeFile(path.join(dir, "beta.md"), "Needle in markdown\n");
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "guide.md"), "before\nneedle\nafter\n");
  });

  it("greps files with literal and ignoreCase options", async () => {
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      literal: true,
      ignoreCase: true,
    });
    expect(text(result)).toContain("alpha.txt:1: needle");
    expect(text(result)).toContain("beta.md:1: Needle in markdown");
  });

  it("honors grep operations override", async () => {
    const result = await runTool(
      createGrepTool(dir, {
        operations: {
          isDirectory: async () => false,
          readFile: async () => "hello override\n",
        },
      }),
      { pattern: "override", path: "virtual.txt" },
    );
    expect(text(result)).toContain("virtual.txt:1: hello override");
  });

  it("requires listFiles when grep operations override handles directories", async () => {
    await expect(
      runTool(
        createGrepTool(dir, {
          operations: {
            isDirectory: async () => true,
            readFile: async () => "",
          },
        }),
        { pattern: "needle", path: "." },
      ),
    ).rejects.toThrow(/listFiles/i);
  });

  it("counts grep limit by match before expanding context", async () => {
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: "docs/guide.md",
      context: 1,
      limit: 1,
    });
    expect(text(result)).toContain("docs/guide.md-1- before");
    expect(text(result)).toContain("docs/guide.md:2: needle");
    expect(text(result)).toContain("docs/guide.md-3- after");
  });

  it("supports root-level ** globs and .gitignore filtering", async () => {
    await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(dir, "ignored.txt"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      glob: "**/*.txt",
      literal: true,
    });
    expect(text(result)).toContain("alpha.txt");
    expect(text(result)).not.toContain("ignored.txt");
  });

  it("applies workspace .gitignore when grepping from a subdirectory", async () => {
    await writeFile(path.join(dir, ".gitignore"), "docs/ignored.md\n");
    await writeFile(path.join(dir, "docs", "ignored.md"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: "docs",
      glob: "*.md",
      literal: true,
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("ignored.md");
  });

  it("matches .gitignore path segments without substring false positives", async () => {
    await writeFile(path.join(dir, ".gitignore"), "dist\n");
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "distance.ts"), "needle\n");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "needle\n");

    const grepResult = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      glob: "**/*.ts",
      literal: true,
    });
    expect(text(grepResult)).toContain("src/distance.ts");
    expect(text(grepResult)).not.toContain("dist/hidden.ts");
  });

  it("honors root-anchored .gitignore patterns when grepping", async () => {
    await writeFile(path.join(dir, ".gitignore"), "/dist\n");
    await mkdir(path.join(dir, "src", "dist"), { recursive: true });
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "dist", "visible.ts"), "needle\n");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      glob: "**/*.ts",
      literal: true,
    });
    expect(text(result)).toContain("src/dist/visible.ts");
    expect(text(result)).not.toContain("dist/hidden.ts");
  });

  it("honors nested .gitignore files when grepping", async () => {
    await writeFile(path.join(dir, "docs", ".gitignore"), "nested-hidden.md\n");
    await writeFile(path.join(dir, "docs", "nested-hidden.md"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: "docs",
      glob: "*.md",
      literal: true,
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("nested-hidden.md");
  });

  it("throws for invalid grep regex and missing paths", async () => {
    await expect(
      runTool(createGrepTool(dir), { pattern: "[", path: "." }),
    ).rejects.toThrow();
    await expect(
      runTool(createGrepTool(dir), { pattern: "x", path: "missing" }),
    ).rejects.toThrow(/ENOENT|not found/i);
  });

  it("finds cwd-relative paths and reports limit truncation", async () => {
    const result = await runTool(createFindTool(dir), {
      pattern: "*.txt",
      path: ".",
      limit: 1,
    });
    expect(text(result)).toContain("alpha.txt");
    expect(result.details).toMatchObject({ resultLimitReached: 1 });
  });

  it("returns find results relative to cwd, not search path", async () => {
    const result = await runTool(createFindTool(dir), {
      pattern: "*.md",
      path: "docs",
    });
    expect(text(result)).toContain("docs/guide.md");
  });

  it("supports root-level ** find patterns and .gitignore filtering", async () => {
    await writeFile(path.join(dir, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(dir, "root.ts"), "x");
    await writeFile(path.join(dir, "ignored.ts"), "x");
    const result = await runTool(createFindTool(dir), { pattern: "**/*.ts" });
    expect(text(result)).toContain("root.ts");
    expect(text(result)).not.toContain("ignored.ts");
  });

  it("applies workspace .gitignore when finding from a subdirectory", async () => {
    await writeFile(path.join(dir, ".gitignore"), "docs/ignored.md\n");
    await writeFile(path.join(dir, "docs", "ignored.md"), "x");
    const result = await runTool(createFindTool(dir), {
      pattern: "*.md",
      path: "docs",
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("ignored.md");
  });

  it("does not let .gitignore segment patterns hide substring matches in find", async () => {
    await writeFile(path.join(dir, ".gitignore"), "dist\n");
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "distance.ts"), "x");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "x");
    const result = await runTool(createFindTool(dir), { pattern: "**/*.ts" });
    expect(text(result)).toContain("src/distance.ts");
    expect(text(result)).not.toContain("dist/hidden.ts");
  });

  it("honors root-anchored and nested .gitignore patterns in find", async () => {
    await writeFile(path.join(dir, ".gitignore"), "/dist\n");
    await mkdir(path.join(dir, "src", "dist"), { recursive: true });
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "dist", "visible.ts"), "x");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "x");
    let result = await runTool(createFindTool(dir), { pattern: "**/*.ts" });
    expect(text(result)).toContain("src/dist/visible.ts");
    expect(text(result)).not.toContain("dist/hidden.ts");

    await writeFile(path.join(dir, "docs", ".gitignore"), "nested-hidden.md\n");
    await writeFile(path.join(dir, "docs", "nested-hidden.md"), "x");
    result = await runTool(createFindTool(dir), {
      pattern: "*.md",
      path: "docs",
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("nested-hidden.md");
  });

  it("throws when find root is missing", async () => {
    await expect(
      runTool(createFindTool(dir), { pattern: "*.txt", path: "missing" }),
    ).rejects.toThrow(/not found/i);
  });

  it("honors find operations override", async () => {
    const result = await runTool(
      createFindTool(dir, {
        operations: {
          exists: async () => true,
          glob: async () => ["one.ts", "two.ts"],
        },
      }),
      { pattern: "*.ts" },
    );
    expect(text(result)).toBe("one.ts\ntwo.ts");
  });

  it("lists directories with stable ordering and limit metadata", async () => {
    const result = await runTool(createLsTool(dir), { path: ".", limit: 1 });
    expect(text(result)).toMatch(/alpha\.txt|beta\.md/);
    expect(result.details).toMatchObject({ entryLimitReached: 1 });
  });

  it("honors ls operations override and reports empty directories", async () => {
    const result = await runTool(
      createLsTool(dir, {
        operations: {
          exists: async () => true,
          stat: async () => ({ isDirectory: () => true }),
          readdir: async () => ["B", "a"],
        },
      }),
      { path: "." },
    );
    expect(text(result)).toBe("a/\nB/");

    const empty = await runTool(createLsTool(dir), { path: "docs", limit: 0 });
    expect(text(empty)).toBe("(empty directory)");
  });

  it("throws for missing ls path and file path", async () => {
    await expect(
      runTool(createLsTool(dir), { path: "missing" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      runTool(createLsTool(dir), { path: "alpha.txt" }),
    ).rejects.toThrow(/not a directory/i);
  });
});

describe("bash tool", () => {
  it("executes a real command in cwd", async () => {
    const result = await runTool(createBashTool(dir), {
      command: "printf '%s' \"$PWD\"",
    });
    await expect(realpath(text(result))).resolves.toBe(await realpath(dir));
  });

  it("executes through operations override", async () => {
    const result = await runTool(
      createBashTool(dir, {
        operations: {
          exec: async (command, cwd, options) => {
            options.onData(Buffer.from(`${command} @ ${path.basename(cwd)}`));
            return { exitCode: 0 };
          },
        },
      }),
      { command: "echo ok" },
    );
    expect(text(result)).toContain("echo ok @");
  });

  it("throws on non-zero exit", async () => {
    await expect(
      runTool(
        createBashTool(dir, {
          operations: {
            exec: async (_command, _cwd, options) => {
              options.onData(Buffer.from("boom"));
              return { exitCode: 2 };
            },
          },
        }),
        { command: "bad" },
      ),
    ).rejects.toThrow(/exited with code 2/i);
  });

  it("handles null exit and operation-level abort", async () => {
    await expect(
      runTool(
        createBashTool(dir, {
          operations: {
            exec: async () => ({ exitCode: null }),
          },
        }),
        { command: "killed" },
      ),
    ).rejects.toThrow(/killed by signal/i);

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runTool(createBashTool(dir), { command: "echo no" }, ctrl.signal),
    ).rejects.toThrow(/aborted/i);
  });

  it("passes timeout in seconds to operations override", async () => {
    let seenTimeout: number | undefined;
    await runTool(
      createBashTool(dir, {
        operations: {
          exec: async (_command, _cwd, options) => {
            seenTimeout = options.timeout;
            return { exitCode: 0 };
          },
        },
      }),
      { command: "echo ok", timeout: 3 },
    );
    expect(seenTimeout).toBe(3);
  });

  it("hard-stops commands that ignore TERM after timeout", async () => {
    const started = Date.now();
    await expect(
      runTool(createBashTool(dir), {
        command: "trap '' TERM; sleep 10",
        timeout: 1,
      }),
    ).rejects.toThrow(/timeout:1/);
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});

describe("composite tools", () => {
  it("can disable every default tool", () => {
    expect(
      createCodingTools(dir, { disabled: ["read", "bash", "edit", "write"] }),
    ).toEqual([]);
    expect(
      createReadOnlyTools(dir, { disabled: ["read", "grep", "find", "ls"] }),
    ).toEqual([]);
  });

  it("runs read-only tools through AgentSession and preserves real details", async () => {
    await writeFile(path.join(dir, "large.txt"), "x".repeat(60 * 1024));
    await writeFile(path.join(dir, "small.txt"), "needle\n");
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "read", arguments: { path: "large.txt" } },
          {
            type: "toolCall",
            name: "grep",
            arguments: { pattern: "needle", path: "." },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: createReadOnlyTools(dir),
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
    const results = session.messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => m.toolName)).toEqual(["read", "grep"]);
    const first = results[0];
    if (first === undefined || first.role !== "toolResult") {
      throw new Error("expected a toolResult message");
    }
    // details 走 unknown → assertRecord 收窄，禁止 any。
    const firstDetails: unknown = first.details;
    assertRecord(firstDetails);
    const truncation = firstDetails["truncation"];
    assertRecord(truncation);
    expect(truncation["totalBytes"]).toBe(60 * 1024);
  });
});

describe("readImageDimensions", () => {
  it("parses PNG IHDR dimensions", () => {
    expect(readImageDimensions(pngHeader(1027, 15000), "image/png")).toEqual({
      width: 1027,
      height: 15000,
    });
  });

  it("parses JPEG SOF dimensions across APP and fill bytes", () => {
    expect(readImageDimensions(jpegHeader(640, 480), "image/jpeg")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("parses GIF screen descriptor dimensions", () => {
    expect(readImageDimensions(gifHeader(320, 240), "image/gif")).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("parses WebP VP8X canvas dimensions", () => {
    expect(readImageDimensions(webpVp8xHeader(1920, 1080), "image/webp")).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("parses WebP VP8 keyframe dimensions", () => {
    expect(readImageDimensions(webpVp8Header(800, 600), "image/webp")).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("parses WebP VP8L lossless dimensions", () => {
    expect(readImageDimensions(webpVp8lHeader(333, 222), "image/webp")).toEqual({
      width: 333,
      height: 222,
    });
  });

  it("returns null for corrupt or unsupported headers", () => {
    expect(readImageDimensions(Buffer.alloc(0), "image/png")).toBeNull();
    expect(
      readImageDimensions(Buffer.from("GIF89a", "ascii"), "image/gif"),
    ).toBeNull();
    expect(
      readImageDimensions(Buffer.from("RIFF0000WEBP", "ascii"), "image/webp"),
    ).toBeNull();
    expect(
      readImageDimensions(pngHeader(1, 1), "image/tiff"),
    ).toBeNull();
  });
});
