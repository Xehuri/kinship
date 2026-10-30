import { describe, expect, it } from "vitest";

import { computeBackoff } from "./host.js";
import { parseEventLine } from "./protocol.js";

describe("parseEventLine - 逐事件解析", () => {
  const accepted = [
    ['{"type":"fact","k":"cpu","v":1}', "fact"],
    ['{"type":"deliver","channel":"main"}', "deliver"],
    ['{"type":"dispatch","workflow":"w"}', "dispatch"],
    ['{"type":"heartbeat"}', "heartbeat"],
  ] as const;

  for (const [line, type] of accepted) {
    it(`接受 ${type} 事件并透传完整 payload`, () => {
      const parsed = parseEventLine(line);
      expect(parsed.kind).toBe("event");
      if (parsed.kind !== "event") return; // 类型收窄（非抑制）
      expect(parsed.event.type).toBe(type);
      expect(parsed.event.payload).toEqual(JSON.parse(line));
    });
  }

  it("exec 识别为保留事件", () => {
    const parsed = parseEventLine('{"type":"exec","cmd":"rm -rf /"}');
    expect(parsed.kind).toBe("reserved");
    if (parsed.kind !== "reserved") return;
    expect(parsed.reservedType).toBe("exec");
    expect(parsed.line).toContain("exec");
  });

  it("非 JSON 行 -> invalid", () => {
    expect(parseEventLine("plain text").kind).toBe("invalid");
  });

  it("JSON 数组 -> invalid", () => {
    expect(parseEventLine("[1,2]").kind).toBe("invalid");
  });

  it("缺 type -> invalid", () => {
    expect(parseEventLine('{"msg":"hi"}').kind).toBe("invalid");
  });

  it("未知 type -> invalid", () => {
    expect(parseEventLine('{"type":"teleport"}').kind).toBe("invalid");
  });

  it("空白行 -> blank", () => {
    expect(parseEventLine("   ").kind).toBe("blank");
  });
});

describe("computeBackoff - 指数退避封顶", () => {
  it("1s,2s,4s… 指数增长", () => {
    const cfg = { baseMs: 1000, capMs: 60000 };
    expect(computeBackoff(0, cfg)).toBe(1000);
    expect(computeBackoff(1, cfg)).toBe(2000);
    expect(computeBackoff(2, cfg)).toBe(4000);
  });

  it("封顶 capBackoffMs", () => {
    expect(computeBackoff(10, { baseMs: 1000, capMs: 60000 })).toBe(60000);
  });
});
