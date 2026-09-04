import { describe, expect, it } from "vitest";
import { cpuPercent, histogramAvg, rateOf, type CpuTicks } from "./delta.js";

const ticks = (over: Partial<CpuTicks> = {}): CpuTicks => ({
  name: "cpu",
  user: 0,
  nice: 0,
  system: 0,
  idle: 0,
  iowait: 0,
  irq: 0,
  softirq: 0,
  steal: 0,
  ...over,
});

describe("rateOf", () => {
  it("is null on the first sample (no previous value)", () => {
    expect(rateOf(undefined, 100, 1000)).toBeNull();
    expect(rateOf(null, 100, 1000)).toBeNull();
  });

  it("computes an exact per-second rate over a known window", () => {
    expect(rateOf(1000, 3000, 2000)).toBe(1000);
    expect(rateOf(0, 512, 500)).toBe(1024);
  });

  it("is null when the counter went backwards (reset), never negative", () => {
    expect(rateOf(5000, 10, 2000)).toBeNull();
  });

  it("is null when no time passed or the clock jumped back", () => {
    expect(rateOf(0, 100, 0)).toBeNull();
    expect(rateOf(0, 100, -5)).toBeNull();
  });

  it("is null for non-finite counters", () => {
    expect(rateOf(0, Number.NaN, 1000)).toBeNull();
  });

  it("reports zero for a counter that did not move", () => {
    expect(rateOf(42, 42, 1000)).toBe(0);
  });
});

describe("cpuPercent", () => {
  it("computes the busy share from two samples", () => {
    // 100 jiffies elapsed, 25 of them idle -> 75% busy.
    const prev = ticks({ user: 100, system: 50, idle: 1000 });
    const next = ticks({ user: 150, system: 75, idle: 1025 });
    const out = cpuPercent(prev, next);
    expect(out?.usagePct).toBeCloseTo(75, 6);
    expect(out?.userPct).toBeCloseTo(50, 6);
    expect(out?.systemPct).toBeCloseTo(25, 6);
  });

  it("counts iowait as idle for the busy figure but reports it separately", () => {
    const prev = ticks({ idle: 0, iowait: 0, user: 0 });
    const next = ticks({ idle: 50, iowait: 25, user: 25 });
    const out = cpuPercent(prev, next);
    expect(out?.usagePct).toBeCloseTo(25, 6);
    expect(out?.iowaitPct).toBeCloseTo(25, 6);
  });

  it("is null when there is no previous sample", () => {
    expect(cpuPercent(null, ticks())).toBeNull();
    expect(cpuPercent(ticks(), null)).toBeNull();
  });

  it("is null when the totals did not advance", () => {
    const same = ticks({ user: 10, idle: 10 });
    expect(cpuPercent(same, same)).toBeNull();
  });

  it("is null when the counters went backwards (reboot)", () => {
    const prev = ticks({ user: 5000, idle: 5000 });
    const next = ticks({ user: 1, idle: 1 });
    expect(cpuPercent(prev, next)).toBeNull();
  });
});

describe("histogramAvg", () => {
  it("averages only the observations inside the window", () => {
    // 4 observations totalling 2s -> 0.5s mean.
    expect(histogramAvg(10, 100, 12, 104)).toBeCloseTo(0.5, 6);
  });

  it("is null when no observations landed in the window", () => {
    expect(histogramAvg(10, 100, 10, 100)).toBeNull();
  });

  it("is null on a counter reset", () => {
    expect(histogramAvg(10, 100, 1, 5)).toBeNull();
  });

  it("is null without a previous sample", () => {
    expect(histogramAvg(null, null, 12, 104)).toBeNull();
  });
});
