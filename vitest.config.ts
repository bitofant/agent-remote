import { defineConfig } from "vitest/config";

// Boring by design: plain Node environment, co-located `*.test.ts` files.
// The shared reducer/render logic is pure functions — no DOM, no processes,
// no tokens — so it runs in milliseconds. Component tests (jsdom) and live
// smoke scripts layer on top later.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
