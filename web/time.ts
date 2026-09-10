/** Locale to format absolute dates/times with, or undefined for the browser
 * default.
 *
 * The web platform exposes a language list, never the OS's regional prefs —
 * there is no `navigator.hourCycle`/`dateFormat`, so a 24-hour Linux desktop
 * still renders "12:00 PM" from a plain `en-US` browser. `navigator.languages`
 * is Accept-Language ("languages I read"), and for a developer working in an
 * English environment the primary tag is the *working* language while a later
 * entry is the actual home locale, carrying the clock and date conventions the
 * OS is set to. Hence: format with the first non-English tag.
 *
 * A deliberate personal heuristic, not a general truth — it assumes English is
 * the language of work rather than of home. An English-only list returns
 * undefined, i.e. exactly the browser default. It also picks a *locale*, not a
 * clock: a 12-hour home locale (ko-KR) still formats 12-hour.
 *
 * Pure (takes the list) so it's testable without a `navigator`. */
export function preferredLocale(langs: readonly string[]): string | undefined {
  for (const tag of langs) {
    const lang = tag.toLowerCase(); // BCP-47 is case-insensitive
    // Exact: a primary subtag ends at the first hyphen, and enm/enq/eno are
    // their own languages, not English.
    if (lang === "en" || lang.startsWith("en-")) continue;
    try {
      // Throws on a malformed tag, [] on a well-formed one the browser can't
      // format with — either way, not a locale worth adopting. Skipping this
      // would hand an unvalidated tag to toLocale*String, which throws mid-render.
      if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0) return tag;
    } catch {
      // malformed tag — skip it
    }
  }
  return undefined;
}

let localeResolved = false;
let localeCache: string | undefined;

/** `preferredLocale` over the live browser list, resolved once. */
export function displayLocale(): string | undefined {
  if (!localeResolved) {
    localeResolved = true;
    // Guarded so this module stays importable from the Node-env pure tests.
    localeCache = preferredLocale(globalThis.navigator?.languages ?? []);
  }
  return localeCache;
}

// Compact "time since" label for session/prompt lists (e.g. "3m", "2h", "5d").
// Shared by the resume picker (App.tsx) and the rewind picker (ChatView.tsx) —
// App lazy-imports ChatView, so it can't be the one exporting this.
export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
