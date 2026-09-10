import { describe, expect, it } from "vitest";
import { formatReset, preferredLocale } from "./time.js";

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

// Built from LOCAL components on both sides, so these assertions hold in any
// timezone the runner happens to be in.
const at = (...p: [number, number, number, number, number]) =>
  new Date(p[0], p[1], p[2], p[3], p[4]);
const NOW = at(2026, 8, 19, 12, 0); // 2026-09-19 12:00 local
const iso = (d: Date) => d.toISOString();
const reset = (d: Date, locale?: string) => formatReset(iso(d), +NOW, locale);

describe("formatReset", () => {
  it("counts down in minutes under the hour", () => {
    expect(reset(at(2026, 8, 19, 12, 45), "de")).toBe("resets in 45m");
  });

  it("never says 0m for a reset that hasn't happened yet", () => {
    expect(formatReset(new Date(+NOW + 20_000).toISOString(), +NOW, "de")).toBe(
      "resets in 1m",
    );
  });

  it("counts down in hours under the day", () => {
    expect(reset(at(2026, 8, 19, 15, 0), "de")).toBe("resets in 3h");
  });

  it("floors, so the hour form never reads '24h'", () => {
    // 23h59m out — one minute short of the day form.
    const t = new Date(+NOW + 23 * 3600_000 + 59 * 60_000).toISOString();
    expect(formatReset(t, +NOW, "de")).toBe("resets in 23h");
  });

  it("adds an ISO-ordered date + a localized time beyond a day", () => {
    expect(reset(at(2026, 8, 21, 12, 0), "de")).toBe(
      "resets in 2 days, 2026-09-21, 12:00",
    );
  });

  it("takes the clock convention from the locale, the date order never", () => {
    // Same instant, 12-hour home locale: the date half must not move.
    expect(reset(at(2026, 8, 21, 12, 0), "en-US")).toBe(
      "resets in 2 days, 2026-09-21, 12:00 PM",
    );
  });

  it("says '1 day', not '1 days', at exactly 24h", () => {
    expect(reset(at(2026, 8, 20, 12, 0), "de")).toBe(
      "resets in 1 day, 2026-09-20, 12:00",
    );
  });

  it("zero-pads month, day, hour and minute", () => {
    // Jan 5th, 08:05 — every field is single-digit. The day count is incidental
    // here (pinned exactly above), so it stays out of the assertion.
    expect(reset(at(2027, 0, 5, 8, 5), "de")).toMatch(
      /^resets in \d+ days, 2027-01-05, 08:05$/,
    );
  });

  it("reports a window that has already turned over", () => {
    expect(reset(at(2026, 8, 19, 11, 0), "de")).toBe("resetting now");
  });

  it("says nothing when there's no usable reset time", () => {
    expect(formatReset(null, +NOW, "de")).toBeNull();
    expect(formatReset("not a date", +NOW, "de")).toBeNull();
  });
});
