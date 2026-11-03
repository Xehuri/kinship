/**
 * 信件边界校验：cap、必填、枚举、服务端字段/数值评分拒绝、控制字符。
 */

import { describe, expect, it } from "vitest";

import { LetterValidationError, validateLetterInput } from "./validate.js";

function letter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "qq",
    kind: "system_note",
    class: "notify",
    trust: "external",
    principal: "123456",
    body: "hello",
    ...overrides,
  };
}

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof LetterValidationError) return error.errors.map((e) => e.field);
    throw error;
  }
  return [];
}

describe("validateLetterInput", () => {
  it("合法最小信件 → 原样解析（可选键不物化）", () => {
    const parsed = validateLetterInput(letter());
    expect(parsed).toEqual({
      source: "qq",
      kind: "system_note",
      class: "notify",
      trust: "external",
      principal: "123456",
      body: "hello",
    });
    expect("id" in parsed).toBe(false);
    expect("created_at" in parsed).toBe(false);
  });

  it("合法完整信件 → 可选字段保留", () => {
    const parsed = validateLetterInput(
      letter({
        title: "标题",
        ref: { run: "r1" },
        correlation_id: "c1",
        dedupe_key: "d1",
        coalesce_key: "k1",
        reply_to: "m1",
        not_before: 1000,
        expires_at: 2000,
        causation_depth: 2,
      }),
    );
    expect(parsed.title).toBe("标题");
    expect(parsed.ref).toEqual({ run: "r1" });
    expect(parsed.dedupe_key).toBe("d1");
    expect(parsed.not_before).toBe(1000);
    expect(parsed.causation_depth).toBe(2);
  });

  it("必填字段缺失 → 结构化字段错误", () => {
    const fields = fieldsOf(() => validateLetterInput({}));
    expect(fields).toEqual(
      expect.arrayContaining(["source", "kind", "class", "trust", "principal", "body"]),
    );
  });

  it("source 必须匹配注册键正则", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ source: "QQ" })))).toContain("source");
    expect(fieldsOf(() => validateLetterInput(letter({ source: "a".repeat(65) })))).toContain(
      "source",
    );
  });

  it("class/trust 枚举非法值", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ class: "urgent" })))).toContain("class");
    expect(fieldsOf(() => validateLetterInput(letter({ trust: "root" })))).toContain("trust");
  });

  it("body 空/空白/超字节上限", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ body: "" })))).toContain("body");
    expect(fieldsOf(() => validateLetterInput(letter({ body: "   " })))).toContain("body");
    expect(
      fieldsOf(() => validateLetterInput(letter({ body: "abcd" }), { maxBodyBytes: 3 })),
    ).toContain("body");
  });

  it("thread_id/thread_name 非空、无控制字符且有长度上限", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ thread_id: "" })))).toContain("thread_id");
    expect(fieldsOf(() => validateLetterInput(letter({ thread_id: "a\nb" })))).toContain(
      "thread_id",
    );
    expect(fieldsOf(() => validateLetterInput(letter({ thread_id: "g".repeat(129) })))).toContain(
      "thread_id",
    );
    expect(fieldsOf(() => validateLetterInput(letter({ thread_name: "" })))).toContain(
      "thread_name",
    );
    expect(fieldsOf(() => validateLetterInput(letter({ thread_name: "a\nb" })))).toContain(
      "thread_name",
    );
    expect(
      fieldsOf(() => validateLetterInput(letter({ thread_name: "n".repeat(201) }))),
    ).toContain("thread_name");
  });

  it("thread_kind 只接受 [a-z0-9_.-]{1,32}", () => {
    for (const bad of ["Group", "a b", "a/b", "", "x".repeat(33)]) {
      expect(fieldsOf(() => validateLetterInput(letter({ thread_kind: bad })))).toContain(
        "thread_kind",
      );
    }
    expect(
      validateLetterInput(
        letter({ thread_id: "123456", thread_name: "群一", thread_kind: "group" }),
      ),
    ).toMatchObject({ thread_id: "123456", thread_name: "群一", thread_kind: "group" });
  });

  it("title ≤200 码点且不允许控制字符/换行", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ title: "x".repeat(201) })))).toContain(
      "title",
    );
    expect(fieldsOf(() => validateLetterInput(letter({ title: "a\nb" })))).toContain("title");
  });

  it("ref JSON 序列化 ≤2KB", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ ref: "x".repeat(2_100) })))).toContain(
      "ref",
    );
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(fieldsOf(() => validateLetterInput(letter({ ref: circular })))).toContain("ref");
  });

  it("correlation/dedupe/coalesce/reply_to ≤128", () => {
    for (const key of ["correlation_id", "dedupe_key", "coalesce_key", "reply_to"]) {
      expect(fieldsOf(() => validateLetterInput(letter({ [key]: "k".repeat(129) })))).toContain(
        key,
      );
    }
  });

  it("principal 不允许控制字符", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ principal: "a\u0000b" })))).toContain(
      "principal",
    );
    expect(fieldsOf(() => validateLetterInput(letter({ kind: "a\nb" })))).toContain("kind");
  });

  it("调用方自带 id/created_at/state/attempts → 拒绝", () => {
    const fields = fieldsOf(() =>
      validateLetterInput(letter({ id: "forged", created_at: 1, state: "acked", attempts: 9 })),
    );
    expect(fields).toEqual(expect.arrayContaining(["id", "created_at", "state", "attempts"]));
  });

  it("调用方自带数值评分/权重/优先级 → 拒绝", () => {
    const fields = fieldsOf(() =>
      validateLetterInput(letter({ score: 100, weight: 5, priority: 1, severity: 3 })),
    );
    expect(fields).toEqual(expect.arrayContaining(["score", "weight", "priority", "severity"]));
  });

  it("未知字段 → 拒绝（边界只接受 schema 内字段）", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ surprise: true })))).toContain("surprise");
  });

  it("时间戳与因果深度边界", () => {
    expect(fieldsOf(() => validateLetterInput(letter({ not_before: -1 })))).toContain("not_before");
    expect(fieldsOf(() => validateLetterInput(letter({ not_before: 1.5 })))).toContain(
      "not_before",
    );
    expect(
      fieldsOf(() => validateLetterInput(letter({ not_before: 2000, expires_at: 1000 }))),
    ).toContain("expires_at");
    expect(
      fieldsOf(() => validateLetterInput(letter({ causation_depth: 33 }), { maxCausationDepth: 32 })),
    ).toContain("causation_depth");
  });

  it("非对象输入 → LetterValidationError", () => {
    expect(() => validateLetterInput("nope")).toThrow(LetterValidationError);
    expect(() => validateLetterInput([])).toThrow(LetterValidationError);
  });
});
