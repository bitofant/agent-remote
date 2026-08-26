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
// Deliberations that aren't blocking anyone: the turn router and Continuity
// Mode run after a turn has already ended, so latency just widens the pause
// before the countdown starts. A local reasoning model regularly needs more
// than the 10s a *card* evaluation can afford to wait.
const BACKGROUND_TIMEOUT_MS = 60_000;

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

const SUGGESTION_SYSTEM = [
  "You predict the developer's likely NEXT message(s) to their AI coding agent,",
  "given the conversation so far. Return 1 to 3 concise, natural follow-up",
  "prompts the developer would plausibly send next (e.g. a logical next step, a",
  "test, a refinement, or a review request). Write each in the developer's",
  "voice, imperative, one sentence, no preamble or quotes. Return MORE THAN ONE",
  "only when the options are SUBSTANTIALLY DISTINCT directions — never trivial",
  "rewordings of the same idea; prefer a single strong suggestion over redundant",
  "ones. If no sensible follow-up exists, return an empty array. Order best",
  "first.",
  'Reply with ONLY JSON: {"suggestions": ["<next prompt>", ...]}.',
].join(" ");

const BRANCH_SYSTEM = [
  "You name git branches for a developer's AI coding agent. Given a diff,",
  "produce a short kebab-case slug describing the change: 2 to 4 words,",
  "lowercase, ASCII letters/digits/dashes ONLY. No username or team prefix, no",
  "slashes, no ticket ids, no quotes, no explanation.",
  'Reply with ONLY JSON: {"branch": "<slug>"}.',
].join(" ");

// Adapted from `suggest_commit_message` in ~/scripts/git-helper.sh so the web
// flow writes messages in the same house style as the user's own CLI helper.
const COMMIT_SYSTEM = [
  "You are a commit message generator.",
  "OUTPUT FORMAT: Single line only, max 72 characters, imperative mood.",
  "CONTENT: Describe WHAT changed. Be concise and technical.",
  "GOOD EXAMPLES: add config to disable in prod; refactor exception handling;",
  "fix rate limiting; add CHIRP endpoint, refactor error handling.",
  "No trailing period, no scope prefix, no body, no quotes.",
  'Reply with ONLY JSON: {"message": "<commit message>"}.',
].join(" ");

const PR_SUPERVISOR_SYSTEM = [
  "You supervise a headless AI coding agent that was asked to open a GitHub pull",
  "request. You are shown the conversation so far and must either reply to the",
  "agent on the developer's behalf or declare the job done.",
  "Declare done ONLY once the transcript shows the pull request was actually",
  "created — normally a GitHub PR URL like",
  "https://github.com/<owner>/<repo>/pull/<number>. Then return its number and",
  "URL.",
  "Otherwise return a short reply that moves the agent forward: review a drafted",
  "description it is asking about, answer its question, or tell it to proceed and",
  "create the PR. Never ask the developer anything; never invent a PR number.",
  "DESCRIPTION STANDARD — when the agent shows you a drafted PR description, do",
  "not rubber-stamp it. Request concrete changes (quoting what to cut) if it has",
  "more bullet points than the change warrants (2-5, at the low end for a small",
  "PR), if any bullet runs to 20 words or more, or if it states the obvious or",
  "spells out implementation details a reader would get from the diff. Only",
  "approve once it is terse and every line earns its place.",
  "If the agent reports a blocking error it cannot recover from, set done to true",
  'with a null number and explain in "reply".',
  'Reply with ONLY JSON: {"done": boolean, "prNumber": number|null,',
  '"prUrl": string|null, "reply": "<message to the agent, or the reason>"}.',
].join(" ");

const TURN_ROUTE_SYSTEM = [
  "You route the turn that just ended in a developer's AI coding agent session,",
  "deciding what should happen next while the developer is away.",
  "You are shown the developer's last request and the agent's FINAL message of",
  "the turn that just ended. A turn is FINISHED when the agent reports the",
  "requested change as complete and working. It is UNFINISHED whenever it was",
  "interrupted or stopped early, it hit an error or a failing test it did not",
  "resolve, it is asking the developer a question or waiting for a decision, or",
  "it announced further work it has not done yet.",
  "Judge only how the turn ended — not whether the change is a good idea, and",
  "not whether files were modified (that is checked separately).",
  "Choose ONE route:",
  '"auto-pr" — the turn is FINISHED: commit the work and open a pull request.',
  '"continuity" — a reply from the developer would move things along. That covers',
  "an UNFINISHED turn (the agent asked a question, offered options to choose",
  "between, reported a blocker it could work around, or announced further work",
  "it has not done yet) AND a FINISHED turn when auto-pr is not available — then",
  "the reply simply starts the next piece of work.",
  '"none" — neither fits: nothing of substance happened, or the situation needs',
  "a human (a destructive decision, repeated failures, an explicit request to",
  "stop).",
  "The user message lists the routes ACTUALLY AVAILABLE — never choose one that",
  'is not listed; if none of them fits, answer "none". Do not answer "none"',
  "merely because the work is done: that is what the routes are for.",
  'Reply with ONLY JSON: {"route": "auto-pr"|"continuity"|"none",',
  '"reason": "<terse, <=12 words>"}.',
  "The reason is required and must be terse; it is shown to the developer.",
].join(" ");

const TASK_COMPLETE_SYSTEM = [
  "You decide whether a developer's AI coding agent session has finished the",
  "task it was working on, so its context can be cleared and the next piece of",
  "work started in a fresh session. You are shown the recent conversation.",
  "Answer true only when the work under discussion is done and nothing in the",
  "transcript is still open — no unanswered question, no failing step, no",
  "announced-but-undone follow-up. When in doubt answer false: keeping the",
  "context costs nothing, losing it mid-task is expensive.",
  'Reply with ONLY JSON: {"complete": boolean, "reason": "<terse, <=12 words>"}.',
].join(" ");

// Shared base so the continue/fresh variants can't drift apart.
const CONTINUITY_BASE = [
  "You write the developer's NEXT message to their AI coding agent, in their",
  "voice: imperative, concrete, no preamble, no quotes, no greeting, no sign-off.",
  "Write only the message itself — the agent reads it as if the developer typed",
  "it. Follow any user instructions exactly; they describe how the developer",
  "wants the work driven.",
];
const CONTINUITY_JSON = 'Reply with ONLY JSON: {"prompt": "<message>"}.';

const CONTINUITY_SYSTEM = [
  ...CONTINUITY_BASE,
  "You are shown the conversation so far. Answer whatever the agent last asked,",
  "decide whatever it asked you to decide, or tell it the next step. Never ask",
  "the agent what you should do — you are the one deciding.",
  CONTINUITY_JSON,
].join(" ");

const CONTINUITY_FRESH_SYSTEM = [
  ...CONTINUITY_BASE,
  "The conversation you are shown is FINISHED work, and the agent reading your",
  "message is a NEW session with no memory of it. So write a self-contained",
  "message that starts the next piece of work: say what to do, not what was",
  "just done, and don't refer back to the old conversation.",
  CONTINUITY_JSON,
].join(" ");

/** Append the user's free-text auto-PR instructions to a generator prompt. */
function withInstructions(base: string, instructions?: string): string {
  const extra = (instructions ?? "").trim();
  return extra ? `${base} Additional user instructions: ${extra}` : base;
}

// Shared base so the two strictness variants can't drift apart.
const QUESTIONS_BASE = [
  "You answer multiple-choice questions posed by an AI coding agent on the",
  "developer's behalf, following any user instructions. Choose the single best",
  "provided option label for each question (exact label text).",
];
const QUESTIONS_JSON =
  'Reply with ONLY JSON: {"answers": {"<question text>": "<chosen label>"}}.';

const QUESTIONS_SYSTEM = [
  ...QUESTIONS_BASE,
  "If genuinely unsure for a question, omit it.",
  QUESTIONS_JSON,
].join(" ");

// Stricter variant, for the "only answer if sure" setting.
const QUESTIONS_SURE_SYSTEM = [
  ...QUESTIONS_BASE,
  "Answer ONLY when the correct option is unambiguous from the instructions or",
  "the question itself. On ANY doubt, omit that question and leave it for the",
  "developer — abstaining is strongly preferred over guessing.",
  QUESTIONS_JSON,
].join(" ");

async function chat(
  system: string,
  user: string,
  timeoutMs = EVAL_TIMEOUT_MS,
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
    timeoutMs,
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

/** Ask for one JSON field, best-effort. Returns null on an unavailable
 * endpoint, any transport error, or a reply that doesn't parse. Shared by the
 * auto-PR generators below, which all want "a string or nothing". */
async function askJson(
  system: string,
  user: string,
): Promise<Record<string, unknown> | null> {
  if (!status.available || !status.model || !user.trim()) return null;
  try {
    const reply = await chat(system, user);
    return parseJsonObject(reply.content);
  } catch {
    return null;
  }
}

/** Propose a kebab-case branch slug for a diff. Best-effort: null when the
 * endpoint is down or the model declines — the caller falls back to a
 * deterministic name. The result still goes through `sanitizeBranchName`. */
export async function suggestBranchName(
  diff: string,
  instructions?: string,
): Promise<string | null> {
  const out = await askJson(
    withInstructions(BRANCH_SYSTEM, instructions),
    diff,
  );
  const branch = out?.branch;
  return typeof branch === "string" && branch.trim() ? branch : null;
}

/** Propose a one-line commit subject for a staged diff. `rejected` carries
 * previous attempts that failed validation so a retry doesn't repeat them.
 * Best-effort: null when unavailable. Still validated by
 * `sanitizeCommitMessage`. */
export async function suggestCommitMessage(
  diff: string,
  instructions?: string,
  rejected: string[] = [],
): Promise<string | null> {
  const user = rejected.length
    ? `${diff}\n\nThese earlier attempts were REJECTED (not a single line of at most 72 characters):\n${rejected
        .map((r) => `- ${r}`)
        .join("\n")}\nGenerate a shorter, single-line message.`
    : diff;
  const out = await askJson(
    withInstructions(COMMIT_SYSTEM, instructions),
    user,
  );
  const message = out?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

/** One supervision verdict over the headless PR session's transcript. */
export interface PrSupervision {
  done: boolean;
  prNumber: number | null;
  prUrl: string | null;
  /** Message to send back to the agent, or (when done) the closing reason. */
  reply: string;
}

/** Read the PR agent's transcript and decide whether to answer it or stop.
 * Best-effort: null when the endpoint is unavailable or the reply is unusable,
 * which the caller treats as "can't supervise" and abandons the run to a human. */
export async function supervisePr(
  transcript: string,
  instructions?: string,
): Promise<PrSupervision | null> {
  const out = await askJson(
    withInstructions(PR_SUPERVISOR_SYSTEM, instructions),
    transcript,
  );
  if (!out) return null;
  const reply = typeof out.reply === "string" ? out.reply.trim() : "";
  const done = out.done === true;
  // A reply is the only way to advance an unfinished run; without one there's
  // nothing to send, so treat it as unusable.
  if (!done && !reply) return null;
  const num = typeof out.prNumber === "number" && Number.isFinite(out.prNumber)
    ? Math.trunc(out.prNumber)
    : null;
  const url = typeof out.prUrl === "string" && out.prUrl.trim() ? out.prUrl.trim() : null;
  return { done, prNumber: num, prUrl: url, reply };
}

/** The deliberation record every LLM verdict carries, for the AI-mode bubble. */
export interface LlmTrace {
  prompt: string;
  thoughts?: string;
  response: string;
}

/** Ask for a JSON verdict AND keep the deliberation, for calls whose reasoning
 * is surfaced in the transcript. `askJson`'s trace-less sibling. Nothing is
 * waiting on these, so they get the longer background budget. */
async function askTraced(
  system: string,
  user: string,
): Promise<{ out: Record<string, unknown>; trace: LlmTrace } | null> {
  if (!status.available || !status.model || !user.trim()) return null;
  let reply: { content: string; reasoning?: string };
  try {
    reply = await chat(system, user, BACKGROUND_TIMEOUT_MS);
  } catch {
    return null;
  }
  const out = parseJsonObject(reply.content);
  if (!out) return null;
  return {
    out,
    trace: {
      prompt: tracePrompt(system, user),
      thoughts: reply.reasoning,
      response: reply.content,
    },
  };
}

/** Which capability handles the turn that just settled. */
export interface TurnRoute {
  route: "auto-pr" | "continuity" | "none";
  reason: string;
  trace: LlmTrace;
}

/** Route a settled turn between auto-PR and continuity. Only the routes the
 * session actually has enabled are offered, so a disabled one is never picked.
 * Best-effort: null when the endpoint is unavailable or the reply is unusable —
 * the caller decides what an unroutable turn means. */
export async function routeTurn(
  digest: string,
  opts: {
    canPr: boolean;
    canContinue: boolean;
    prInstructions?: string;
    continuityInstructions?: string;
  },
): Promise<TurnRoute | null> {
  const available: string[] = [];
  if (opts.canPr) available.push("auto-pr");
  if (opts.canContinue) available.push("continuity");
  available.push("none");
  const user = [
    `Routes available: ${available.join(", ")}.`,
    opts.canPr && opts.prInstructions?.trim()
      ? `Pull-request instructions from the developer: ${opts.prInstructions.trim()}`
      : "",
    opts.canContinue && opts.continuityInstructions?.trim()
      ? `Instructions from the developer for how to keep the work going: ${opts.continuityInstructions.trim()}`
      : "",
    "",
    digest,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await askTraced(TURN_ROUTE_SYSTEM, user);
  if (!result) return null;
  const raw = result.out.route;
  const route =
    raw === "auto-pr" || raw === "continuity" || raw === "none" ? raw : null;
  if (!route) return null;
  // Never honour a route the session didn't offer.
  const clamped =
    (route === "auto-pr" && !opts.canPr) ||
    (route === "continuity" && !opts.canContinue)
      ? "none"
      : route;
  return {
    route: clamped,
    reason:
      typeof result.out.reason === "string" ? result.out.reason.trim() : "",
    trace: result.trace,
  };
}

/** Is the session's task done, so its context can be cleared and the next piece
 * of work started fresh? Only asked in `newSession: "always"`. Best-effort. */
export async function taskComplete(
  transcript: string,
  instructions?: string,
): Promise<{ complete: boolean; reason: string; trace: LlmTrace } | null> {
  const result = await askTraced(
    withInstructions(TASK_COMPLETE_SYSTEM, instructions),
    transcript,
  );
  if (!result || typeof result.out.complete !== "boolean") return null;
  return {
    complete: result.out.complete,
    reason:
      typeof result.out.reason === "string" ? result.out.reason.trim() : "",
    trace: result.trace,
  };
}

/** Write the developer's next message to the agent from the conversation so
 * far. `fresh` means it will be read by a brand-new session with no memory of
 * that conversation, so the message must stand alone. Best-effort: null when
 * the endpoint is unavailable or nothing usable came back — continuity then
 * simply doesn't fire (it cannot run without the endpoint). */
export async function continuityPrompt(
  transcript: string,
  opts: { instructions?: string; fresh: boolean },
): Promise<{ text: string; trace: LlmTrace } | null> {
  const result = await askTraced(
    withInstructions(
      opts.fresh ? CONTINUITY_FRESH_SYSTEM : CONTINUITY_SYSTEM,
      opts.instructions,
    ),
    transcript,
  );
  if (!result) return null;
  const text =
    typeof result.out.prompt === "string" ? result.out.prompt.trim() : "";
  return text ? { text, trace: result.trace } : null;
}

/** Max distinct suggestions surfaced to the composer. */
const MAX_SUGGESTIONS = 3;

/** Predict 1–3 substantially-distinct next user prompts from a rendered
 * transcript, for the composer's suggestion chips. Best-effort: returns `[]`
 * when the endpoint is unavailable, anything fails, or the model declines.
 * Harnesses that emit their own suggestions (e.g. Claude) never reach here. */
export async function suggestNextPrompt(
  transcript: string,
): Promise<string[]> {
  if (!status.available || !status.model || !transcript.trim()) return [];
  let reply: { content: string; reasoning?: string };
  try {
    reply = await chat(SUGGESTION_SYSTEM, transcript);
  } catch {
    return [];
  }
  const out = parseJsonObject(reply.content);
  const raw = Array.isArray(out?.suggestions) ? out.suggestions : [];
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    // Dedupe case-insensitively so a chatty model can't emit near-identical chips.
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(text);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return suggestions;
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
    const system = req.onlyIfSure ? QUESTIONS_SURE_SYSTEM : QUESTIONS_SYSTEM;
    let reply: { content: string; reasoning?: string };
    try {
      reply = await chat(system, user);
    } catch {
      return { available: false };
    }
    const trace = {
      prompt: tracePrompt(system, user),
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
