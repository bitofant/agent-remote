import { defineConfig, configDefaults } from "vitest/config";

// Boring by design: plain Node environment, co-located `*.test.ts` files.
// The shared reducer/render logic is pure functions — no DOM, no processes,
// no tokens — so it runs in milliseconds. Component tests (jsdom) and live
// smoke scripts layer on top later.
//
// `*.e2e.test.ts` (live claude-local model calls) are excluded here so this
// gate stays pure/fast; run them with `npm run test:e2e` (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
  },
});
