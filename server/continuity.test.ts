import { describe, expect, it } from "vitest";
import {
  autoPromptDelayMs,
  shouldStartNewSession,
  usageBlocker,
} from "./continuity.js";
import type { ChatUsage, ChatUsageWindow } from "../shared/protocol.js";

function usage(
  windows: Array<Partial<ChatUsageWindow> & { key: string }>,
  available = true,
): ChatUsage {
  return {
    available,
    subscriptionType: "max",
    windows: windows.map((w) => ({
      label: w.key,
      utilization: null,
      resetsAt: null,
      ...w,
    })),
    sessionCostUsd: 0,
    at: Date.now(),
  };
}

describe("autoPromptDelayMs", () => {
  it("gives a floor even for a one-word exchange", () => {
    expect(autoPromptDelayMs(0, 0)).toBe(4_000);
    expect(autoPromptDelayMs(5, 5)).toBe(4_000);
  });

  it("caps however much there is to read", () => {
    expect(autoPromptDelayMs(1_000_000, 1_000_000)).toBe(30_000);
  });

  it("grows with the agent's reply — there is more to read", () => {
    const short = autoPromptDelayMs(200, 100);
    const long = autoPromptDelayMs(600, 100);
    expect(long).toBeGreaterThan(short);
  });

  it("grows with the generated prompt — there is more to type", () => {
    const short = autoPromptDelayMs(200, 40);
    const long = autoPromptDelayMs(200, 400);
    expect(long).toBeGreaterThan(short);
  });

  it("weighs typing more heavily per character than reading", () => {
    // 400 chars to type should cost more than 400 chars to skim.
    expect(autoPromptDelayMs(0, 400)).toBeGreaterThan(autoPromptDelayMs(400, 0));
  });

  it("stays inside the window for a realistic turn", () => {
    const ms = autoPromptDelayMs(1_200, 180);
    expect(ms).toBeGreaterThanOrEqual(4_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });
});

describe("shouldStartNewSession", () => {
  const cases = [true, false];

  it("never starts one in `never`, whatever happened", () => {
    for (const afterPr of cases)
      for (const taskComplete of cases)
        expect(
          shouldStartNewSession("never", { afterPr, taskComplete }),
        ).toBe(false);
  });

  it("starts one in `after-pr` only once a PR landed", () => {
    for (const taskComplete of cases) {
      expect(
        shouldStartNewSession("after-pr", { afterPr: true, taskComplete }),
      ).toBe(true);
      expect(
        shouldStartNewSession("after-pr", { afterPr: false, taskComplete }),
      ).toBe(false);
    }
  });

  it("starts one in `always` after a PR OR a completed task", () => {
    expect(
      shouldStartNewSession("always", { afterPr: true, taskComplete: false }),
    ).toBe(true);
    expect(
      shouldStartNewSession("always", { afterPr: false, taskComplete: true }),
    ).toBe(true);
  });

  it("continues in place in `always` while the task is unfinished", () => {
    expect(
      shouldStartNewSession("always", { afterPr: false, taskComplete: false }),
    ).toBe(false);
  });
});

describe("usageBlocker", () => {
  it("lets the loop run when no harness reports usage", () => {
    // pi never emits a `usage` event, so ChatState.usage stays null.
    expect(usageBlocker(null)).toBeNull();
  });

  it("lets the loop run when plan limits don't apply", () => {
    // API-key / local / 3rd-party sessions: `available: false`, no windows.
    expect(usageBlocker(usage([{ key: "five_hour", utilization: 99 }], false)))
      .toBeNull();
  });

  it("lets the loop run below the threshold", () => {
    expect(
      usageBlocker(
        usage([
          { key: "five_hour", utilization: 89.4 },
          { key: "seven_day", utilization: 12 },
        ]),
      ),
    ).toBeNull();
  });

  it("blocks on the session window", () => {
    const w = usageBlocker(usage([{ key: "five_hour", utilization: 90 }]));
    expect(w?.key).toBe("five_hour");
  });

  it("blocks on any weekly window, including the per-model ones", () => {
    for (const key of ["seven_day", "seven_day_opus", "seven_day_sonnet"]) {
      expect(usageBlocker(usage([{ key, utilization: 95 }]))?.key).toBe(key);
    }
  });

  it("names the worst offender, not the first", () => {
    const w = usageBlocker(
      usage([
        { key: "five_hour", utilization: 91 },
        { key: "seven_day", utilization: 97 },
        { key: "seven_day_opus", utilization: 93 },
      ]),
    );
    expect(w?.key).toBe("seven_day");
  });

  it("ignores a window whose utilization is unknown", () => {
    expect(
      usageBlocker(usage([{ key: "five_hour", utilization: null }])),
    ).toBeNull();
  });

  it("ignores windows that are neither the session nor a weekly one", () => {
    expect(
      usageBlocker(usage([{ key: "some_future_window", utilization: 100 }])),
    ).toBeNull();
  });
});
