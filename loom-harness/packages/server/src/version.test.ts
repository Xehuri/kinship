import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveLoomVersion } from "./version.js";

const tmpDirs: string[] = [];

function tempVersionFile(content: string): URL {
  const dir = mkdtempSync(join(tmpdir(), "loom-version-"));
  tmpDirs.push(dir);
  const path = join(dir, "VERSION");
  writeFileSync(path, content, "utf8");
  return pathToFileURL(path);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveLoomVersion", () => {
  it("LOOM_VERSION 环境变量优先（trim）", () => {
    expect(resolveLoomVersion({ LOOM_VERSION: "  abc123  " }, tempVersionFile("from-file"))).toBe(
      "abc123",
    );
  });

  it("环境变量缺失时读 VERSION 文件", () => {
    expect(resolveLoomVersion({}, tempVersionFile("  deadbee\n"))).toBe("deadbee");
  });

  it("VERSION 文件缺失时回退 0.0.0-dev", () => {
    expect(resolveLoomVersion({}, new URL("file:///no/such/loom/VERSION"))).toBe("0.0.0-dev");
  });

  it("VERSION 文件为空时回退 0.0.0-dev", () => {
    expect(resolveLoomVersion({}, tempVersionFile("  \n"))).toBe("0.0.0-dev");
  });

  it("环境变量为空串时继续读 VERSION 文件", () => {
    expect(resolveLoomVersion({ LOOM_VERSION: "   " }, tempVersionFile("cafebabe"))).toBe(
      "cafebabe",
    );
  });
});
