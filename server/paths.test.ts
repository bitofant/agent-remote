import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { expandHome, normalizeFolder } from "./paths.js";

describe("expandHome", () => {
  const home = homedir();

  it("expands a bare tilde", () => {
    expect(expandHome("~")).toBe(home);
  });

  it("expands a tilde-rooted path", () => {
    expect(expandHome("~/src/foo")).toBe(`${home}/src/foo`);
  });

  it("preserves a trailing slash (folder rows are stored verbatim)", () => {
    expect(expandHome("~/src/foo/")).toBe(`${home}/src/foo/`);
  });

  it("leaves absolute and relative paths alone", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
    expect(expandHome("./x")).toBe("./x");
    expect(expandHome("")).toBe("");
  });

  it("does not touch a tilde that isn't the path root", () => {
    expect(expandHome("/tmp/~/x")).toBe("/tmp/~/x");
    expect(expandHome("~backup")).toBe("~backup");
    expect(expandHome("~user/x")).toBe("~user/x");
  });
});

describe("normalizeFolder", () => {
  const home = homedir();

  it("adds a missing trailing slash", () => {
    expect(normalizeFolder("/tmp/x")).toBe("/tmp/x/");
  });

  it("expands and slashes in one step", () => {
    expect(normalizeFolder("~/src/foo")).toBe(`${home}/src/foo/`);
    expect(normalizeFolder("~")).toBe(`${home}/`);
  });

  it("is idempotent — the two spellings collapse to one key", () => {
    const once = normalizeFolder("~/src/foo");
    expect(normalizeFolder(once)).toBe(once);
    expect(normalizeFolder("~/src/foo/")).toBe(once);
    expect(normalizeFolder(`${home}/src/foo`)).toBe(once);
  });

  it("leaves root and empty input alone", () => {
    expect(normalizeFolder("/")).toBe("/");
    expect(normalizeFolder("")).toBe("");
  });
});
