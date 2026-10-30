/**
 * RingBuffer 验收测试：行可见性、分页、字符上限截断、检索与清空。
 */
import { describe, expect, it } from "vitest";
import { RingBuffer } from "./buffer.js";

describe("RingBuffer", () => {
  it("appends and reads complete lines with stable numbering", () => {
    const buffer = new RingBuffer();
    buffer.append("alpha\nbeta\ngamma\n");

    const result = buffer.read();

    expect(result.lines).toEqual(["alpha", "beta", "gamma"]);
    expect(result.totalLines).toBe(3);
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(buffer.length).toBe(3);
    expect(buffer.size).toBe("alpha\nbeta\ngamma\n".length);
  });

  it("hides a trailing partial line until flushPartial completes it", () => {
    const buffer = new RingBuffer();
    buffer.append("first\npartial");

    expect(buffer.read().lines).toEqual(["first"]);
    expect(buffer.read().totalLines).toBe(1);
    expect(buffer.length).toBe(1);

    buffer.flushPartial();

    expect(buffer.read().lines).toEqual(["first", "partial"]);
    expect(buffer.read().totalLines).toBe(2);
    expect(buffer.length).toBe(2);
    expect(buffer.snapshot().endsWith("\n")).toBe(true);
  });

  it("completes a partial line when a later append supplies the newline", () => {
    const buffer = new RingBuffer();
    buffer.append("a");
    expect(buffer.read().lines).toEqual([]);

    buffer.append("b\n");

    expect(buffer.read().lines).toEqual(["ab"]);
    expect(buffer.length).toBe(1);
    expect(buffer.size).toBe(3);
  });

  it("paginates with offset and limit and reports hasMore", () => {
    const buffer = new RingBuffer();
    buffer.append("one\ntwo\nthree\nfour\nfive\n");

    const middle = buffer.read(1, 2);

    expect(middle.lines).toEqual(["two", "three"]);
    expect(middle.totalLines).toBe(5);
    expect(middle.offset).toBe(1);
    expect(middle.hasMore).toBe(true);

    const tail = buffer.read(3, 2);

    expect(tail.lines).toEqual(["four", "five"]);
    expect(tail.hasMore).toBe(false);

    const beyond = buffer.read(10, 2);

    expect(beyond.lines).toEqual([]);
    expect(beyond.totalLines).toBe(5);
    expect(beyond.offset).toBe(10);
    expect(beyond.hasMore).toBe(false);
  });

  it("keeps only the last maxChars characters when the cap is exceeded", () => {
    const buffer = new RingBuffer(10);
    buffer.append("0123456789ABC");

    expect(buffer.size).toBe(10);
    expect(buffer.snapshot()).toBe("3456789ABC");
    expect(buffer.length).toBe(0);
  });

  it("turns a truncated partial head into one line on the next newline", () => {
    const buffer = new RingBuffer(6);
    buffer.append("aaa\nbbbb");

    expect(buffer.size).toBe(6);
    expect(buffer.snapshot()).toBe("a\nbbbb");
    expect(buffer.read().lines).toEqual(["a"]);
    expect(buffer.length).toBe(1);

    buffer.append("\n");

    expect(buffer.read().lines).toEqual(["", "bbbb"]);
    expect(buffer.length).toBe(2);
  });

  it("searches complete lines with 1-based numbers and optional ignoreCase", () => {
    const buffer = new RingBuffer();
    buffer.append("Error: one\nok\nerror: two\nERROR: three\n");

    const sensitive = buffer.search("error");

    expect(sensitive.totalMatches).toBe(1);
    expect(sensitive.matches).toEqual([{ lineNumber: 3, text: "error: two" }]);

    const insensitive = buffer.search("error", true);

    expect(insensitive.totalMatches).toBe(3);
    expect(insensitive.matches).toEqual([
      { lineNumber: 1, text: "Error: one" },
      { lineNumber: 3, text: "error: two" },
      { lineNumber: 4, text: "ERROR: three" },
    ]);
  });

  it("throws the native SyntaxError for an invalid pattern", () => {
    const buffer = new RingBuffer();
    buffer.append("anything\n");

    expect(() => buffer.search("[")).toThrow(SyntaxError);
  });

  it("clear resets size, length, read state and snapshot", () => {
    const buffer = new RingBuffer();
    buffer.append("one\ntwo");

    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.length).toBe(0);
    expect(buffer.snapshot()).toBe("");
    expect(buffer.read()).toEqual({
      lines: [],
      totalLines: 0,
      offset: 0,
      hasMore: false,
    });
  });

  it("returns an empty page when limit is zero or negative", () => {
    const buffer = new RingBuffer();
    buffer.append("one\ntwo\nthree\n");

    expect(buffer.read(0, 0)).toEqual({
      lines: [],
      totalLines: 3,
      offset: 0,
      hasMore: false,
    });
    expect(buffer.read(1, -5)).toEqual({
      lines: [],
      totalLines: 3,
      offset: 1,
      hasMore: false,
    });
  });

  it('retains "\\r" inside line text for CRLF input', () => {
    const buffer = new RingBuffer();
    buffer.append("line1\r\nline2\r\n");

    const result = buffer.read();

    expect(result.lines).toEqual(["line1\r", "line2\r"]);
    expect(result.totalLines).toBe(2);
    expect(buffer.length).toBe(2);
  });
});
