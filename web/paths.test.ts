import { describe, expect, it } from "vitest";
import { displayPath, folderName } from "./paths.js";

describe("displayPath", () => {
  const home = "/home/joran";

  it("shortens paths under home", () => {
    expect(displayPath("/home/joran/src/colibri/", home)).toBe("~/src/colibri/");
  });

  it("leaves home itself absolute — a lone `~/` names nothing", () => {
    expect(displayPath("/home/joran/", home)).toBe("/home/joran/");
    expect(displayPath("/home/joran", home)).toBe("/home/joran");
  });

  it("tolerates a trailing slash on home", () => {
    expect(displayPath("/home/joran/src/x/", "/home/joran/")).toBe("~/src/x/");
  });

  it("leaves paths outside home alone", () => {
    expect(displayPath("/tmp/x/", home)).toBe("/tmp/x/");
    expect(displayPath("/home/other/x/", home)).toBe("/home/other/x/");
  });

  it("does not match a partial segment", () => {
    expect(displayPath("/home/joranson/x/", home)).toBe("/home/joranson/x/");
  });

  it("passes through when home is unknown", () => {
    expect(displayPath("/home/joran/x/", "")).toBe("/home/joran/x/");
  });
});

describe("folderName", () => {
  const home = "/home/joran";

  it("takes the last segment, trailing slash or not", () => {
    expect(folderName("/home/joran/src/colibri/")).toBe("colibri");
    expect(folderName("/home/joran/src/colibri")).toBe("colibri");
  });

  it("labels home 'home', not the account name", () => {
    expect(folderName("/home/joran/", home)).toBe("home");
    expect(folderName("/home/joran", `${home}/`)).toBe("home");
  });

  it("still names a folder that merely sits under home", () => {
    expect(folderName("/home/joran/scripts/", home)).toBe("scripts");
  });

  it("falls back to the segment when home is unknown", () => {
    expect(folderName("/home/joran/")).toBe("joran");
  });
});
