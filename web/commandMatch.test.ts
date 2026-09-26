import { describe, expect, it } from "vitest";
import { filterRanked, matchRank } from "./commandMatch";

describe("matchRank", () => {
  it("matches a whole-string prefix, case-insensitively", () => {
    expect(matchRank("./restart.sh", "./RE")).toBe(0);
    expect(matchRank("git", "")).toBe(0);
  });
  it("matches past a leading ./ or path segment", () => {
    expect(matchRank("./restart.sh", "rest")).toBe(1);
    expect(matchRank("scripts/deploy.sh", "dep")).toBe(1);
  });
  it("matches later words and flags without dashes", () => {
    expect(matchRank("git push origin", "push")).toBe(1);
    expect(matchRank("--force", "force")).toBe(1);
  });
  it("doesn't match mid-word", () => {
    expect(matchRank("./restart.sh", "start")).toBeNull();
  });
});

describe("filterRanked", () => {
  it("puts whole-prefix hits before word hits", () => {
    const out = filterRanked(["./restart.sh", "rsync", "rest-cli"], (s) => s, "rest");
    expect(out).toEqual(["rest-cli", "./restart.sh"]);
  });
});
