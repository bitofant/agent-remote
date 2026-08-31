// Splitting plain text into text/URL runs, so AI-mode note lines (a PR url, a
// git remote in an error) become clickable. Kept pure and separate from the
// component because the interesting part is the trailing-punctuation trimming.

/** One run of a linkified string: literal text, or a URL to anchor. */
export type LinkRun =
  | { text: string; url?: undefined }
  | { text: string; url: string };

// Deliberately narrow: http(s) only, no bare-domain or www guessing — this runs
// over machine-written notes and stderr, where a false positive is worse than a
// missed link.
const URL_RE = /https?:\/\/[^\s<>"']+/g;

// Trailing characters that are almost always sentence punctuation, not URL.
// A closing bracket only counts as punctuation when it has no opener in the URL
// (`…/foo_(bar)` is a real path, `(see …/foo)` is not).
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "”", "’"]);

function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (TRAILING.has(ch)) end--;
    else if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      const slice = url.slice(0, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (closes > opens) end--;
      else break;
    } else break;
  }
  return url.slice(0, end);
}

/** Split `text` into literal and URL runs, in order. Never empty for non-empty
 * input; a string with no URL yields a single text run. */
export function linkRuns(text: string): LinkRun[] {
  const runs: LinkRun[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!url) continue;
    const start = m.index!;
    if (start > last) runs.push({ text: text.slice(last, start) });
    runs.push({ text: url, url });
    last = start + url.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}
