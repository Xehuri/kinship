/**
 * frontmatter 解析单测（T24）。
 * Given/When/Then：直接喂文本、断言解析结果；穷尽围栏/键值/续行/引号/失败路径。
 */

import { describe, it, expect } from "vitest";import {
  parseMdFrontmatter,
  parseMemoryValue,
  parseToolsValue,
} from "./frontmatter.js";

describe("parseMdFrontmatter: 正常解析", () => {
  it("提取键值与围栏后正文", () => {
    const text = [
      "---",
      "name: review-pr",
      "description: Use when asked to review a pull request.",
      "---",
      "# 正文标题",
      "正文第二行",
    ].join("\n");

    const r = parseMdFrontmatter(text);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["name"]).toBe("review-pr");
      expect(r.data["description"]).toBe(
        "Use when asked to review a pull request.",
      );
      expect(r.body).toBe("# 正文标题\n正文第二行");
    }
  });

  it("值含冒号（URL/时间戳）按第一个冒号切分", () => {
    const r = parseMdFrontmatter("---\ndescription: see http://a:8080/x\n---\nB");
    expect(r.ok && r.data["description"]).toBe("see http://a:8080/x");
  });

  it("剥成对引号、跳过注释行与空行", () => {
    const r = parseMdFrontmatter(
      '---\n# 注释\nname: "quoted-name"\n\n---\nBODY',
    );
    expect(r.ok && r.data["name"]).toBe("quoted-name");
    expect(r.ok && r.body).toBe("BODY");
  });

  it("缩进续行折叠进上一键的值", () => {
    const r = parseMdFrontmatter(
      "---\ndescription: first part\n  second part\n---\nB",
    );
    expect(r.ok && r.data["description"]).toBe("first part second part");
  });

  it("容忍 BOM 与 CRLF（正文换行归一为 \\n）", () => {
    const r = parseMdFrontmatter("﻿---\r\nname: x\r\n---\r\nB\r\nC");
    expect(r.ok && r.data["name"]).toBe("x");
    expect(r.ok && r.body).toBe("B\nC");
  });

  it("重复键后者覆盖前者", () => {
    const r = parseMdFrontmatter("---\nname: a\nname: b\n---\n");
    expect(r.ok && r.data["name"]).toBe("b");
  });
});

describe("parseMdFrontmatter: 失败路径（返回 reason，不抛）", () => {
  it("缺开头围栏", () => {
    const r = parseMdFrontmatter("# 无 frontmatter\n正文");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("缺少 frontmatter 围栏");
  });

  it("缺闭合围栏", () => {
    const r = parseMdFrontmatter("---\nname: a\n正文没有围栏");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("闭合围栏");
  });

  it("块内非键值行", () => {
    const r = parseMdFrontmatter("---\nthis is not kv\n---\nB");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("非键值");
  });

  it("续行之前没有键", () => {
    const r = parseMdFrontmatter("---\n  orphan continuation\n---\nB");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("续行之前没有键");
  });

  it("空文本", () => {
    expect(parseMdFrontmatter("").ok).toBe(false);
  });
});

describe("parseToolsValue", () => {
  it("方括号形态 [A, B]", () => {
    expect(parseToolsValue("[WebFetch, Grep]")).toEqual(["WebFetch", "Grep"]);
  });
  it("逗号形态 A, B", () => {
    expect(parseToolsValue("WebFetch, Grep")).toEqual(["WebFetch", "Grep"]);
  });
  it("单值 A", () => {
    expect(parseToolsValue("WebFetch")).toEqual(["WebFetch"]);
  });
  it("空/未定义 -> undefined（不造假数组）", () => {
    expect(parseToolsValue(undefined)).toBeUndefined();
    expect(parseToolsValue("")).toBeUndefined();
    expect(parseToolsValue("[]")).toBeUndefined();
  });
  it("剥每项引号", () => {
    expect(parseToolsValue('"a", b')).toEqual(["a", "b"]);
  });
});

describe("parseMemoryValue: frontmatter memory glob 列表（角色自声明注入）", () => {
  it("方括号形态 [a/**, b/*.md]", () => {
    expect(parseMemoryValue("[memory/fact/**, data/*.md]")).toEqual(["memory/fact/**", "data/*.md"]);
  });
  it("逗号形态 a/**, b.md 与单值", () => {
    expect(parseMemoryValue("memory/a/**, b.md")).toEqual(["memory/a/**", "b.md"]);
    expect(parseMemoryValue("AGENTS.md")).toEqual(["AGENTS.md"]);
  });
  it("空/未定义 -> undefined（缺省=零注入，不造假数组）", () => {
    expect(parseMemoryValue(undefined)).toBeUndefined();
    expect(parseMemoryValue("")).toBeUndefined();
    expect(parseMemoryValue("[]")).toBeUndefined();
  });
  it("剥每项引号；? 元字符保留", () => {
    expect(parseMemoryValue('"memory/a.md", log-2026-0?.md')).toEqual(["memory/a.md", "log-2026-0?.md"]);
  });
  it("含 [ ] { } 反引号的条目整条剔除、其余保留（花括号展开不支持，fail-soft）", () => {
    expect(parseMemoryValue("a.md, b{c,d}.md, [x], `y`")).toEqual(["a.md"]);
  });
  it("frontmatter 行内 memory 键解析进 data（与 tags/tools 共存）", () => {
    const fm = parseMdFrontmatter(["---", "tags: [a]", "memory: [memory/fact/**]", "---", "# body"].join("\n"));
    expect(fm.ok).toBe(true);
    if (fm.ok) {
      expect(parseMemoryValue(fm.data["memory"])).toEqual(["memory/fact/**"]);
      expect(fm.body).toBe("# body");
    }
  });
});
