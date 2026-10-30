import { describe, expect, it } from "vitest";

import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter - 注释围栏键值块", () => {
  it("解析全量合法键", () => {
    const text = [
      "#---",
      "#enabled: false",
      "#name: my-task",
      "#lang: node",
      "#respawn: false",
      "#---",
      "print(1)",
    ].join("\n");
    const r = parseFrontmatter(text, "whatever.py");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toEqual({ enabled: false, name: "my-task", lang: "node", respawn: false });
  });

  it("无 frontmatter -> 全默认值，name 取文件名去扩展名", () => {
    const r = parseFrontmatter("print(1)\n", "hello.py");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toEqual({ enabled: true, name: "hello", lang: "python", respawn: true });
  });

  it("缺省键走默认，未知语言文件兜底 python", () => {
    const text = ["#---", "#name: x", "#---", "echo 1"].join("\n");
    const r = parseFrontmatter(text, "script.weird");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toEqual({ enabled: true, name: "x", lang: "python", respawn: true });
  });

  it("纯注释行与空行被跳过", () => {
    const text = ["#---", "# 这是说明", "", "#enabled: false", "#---"].join("\n");
    const r = parseFrontmatter(text, "a.py");
    expect(r.ok).toBe(true);
  });

  it("未闭合围栏 -> 错误", () => {
    const r = parseFrontmatter("#---\n#enabled: true\nprint(1)\n", "a.py");
    expect(r.ok).toBe(false);
  });

  it("未知键 -> 错误", () => {
    const r = parseFrontmatter("#---\n#owner: bob\n#---\n", "a.py");
    expect(r.ok).toBe(false);
  });

  it("非法布尔 -> 错误", () => {
    const r = parseFrontmatter("#---\n#enabled: yes\n#---\n", "a.py");
    expect(r.ok).toBe(false);
  });

  it("非法 lang -> 错误", () => {
    const r = parseFrontmatter("#---\n#lang: cobol\n#---\n", "a.py");
    expect(r.ok).toBe(false);
  });

  it("扩展名推断语言", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["a.py", "python"],
      ["a.ts", "ts"],
      ["a.mjs", "node"],
      ["a.sh", "shell"],
      ["a.txt", "python"],
    ];
    for (const [file, lang] of cases) {
      const r = parseFrontmatter("", file);
      expect(r.ok && r.meta.lang).toBe(lang);
    }
  });
});
