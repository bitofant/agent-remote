// Optional, best-effort LLM assist. Talks to an OpenAI-compatible endpoint
// (default: local vLLM at http://localhost:8000/v1) to judge permission prompts
// and answer questions on the user's behalf. Everything here is fail-safe:
// any error / unreachable endpoint degrades to "unavailable" and the UI falls
// back to the normal manual flow. Harness-agnostic; lives outside adapters.

import type { LlmConfig } from "./config.js";
import type {
  LlmDecision,
  LlmEvaluateRequest,
  LlmStatus,
} from "../shared/protocol.js";

let cfg: LlmConfig | null = null;
let status: LlmStatus = { available: false, model: null };
let timer: ReturnType<typeof setInterval> | null = null;

const POLL_MS = 25_000;
const MODELS_TIMEOUT_MS = 4_000;
const EVAL_TIMEOUT_MS = 10_000;

/** `${baseUrl}/models` etc., tolerating a trailing slash on baseUrl. */
function url(path: string): string {
  const base = (cfg?.baseUrl ?? "").replace(/\/+$/, "");
  return `${base}/${path}`;
}

async function fetchJson(
  target: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Resolve the model to use: the configured name, unless it's "default"/empty,
 * in which case the first model the endpoint advertises. Doubles as the health
 * probe — throws if the endpoint is down or lists no models. */
async function resolveModel(): Promise<string> {
  const data = (await fetchJson(
    url("models"),
    { method: "GET" },
    MODELS_TIMEOUT_MS,
  )) as { data?: { id?: string }[] };
  const configured = (cfg?.model ?? "").trim();
  if (configured && configured !== "default") return configured;
  const first = data?.data?.[0]?.id;
  if (!first) throw new Error("no models advertised");
  return first;
}

async function poll(): Promise<void> {
  try {
    const model = await resolveModel();
    status = { available: true, model };
  } catch {
    status = { available: false, model: null };
  }
}

/** Begin polling the endpoint's health/model list. Safe to call once at boot. */
export function startLlmPolling(config: LlmConfig): void {
  cfg = config;
  if (timer) clearInterval(timer);
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
  // Don't keep the process alive just for polling.
  timer.unref?.();
}

/** Latest cached endpoint health. Cheap; never throws. */
export function llmStatus(): LlmStatus {
  return status;
}

/** Extract a JSON object from a model reply that may be fenced or chatty. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let s = text.trim();
  // Strip ``` / ```json fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Fall back to the first {...} span.
  if (!s.startsWith("{")) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const PERMISSION_SYSTEM = [
  "You gate tool-call permission prompts for a developer's AI coding agent.",
  "Decide whether to auto-ALLOW the requested tool call.",
  "You will be given the tool name, its arguments (JSON), an optional workspace",
  "directory, and optional user instructions. If user instructions are present,",
  "ALLOW only when the call clearly satisfies them. With no instructions, ALLOW:",
  "(a) trivially safe, common, reversible read operations (e.g. reading files,",
  "`ls`, `git status`, `git diff`, `git log`); and (b) file edits/writes/creates",
  "whose target path is inside the workspace directory or a subfolder of it —",
  "this includes relative paths (which are within the workspace) and absolute",
  "paths under the workspace root. Writing to or editing files under `/tmp/` (or",
  "a subfolder of it) is also allowed by default. Do NOT allow anything destructive, networked,",
  "or state-changing when in doubt (e.g. `rm`, `curl | sh`, force pushes,",
  "arbitrary shell mutations, writes to files OUTSIDE the workspace (other than",
  "under `/tmp/`), credential",
  "access) — a path outside the workspace and not under `/tmp/`, or `..` escaping",
  "the workspace to somewhere other than `/tmp/`, is never allowed by default.",
  'Reply with ONLY JSON: {"allow": boolean, "reason": "<terse, <=12 words>"}.',
  "The reason is required and must be terse; it is shown when denying.",
].join(" ");

const QUESTIONS_SYSTEM = [
  "You answer multiple-choice questions posed by an AI coding agent on the",
  "developer's behalf, following any user instructions. Choose the single best",
  "provided option label for each question (exact label text). If genuinely",
  "unsure for a question, omit it.",
  'Reply with ONLY JSON: {"answers": {"<question text>": "<chosen label>"}}.',
].join(" ");

async function chat(
  system: string,
  user: string,
): Promise<{ content: string; reasoning?: string }> {
  const body = {
    model: status.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    stream: false,
  };
  const data = (await fetchJson(
    url("chat/completions"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    EVAL_TIMEOUT_MS,
  )) as {
    choices?: {
      message?: { content?: string; reasoning_content?: string };
    }[];
  };
  const msg = data?.choices?.[0]?.message;
  const reasoning = msg?.reasoning_content?.trim();
  return { content: msg?.content ?? "", reasoning: reasoning || undefined };
}

/** Render the outgoing prompt for the diagnostic trace shown in the UI. */
function tracePrompt(system: string, user: string): string {
  return `SYSTEM:\n${system}\n\nUSER:\n${user}`;
}

/** Judge a pending UI request. Returns a normalized decision, or
 * `{ available: false }` when the endpoint is unavailable or anything fails. */
export async function evaluate(
  req: LlmEvaluateRequest,
): Promise<LlmDecision> {
  if (!status.available || !status.model) return { available: false };
  const instructions = (req.instructions ?? "").trim();

  if (req.kind === "questions" && req.capabilities.questions) {
    const user = JSON.stringify({
      instructions: instructions || null,
      questions: (req.questions ?? []).map((q) => ({
        question: q.question,
        multiSelect: q.multiSelect ?? false,
        options: q.options.map((o) => o.label),
      })),
    });
    let reply: { content: string; reasoning?: string };
    try {
      reply = await chat(QUESTIONS_SYSTEM, user);
    } catch {
      return { available: false };
    }
    const trace = {
      prompt: tracePrompt(QUESTIONS_SYSTEM, user),
      thoughts: reply.reasoning,
      response: reply.content,
    };
    const out = parseJsonObject(reply.content);
    const raw = out?.answers;
    const answers: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string") answers[k] = v;
        else if (Array.isArray(v))
          answers[k] = v.filter((x) => typeof x === "string").join(", ");
      }
    }
    if (Object.keys(answers).length === 0)
      return { available: true, action: "none", trace };
    return { available: true, action: "answer", answers, trace };
  }

  if (
    (req.kind === "select" || req.kind === "confirm") &&
    req.capabilities.permissions
  ) {
    const user = JSON.stringify({
      instructions: instructions || null,
      workspace: req.workspace ?? null,
      tool: req.tool?.name ?? null,
      arguments: req.tool?.args ?? null,
    });
    let reply: { content: string; reasoning?: string };
    try {
      reply = await chat(PERMISSION_SYSTEM, user);
    } catch {
      return { available: false };
    }
    const trace = {
      prompt: tracePrompt(PERMISSION_SYSTEM, user),
      thoughts: reply.reasoning,
      response: reply.content,
    };
    const out = parseJsonObject(reply.content);
    if (!out || typeof out.allow !== "boolean")
      return { available: true, action: "none", trace };
    const reason = typeof out.reason === "string" ? out.reason : "";
    return {
      available: true,
      action: out.allow ? "allow" : "deny",
      reason,
      trace,
    };
  }

  return { available: true, action: "none" };
}
