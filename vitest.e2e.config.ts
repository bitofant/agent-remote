import { defineConfig } from "vitest/config";

// Live end-to-end tests: `*.e2e.test.ts` drive the real claude-local harness
// (Claude SDK → local vLLM). Kept out of the default `npm test` gate because
// they need a running endpoint; the tests self-skip when claude-local is
// disabled or its endpoint is unreachable. Run: `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One live vLLM endpoint — run files sequentially so concurrent turns don't
    // starve each other (degrades model output/latency and causes timeouts).
    fileParallelism: false,
  },
});
