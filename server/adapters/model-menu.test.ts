import { describe, expect, it } from "vitest";
import {
  menuLabel,
  menuModels,
  pickDefault,
  pruneToLatest,
  sortModels,
} from "./model-menu.js";

// Minimal structural stand-in for the SDK ModelInfo.
const m = (value: string, displayName = value, description?: string) => ({
  value,
  displayName,
  description,
});

// Claude Code's alias-row shape: a bare display name plus a versioned resolvedModel.
const alias = (value: string, displayName: string, resolvedModel: string) => ({
  value,
  displayName,
  description: "",
  resolvedModel,
});

const ids = (list: { value: string }[]) => list.map((x) => x.value);

describe("pruneToLatest", () => {
  it("keeps only the latest version within a family when the major is unchanged", () => {
    const kept = pruneToLatest([
      m("claude-opus-4-8"),
      m("claude-opus-4-7"),
      m("claude-opus-4-6"),
    ]);
    expect(ids(kept)).toEqual(["claude-opus-4-8"]);
  });

  it("keeps the latest two when the major version just changed", () => {
    const kept = pruneToLatest([
      m("claude-opus-5-0"),
      m("claude-opus-4-8"),
      m("claude-opus-4-7"),
    ]);
    // Top two differ in major (5 vs 4) → show both; drop the rest.
    expect(new Set(ids(kept))).toEqual(new Set(["claude-opus-5-0", "claude-opus-4-8"]));
  });

  it("treats a family with no minor as minor 0 and still picks the highest major", () => {
    const kept = pruneToLatest([m("claude-sonnet-5"), m("claude-sonnet-4-6")]);
    // 5 vs 4 differ in major → both kept.
    expect(new Set(ids(kept))).toEqual(new Set(["claude-sonnet-5", "claude-sonnet-4-6"]));
  });

  it("prunes each family independently", () => {
    const kept = pruneToLatest([
      m("claude-opus-4-8"),
      m("claude-opus-4-7"),
      m("claude-sonnet-4-6"),
      m("claude-sonnet-4-5"),
      m("claude-haiku-4-5"),
    ]);
    expect(new Set(ids(kept))).toEqual(
      new Set(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]),
    );
  });

  it("ignores a trailing date snapshot when parsing the version", () => {
    const kept = pruneToLatest([
      m("claude-haiku-4-5-20251001"),
      m("claude-haiku-4-4-20250101"),
    ]);
    expect(ids(kept)).toEqual(["claude-haiku-4-5-20251001"]);
  });

  it("passes through unknown families and unversioned models untouched", () => {
    const kept = pruneToLatest([
      m("some-custom-model"),
      m("claude-opus"), // known family, no version → kept
      m("claude-opus-4-8"),
      m("claude-opus-4-7"),
    ]);
    expect(ids(kept)).toContain("some-custom-model");
    expect(ids(kept)).toContain("claude-opus"); // unversioned kept
    expect(ids(kept)).toContain("claude-opus-4-8"); // latest versioned kept
    expect(ids(kept)).not.toContain("claude-opus-4-7"); // older versioned pruned
  });
});

describe("sortModels", () => {
  it("orders known families smallest → largest", () => {
    const sorted = sortModels([
      m("claude-opus-4-8"),
      m("claude-haiku-4-5"),
      m("claude-sonnet-5"),
    ]);
    expect(ids(sorted)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
    ]);
  });

  it("leaves SDK order untouched when any model is an unknown family", () => {
    const input = [m("claude-opus-4-8"), m("mystery-model")];
    expect(ids(sortModels(input))).toEqual(["claude-opus-4-8", "mystery-model"]);
  });
});

describe("menuLabel", () => {
  it("appends the resolved version to a bare alias name", () => {
    expect(menuLabel(alias("opus", "Opus", "claude-opus-4-8"))).toBe("Opus 4.8");
    expect(menuLabel(alias("sonnet", "Sonnet", "claude-sonnet-5"))).toBe("Sonnet 5");
    expect(menuLabel(alias("haiku", "Haiku", "claude-haiku-4-5"))).toBe("Haiku 4.5");
  });

  it("appends the version to the default row too", () => {
    expect(menuLabel(alias("default", "Default (recommended)", "claude-opus-4-8"))).toBe(
      "Default (recommended) 4.8",
    );
  });

  it("does not double-append when the name already carries the version", () => {
    expect(menuLabel(m("claude-opus-4-8", "Claude Opus 4.8"))).toBe("Claude Opus 4.8");
  });

  it("leaves the name unchanged when no version can be resolved", () => {
    expect(menuLabel(m("some-custom-model", "Custom Model"))).toBe("Custom Model");
  });
});

describe("alias rows (Claude Code shape)", () => {
  it("keeps every alias even when several resolve to the same family", () => {
    // Default + Opus both resolve to opus; pruning must NOT collapse them.
    const kept = pruneToLatest([
      alias("default", "Default (recommended)", "claude-opus-4-8"),
      alias("opus", "Opus", "claude-opus-4-8"),
      alias("sonnet", "Sonnet", "claude-sonnet-5"),
      alias("haiku", "Haiku", "claude-haiku-4-5"),
    ]);
    expect(ids(kept)).toEqual(["default", "opus", "sonnet", "haiku"]);
  });
});

describe("long-context [1m] variants", () => {
  it("keeps the plain row and its variant, plain first", () => {
    const menu = menuModels([m("claude-opus-4-8[1m]"), m("claude-opus-4-8")]);
    expect(ids(menu)).toEqual(["claude-opus-4-8", "claude-opus-4-8[1m]"]);
  });

  it("prunes plain and variant rows independently", () => {
    const menu = menuModels([
      m("claude-opus-4-6"),
      m("claude-opus-4-6[1m]"),
      m("claude-opus-4-8"),
      m("claude-opus-4-8[1m]"),
    ]);
    // Each group drops its own older version; both 4.8 rows survive.
    expect(ids(menu)).toEqual(["claude-opus-4-8", "claude-opus-4-8[1m]"]);
  });

  it("does not read the bracket tag as a minor version", () => {
    expect(menuLabel(m("claude-sonnet-5[1m]", "Sonnet"))).toBe("Sonnet 5");
  });

  it("handles the real enterprise catalog", () => {
    // Straight from `/model` on a Claude Code enterprise install.
    const menu = menuModels([
      alias("default", "Default (recommended)", "claude-sonnet-4-6"),
      m("claude-opus-4-8[1m]", "Opus 4.8 (1M context)"),
      alias("sonnet", "Sonnet", "claude-sonnet-4-6"),
      m("claude-sonnet-4-6[1m]", "Sonnet 4.6 (1M context)"),
      alias("haiku", "Haiku", "claude-haiku-4-5"),
      m("claude-opus-4-6", "Opus 4.6"),
      m("claude-opus-4-6[1m]", "Opus 4.6 (1M context)"),
      m("claude-opus-4-8", "Opus 4.8"),
      alias("opusplan", "Opus Plan Mode", "claude-opus-4-8"),
    ]);
    expect(ids(menu)).toEqual([
      "haiku",
      "default", // resolves to sonnet
      "sonnet",
      "claude-sonnet-4-6[1m]",
      "opusplan", // alias rows precede versioned ones within a family
      "claude-opus-4-8",
      "claude-opus-4-8[1m]",
    ]);
    // Superseded 4.6 rows (plain and variant) are gone; both 4.8s remain.
    expect(ids(menu)).not.toContain("claude-opus-4-6");
    expect(ids(menu)).not.toContain("claude-opus-4-6[1m]");
  });
});

describe("pickDefault", () => {
  // The adapter's real preference: Opus Plan Mode where offered, else plain Opus.
  const PREF = ["opusplan", "opus"];

  // Work laptop: no bare "opus" row, but opusplan and versioned Opus rows.
  const WORK = [
    alias("default", "Default (recommended)", "claude-sonnet-4-6"),
    alias("sonnet", "Sonnet", "claude-sonnet-4-6"),
    alias("haiku", "Haiku", "claude-haiku-4-5"),
    alias("opusplan", "Opus Plan Mode", "claude-opus-4-8"),
    m("claude-opus-4-8", "Opus 4.8"),
    m("claude-opus-4-8[1m]", "Opus 4.8 (1M context)"),
  ];

  // Private laptop: today's plain alias catalog, no opusplan.
  const PRIVATE = [
    alias("default", "Default (recommended)", "claude-opus-4-8"),
    alias("opus", "Opus", "claude-opus-4-8"),
    alias("sonnet", "Sonnet", "claude-sonnet-5"),
    alias("haiku", "Haiku", "claude-haiku-4-5"),
  ];

  it("takes opusplan when the catalog offers it", () => {
    expect(pickDefault(menuModels(WORK), PREF)?.value).toBe("opusplan");
  });

  it("falls back to plain Opus when opusplan is absent", () => {
    expect(pickDefault(menuModels(PRIVATE), PREF)?.value).toBe("opus");
  });

  it("an earlier alias wins even against a better-tiered later one", () => {
    // opusplan is only a substring match for "opus", but it is preference #1.
    const menu = menuModels(WORK);
    expect(pickDefault(menu, PREF)?.value).toBe("opusplan");
    expect(pickDefault(menu, ["opus"])?.value).toBe("claude-opus-4-8");
  });

  it("prefers the bare alias row over a versioned one", () => {
    const menu = menuModels([alias("opus", "Opus", "claude-opus-4-8"), m("claude-opus-4-8")]);
    expect(pickDefault(menu, ["opus"])?.value).toBe("opus");
  });

  it("never picks a long-context variant over its plain row", () => {
    const menu = menuModels([m("claude-opus-4-8[1m]"), m("claude-opus-4-8")]);
    expect(pickDefault(menu, PREF)?.value).toBe("claude-opus-4-8");
  });

  it("takes the highest version when a major bump keeps two rows", () => {
    const menu = menuModels([m("claude-opus-4-8"), m("claude-opus-5-0")]);
    expect(ids(menu)).toHaveLength(2); // both shown…
    expect(pickDefault(menu, PREF)?.value).toBe("claude-opus-5-0"); // …newest default
  });

  it("returns undefined when no alias matches", () => {
    expect(
      pickDefault(menuModels([alias("haiku", "Haiku", "claude-haiku-4-5")]), PREF),
    ).toBeUndefined();
  });

  it("keeps the plan-mode row in the menu it picks from", () => {
    expect(ids(menuModels(WORK))).toContain("opusplan");
  });
});

describe("menuModels", () => {
  it("prunes then sorts", () => {
    const menu = menuModels([
      m("claude-opus-4-7"),
      m("claude-opus-4-8"),
      m("claude-haiku-4-5"),
      m("claude-sonnet-5"),
      m("claude-sonnet-4-6"),
    ]);
    // haiku (single) → sonnet (5 vs 4.6 major bump: both) → opus (4.8 only)
    expect(ids(menu)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ]);
  });
});
