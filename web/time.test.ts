import { describe, expect, it } from "vitest";
import { preferredLocale } from "./time.js";

describe("preferredLocale", () => {
  it("takes the first non-English tag as the home locale", () => {
    expect(preferredLocale(["en-US", "en", "de"])).toBe("de");
    expect(preferredLocale(["en-GB", "fr-FR", "de"])).toBe("fr-FR");
  });

  it("keeps the browser default for an English-only list", () => {
    expect(preferredLocale(["en-US", "en"])).toBeUndefined();
    expect(preferredLocale(["en"])).toBeUndefined();
    expect(preferredLocale([])).toBeUndefined();
  });

  it("matches the primary subtag exactly, not an 'en' prefix", () => {
    // enq (Enga), enm (Middle English), eno (Enggano) are their own languages —
    // but the browser can't format with them, so they're skipped anyway.
    expect(preferredLocale(["en-US", "eno-x-private"])).toBeUndefined();
    // A region starting with "en" must not be mistaken for the language.
    expect(preferredLocale(["de-EN"])).toBe("de-EN");
  });

  it("is case-insensitive about English", () => {
    expect(preferredLocale(["EN-us", "EN"])).toBeUndefined();
  });

  it("never returns a tag the browser can't format with", () => {
    // Unvalidated, these reach toLocale*String and throw mid-render.
    expect(preferredLocale(["en-US", "!!!"])).toBeUndefined();
    expect(preferredLocale(["en-US", ""])).toBeUndefined();
    expect(preferredLocale(["en-US", "zz"])).toBeUndefined();
    // …and a junk entry doesn't stop a good one further down the list.
    expect(preferredLocale(["en-US", "!!!", "de"])).toBe("de");
  });
});
