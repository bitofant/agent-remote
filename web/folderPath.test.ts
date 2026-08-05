import { describe, expect, it } from "vitest";
import {
  chainFrom,
  matchEntries,
  parentOf,
  rootFor,
  splitTyped,
  toAbsDir,
  toTyped,
} from "./folderPath.js";

const home = "/home/joran";

describe("splitTyped", () => {
  it("splits at the last slash, keeping it on the directory", () => {
    expect(splitTyped("~/src/coli")).toEqual({ dir: "~/src/", partial: "coli" });
    expect(splitTyped("~/src/")).toEqual({ dir: "~/src/", partial: "" });
  });

  it("treats a bare name as a partial with no directory", () => {
    expect(splitTyped("src")).toEqual({ dir: "", partial: "src" });
    expect(splitTyped("")).toEqual({ dir: "", partial: "" });
  });
});

describe("toAbsDir", () => {
  it("expands `~` and guarantees a trailing slash", () => {
    expect(toAbsDir("~/src/", home)).toBe("/home/joran/src/");
    expect(toAbsDir("~/src", home)).toBe("/home/joran/src/");
    expect(toAbsDir("~", home)).toBe("/home/joran/");
    expect(toAbsDir("~/", `${home}/`)).toBe("/home/joran/");
  });

  it("defaults an empty prefix to home", () => {
    expect(toAbsDir("", home)).toBe("/home/joran/");
  });

  it("leaves absolute paths alone", () => {
    expect(toAbsDir("/tmp/", home)).toBe("/tmp/");
    expect(toAbsDir("/", home)).toBe("/");
  });

  it("never matches a partial segment of home", () => {
    expect(toAbsDir("~x/", home)).toBe("~x/");
  });
});

describe("toTyped", () => {
  it("collapses home to `~/`, including home itself", () => {
    expect(toTyped("/home/joran/src/", home)).toBe("~/src/");
    expect(toTyped("/home/joran/", home)).toBe("~/");
  });

  it("leaves paths outside home (and unknown home) absolute", () => {
    expect(toTyped("/tmp/x/", home)).toBe("/tmp/x/");
    expect(toTyped("/home/joranson/", home)).toBe("/home/joranson/");
    expect(toTyped("/home/joran/x/", "")).toBe("/home/joran/x/");
  });
});

describe("parentOf", () => {
  it("walks up one level, ending at the filesystem root", () => {
    expect(parentOf("/home/joran/src/")).toBe("/home/joran/");
    expect(parentOf("/home/")).toBe("/");
    expect(parentOf("/")).toBe(null);
  });
});

describe("rootFor", () => {
  it("roots the tree at home for paths inside it, else at /", () => {
    expect(rootFor("/home/joran/src/", home)).toBe("/home/joran/");
    expect(rootFor("/home/joran/", home)).toBe("/home/joran/");
    expect(rootFor("/tmp/x/", home)).toBe("/");
    expect(rootFor("/home/joran/src/", "")).toBe("/");
  });
});

describe("chainFrom", () => {
  it("lists root down to the target, inclusive", () => {
    expect(chainFrom("/home/joran/", "/home/joran/src/x/")).toEqual([
      "/home/joran/",
      "/home/joran/src/",
      "/home/joran/src/x/",
    ]);
    expect(chainFrom("/", "/tmp/a/")).toEqual(["/", "/tmp/", "/tmp/a/"]);
  });

  it("is just the root when the target is the root or outside it", () => {
    expect(chainFrom("/home/joran/", "/home/joran/")).toEqual(["/home/joran/"]);
    expect(chainFrom("/home/joran/", "/etc/")).toEqual(["/home/joran/"]);
  });
});

describe("matchEntries", () => {
  const entries = [{ name: "Src" }, { name: "scripts" }, { name: "src" }, { name: "tmp" }];

  it("prefix-matches case-insensitively, case-exact first", () => {
    expect(matchEntries(entries, "s").map((e) => e.name)).toEqual([
      "scripts",
      "src",
      "Src",
    ]);
  });

  it("lets the real casing win the highlight", () => {
    expect(matchEntries(entries, "src").map((e) => e.name)).toEqual([
      "src",
      "Src",
    ]);
    expect(matchEntries(entries, "Sr").map((e) => e.name)).toEqual([
      "Src",
      "src",
    ]);
  });

  it("matches everything on an empty partial, nothing on a miss", () => {
    expect(matchEntries(entries, "")).toHaveLength(4);
    expect(matchEntries(entries, "zz")).toEqual([]);
  });
});
