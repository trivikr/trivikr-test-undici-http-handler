import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["src/**/*.e2e.spec.ts"],
    include: ["src/**/*.spec.ts"],
  },
});
