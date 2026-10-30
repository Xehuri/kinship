// T01 冒烟测试：锁定 server 占位导出存在
import { describe, expect, it } from "vitest";

import { LOOM_SERVER_PLACEHOLDER } from "./index.js";

describe("loom-server smoke", () => {
  it("exports placeholder constant", () => {
    expect(LOOM_SERVER_PLACEHOLDER).toBe("server");
  });
});
