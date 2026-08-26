import { describe, expect, it } from "vitest";
import { decideFlow } from "./autopr.js";

describe("decideFlow", () => {
  it("commits whenever the tree is dirty", () => {
    expect(decideFlow({ dirty: true, onMain: true, diffVsBase: false })).toBe(
      "commit",
    );
    expect(decideFlow({ dirty: true, onMain: false, diffVsBase: true })).toBe(
      "commit",
    );
  });

  it("opens a PR for an already-committed branch", () => {
    expect(decideFlow({ dirty: false, onMain: false, diffVsBase: true })).toBe(
      "pr-only",
    );
  });

  it("does nothing on a clean branch that matches the base", () => {
    expect(decideFlow({ dirty: false, onMain: false, diffVsBase: false })).toBe(
      "nothing",
    );
  });

  it("does nothing on a clean integration branch, whatever the base diff says", () => {
    // origin/main vs local main can differ (we're behind); that's a pull, not a PR.
    expect(decideFlow({ dirty: false, onMain: true, diffVsBase: true })).toBe(
      "nothing",
    );
  });
});
