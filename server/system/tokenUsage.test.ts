import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICING,
  buildTokenUsage,
  localDay,
  parseTokenUsageFile,
  unsampledTokens,
  type TokenUsageState,
} from "./tokenUsage.js";

const FILE = JSON.stringify({
  last_check: "2026-09-16T20:29:01-04:00",
  last_model: "gemma",
  last_counters: { prompt: 1000, generation: 100 },
  daily: {
    "2026-09-15": { prompt: 5, generation: 1 },
    "2026-09-16": { prompt: 2_000_000, generation: 100_000 },
  },
  lifetime: {
    tiny: { prompt: 10, generation: 1 },
    gemma: { prompt: 4_000_000, generation: 200_000 },
    qwen: { prompt: 1_000_000, generation: 50_000 },
    empty: { prompt: 0, generation: 0 },
  },
});

const now = new Date(2026, 8, 16, 21, 0).getTime();

describe("parseTokenUsageFile", () => {
  it("normalizes the sampler's state", () => {
    const s = parseTokenUsageFile(FILE);
    expect(s.lastCheck).toBe(Date.parse("2026-09-16T20:29:01-04:00"));
    expect(s.lastModel).toBe("gemma");
    expect(s.lastCounters).toEqual({ prompt: 1000, generation: 100 });
    expect(s.lifetime.gemma).toEqual({ prompt: 4_000_000, generation: 200_000 });
  });

  it("tolerates missing/junk fields and rejects non-objects", () => {
    const s = parseTokenUsageFile(JSON.stringify({ lifetime: { m: { prompt: "x" } } }));
    expect(s.lastCheck).toBeNull();
    expect(s.lastCounters).toBeNull();
    expect(s.lifetime.m).toEqual({ prompt: 0, generation: 0 });
    expect(() => parseTokenUsageFile("[]")).toThrow();
    expect(() => parseTokenUsageFile("nope")).toThrow();
  });
});

describe("unsampledTokens", () => {
  const s = parseTokenUsageFile(FILE);
  it("diffs live counters against the last sample", () => {
    expect(unsampledTokens(s, { model: "gemma", prompt: 1500, generation: 130 })).toEqual({
      prompt: 500,
      generation: 30,
    });
  });
  it("treats a counter below the sample as a restart", () => {
    expect(unsampledTokens(s, { model: "gemma", prompt: 40, generation: 120 })).toEqual({
      prompt: 40,
      generation: 20,
    });
  });
  it("treats a model change as a restart", () => {
    expect(unsampledTokens(s, { model: "qwen", prompt: 5000, generation: 10 })).toEqual({
      prompt: 5000,
      generation: 10,
    });
  });
  it("is null without live counters or a baseline", () => {
    expect(unsampledTokens(s, null)).toBeNull();
    expect(unsampledTokens(s, { model: "gemma", prompt: null, generation: 1 })).toBeNull();
    const noBase: TokenUsageState = { ...s, lastCounters: null };
    expect(unsampledTokens(noBase, { model: "gemma", prompt: 1, generation: 1 })).toBeNull();
  });
});

describe("buildTokenUsage", () => {
  const s = parseTokenUsageFile(FILE);

  it("sorts models by total tokens and sums a grand total", () => {
    const u = buildTokenUsage(s, { file: "f", now, live: null, pricing: DEFAULT_PRICING });
    expect(u.models.map((m) => m.model)).toEqual(["gemma", "qwen", "tiny", "empty"]);
    expect(u.total.prompt).toBe(5_000_010);
    expect(u.total.generation).toBe(250_001);
    expect(u.current?.model).toBe("gemma");
    expect(u.today).toMatchObject({ prompt: 2_000_000, generation: 100_000 });
    // $3/M in, $15/M out.
    expect(u.today.costUsd).toBeCloseTo(6 + 1.5);
  });

  it("folds unsampled live tokens into today, current and total", () => {
    const u = buildTokenUsage(s, {
      file: "f",
      now,
      live: { model: "gemma", prompt: 1_001_000, generation: 10_100 },
      pricing: DEFAULT_PRICING,
    });
    expect(u.unsampled).toEqual({ prompt: 1_000_000, generation: 10_000 });
    expect(u.today.prompt).toBe(3_000_000);
    expect(u.current).toMatchObject({ model: "gemma", prompt: 5_000_000, generation: 210_000 });
    expect(u.total.prompt).toBe(6_000_010);
  });

  it("uses the live model, even one the file has never seen", () => {
    const u = buildTokenUsage(s, {
      file: "f",
      now,
      live: { model: "new", prompt: 7, generation: 3 },
      pricing: null,
    });
    expect(u.currentModel).toBe("new");
    expect(u.current).toMatchObject({ model: "new", prompt: 7, generation: 3, costUsd: null });
    expect(u.models.some((m) => m.model === "new")).toBe(true);
  });

  it("reports zero for a day with no entry", () => {
    const u = buildTokenUsage(s, {
      file: "f",
      now: new Date(2026, 8, 20).getTime(),
      live: null,
      pricing: null,
    });
    expect(u.today).toEqual({ prompt: 0, generation: 0, costUsd: null });
  });
});

describe("localDay", () => {
  it("uses local, zero-padded date parts", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });
});
