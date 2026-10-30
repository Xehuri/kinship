/**
 * 嵌套布局路径回归：脚本与配置模板必须指向 axeuh-health-monitor/loom-harness，
 * 不得残留旧的兄弟目录根。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OLD_ROOT = "/server/axeuh-harness";
const NEW_ROOT = "/server/axeuh-health-monitor/loom-harness";

const FILES = [
  "scripts/make-fixture.sh",
  "scripts/cutover-execute.sh",
  "config/loom.example.yaml",
] as const;

describe("脚本与配置模板的嵌套路径", () => {
  for (const rel of FILES) {
    it(`${rel} 不再引用旧根且含新根`, () => {
      const text = readFileSync(join(REPO, rel), "utf8");
      expect(text).not.toContain(OLD_ROOT);
      expect(text).toContain(NEW_ROOT);
    });
  }
});
