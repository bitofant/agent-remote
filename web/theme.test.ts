import { describe, expect, it } from "vitest";
import {
  THEME_VARS,
  normalizeHex,
  normalizeTheme,
  serializeTheme,
  type Theme,
} from "./theme";

const sample = (): Theme =>
  Object.fromEntries(THEME_VARS.map((v, i) => [v.name, `#00000${i % 10}`]));

describe("normalizeHex", () => {
  it("expands 3-digit hex to 6", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
  });

  it("lowercases 6-digit hex", () => {
    expect(normalizeHex("#39BAE6")).toBe("#39bae6");
  });

  it("passes through anything it can't parse, so typing isn't fought", () => {
    expect(normalizeHex("#39ba")).toBe("#39ba");
    expect(normalizeHex("")).toBe("");
  });
});

describe("serializeTheme", () => {
  it("emits a :root block covering every themed var", () => {
    const css = serializeTheme(sample());
    expect(css.startsWith(":root {")).toBe(true);
    expect(css.trimEnd().endsWith("}")).toBe(true);
    for (const v of THEME_VARS) expect(css).toContain(`--${v.name}:`);
  });

  it("separates groups with a blank line but never trails one", () => {
    const css = serializeTheme(sample());
    expect(css).not.toContain("\n\n\n");
    expect(css).not.toContain("\n\n}");
  });

  it("round-trips through the CSS var syntax the stylesheet uses", () => {
    const theme = sample();
    for (const line of serializeTheme(theme).split("\n")) {
      const m = /^ {2}--([a-z-]+): (.+);$/.exec(line);
      if (m) expect(theme[m[1]]).toBe(m[2]);
    }
  });
});

describe("normalizeTheme", () => {
  const base = (): Theme =>
    Object.fromEntries(THEME_VARS.map((v) => [v.name, "#111111"]));

  it("keeps values the stored palette does define", () => {
    const out = normalizeTheme({ accent: "#ff0000" }, base());
    expect(out.accent).toBe("#ff0000");
  });

  it("fills vars added since the palette was saved", () => {
    // --raised did not exist when early palettes were written.
    const out = normalizeTheme({ accent: "#ff0000" }, base());
    expect(out.raised).toBe("#111111");
    for (const v of THEME_VARS) expect(out).toHaveProperty(v.name);
  });

  it("drops vars retired since the palette was saved", () => {
    // --border was removed from the palette.
    const out = normalizeTheme({ border: "#abcdef", accent: "#ff0000" }, base());
    expect(out).not.toHaveProperty("border");
  });

  it("normalizes stored shorthand hex", () => {
    expect(normalizeTheme({ accent: "#F00" }, base()).accent).toBe("#ff0000");
  });

  it("falls back for blank or non-string values", () => {
    const out = normalizeTheme({ accent: "  ", panel: 42, bg: null }, base());
    expect(out.accent).toBe("#111111");
    expect(out.panel).toBe("#111111");
    expect(out.bg).toBe("#111111");
  });

  it("survives junk where an object was expected", () => {
    for (const junk of [null, undefined, "nope", 7, []]) {
      expect(() => normalizeTheme(junk, base())).not.toThrow();
      expect(normalizeTheme(junk, base()).accent).toBe("#111111");
    }
  });
});
