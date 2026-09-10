import { describe, expect, it } from "vitest";
import { windowElapsedPct } from "./usage.js";
import type { ChatUsageWindow } from "../shared/protocol.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function win(over: Partial<ChatUsageWindow> = {}): ChatUsageWindow {
  return {
    key: "five_hour",
    label: "Current session (5h)",
    utilization: 50,
    resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
    windowMs: 5 * HOUR,
    ...over,
  };
}

describe("windowElapsedPct", () => {
  it("reads elapsed time back out of the reset time", () => {
    // 2h left of a 5h window → 3h gone.
    expect(windowElapsedPct(win(), NOW)).toBeCloseTo(60);
  });

  it("is 0 at the start and 100 at the reset", () => {
    const start = win({ resetsAt: new Date(NOW + 5 * HOUR).toISOString() });
    expect(windowElapsedPct(start, NOW)).toBe(0);
    const done = win({ resetsAt: new Date(NOW).toISOString() });
    expect(windowElapsedPct(done, NOW)).toBe(100);
  });

  it("clamps a stale snapshot instead of running off the track", () => {
    const past = win({ resetsAt: new Date(NOW - 9 * HOUR).toISOString() });
    expect(windowElapsedPct(past, NOW)).toBe(100);
    const skewed = win({ resetsAt: new Date(NOW + 40 * HOUR).toISOString() });
    expect(windowElapsedPct(skewed, NOW)).toBe(0);
  });

  it("handles a week-long window", () => {
    const week = win({
      key: "seven_day",
      windowMs: 7 * 24 * HOUR,
      resetsAt: new Date(NOW + 7 * 24 * HOUR - 24 * HOUR).toISOString(),
    });
    expect(windowElapsedPct(week, NOW)).toBeCloseTo(100 / 7);
  });

  it("says nothing rather than guessing when the harness is silent", () => {
    expect(windowElapsedPct(win({ resetsAt: null }), NOW)).toBeNull();
    expect(windowElapsedPct(win({ windowMs: null }), NOW)).toBeNull();
    expect(windowElapsedPct(win({ windowMs: 0 }), NOW)).toBeNull();
    expect(windowElapsedPct(win({ resetsAt: "not a date" }), NOW)).toBeNull();
  });
});
