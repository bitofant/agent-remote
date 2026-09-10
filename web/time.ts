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

/** Locale to format times with, or undefined for the browser default.
 *
 * The web platform exposes a language list, never the OS's regional prefs —
 * there is no `navigator.hourCycle`, so a 24-hour Linux desktop still renders
 * "12:00 PM" from a plain `en-US` browser. `navigator.languages` is
 * Accept-Language ("languages I read"), and for a developer working in an
 * English environment the primary tag is the *working* language while a later
 * entry is the actual home locale, carrying the clock convention the OS is set
 * to. Hence: format with the first non-English tag.
 *
 * A deliberate personal heuristic, not a general truth — it assumes English is
 * the language of work rather than of home. An English-only list returns
 * undefined, i.e. the browser default. It also picks a *locale*, not a clock: a
 * 12-hour home locale (ko-KR) still formats 12-hour.
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

const pad = (n: number) => String(n).padStart(2, "0");

/** A rate-limit window's reset time: "resets in 3h" under a day, else
 * "resets in 2 days, 2026-09-21, 12:00" — the distance is what's actionable,
 * the stamp answers "when exactly".
 *
 * The date half is hardcoded ISO order (locale-independent, unambiguous, and
 * sorts); the time half follows `displayLocale`, since that's the part carrying
 * the 12h/24h convention the browser can't read off the OS. `locale` is
 * injectable so the format is testable without a `navigator`. */
export function formatReset(
  iso: string | null,
  now = Date.now(),
  locale = displayLocale(),
): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const diffMs = t.getTime() - now;
  if (diffMs <= 0) return "resetting now";
  const minutes = diffMs / 60_000;
  if (minutes < 60) return `resets in ${Math.max(1, Math.floor(minutes))}m`;
  // Floor, so the coarse unit never overstates and the branch boundaries are
  // exact: 23.9h reads "23h", not "24h" a minute before the day form.
  const hours = minutes / 60;
  if (hours < 24) return `resets in ${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  // Local getters — NOT toISOString(), which is UTC and names the wrong hour.
  const date = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const time = t.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `resets in ${days} day${days === 1 ? "" : "s"}, ${date}, ${time}`;
}
