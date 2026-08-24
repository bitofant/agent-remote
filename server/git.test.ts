import { describe, expect, it } from "vitest";
import {
  derivePrefix,
  fallbackSlug,
  sanitizeBranchName,
  sanitizeCommitMessage,
  truncateDiff,
} from "./git.js";

describe("derivePrefix", () => {
  it("uses the first name, ASCII-folded", () => {
    expect(derivePrefix("Jöran Tesse", "x@y.z", "os")).toBe("joran");
  });

  it("falls back to the email local part", () => {
    expect(derivePrefix("", "Joe.Random@example.com", "os")).toBe("joe.random");
  });

  it("falls back to the OS user when the name folds away entirely", () => {
    // CJK has no combining decomposition, so the ASCII filter empties it.
    expect(derivePrefix("张伟", "", "builder")).toBe("builder");
  });

  it("never returns an empty prefix", () => {
    expect(derivePrefix("", "", "")).toBe("auto");
  });
});

describe("sanitizeBranchName", () => {
  it("kebab-cases a phrase", () => {
    expect(sanitizeBranchName("Add PR flow")).toBe("add-pr-flow");
  });

  it("strips characters outside [a-z0-9-]", () => {
    expect(sanitizeBranchName("feat/fix_the thing! (v2)")).toBe(
      "feat-fix-the-thing-v2",
    );
  });

  it("folds accents rather than dropping the whole word", () => {
    expect(sanitizeBranchName("Ändere die Größe")).toBe("andere-die-gro-e");
  });

  it("collapses and trims separators", () => {
    expect(sanitizeBranchName("  --a---b--  ")).toBe("a-b");
  });

  it("caps length on a word boundary", () => {
    const slug = sanitizeBranchName(
      "add a really quite extremely long branch name that keeps going",
    );
    expect(slug!.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
    expect(slug).toBe("add-a-really-quite-extremely-long-branch");
  });

  it("rejects input with nothing usable", () => {
    expect(sanitizeBranchName("!!! ???")).toBeNull();
    expect(sanitizeBranchName("")).toBeNull();
    expect(sanitizeBranchName(undefined)).toBeNull();
  });
});

describe("sanitizeCommitMessage", () => {
  it("accepts and trims a single short line", () => {
    expect(sanitizeCommitMessage("  add auto PR flow  ")).toBe("add auto PR flow");
  });

  it("strips wrapping quotes a chatty model adds", () => {
    expect(sanitizeCommitMessage('"add auto PR flow"')).toBe("add auto PR flow");
  });

  it("rejects a multi-line message", () => {
    expect(sanitizeCommitMessage("add auto PR flow\n\nwith details")).toBeNull();
  });

  it("rejects a message over 72 chars", () => {
    expect(sanitizeCommitMessage("x".repeat(73))).toBeNull();
    expect(sanitizeCommitMessage("x".repeat(72))).toBe("x".repeat(72));
  });

  it("rejects empty input", () => {
    expect(sanitizeCommitMessage("   ")).toBeNull();
    expect(sanitizeCommitMessage(null)).toBeNull();
  });
});

describe("truncateDiff", () => {
  it("leaves a small diff alone", () => {
    expect(truncateDiff("small", 100)).toBe("small");
  });

  it("marks a clipped diff", () => {
    const out = truncateDiff("y".repeat(50), 10);
    expect(out.startsWith("y".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("fallbackSlug", () => {
  it("is a valid branch slug", () => {
    const slug = fallbackSlug(new Date(2026, 7, 24, 14, 32));
    expect(slug).toBe("auto-pr-20260824-1432");
    expect(sanitizeBranchName(slug)).toBe(slug);
  });
});
