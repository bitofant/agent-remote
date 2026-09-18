// Lifetime token usage, read from an external sampler's JSON state file (e.g.
// ~/scripts/vllm-token-usage.sh on a 10-min cron). We never write it: the cron
// owns the counters; we only fold in what's been served since its last sample.
import { readFileSync, statSync } from "node:fs";
import type {
  ModelTokenTally,
  TokenPricing,
  TokenTally,
  TokenUsageSection,
} from "../../shared/protocol.js";

export interface Counts {
  prompt: number;
  generation: number;
}

export interface TokenUsageState {
  lastCheck: number | null;
  lastModel: string | null;
  lastCounters: Counts | null;
  daily: Record<string, Counts>;
  lifetime: Record<string, Counts>;
}

/** Live engine counters, for the not-yet-sampled tail. */
export interface LiveCounters {
  model: string | null;
  prompt: number | null;
  generation: number | null;
}

export const DEFAULT_PRICING: TokenPricing = {
  label: "Claude Sonnet",
  inputPerM: 3,
  outputPerM: 15,
};

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

const counts = (v: unknown): Counts => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { prompt: num(o.prompt), generation: num(o.generation) };
};

const countsMap = (v: unknown): Record<string, Counts> => {
  const out: Record<string, Counts> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, c] of Object.entries(v)) out[k] = counts(c);
  }
  return out;
};

/** Throws on non-JSON / non-object so the section reports why. */
export function parseTokenUsageFile(text: string): TokenUsageState {
  const j = JSON.parse(text) as unknown;
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    throw new Error("Token usage file is not a JSON object.");
  }
  const o = j as Record<string, unknown>;
  const at = typeof o.last_check === "string" ? Date.parse(o.last_check) : NaN;
  return {
    lastCheck: Number.isNaN(at) ? null : at,
    lastModel: typeof o.last_model === "string" ? o.last_model : null,
    lastCounters: o.last_counters ? counts(o.last_counters) : null,
    daily: countsMap(o.daily),
    lifetime: countsMap(o.lifetime),
  };
}

/** Same reset rule as the sampler script: a counter below its stored value means
 * the server restarted, so everything it reports now is new. */
const deltaOf = (current: number | null, prev: number): number | null =>
  current == null ? null : current >= prev ? current - prev : current;

/** Tokens served since the file's last sample, or null if unknowable. A model
 * change implies a restart since that sample, so the live counters are all new. */
export function unsampledTokens(
  state: TokenUsageState,
  live: LiveCounters | null,
): Counts | null {
  if (!live || live.prompt == null || live.generation == null || !state.lastCounters) {
    return null;
  }
  if (live.model && state.lastModel && live.model !== state.lastModel) {
    return { prompt: live.prompt, generation: live.generation };
  }
  return {
    prompt: deltaOf(live.prompt, state.lastCounters.prompt) ?? 0,
    generation: deltaOf(live.generation, state.lastCounters.generation) ?? 0,
  };
}

/** Local-time YYYY-MM-DD — the script keys days by `date +%F`, not UTC. */
export function localDay(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const tally = (c: Counts, pricing: TokenPricing | null): TokenTally => ({
  prompt: c.prompt,
  generation: c.generation,
  costUsd: pricing
    ? (c.prompt / 1e6) * pricing.inputPerM + (c.generation / 1e6) * pricing.outputPerM
    : null,
});

const add = (a: Counts, b: Counts | null): Counts =>
  b ? { prompt: a.prompt + b.prompt, generation: a.generation + b.generation } : a;

export function buildTokenUsage(
  state: TokenUsageState,
  opts: {
    file: string;
    now: number;
    live: LiveCounters | null;
    pricing: TokenPricing | null;
  },
): TokenUsageSection {
  const unsampled = unsampledTokens(state, opts.live);
  const currentModel = opts.live?.model ?? state.lastModel;
  // Unsampled tokens belong to whatever is serving now.
  const owner = unsampled ? currentModel ?? state.lastModel ?? "unknown" : null;

  const lifetime = { ...state.lifetime };
  if (owner) lifetime[owner] = add(lifetime[owner] ?? { prompt: 0, generation: 0 }, unsampled);

  const models: ModelTokenTally[] = Object.entries(lifetime)
    .map(([model, c]) => ({ model, ...tally(c, opts.pricing) }))
    .sort(
      (a, b) =>
        b.prompt + b.generation - (a.prompt + a.generation) || a.model.localeCompare(b.model),
    );

  const total = models.reduce<Counts>((acc, m) => add(acc, m), { prompt: 0, generation: 0 });
  const today = add(state.daily[localDay(opts.now)] ?? { prompt: 0, generation: 0 }, unsampled);
  const current = currentModel
    ? (models.find((m) => m.model === currentModel) ?? {
        model: currentModel,
        ...tally({ prompt: 0, generation: 0 }, opts.pricing),
      })
    : null;

  return {
    file: opts.file,
    lastCheck: state.lastCheck,
    currentModel,
    unsampled,
    today: tally(today, opts.pricing),
    current,
    total: tally(total, opts.pricing),
    models,
    pricing: opts.pricing,
  };
}

let cache: { file: string; key: string; state: TokenUsageState } | null = null;

/** Re-parses whenever the file changes. Keyed on inode too: the script replaces
 * the file via `mv`, so a same-mtime rewrite still shows up as a new inode. */
export function readTokenUsageState(file: string): TokenUsageState {
  const st = statSync(file);
  const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
  if (cache?.file === file && cache.key === key) return cache.state;
  const state = parseTokenUsageFile(readFileSync(file, "utf8"));
  cache = { file, key, state };
  return state;
}
