/**
 * W25 skills 热重载单测 —— loader.reload() 公共 API。
 *
 * 验收点（工单 W25 a/d）：
 *   1. reload 轮次往返：改 description / 增删 skill 文件 → 重扫原子换入，清单、
 *      catalogText、invoke 面即刻新值；generation 单调 +1；
 *   2. 正文不嗅探：只改正文（frontmatter 逐字不动）→ reload 成功但 catalogText 逐字节
 *      相等（catalog 哈希面零位移 = "零 notice"的数据源保证）；
 *   3. fail-soft：allowlist 目录不可读 / 全坏（零有效 skill）→ ok:false + reason，
 *      旧 catalog 照常服务（entries/catalogText/hook 全部旧值，绝不空化）。
 *
 * Given/When/Then 单例单行为；tmp 目录真扫（绝不碰 state/session 现网吧）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentSession } from "../index.js";
import { createFakeModel } from "../testing.js";
import { loadSkills, type SkillsLoader } from "./loader.js";

let root: string;
let skillsDir: string;

/** 平铺形态 skill 文本（哨兵正文 = 嗅探缺席断言靶）。 */
function skillMd(name: string, description: string, bodyTag: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `# ${bodyTag}`,
    `BODY-TEXT::${bodyTag}::这是只在 invoke 时才允许出现的正文`,
  ].join("\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "w25-reload-"));
  skillsDir = join(root, "skills");
  mkdirSync(skillsDir, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("W25-a: reload 轮次往返（清单/catalogText/invoke/generation 四面同换）", () => {
  it("改 description + 增删 skill 文件 → reload 后清单与 catalog 块即刻新值，旧名 invoke 未知", async () => {
    // Given：alpha（平铺）+ beta（目录形态）两件。
    const dir = join(root, "roundtrip");
    mkdirSync(join(dir, "beta"), { recursive: true });
    writeFileSync(join(dir, "alpha.md"), skillMd("alpha", "ALPHA-DESC-ONE", "A1"));
    writeFileSync(join(dir, "beta", "SKILL.md"), skillMd("beta", "BETA-DESC", "B"));
    const loader: SkillsLoader = await loadSkills({ allowlist: [dir] });
    expect(loader.generation()).toBe(0);
    expect(loader.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);

    // When：改 alpha 描述、删 beta、加 gamma，然后 reload。
    writeFileSync(join(dir, "alpha.md"), skillMd("alpha", "ALPHA-DESC-TWO", "A2"));
    rmSync(join(dir, "beta"), { recursive: true, force: true });
    writeFileSync(join(dir, "gamma.md"), skillMd("gamma", "GAMMA-DESC", "G"));
    const r = loader.reload();

    // Then：轮次往返全套。
    expect(r.ok).toBe(true);
    expect(r.generation).toBe(1);
    expect(loader.generation()).toBe(1);
    expect(loader.entries.map((e) => e.name)).toEqual(["alpha", "gamma"]);
    expect(loader.catalogText()).toContain("- alpha: ALPHA-DESC-TWO");
    expect(loader.catalogText()).toContain("- gamma: GAMMA-DESC");
    expect(loader.catalogText()).not.toContain("beta");
    // 换入后的下一请求 system prompt 即携新 catalog（活读面）。
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      systemPrompt: "You are an agent.",
      tools: [loader.tool],
      hooks: [loader.hook],
    });
    await session.run("go");
    expect(fake.getCalls()[0]!.systemPrompt).toContain("- alpha: ALPHA-DESC-TWO");
    expect(fake.getCalls()[0]!.systemPrompt).not.toContain("ALPHA-DESC-ONE");
    fake.teardown();
    // invoke 按名解析走现视图：新名可读、旧名未知。
    expect(await loader.invoke("gamma")).toContain("BODY-TEXT::G::");
    await expect(loader.invoke("beta")).rejects.toThrow(/unknown skill "beta"/);
  });
});

describe("W25-c: 正文不嗅探（body-only 改动 catalog 零位移）", () => {
  it("只改正文不动 frontmatter → reload 成功但 catalogText 逐字节相等（差异嗅探的数据源保证）", async () => {
    // Given：单件基线。
    const dir = join(root, "bodyonly");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "solo.md");
    writeFileSync(file, skillMd("solo", "SOLO-DESC", "V1"));
    const loader = await loadSkills({ allowlist: [dir] });
    const text0 = loader.catalogText();

    // When：正文改写（描述逐字不动）后 reload。
    writeFileSync(file, skillMd("solo", "SOLO-DESC", "V2-BODY-REWRITTEN"));
    const r = loader.reload();

    // Then：重载代号 +1（嗅探据代号进内容比对走 touch-无变零发），catalog 块字节全等。
    expect(r.ok).toBe(true);
    expect(r.generation).toBe(1);
    expect(loader.catalogText()).toBe(text0);
    expect(loader.entries[0]!.description).toBe("SOLO-DESC");
    // 正文懒读不受 reload 影响：invoke 现读现盘新正文。
    expect(await loader.invoke("solo")).toContain("V2-BODY-REWRITTEN");
  });
});

describe("W25-d: reload 失败 fail-soft（旧 catalog 照服务，绝不空化/绝不抛）", () => {
  it("allowlist 目录被删 → ok:false reason 可读，entries/catalogText/hook 全为旧值", async () => {
    // Given：可用装配。
    const dir = join(root, "gone");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.md"), skillMd("keep", "KEEP-DESC", "K"));
    const loader = await loadSkills({ allowlist: [dir] });
    const text0 = loader.catalogText();

    // When：目录整删（模拟不可读）。
    rmSync(dir, { recursive: true, force: true });
    const r = loader.reload();

    // Then：fail-soft —— 不抛、旧面照服务、代号不动。
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unreadable");
    expect(r.generation).toBe(0);
    expect(loader.catalogText()).toBe(text0);
    expect(loader.entries.map((e) => e.name)).toEqual(["keep"]);
    // 下一请求的 system prompt 仍是旧 catalog（绝不留白）。
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [loader.tool],
      hooks: [loader.hook],
    });
    await session.run("go");
    expect(fake.getCalls()[0]!.systemPrompt).toContain("- keep: KEEP-DESC");
    fake.teardown();
  });

  it("目录仍在但全坏（零有效 skill）→ 同样 fail-soft 保留旧 catalog", async () => {
    // Given：好件装配后把目录换成全坏。
    const dir = join(root, "allbad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "good.md"), skillMd("good", "GOOD-DESC", "G"));
    const loader = await loadSkills({ allowlist: [dir] });

    // When：好件删除、只剩无 frontmatter 坏文件。
    rmSync(join(dir, "good.md"));
    writeFileSync(join(dir, "broken.md"), "# 没有任何 frontmatter\n只有正文。\n");
    const r = loader.reload();

    // Then：零有效 = 数据灾难场景，保留旧清单继续服务。
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no valid skills");
    expect(loader.entries.map((e) => e.name)).toEqual(["good"]);
    expect(loader.catalogText()).toContain("- good: GOOD-DESC");
  });
});
