/**
 * skills 加载器 degrade 通路单测（T24-d）。
 * Given/When/Then：坏 frontmatter / 缺 description / 零有效目录，
 * 断言"跳过 + 记录 degrade、好文件不受累、全坏目录 fail-loud 抛"。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentSession } from "../index.js";
import { createFakeModel } from "../testing.js";
import { loadSkills, scanSkills, type SkillsLoader } from "./loader.js";

let brokenDir: string;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "t24-degrade-"));
  brokenDir = join(tmpRoot, "broken");
  await mkdir(brokenDir, { recursive: true });

  await writeFile(
    join(brokenDir, "good.md"),
    ["---", "name: good", "description: fine one.", "---", "# GOOD", "正文好文件"].join("\n"),
  );
  await writeFile(join(brokenDir, "no-fence.md"), "# 没有 frontmatter 的文档\n正文\n");
  await writeFile(
    join(brokenDir, "unclosed.md"),
    "---\nname: x\ndescription: y\n没有闭合围栏\n",
  );
  await writeFile(join(brokenDir, "no-desc.md"), "---\nname: no-desc\n---\nB");
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("T24-d: 坏 frontmatter 跳过并记 degrade", () => {
  it("坏文件不进清单但进 degraded（含原因与定位）；同目录好文件不受影响", async () => {
    const scan = await scanSkills([brokenDir]);
    expect(scan.entries.map((e) => e.name)).toEqual(["good"]);
    expect(scan.degraded).toHaveLength(3);

    const reasons = scan.degraded.map((d) => d.reason).join(" | ");
    expect(reasons).toContain("坏 frontmatter"); // no-fence.md
    expect(reasons).toContain("闭合围栏"); // unclosed.md
    expect(reasons).toContain("缺少 description"); // no-desc.md
    for (const d of scan.degraded) {
      expect(d.dir).toBeTruthy();
      expect(d.file).toBeTruthy();
    }
  });

  it("loadSkills 容忍 degrade：好文件照常出 catalog，degraded 明细对外可见", async () => {
    const loader: SkillsLoader = await loadSkills({ allowlist: [brokenDir] });
    expect(loader.entries.map((e) => e.name)).toEqual(["good"]);
    expect(loader.degraded).toHaveLength(3);

    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [loader.tool],
      hooks: [loader.hook],
    });
    await session.run("go");
    expect(fake.getCalls()[0]!.systemPrompt).toContain("- good: fine one.");
    fake.teardown();
  });

  it("allowlist 内零有效 skill -> loadSkills 抛（fail-loud，degrade 计数随消息给出）", async () => {
    const dir = join(tmpRoot, "zero-valid");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bad.md"), "no frontmatter at all");
    await expect(loadSkills({ allowlist: [dir] })).rejects.toThrow(
      /no valid skills in allowlist/,
    );
  });
});
