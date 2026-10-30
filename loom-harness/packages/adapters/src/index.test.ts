import { describe, expect, it } from "vitest";

import { EventPump, JsonlSessionStore, SSESink } from "./index.js";

describe("loom-adapters barrel", () => {
  it("exports the vendored adapters and the new SSE sink", () => {
    expect(typeof JsonlSessionStore).toBe("function");
    expect(typeof EventPump).toBe("function");
    expect(typeof SSESink).toBe("function");
  });
});
