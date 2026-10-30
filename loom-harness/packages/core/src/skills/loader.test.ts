/**
 * skills 加载器单测（T24）。
 *
 * 验收点（docs/02 T24 + 任务卡第 4 条）：
 *   a. allowlist 外目录被排除（清单 + catalog 双通路）；
 *   b. 目录清单/ catalog 只含元数据（name+description），绝无正文；
 *   c. 显式 invoke 才把正文注入当轮 toolResult（且懒读：扫描后改文件 -> invoke 读到新正文）；
 *   d. 坏 frontmatter 跳过并记 degrade，不拖垮清单。
 *
 * 经 testing.ts 的 fake-model 捕获 Context.systemPrompt，与 plugins/__tests__/skills.test.ts
 * 同款断言通路；loader 与 vendored 插件的集成即在此验证。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentSession, Type, type HarnessTool } from "../index.js";
import { createFakeModel } from "../testing.js";
import { loadSkills, scanSkills } from "./loader.js";

/** 一段合法 skill 文本（frontmatter + 可识别正文）。 */
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

let skillsDir: string; // allowlist 内
let outsideDir: string; // allowlist 外

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "t24-skills-"));
  skillsDir = join(root, "skills");
  outsideDir = join(root, "outside");

  // 两种布局：目录形态 <name>/SKILL.md 与平铺形态 <name>.md
  await mkdir(join(skillsDir, "review-pr"), { recursive: true });
  await writeFile(
    join(skillsDir, "review-pr", "SKILL.md"),
    skillMd("review-pr", "Use when asked to review a pull request.", "REVIEW"),
  );
  await writeFile(
    join(skillsDir, "deep-research.md"),
    skillMd("deep-research", "Multi-source fact-checked research.", "RESEARCH"),
  );
  // tools 声明（透传激活集通路）
  await writeFile(
    join(skillsDir, "fetcher.md"),
    [
      "---",
      "name: fetcher",
      "description: Use to fetch web pages.",
      "tools: WebFetch",
      "---",
      "BODY-TEXT::FETCHER::",
    ].join("\n"),
  );
  // 非 skill 内容：普通子目录（无 SKILL.md）、隐藏/下划线目录、.txt
  await mkdir(join(skillsDir, "assets"), { recursive: true });
  await writeFile(join(skillsDir, "assets", "logo.txt"), "not a skill");
  await mkdir(join(skillsDir, "_template"), { recursive: true });
  await writeFile(join(skillsDir, "_template", "tpl.md"), "---\nname: tpl\ndescription: d\n---\nB");
  await writeFile(join(skillsDir, "notes.txt"), "ignore me");

  // allowlist 外目录：合法 skill，但绝不可见
  await mkdir(outsideDir, { recursive: true });
  await writeFile(
    join(outsideDir, "secret-skill.md"),
    skillMd("secret-skill", "Should never appear.", "SECRET"),
  );
});

afterAll(async () => {
  const root = join(skillsDir, "..");
  await rm(root, { recursive: true, force: true });
});

describe("T24-a: allowlist 排除", () => {
  it("scanSkills 只收 allowlist 内目录；allowlist 外的合法 skill 不进清单", async () => {
    const scan = await scanSkills([skillsDir]);
    const names = scan.entries.map((e) => e.name);

    expect(names).toContain("review-pr"); // 目录形态 <name>/SKILL.md
    expect(names).toContain("deep-research"); // 平铺形态 <name>.md
    expect(names).not.toContain("secret-skill"); // allowlist 外目录
    // 非 skill 内容不入清单
    expect(names).not.toContain("tpl");
    expect(names).not.toContain("assets");
  });

  it("非白名单目录的 skill 不出现在 system prompt catalog", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    // 只 allowlist skillsDir，outsideDir 不传入
    const loader = await loadSkills({ allowlist: [skillsDir] });
    const session = new AgentSession({
      model: fake,
      systemPrompt: "You are an agent.",
      tools: [loader.tool],
      hooks: [loader.hook],
    });
    await session.run("go");

    const sys = fake.getCalls()[0]!.systemPrompt;
    expect(sys).not.toContain("secret-skill");
    expect(sys).not.toContain("BODY-TEXT::SECRET::");
    fake.teardown();
  });

  it("allowlist 为空 / 目录不可读 -> fail-loud 抛", async () => {
    await expect(scanSkills([])).rejects.toThrow(/non-empty/);
    await expect(
      scanSkills([join(skillsDir, "definitely-not-here")]),
    ).rejects.toThrow(/unreadable/);
  });
});

describe("T24-b: 清单只进元数据，绝无正文", () => {
  it("SkillEntry 结构无 body 字段；catalog 含 name+description 行、不含任何 BODY-TEXT", async () => {
    const scan = await scanSkills([skillsDir]);
    for (const entry of scan.entries) {
      expect("body" in entry).toBe(false);
    }

    const loader = await loadSkills({ allowlist: [skillsDir] });
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

    const sys = fake.getCalls()[0]!.systemPrompt;
    expect(sys).toContain("## Available skills");
    // 精确钉 name↔description 配对（vendored 插件的 catalog 行格式）
    expect(sys).toContain("- review-pr: Use when asked to review a pull request.");
    expect(sys).toContain("- deep-research: Multi-source fact-checked research.");
    // 正文绝不进 system prompt
    expect(sys).not.toContain("BODY-TEXT::REVIEW::");
    expect(sys).not.toContain("BODY-TEXT::RESEARCH::");
    expect(sys).not.toContain("BODY-TEXT::FETCHER::");
    fake.teardown();
  });
});

describe("T24-c: invoke 才注入正文（懒读）", () => {
  it("tool invoke 返回 body 全文作 toolResult；未 invoke 时消息里无正文", async () => {
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "skill", arguments: { name: "review-pr" } },
        ],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const loader = await loadSkills({ allowlist: [skillsDir] });
    const session = new AgentSession({
      model: fake,
      tools: [loader.tool],
      hooks: [loader.hook],
    });
    await session.run("go");

    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: { text?: string }[]; isError?: boolean }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).not.toBe(true);
    const text = tr!.content.map((b) => b.text ?? "").join("");
    expect(text).toContain("BODY-TEXT::REVIEW::");
    // 未调用的技能正文不出现
    expect(text).not.toContain("BODY-TEXT::RESEARCH::");
    fake.teardown();
  });

  it("懒读证明：loadSkills 之后改写文件，invoke 读到新正文（扫描期未驻留旧正文）", async () => {
    const file = join(skillsDir, "deep-research.md");
    const loader = await loadSkills({ allowlist: [skillsDir] });

    // 加载后再改正文（若加载期驻留了 body，下面 invoke 会读到旧文本）
    await writeFile(
      file,
      skillMd("deep-research", "Multi-source fact-checked research.", "RESEARCH-V2"),
    );

    const body = await loader.invoke("deep-research");
    expect(body).toContain("BODY-TEXT::RESEARCH-V2::");
    expect(body).not.toContain("RESEARCH::这是");
  });

  it("invoke() 程序化通路 = tool 通路同源；未知名抛带 available", async () => {
    const loader = await loadSkills({ allowlist: [skillsDir] });
    const body = await loader.invoke("fetcher");
    expect(body).toContain("BODY-TEXT::FETCHER::");

    await expect(loader.invoke("nope")).rejects.toThrow(/unknown skill "nope"/);
  });

  it("frontmatter tools 声明透传：invoke 激活 deferred 工具下一 turn 可见", async () => {
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "skill", arguments: { name: "fetcher" } },
        ],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const trivial: HarnessTool = {
      name: "WebFetch",
      description: "web",
      parameters: Type.Object({}),
      isConcurrencySafe: () => true,
      async execute() {
        return { content: [{ type: "text", text: "ran" }] };
      },
    };
    const loader = await loadSkills({ allowlist: [skillsDir] });
    const { deferredTools } = await import("../plugins/deferred-tools.js");
    const session = new AgentSession({
      model: fake,
      tools: [trivial, loader.tool],
      hooks: [
        deferredTools({ deferred: ["WebFetch"], alwaysListed: [loader.tool.name] }),
        loader.hook,
      ],
    });
    await session.run("go");

    const turn1 = (fake.getCalls()[0]!.tools ?? []).map((t) => t.name);
    const turn2 = (fake.getCalls()[1]!.tools ?? []).map((t) => t.name);
    expect(turn1).not.toContain("WebFetch");
    expect(turn2).toContain("WebFetch"); // 激活集复用 O1 seam
    fake.teardown();
  });
});

