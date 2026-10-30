// vitest 根配置：只跑各 package src 下的 *.test.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
});
