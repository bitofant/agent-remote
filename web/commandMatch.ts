// Command-builder search: a prefix of the whole string ranks first, then a
// prefix of any word/path segment — so "rest" finds "./restart.sh" and
// "force" finds "--force". Returns 0 (whole), 1 (word) or null (no match).
export function matchRank(s: string, q: string): 0 | 1 | null {
  const text = s.toLowerCase();
  const query = q.trim().toLowerCase();
  if (!query || text.startsWith(query)) return 0;
  const words = text.split(/[\s/]+/).map((w) => w.replace(/^-+/, ""));
  return words.some((w) => w.startsWith(query)) ? 1 : null;
}

// Filters, keeping whole-string prefix hits ahead of word hits (stable otherwise).
export function filterRanked<T>(items: T[], key: (t: T) => string, q: string): T[] {
  const ranked = items
    .map((item) => ({ item, rank: matchRank(key(item), q) }))
    .filter((r): r is { item: T; rank: 0 | 1 } => r.rank !== null);
  return [...ranked.filter((r) => r.rank === 0), ...ranked.filter((r) => r.rank === 1)].map(
    (r) => r.item,
  );
}
