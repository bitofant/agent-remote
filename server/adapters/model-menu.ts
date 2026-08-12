// Model-switcher menu policy, kept pure (no SDK runtime import — the ModelInfo
// type import is erased) so it can be unit-tested via `npm test`.
//
// Claude Code returns *alias* rows: `value`/`displayName` are "opus"/"Opus",
// "sonnet"/"Sonnet", "default"/"Default (recommended)", and the versioned wire
// id lives only in `resolvedModel` ("claude-sonnet-5"). So:
//   - menuLabel appends the version (from resolvedModel) to the display name, so
//     the menu actually shows "Opus 4.8" rather than a bare "Opus".
//   - pruneToLatest keys off `value` (the id the user selects), NOT resolvedModel
//     — grouping aliases by their resolved family would wrongly collapse distinct
//     rows like Default and Opus (both resolve to Opus) into one. For alias rows
//     `value` carries no version, so pruning is a safe no-op; for a harness that
//     returns versioned values it prunes each family to the latest (plus the
//     prior major when the major version just changed).
//   - sortModels orders smallest → largest by family; unknown families → SDK order.
//   - a bracketed suffix is a *variant*, not a version: "claude-opus-4-8[1m]" is
//     the same model as "claude-opus-4-8" with a 1M-token context window, and the
//     enterprise catalog lists both. It gets its own pruning group (so both survive)
//     and sorts after the plain row (so the plain one is the default pick).
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

// Family ordering (smallest → largest). Also the set of recognized families.
export const KNOWN_MODEL_ORDER = ["haiku", "sonnet", "opus", "fable", "mythos"];

// A trailing bracketed tag ("[1m]") names a context-window variant of the model.
const VARIANT_RE = /\[[^\]]*\]/;

/** Is this a long-context (bracket-tagged) variant, e.g. `claude-opus-4-8[1m]`? */
export function isVariant(id: string): boolean {
  return VARIANT_RE.test(id);
}

// Versioned wire id when the SDK resolves an alias; else the value itself.
function wireId(m: ModelInfo): string {
  return (m.resolvedModel ?? m.value).toLowerCase();
}

function familyIn(id: string): string | null {
  return KNOWN_MODEL_ORDER.find((family) => id.includes(family)) ?? null;
}

// [major, minor] from the first two numeric groups after the family name
// (e.g. "claude-opus-4-8" → [4, 8], "claude-sonnet-5" → [5, 0]), ignoring any
// trailing date snapshot ("...-4-5-20251001" → [4, 5]). null when no version.
// The variant tag is stripped first, or "claude-sonnet-5[1m]" would read as 5.1.
function versionParts(id: string): [number, number] | null {
  id = id.replace(VARIANT_RE, "");
  const family = familyIn(id);
  const after = family ? id.slice(id.indexOf(family) + family.length) : id;
  const nums = after.match(/\d+/g);
  if (!nums) return null;
  return [Number(nums[0]), nums.length > 1 ? Number(nums[1]) : 0];
}

function versionText(id: string): string | null {
  const v = versionParts(id);
  if (!v) return null;
  return v[1] ? `${v[0]}.${v[1]}` : `${v[0]}`;
}

// Rank by resolved family so alias rows ("default" → opus) sort correctly.
function modelRank(m: ModelInfo): number {
  return KNOWN_MODEL_ORDER.findIndex((family) => wireId(m).includes(family));
}

/** Menu label: the SDK display name, with the resolved version appended when the
 * name doesn't already carry it (so "Opus" → "Opus 4.8"). */
export function menuLabel(m: ModelInfo): string {
  const name = (m.displayName || m.value).trim();
  const ver = versionText(wireId(m));
  if (!ver) return name;
  // Already shows the number? leave it (avoids "Opus 4.8 4.8").
  if (name.replace(/\D/g, "").includes(ver.replace(/\D/g, ""))) return name;
  return `${name} ${ver}`;
}

/** Sort smallest → largest only when every model is a known family; else SDK order.
 * Within a family the plain row precedes its long-context variant. */
export function sortModels(models: readonly ModelInfo[]): ModelInfo[] {
  if (models.some((m) => modelRank(m) === -1)) return [...models];
  const variant = (m: ModelInfo) => (isVariant(m.value) ? 1 : 0);
  return [...models].sort(
    (a, b) => modelRank(a) - modelRank(b) || variant(a) - variant(b),
  );
}

/** Reduce each family to its latest version, or the latest two when the major
 * version just changed. Keyed off `value` (the selectable id): alias rows carry
 * no version, so they pass through untouched. A long-context variant is its own
 * group, so "Opus 4.8" and "Opus 4.8 (1M context)" both reach the menu. */
export function pruneToLatest(models: readonly ModelInfo[]): ModelInfo[] {
  const groups = new Map<string, { m: ModelInfo; v: [number, number] }[]>();
  const kept: ModelInfo[] = [];
  for (const m of models) {
    const id = m.value.toLowerCase();
    const family = familyIn(id);
    const v = family ? versionParts(id) : null;
    if (family && v) {
      const key = isVariant(id) ? `${family}[variant]` : family;
      const g = groups.get(key) ?? [];
      g.push({ m, v });
      groups.set(key, g);
    } else {
      kept.push(m); // alias / unknown family / unversioned — never filtered out
    }
  }
  for (const g of groups.values()) {
    g.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1]);
    kept.push(g[0].m);
    // Major version just changed → also keep the previous major (one extra entry).
    if (g.length > 1 && g[1].v[0] !== g[0].v[0]) kept.push(g[1].m);
  }
  return kept;
}

/** The models the menu should show, in order. */
export function menuModels(models: readonly ModelInfo[]): ModelInfo[] {
  return sortModels(pruneToLatest(models));
}

/** Which menu row to select by default, given an ordered preference list of
 * aliases (e.g. ["opusplan", "opus"] — take Opus Plan Mode where the catalog
 * offers it, else plain Opus).
 *
 * Not a substring scan: "opusplan" contains "opus", so `includes()` couldn't
 * tell the two apart — it matched whichever sorted first. Ranking, in order:
 *   1. earlier alias in the preference list wins outright;
 *   2. exact alias row → versioned id of that family → anything else containing
 *      the name (so "opus" prefers `opus`/`claude-opus-4-8` over `opusplan`);
 *   3. plain before its long-context "[1m]" variant (that one bills usage credits);
 *   4. highest version.
 * undefined when no alias matches anything. */
export function pickDefault(
  models: readonly ModelInfo[],
  aliases: readonly string[],
): ModelInfo | undefined {
  const tier = (id: string, alias: string): number => {
    if (id === alias) return 0;
    if (familyIn(id) === alias && versionParts(id)) return 1;
    return id.includes(alias) ? 2 : 3;
  };
  // Lower is better, compared left to right.
  const rank = (m: ModelInfo): number[] | null => {
    const id = m.value.toLowerCase();
    const i = aliases.findIndex((a) => tier(id, a) < 3);
    if (i === -1) return null;
    const [major, minor] = versionParts(wireId(m)) ?? [0, 0];
    return [i, tier(id, aliases[i]), isVariant(id) ? 1 : 0, -major, -minor];
  };
  let best: ModelInfo | undefined;
  let bestRank: number[] | null = null;
  for (const m of models) {
    const r = rank(m);
    if (!r) continue;
    if (!bestRank || compare(r, bestRank) < 0) {
      best = m;
      bestRank = r;
    }
  }
  return best;
}

// Lexicographic: the first differing element decides.
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
