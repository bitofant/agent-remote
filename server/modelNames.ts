// LLM-generated display names for model pickers whose catalog labels are raw
// ids (pi: `RedHatAI/gemma-4-31B-it-NVFP4` → `Gemma 4`). Harness-agnostic:
// opt-in via `HarnessAdapter.llmModelNames`. On a `models` event the whole
// catalog goes to the LLM in one call (so quants of one family can be told
// apart), results are validated and posted as a `model-names` event.
// Cached per CATALOG, not per model — a name depends on its neighbours ("Gemma
// 4" is only right while there's one) — in memory and in a persistent store, so
// names survive restarts until the model list changes. Best-effort: no
// endpoint → raw labels stay.
import { createHash } from "node:crypto";
import type { SessionManager } from "./sessions/manager.js";
import type { HarnessAdapter } from "./adapters/types.js";
import type { ChatModel } from "../shared/protocol.js";
import { llmStatus, suggestModelNames } from "./llm.js";

// Bump when the naming prompt changes, so stored names are regenerated.
const PROMPT_VERSION = 1;
const MAX_NAME_CHARS = 40;
// The first poll of the endpoint may not have landed when a session starts, and
// the endpoint may be restarting; keep waiting while a session shows the list.
const LLM_WAIT_MS = 10 * 60_000;
const LLM_WAIT_STEP_MS = 5_000;
// A failed call retries on its own — no later `models` event is coming.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15_000;

/** Persistence for named catalogs (db.ts in production; injected so this
 * module stays DB-free for the pure tests). */
export interface ModelNamesStore {
  get(key: string): Record<string, string> | undefined;
  set(key: string, names: Record<string, string>): void;
}

/** Identity of a catalog as the namer saw it: everything sent to the LLM, order-
 * independent. Exported for testing. */
export function catalogKey(models: ChatModel[]): string {
  const lines = models
    .map((m) => [m.id, m.label, m.group ?? ""].join("\t"))
    .sort();
  return createHash("sha256")
    .update(`v${PROMPT_VERSION}\n${lines.join("\n")}`)
    .digest("hex");
}

/** Keep only usable names: a single short line, and unique within its group —
 * a clash would make two picker rows indistinguishable, so both fall back to
 * their raw labels. Exported for testing. */
export function sanitizeModelNames(
  models: ChatModel[],
  raw: Record<string, unknown>,
): Record<string, string> {
  const ok = new Map<string, string>();
  for (const m of models) {
    const v = raw[m.id];
    if (typeof v !== "string") continue;
    const name = v.trim();
    if (!name || name.length > MAX_NAME_CHARS || /[\r\n]/.test(name)) continue;
    ok.set(m.id, name);
  }
  const seen = new Map<string, string[]>();
  for (const m of models) {
    const name = ok.get(m.id);
    if (name === undefined) continue;
    const key = `${m.group ?? ""}\u0000${name.toLowerCase()}`;
    seen.set(key, [...(seen.get(key) ?? []), m.id]);
  }
  for (const ids of seen.values())
    if (ids.length > 1) for (const id of ids) ok.delete(id);
  return Object.fromEntries(ok);
}

function sameNames(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export function attachModelNames(
  manager: SessionManager,
  adapters: Map<string, HarnessAdapter>,
  store?: ModelNamesStore,
  timing: { waitStepMs?: number; retryDelayMs?: number } = {},
): () => void {
  const waitStep = timing.waitStepMs ?? LLM_WAIT_STEP_MS;
  const retryDelay = timing.retryDelayMs ?? RETRY_DELAY_MS;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const cache = new Map<string, Record<string, string>>();
  // Latest known name per id, shown while a changed catalog is being renamed.
  const lastNames = new Map<string, string>();
  const inflight = new Set<string>();
  // Sessions currently showing each catalog: all get the names when they land.
  const watchers = new Map<string, Set<string>>();

  const unwatch = (sessionId: string) => {
    for (const [key, ids] of watchers) {
      ids.delete(sessionId);
      if (ids.size === 0) watchers.delete(key);
    }
  };
  const watched = (key: string) => (watchers.get(key)?.size ?? 0) > 0;

  const lookup = (key: string) => {
    let names = cache.get(key);
    if (!names) {
      try {
        names = store?.get(key);
      } catch {
        names = undefined;
      }
      if (names) cache.set(key, names);
    }
    return names;
  };

  const post = (sessionId: string, names: Record<string, string>) => {
    const state = manager.chatState(sessionId);
    if (state && !sameNames(state.modelNames ?? {}, names))
      manager.postModelNames(sessionId, names);
  };

  // Names for a catalog, or undefined once nobody shows it / attempts run out.
  const generate = async (key: string, models: ChatModel[]) => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(retryDelay);
      for (let waited = 0; !llmStatus().available; waited += waitStep) {
        if (waited >= LLM_WAIT_MS || !watched(key)) return undefined;
        await sleep(waitStep);
      }
      if (!watched(key)) return undefined;
      const raw = await suggestModelNames(
        models.map((m) => ({ id: m.id, label: m.label, provider: m.group })),
      ).catch(() => ({}));
      if (Object.keys(raw).length > 0) return sanitizeModelNames(models, raw);
    }
    return undefined;
  };

  const request = async (key: string, models: ChatModel[]) => {
    const names = await generate(key, models);
    if (!names) return;
    cache.set(key, names);
    for (const [id, n] of Object.entries(names)) lastNames.set(id, n);
    try {
      store?.set(key, names);
    } catch {
      // Persistence is an optimisation; the in-memory cache still serves.
    }
    // Live push to every session still showing this catalog — no reload needed.
    for (const id of watchers.get(key) ?? []) post(id, names);
    watchers.delete(key);
  };

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit: (sessionId) => unwatch(sessionId),
    onRemoved: (sessionId) => unwatch(sessionId),
    onChatEvent(sessionId, event) {
      if (event.type !== "models") return;
      const info = manager.sessionInfo(sessionId);
      if (!info || !adapters.get(info.harnessId)?.llmModelNames) return;
      const models = event.models;
      const key = catalogKey(models);
      unwatch(sessionId);
      const hit = lookup(key);
      if (hit) {
        for (const [id, n] of Object.entries(hit)) lastNames.set(id, n);
        post(sessionId, hit);
        return;
      }
      watchers.set(key, (watchers.get(key) ?? new Set()).add(sessionId));
      // Changed catalog: keep showing names of models we already knew
      // (re-validated against the new list) until the rename lands.
      post(sessionId, sanitizeModelNames(models, Object.fromEntries(lastNames)));
      if (inflight.has(key)) return;
      inflight.add(key);
      void request(key, models)
        .catch(() => {})
        .finally(() => inflight.delete(key));
    },
  });
}
