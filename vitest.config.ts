import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Against a shared real Postgres, files must not reset the schema under each other.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
