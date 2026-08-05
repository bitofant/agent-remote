// Pure path-text logic for the add-folder picker: turning what's typed in its
// text field into the directory to list, the partial name being completed, and
// the tree rows to expand. Display uses `~/…`; every path handed to the server
// or kept as a tree key is absolute and trailing-slashed (server/paths.ts's
// canonical form), so the two can't drift.

const trimEnd = (p: string) => p.replace(/\/+$/, "");
const withSlash = (p: string) => (p.endsWith("/") ? p : `${p}/`);

/** Split typed text at the last "/": the directory prefix (kept, with its
 * slash) and the trailing name still being typed. */
export function splitTyped(text: string): { dir: string; partial: string } {
  const i = text.lastIndexOf("/");
  if (i < 0) return { dir: "", partial: text };
  return { dir: text.slice(0, i + 1), partial: text.slice(i + 1) };
}

/** Typed directory prefix → absolute canonical path. An empty prefix means
 * home, so a freshly cleared field still browses somewhere sensible. */
export function toAbsDir(dir: string, home: string): string {
  const d = dir || "~/";
  const root = trimEnd(home);
  const expanded =
    d === "~" || d.startsWith("~/") ? `${root}${d.slice(1)}` : d;
  return withSlash(expanded);
}

/** Absolute path → what the text field shows. Unlike `displayPath` (folder
 * list) home itself collapses to `~/` — here it's a prefix you keep typing. */
export function toTyped(abs: string, home: string): string {
  const root = trimEnd(home);
  if (!root || !abs.startsWith(root)) return abs;
  const rest = abs.slice(root.length);
  return rest === "" || rest.startsWith("/") ? `~${withSlash(rest)}` : abs;
}

/** Parent of an absolute directory, or null at the filesystem root. */
export function parentOf(abs: string): string | null {
  const trimmed = trimEnd(abs);
  const i = trimmed.lastIndexOf("/");
  if (i < 0 || trimmed === "") return null;
  return i === 0 ? "/" : `${trimmed.slice(0, i)}/`;
}

/** Where the tree starts: home when the path is inside it (the common case,
 * and far less noise than four levels of `/home/…`), else the filesystem root. */
export function rootFor(abs: string, home: string): string {
  const root = withSlash(trimEnd(home));
  return home && abs.startsWith(root) ? root : "/";
}

/** `root` down to `abs` inclusive — the rows the tree must have loaded and
 * expanded for the typed folder to be visible. */
export function chainFrom(root: string, abs: string): string[] {
  const chain: string[] = [];
  for (let p: string | null = withSlash(abs); p && p.length >= root.length; p = parentOf(p)) {
    chain.unshift(p);
    if (p === root) break;
  }
  return chain[0] === root ? chain : [root];
}

/** Entries prefix-matching what's typed (case-insensitive; an empty partial
 * matches all). Case-exact matches sort first, so typing the real casing
 * highlights that folder rather than an alphabetically earlier neighbour. */
export function matchEntries<T extends { name: string }>(
  entries: T[],
  partial: string,
): T[] {
  if (!partial) return entries;
  const q = partial.toLowerCase();
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(q))
    .sort(
      (a, b) =>
        Number(b.name.startsWith(partial)) - Number(a.name.startsWith(partial)),
    );
}
