// LLM engine discovery for the System state page.
//
// The rule, deliberately narrow: the engine we report on is the one THIS app is
// configured to talk to (config.llm.baseUrl). If that endpoint is local, probe
// it and name the docker container publishing its port; if it's remote, we
// assume there's no local engine to monitor rather than scraping someone
// else's server.
//
// vLLM and llama.cpp are two flavours behind one normalized shape. Anything
// unrecognized degrades to "unknown"/null — never a throw, never a fake zero.
import { hostname } from "node:os";
import type { EngineSection } from "../../shared/protocol.js";
import { histogramAvg, rateOf } from "./delta.js";
import { containerForPort, type PsRow } from "./docker.js";
import {
  flavourOf,
  labelOf,
  looksLikePrometheus,
  parsePrometheus,
  sumOf,
  type Sample,
} from "./metrics.js";

/** Short: a stalled engine must not eat into the 2s sampling tick. */
const ENGINE_TIMEOUT_MS = 2000;

export interface EngineTarget {
  origin: string;
  hostname: string;
  port: number;
  isLocal: boolean;
  metricsUrl: string;
  modelsUrl: string;
  propsUrl: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** `/metrics` and `/health` live at the SERVER ROOT, not under the OpenAI
 * `/v1` prefix — so the configured baseUrl's trailing `/v1` is stripped. */
export function parseEngineTarget(baseUrl: string): EngineTarget | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const origin = `${u.protocol}//${u.host}`;
  const isLocal =
    LOCAL_HOSTS.has(host) ||
    /^127\./.test(host) ||
    host === hostname().toLowerCase();
  return {
    origin,
    hostname: host,
    port,
    isLocal,
    metricsUrl: `${origin}/metrics`,
    modelsUrl: `${origin}/v1/models`,
    propsUrl: `${origin}/props`,
  };
}

/** Text sibling of llm.ts's fetchJson — Prometheus is text/plain, not JSON. */
async function fetchText(
  target: string,
  timeoutMs = ENGINE_TIMEOUT_MS,
): Promise<{ body: string; contentType: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      body: await res.text(),
      contentType: res.headers.get("content-type") ?? "",
    };
  } finally {
    clearTimeout(t);
  }
}

/** Counters carried between ticks so rates can be derived. The engine's own
 * *_total metrics are monotonic, so tok/s only exists as a delta. */
export interface EngineCounters {
  at: number;
  promptTokens: number | null;
  generationTokens: number | null;
  ttftSum: number | null;
  ttftCount: number | null;
}

interface Normalized {
  gauges: Pick<
    EngineSection,
    | "requestsRunning"
    | "requestsWaiting"
    | "kvCacheUsedPct"
    | "prefixCacheHitPct"
    | "preemptionsTotal"
    | "promptTokensTotal"
    | "generationTokensTotal"
  >;
  counters: EngineCounters;
  model: string | null;
}

const pct = (v: number | null) => (v == null ? null : v * 100);

const ratioPct = (hits: number | null, queries: number | null) =>
  hits == null || queries == null || queries <= 0 ? null : (hits / queries) * 100;

function normalizeVllm(s: Sample[], at: number): Normalized {
  const prompt = sumOf(s, "vllm:prompt_tokens_total");
  const generation = sumOf(s, "vllm:generation_tokens_total");
  return {
    gauges: {
      requestsRunning: sumOf(s, "vllm:num_requests_running"),
      requestsWaiting: sumOf(s, "vllm:num_requests_waiting"),
      kvCacheUsedPct: pct(sumOf(s, "vllm:kv_cache_usage_perc")),
      prefixCacheHitPct: ratioPct(
        sumOf(s, "vllm:prefix_cache_hits_total"),
        sumOf(s, "vllm:prefix_cache_queries_total"),
      ),
      preemptionsTotal: sumOf(s, "vllm:num_preemptions_total"),
      promptTokensTotal: prompt,
      generationTokensTotal: generation,
    },
    counters: {
      at,
      promptTokens: prompt,
      generationTokens: generation,
      ttftSum: sumOf(s, "vllm:time_to_first_token_seconds_sum"),
      ttftCount: sumOf(s, "vllm:time_to_first_token_seconds_count"),
    },
    model: labelOf(s, "vllm:num_requests_running", "model_name"),
  };
}

/** Written from llama.cpp's documented /metrics (it isn't installed here), so
 * every lookup is allowed to miss: a renamed metric yields null, not a throw. */
function normalizeLlamacpp(s: Sample[], at: number): Normalized {
  const prompt = sumOf(s, "llamacpp:prompt_tokens_total");
  const generation = sumOf(s, "llamacpp:tokens_predicted_total");
  return {
    gauges: {
      requestsRunning: sumOf(s, "llamacpp:requests_processing"),
      requestsWaiting: sumOf(s, "llamacpp:requests_deferred"),
      kvCacheUsedPct: pct(sumOf(s, "llamacpp:kv_cache_usage_ratio")),
      prefixCacheHitPct: null,
      preemptionsTotal: null,
      promptTokensTotal: prompt,
      generationTokensTotal: generation,
    },
    counters: { at, promptTokens: prompt, generationTokens: generation, ttftSum: null, ttftCount: null },
    model: null,
  };
}

export function normalizeMetrics(
  flavour: "vllm" | "llamacpp" | "unknown",
  samples: Sample[],
  at: number,
): Normalized {
  if (flavour === "vllm") return normalizeVllm(samples, at);
  if (flavour === "llamacpp") return normalizeLlamacpp(samples, at);
  return {
    gauges: {
      requestsRunning: null,
      requestsWaiting: null,
      kvCacheUsedPct: null,
      prefixCacheHitPct: null,
      preemptionsTotal: null,
      promptTokensTotal: null,
      generationTokensTotal: null,
    },
    counters: { at, promptTokens: null, generationTokens: null, ttftSum: null, ttftCount: null },
    model: null,
  };
}

/** Model id + context length from an OpenAI-compatible /v1/models body. The
 * JSON parse doubles as content validation: an SPA's HTML throws here. */
export function parseModelsBody(
  body: string,
): { model: string; maxModelLen: number | null } | null {
  try {
    const j = JSON.parse(body) as {
      data?: { id?: unknown; max_model_len?: unknown }[];
    };
    const first = j.data?.[0];
    if (!first || typeof first.id !== "string" || !first.id) return null;
    const len = first.max_model_len;
    return {
      model: first.id,
      maxModelLen: typeof len === "number" && Number.isFinite(len) ? len : null,
    };
  } catch {
    return null;
  }
}

/** llama.cpp's /props carries n_ctx and the loaded model path. */
export function parsePropsBody(
  body: string,
): { model: string | null; maxModelLen: number | null } | null {
  try {
    const j = JSON.parse(body) as {
      n_ctx?: unknown;
      model_path?: unknown;
      default_generation_settings?: { n_ctx?: unknown; model?: unknown };
    };
    if (typeof j !== "object" || j === null) return null;
    const gen = j.default_generation_settings ?? {};
    const ctx = typeof j.n_ctx === "number" ? j.n_ctx : gen.n_ctx;
    const model =
      typeof gen.model === "string"
        ? gen.model
        : typeof j.model_path === "string"
          ? j.model_path
          : null;
    const maxModelLen =
      typeof ctx === "number" && Number.isFinite(ctx) ? ctx : null;
    // Require at least one recognisable field: `{}` (or any unrelated JSON)
    // must not read as "a llama.cpp server is running here".
    if (maxModelLen == null && model == null) return null;
    return { model, maxModelLen };
  } catch {
    return null;
  }
}

const emptyEngine = (
  baseUrl: string,
  detection: EngineSection["detection"],
): EngineSection => ({
  detection,
  flavour: "unknown",
  baseUrl,
  reachable: false,
  detail: null,
  model: null,
  maxModelLen: null,
  container: null,
  requestsRunning: null,
  requestsWaiting: null,
  kvCacheUsedPct: null,
  prefixCacheHitPct: null,
  preemptionsTotal: null,
  promptTokensTotal: null,
  generationTokensTotal: null,
  promptTokensPerSec: null,
  generationTokensPerSec: null,
  timeToFirstTokenMs: null,
});

export interface EngineProbe {
  /** Null only when there is nothing to report on at all (no/!bad config); the
   * sampler turns `error` into the section's `errors` entry. A configured
   * endpoint that simply isn't answering still yields a section, carrying its
   * reason in `detail`. */
  section: EngineSection | null;
  counters: EngineCounters | null;
  error?: string;
}

/**
 * Probe order: /metrics (richest) → /v1/models → /health. Each step validates
 * CONTENT, never just the status code — an SPA on the configured port answers
 * 200 with HTML for every path and would otherwise be reported as an engine.
 */
export async function probeEngine(
  baseUrl: string,
  psRows: PsRow[] | null,
  prev: EngineCounters | null,
  now = Date.now(),
): Promise<EngineProbe> {
  const target = parseEngineTarget(baseUrl);
  if (!target) {
    return { section: null, counters: null, error: "Unparseable llm.baseUrl." };
  }
  if (!target.isLocal) {
    const remote = emptyEngine(baseUrl, "remote");
    remote.detail = `Endpoint is not local (${target.hostname}), so there is no engine on this box to monitor.`;
    return { section: remote, counters: null };
  }

  const container = psRows
    ? (containerForPort(psRows, target.port)?.name ?? null)
    : null;
  const section = emptyEngine(baseUrl, "none");
  section.container = container;

  // 1. Prometheus metrics.
  try {
    const { body, contentType } = await fetchText(target.metricsUrl);
    if (looksLikePrometheus(body, contentType)) {
      const flavour = flavourOf(body);
      if (flavour !== "unknown") {
        const samples = parsePrometheus(body);
        const { gauges, counters, model } = normalizeMetrics(flavour, samples, now);
        const dt = prev ? now - prev.at : 0;
        Object.assign(section, gauges, {
          detection: "local-metrics" as const,
          flavour,
          reachable: true,
          model,
          promptTokensPerSec: rateOf(prev?.promptTokens, counters.promptTokens, dt),
          generationTokensPerSec: rateOf(
            prev?.generationTokens,
            counters.generationTokens,
            dt,
          ),
          timeToFirstTokenMs: msOrNull(
            histogramAvg(prev?.ttftSum, prev?.ttftCount, counters.ttftSum, counters.ttftCount),
          ),
        });
        await enrichModel(section, target);
        return { section, counters };
      }
    }
  } catch {
    // Fall through to the cheaper probes.
  }

  // 2. /v1/models — the JSON parse is itself the content validation.
  try {
    const { body } = await fetchText(target.modelsUrl);
    const info = parseModelsBody(body);
    if (info) {
      section.detection = "local-health";
      section.reachable = true;
      section.model = info.model;
      section.maxModelLen = info.maxModelLen;
      return { section, counters: null };
    }
  } catch {
    // Fall through.
  }

  // 3. /props — llama.cpp with metrics disabled. Its shape (n_ctx / model) is
  //    the validation, same as the model list above.
  try {
    const { body } = await fetchText(target.propsUrl);
    const props = parsePropsBody(body);
    if (props) {
      section.detection = "local-health";
      section.flavour = "llamacpp";
      section.reachable = true;
      section.model = props.model;
      section.maxModelLen = props.maxModelLen;
      return { section, counters: null };
    }
  } catch {
    // Fall through to "not detected".
  }

  // Deliberately NO bare /health probe. A 200 there proves something is
  // listening, not that it's an LLM engine — Open-WebUI answers /health with
  // {"status":true} and would otherwise be reported as a running engine. Every
  // step above demands positive evidence: engine metrics, a model list, or
  // llama.cpp's props.

  section.detail = container
    ? `Container "${container}" publishes ${target.port} but isn't serving an engine API (still loading?).`
    : `Nothing answering on ${target.origin}.`;
  return { section, counters: null };
}

const msOrNull = (sec: number | null) => (sec == null ? null : sec * 1000);

/** Metrics give numbers but rarely the context length; ask the model list. */
async function enrichModel(
  section: EngineSection,
  target: EngineTarget,
): Promise<void> {
  try {
    const { body } = await fetchText(target.modelsUrl);
    const info = parseModelsBody(body);
    if (info) {
      section.model ??= info.model;
      section.maxModelLen = info.maxModelLen;
      return;
    }
  } catch {
    // Best-effort only.
  }
  if (section.flavour !== "llamacpp") return;
  try {
    const { body } = await fetchText(target.propsUrl);
    const props = parsePropsBody(body);
    if (props) {
      section.model ??= props.model;
      section.maxModelLen = props.maxModelLen;
    }
  } catch {
    // Best-effort only.
  }
}
