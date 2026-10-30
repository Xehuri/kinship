/**
 * SSESink 帧格式测试（T05 TDD：先写帧断言）。
 *
 * 硬约束：
 *   1. 帧里**绝不出现 `event:` 字段行**（前端 EventSource.onmessage 只收缺省 message 事件）。
 *   2. `data:` 后是**完整 JSON 信封**（可 parse，sessionId/track/seq/event 逐字段保真）。
 *   3. 帧以 `\n\n` 分隔；write 抛错原样上抛（交给 EventPump.onError 隔离）。
 */

import { describe, it, expect } from "vitest";
import { SSESink, type SSEResponseLike } from "../sse-sink.js";
import { EventPump, type TransportEnvelope } from "../event-pump.js";

/** 收集写入分块的假 res（最小结构，无需真开端口）。 */
function fakeRes() {
  const chunks: string[] = [];
  const res: SSEResponseLike = { write: (c: string) => void chunks.push(c) };
  return { chunks, res, text: () => chunks.join("") };
}

function envelope(seq: number): TransportEnvelope {
  return {
    sessionId: "S1",
    tag: "q1",
    track: "live",
    seq,
    event: { type: "text_delta", contentIndex: 0, delta: "he\nllo \"quoted\"" },
  };
}

describe("SSESink", () => {
  it("writes a data-only frame: no `event:` line, terminated by a blank line", () => {
    const { res, text } = fakeRes();
    new SSESink(res).send(envelope(0));

    const frame = text();
    expect(frame.startsWith("data:")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    // 前端硬约束：任何一行都不能以 event: 开头（缺省即 message）。
    // 注意只查行首字段位：JSON 体内的 "event": 键不是 SSE 字段行。
    expect(frame.split("\n").some((l) => l.startsWith("event:"))).toBe(false);
    expect(/^event:/m.test(frame)).toBe(false);
  });

  it("payload with embedded newlines/quotes stays one data line (JSON escapes control chars)", () => {
    const { res, chunks } = fakeRes();
    new SSESink(res).send(envelope(3));

    expect(chunks).toHaveLength(1);
    // data: 行 + 空行 = 恰好 2 个换行结尾结构；正文不因 delta 含 \n 而多行。
    const lines = chunks[0]!.split("\n");
    expect(lines).toHaveLength(3); // "data:{...}", "", ""
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("");
  });

  it("data: after-prefix parses back to the full envelope, field-for-field", () => {
    const { res, text } = fakeRes();
    const env = envelope(7);
    new SSESink(res).send(env);

    const body = text().slice("data:".length).trimEnd();
    expect(JSON.parse(body)).toEqual(env);
  });

  it("successive sends emit successive frames, each a self-contained data block", () => {
    const { res, chunks } = fakeRes();
    const sink = new SSESink(res);
    sink.send(envelope(0));
    sink.send(envelope(1));

    expect(chunks).toHaveLength(2);
    for (const [i, chunk] of chunks.entries()) {
      const env = JSON.parse(chunk.slice("data:".length).trimEnd()) as TransportEnvelope;
      expect(env.seq).toBe(i);
      expect(env.sessionId).toBe("S1");
      expect(env.track).toBe("live");
    }
  });

  it("omits the tag field when the envelope has none", () => {
    const { res, text } = fakeRes();
    const env: TransportEnvelope = { sessionId: "S2", track: "recorded", seq: 0, event: { type: "turn-start", turnIdx: 0 } };
    new SSESink(res).send(env);
    expect(JSON.parse(text().slice(5).trimEnd())).not.toHaveProperty("tag");
  });

  it("propagates res.write failures untouched (EventPump owns the isolation)", () => {
    const sink = new SSESink({
      write() {
        throw new Error("connection reset");
      },
    });
    expect(() => sink.send(envelope(0))).toThrow("connection reset");
  });

  it("composes with EventPump: forwarded envelopes land as parseable SSE frames, seq gap marks a drop", () => {
    // 用最小假 session 驱动 pump（不为 SSE 测试拉整个内核）。
    const listeners: Array<(e: { type: string; delta?: string }) => void> = [];
    const fakeSession = {
      id: "S9",
      on(_t: string, cb: (e: { type: string; delta?: string }) => void) {
        listeners.push(cb);
        return () => void listeners.splice(listeners.indexOf(cb), 1);
      },
    };
    const { res, text } = fakeRes();
    const pump = new EventPump(
      fakeSession as unknown as ConstructorParameters<typeof EventPump>[0],
      { sink: new SSESink(res) },
    );
    const detach = pump.attachLive();
    // 手工触发一条 live 事件（fake session 只支持手动 emit）。
    listeners[0]?.({ type: "text_delta", delta: "x" });
    detach();

    const frames = text().split("\n\n").filter((f) => f.length > 0);
    expect(frames).toHaveLength(1);
    const env = JSON.parse(frames[0]!.slice("data:".length)) as TransportEnvelope;
    expect(env.sessionId).toBe("S9");
    expect(env.seq).toBe(0);
    expect(env.track).toBe("live");
  });
});
