import { describe, expect, it } from "vitest";

import {
  clipText,
  countBy,
  formatCoverage,
  formatIso,
  formatPayload,
  plainBlock,
  plainInline,
} from "./text-utils.js";

describe("plainInline", () => {
  it("normalizes CRLF and CR line endings to spaces", () => {
    expect(plainInline("a\r\nb\rc")).toBe("a b c");
  });

  it("collapses multiline whitespace runs into one space and trims", () => {
    expect(plainInline("  line1\n\n   line2 \nline3  ")).toBe("line1 line2 line3");
  });

  it("keeps brace placeholders verbatim", () => {
    expect(plainInline("计划 {昨天日期}\n  完成")).toBe("计划 {昨天日期} 完成");
  });
});

describe("plainBlock", () => {
  it("normalizes newlines, strips trailing spaces, and preserves inner blank lines", () => {
    expect(plainBlock("\n\r\nline one  \r\n  \r\nline two\t\n\n")).toBe(
      "line one\n\nline two",
    );
  });

  it("keeps brace placeholders and quotes verbatim", () => {
    expect(plainBlock('{昨天日期} "保留"  \n下一行')).toBe('{昨天日期} "保留"\n下一行');
  });
});

describe("formatPayload", () => {
  it("returns none for null and undefined", () => {
    expect(formatPayload(null)).toBe("none");
    expect(formatPayload(undefined)).toBe("none");
  });

  it("inlines strings and clips to the default limit", () => {
    expect(formatPayload("  a\n\n b  ")).toBe("a b");
    expect(formatPayload("x".repeat(310))).toBe(`${"x".repeat(300)}…(+10)`);
  });

  it("formats numbers and booleans", () => {
    expect(formatPayload(42)).toBe("42");
    expect(formatPayload(false)).toBe("false");
  });

  it("joins array elements without brackets", () => {
    expect(formatPayload([1, "two", { a: 1 }])).toBe("1, two, a=1");
  });

  it("flattens nested objects without braces or quotes", () => {
    const text = formatPayload({ b: 2, a: "x\ny", gone: undefined, nil: null });
    expect(text).toBe("b=2, a=x y, nil=none");
    expect(formatPayload({ outer: { inner: 1, text: "a b" } })).toBe(
      "outer=inner=1, text=a b",
    );
    expect(text).not.toMatch(/[{}"]/);
  });

  it("clips object values through the shared clip marker", () => {
    expect(formatPayload({ long: "y".repeat(100) })).toBe(
      `long=${"y".repeat(80)}…(+20)`,
    );
  });
});

describe("clipText", () => {
  it("returns short values unchanged", () => {
    expect(clipText("abc", 3)).toBe("abc");
  });

  it("appends a length marker when clipping", () => {
    expect(clipText("abcdef", 3)).toBe("abc…(+3)");
  });

  it("returns an empty string for non-positive limits", () => {
    expect(clipText("abc", 0)).toBe("");
    expect(clipText("abc", -1)).toBe("");
  });
});

describe("formatCoverage", () => {
  it("lists checkpoints and debt", () => {
    expect(
      formatCoverage({
        profile: "p",
        checkpoints: ["c1", "c2"],
        debt: ["d1", "d2"],
      }),
    ).toBe("profile=p checkpoints=c1,c2 debt=d1;d2");
  });

  it("renders none for empty lists", () => {
    expect(formatCoverage({ profile: "p", checkpoints: [], debt: [] })).toBe(
      "profile=p checkpoints=none debt=none",
    );
  });
});

describe("formatIso", () => {
  it("formats finite timestamps", () => {
    expect(formatIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("returns a dash for non-finite values", () => {
    expect(formatIso(Number.NaN)).toBe("—");
    expect(formatIso(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("countBy", () => {
  it("orders by count desc then key asc", () => {
    const items = ["done", "done", "done", "planned", "skipped"];
    expect(countBy(items, (item) => item)).toBe("done 3, planned 1, skipped 1");
  });

  it("breaks ties by key ascending", () => {
    expect(countBy(["b", "a"], (item) => item)).toBe("a 1, b 1");
  });

  it("returns none for empty input", () => {
    expect(countBy([], (item) => item)).toBe("none");
  });
});
