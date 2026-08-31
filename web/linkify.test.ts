import { describe, expect, it } from "vitest";
import { linkRuns } from "./linkify.js";

describe("linkRuns", () => {
  it("returns a single text run when there is no url", () => {
    expect(linkRuns("Pushed joran/x to origin")).toEqual([
      { text: "Pushed joran/x to origin" },
    ]);
  });

  it("splits a bare url", () => {
    const url = "https://github.com/bitofant/agent-remote/pull/70";
    expect(linkRuns(url)).toEqual([{ text: url, url }]);
  });

  it("keeps the surrounding text in order", () => {
    expect(linkRuns("see https://x.dev/a now")).toEqual([
      { text: "see " },
      { text: "https://x.dev/a", url: "https://x.dev/a" },
      { text: " now" },
    ]);
  });

  it("drops trailing sentence punctuation", () => {
    expect(linkRuns("opened https://x.dev/a.")).toEqual([
      { text: "opened " },
      { text: "https://x.dev/a", url: "https://x.dev/a" },
      { text: "." },
    ]);
  });

  it("keeps balanced brackets but not an unmatched closer", () => {
    expect(linkRuns("(see https://x.dev/a_(b))")).toEqual([
      { text: "(see " },
      { text: "https://x.dev/a_(b)", url: "https://x.dev/a_(b)" },
      { text: ")" },
    ]);
  });

  it("finds several urls", () => {
    const runs = linkRuns("a https://x.dev/1 b http://y.dev/2 c");
    expect(runs.filter((r) => r.url).map((r) => r.url)).toEqual([
      "https://x.dev/1",
      "http://y.dev/2",
    ]);
  });

  it("ignores a bare domain", () => {
    expect(linkRuns("github.com/x")).toEqual([{ text: "github.com/x" }]);
  });

  it("handles an empty string", () => {
    expect(linkRuns("")).toEqual([]);
  });
});
