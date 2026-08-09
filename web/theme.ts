// The app's palette, as data. Mirrors the :root block in styles.css — every
// color in the app resolves to one of these, so a theme *is* these values.
// Adding a color: add it here and to :root, nowhere else.

import { useEffect, useState } from "react";

export type ThemeVar = {
  name: string; // CSS custom property, without the leading --
  label: string;
  group: string;
  hint?: string;
  /** "length" renders a px slider instead of a colour swatch. */
  kind?: "color" | "length";
  max?: number;
};

export const THEME_VARS: ThemeVar[] = [
  { name: "bg", label: "Background", group: "Surfaces", hint: "Base: page + terminal" },
  { name: "panel", label: "Panel", group: "Surfaces", hint: "+1: bubbles, sidebar, dialogs" },
  { name: "raised", label: "Raised", group: "Surfaces", hint: "+2: tool blocks, code, chips" },
  { name: "text", label: "Text", group: "Text", hint: "Body copy, terminal foreground" },
  { name: "muted", label: "Muted text", group: "Text", hint: "Labels, paths, timestamps" },
  { name: "accent", label: "Accent", group: "Brand", hint: "Links, focus, primary buttons" },
  { name: "on-accent", label: "On accent", group: "Brand", hint: "Text on an accent fill" },
  { name: "success", label: "Success", group: "Status", hint: "Diff adds, done tools" },
  { name: "warning", label: "Warning", group: "Status", hint: "Running tools, notices" },
  { name: "danger", label: "Danger", group: "Status", hint: "Diff deletes, errors, Stop" },
  { name: "danger-hover", label: "Danger hover", group: "Status" },
  { name: "on-danger", label: "On danger", group: "Status", hint: "Text on a danger fill" },

  // Keep these concentric: --r-sm should be about --r-lg minus 8px of padding,
  // or nested corners stop looking parallel.
  { name: "r-sm", label: "Small", group: "Radius", hint: "Nested blocks", kind: "length", max: 16 },
  { name: "r-md", label: "Medium", group: "Radius", hint: "Buttons, inputs", kind: "length", max: 20 },
  { name: "r-lg", label: "Large", group: "Radius", hint: "Bubbles, dialogs", kind: "length", max: 28 },
];

export const isColor = (v: ThemeVar) => (v.kind ?? "color") === "color";

/** "12px" -> 12, for the length sliders. */
export const pxValue = (raw: string | undefined) =>
  Number.parseFloat(raw ?? "") || 0;

export type Theme = Record<string, string>;

const listeners = new Set<(t: Theme) => void>();

// Captured once, before any override is applied, so "Reset" always has a real
// baseline to go back to (reading it later would return the override).
let defaults: Theme | null = null;

function readVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`);
  return normalizeHex(raw.trim());
}

export function defaultTheme(): Theme {
  if (!defaults) {
    defaults = {};
    for (const v of THEME_VARS) defaults[v.name] = readVar(v.name);
  }
  return { ...defaults };
}

/** The palette in effect right now (defaults merged with any live override). */
export function readTheme(): Theme {
  defaultTheme(); // ensure baseline is captured before overrides land
  const t: Theme = {};
  for (const v of THEME_VARS) t[v.name] = readVar(v.name);
  return t;
}

export function applyTheme(theme: Theme): void {
  defaultTheme();
  const root = document.documentElement;
  for (const v of THEME_VARS) {
    const value = theme[v.name];
    if (value) root.style.setProperty(`--${v.name}`, value);
  }
  const full = readTheme();
  for (const fn of listeners) fn(full);
}

export function resetTheme(): void {
  const root = document.documentElement;
  for (const v of THEME_VARS) root.style.removeProperty(`--${v.name}`);
  const full = readTheme();
  for (const fn of listeners) fn(full);
}

/** Notifies non-CSS consumers (xterm takes its theme as a JS object). */
export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** xterm can't read CSS vars — it needs concrete values handed to it. */
export function xtermTheme(t: Theme = readTheme()) {
  return {
    background: t.bg,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: withAlpha(t.accent, 0.3),
  };
}

/** Paste-ready replacement for the :root block in styles.css. */
export function serializeTheme(theme: Theme): string {
  const lines: string[] = [":root {"];
  let group = "";
  for (const v of THEME_VARS) {
    if (v.group !== group) {
      if (group) lines.push("");
      group = v.group;
    }
    lines.push(`  --${v.name}: ${theme[v.name]};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Reconciles a stored theme against the *current* var list: keeps known keys,
    fills gaps from `base`, drops retired ones. The palette has already gained
    --raised and lost --border, so saved themes outlive the schema and a raw
    load would either miss vars or resurrect dead ones. */
export function normalizeTheme(raw: unknown, base: Theme): Theme {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Theme = {};
  for (const v of THEME_VARS) {
    const value = src[v.name];
    out[v.name] = typeof value === "string" && value.trim()
      ? normalizeHex(value.trim())
      : base[v.name];
  }
  return out;
}

/** `#abc` → `#aabbcc`; anything already 6-digit is passed through lowercased.
    <input type="color"> only accepts the long form. */
export function normalizeHex(value: string): string {
  const m = /^#([0-9a-f]{3})$/i.exec(value);
  if (m) {
    const [r, g, b] = m[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : value;
}

// Scratch buffer so a reload mid-iteration doesn't wipe the palette. NOT the
// export path — a palette ships by pasting the :root block into styles.css.
export const DRAFT_KEY = "agent-remote:theme-draft";

/** URL-gated (#theme) rather than build-gated: the app normally runs as a prod
    systemd service, so import.meta.env.DEV would hide this exactly where the
    real sessions worth restyling live. */
export function useThemeEditorOpen(): boolean {
  const [open, setOpen] = useState(() => location.hash === "#theme");
  useEffect(() => {
    const onHash = () => setOpen(location.hash === "#theme");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return open;
}

/** Named palettes, separate from the scratch draft above. */
const SAVED_KEY = "agent-remote:themes";

export type SavedThemes = Record<string, Theme>;

export function listThemes(): SavedThemes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "{}");
  } catch {
    return {}; // corrupt store shouldn't break the editor
  }
  if (!parsed || typeof parsed !== "object") return {};
  const base = defaultTheme();
  const out: SavedThemes = {};
  for (const [name, theme] of Object.entries(parsed as Record<string, unknown>)) {
    out[name] = normalizeTheme(theme, base);
  }
  return out;
}

function writeThemes(all: SavedThemes): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(all));
  } catch {
    /* quota/private mode — saving silently no-ops rather than breaking edits */
  }
}

export function saveTheme(name: string, theme: Theme): SavedThemes {
  const all = { ...listThemes(), [name]: { ...theme } };
  writeThemes(all);
  return all;
}

export function deleteTheme(name: string): SavedThemes {
  const all = listThemes();
  delete all[name];
  writeThemes(all);
  return all;
}

/** Re-applies a saved draft on load. Call before the app renders. */
export function restoreThemeDraft(): void {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    // Normalized too: a draft written before the var list changed is still valid.
    if (raw) applyTheme(normalizeTheme(JSON.parse(raw), defaultTheme()));
  } catch {
    /* malformed draft — fall back to the stylesheet defaults */
  }
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(normalizeHex(hex));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
