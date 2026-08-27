// Continuity Mode: the AI-assistant capability that keeps the agent working.
// When server/turnRouter.ts decides a settled turn needs a reply rather than a
// pull request (the agent asked a question, offered options, announced more
// work), this writes the developer's next message from the transcript and sends
// it — optionally in a fresh session, when the task at hand is done.
//
// The send is deliberately NOT immediate. The composed text lands in the
// composer and a countdown ring sweeps around Send, sized to how long a human
// would take to read the agent's last message and type this reply. That window
// is the intervention point: typing, or `cancel-auto-prompt`, withdraws it. The
// BACKEND owns the timer (same split as server/assistant.ts), so the loop
// continues with no browser open.
//
// Harness-agnostic: it speaks only ChatAction/ChatState and the manager, like a
// browser would.
import { randomUUID } from "node:crypto";
import type { SessionManager } from "./sessions/manager.js";
import type {
  ChatUsage,
  ChatUsageWindow,
  ContinuityNewSession,
} from "../shared/protocol.js";
import type { RunContext } from "./turnRouter.js";
import { continuityPrompt, taskComplete } from "./llm.js";
import { buildSuggestionTranscript, messageText } from "./suggestions.js";

// How much conversation continuity reads. Far more than the suggestion chips
// need: it has to answer what the agent actually asked, and messageText already
// strips tool output down to `[used tool: X]`, so a wide window stays cheap.
const MAX_TRANSCRIPT_MESSAGES = 40;
const MAX_TRANSCRIPT_CHARS = 12_000;

// Emulate a human reading the agent's last message and typing a reply, so the
// window to intervene scales with how much there is to take in. Skim speed
// (~300 wpm) and typing speed (~95 wpm) in characters per second.
const READ_CHARS_PER_SEC = 25;
const TYPE_CHARS_PER_SEC = 8;
const MIN_DELAY_MS = 4_000;
const MAX_DELAY_MS = 30_000;

/** Grace window before an auto-prompt is sent, from the length of what there is
 * to read and what there is to type. Pure; exported for testing. */
export function autoPromptDelayMs(
  replyChars: number,
  promptChars: number,
): number {
  const seconds =
    Math.max(0, replyChars) / READ_CHARS_PER_SEC +
    Math.max(0, promptChars) / TYPE_CHARS_PER_SEC;
  return Math.min(
    MAX_DELAY_MS,
    Math.max(MIN_DELAY_MS, Math.round(seconds * 1000)),
  );
}

// --- Plan rate limits ------------------------------------------------------
// Continuity spends the developer's plan allowance unattended, so it stops well
// short of the ceiling: a loop that runs the 5-hour or weekly window to 100%
// leaves nothing for the human who comes back to it. Only the *unattended send*
// is withheld — the prompt is still written and parked in the composer.

/** Every checked window must be strictly below this to keep the loop running. */
const USAGE_LIMIT_PCT = 90;
/** How long to wait for the harness to answer a `usage` request. */
const USAGE_TIMEOUT_MS = 10_000;
/** The harness's key for the rolling session window. */
const SESSION_WINDOW = "five_hour";
/** Weekly windows are per-model (`seven_day`, `seven_day_opus`, …); all count. */
const isWeeklyWindow = (key: string) => key.startsWith("seven_day");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The session/weekly window standing in the way, or null to go ahead. Returns
 * the WORST offender so the note names the one that actually matters.
 *
 * Null usage means the harness doesn't report any (pi), and `available: false`
 * means plan limits don't apply at all (API-key, local or 3rd-party sessions) —
 * both proceed. Windows with an unknown utilization can't block. Pure; exported
 * for testing.
 */
export function usageBlocker(usage: ChatUsage | null): ChatUsageWindow | null {
  if (!usage?.available) return null;
  let worst: ChatUsageWindow | null = null;
  for (const w of usage.windows) {
    if (w.key !== SESSION_WINDOW && !isWeeklyWindow(w.key)) continue;
    if (w.utilization == null || w.utilization < USAGE_LIMIT_PCT) continue;
    if (!worst || w.utilization > worst.utilization!) worst = w;
  }
  return worst;
}

/** Harnesses that ignored a `usage` request (pi's translator no-ops it). Usage
 * support is a property of the harness, not the session, so one timeout is
 * enough — without this every iteration of a pi loop would idle for the whole
 * timeout waiting for an answer that never comes. */
const usageUnsupported = new Set<string>();

/**
 * Freshest usage snapshot for a session, or null when the harness reports none.
 *
 * Asks for a new one and waits briefly. A harness without usage support never
 * answers and has no prior snapshot → null → the caller proceeds. But once a
 * snapshot has *ever* arrived we know limits do apply, so a timed-out refresh
 * falls back to the stale value rather than waving the loop through blind.
 */
async function currentUsage(
  manager: SessionManager,
  sessionId: string,
): Promise<ChatUsage | null> {
  const harness = manager.sessionInfo(sessionId)?.harnessId;
  const known = manager.chatState(sessionId)?.usage ?? null;
  if (!known && harness && usageUnsupported.has(harness)) return null;

  manager.chatAction(sessionId, { type: "usage" });
  const before = known?.at ?? 0;
  const deadline = Date.now() + USAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(200);
    const now = manager.chatState(sessionId)?.usage;
    if (now && now.at > before) return now;
  }
  // Never answered and never has: remember, so the next lap doesn't wait again.
  if (!known && harness) usageUnsupported.add(harness);
  return known;
}

/** Should this continuation start from a clean context? `after-pr` fires only
 * once auto-PR has landed the work; `always` additionally clears whenever the
 * LLM judges the task finished. Pure; exported for testing. */
export function shouldStartNewSession(
  mode: ContinuityNewSession,
  input: { afterPr: boolean; taskComplete: boolean },
): boolean {
  if (mode === "never") return false;
  if (mode === "after-pr") return input.afterPr;
  return input.afterPr || input.taskComplete;
}

/** The agent's last spoken message — what the human would be reading. */
function lastReplyChars(manager: SessionManager, sessionId: string): number {
  const messages = manager.chatState(sessionId)?.messages ?? [];
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return last ? messageText(last).length : 0;
}

/**
 * Continue the work in `ctx.sessionId`: compose the next prompt and arm it.
 *
 * `afterPr` marks the call that follows a merged pull request (from
 * server/autopr.ts), which is what the `after-pr` new-session policy keys off.
 * Best-effort throughout — no endpoint, no usable prompt, or a harness that
 * won't start simply means the loop stops, with a note saying why.
 */
export async function runContinuity(
  ctx: RunContext,
  opts: { afterPr: boolean },
): Promise<void> {
  const { manager, sessionId, note } = ctx;
  const state = manager.chatState(sessionId);
  const settings = state?.assistant;
  if (!state || !settings?.continuity.enabled) return;
  const instructions = settings.continuity.instructions;

  const transcript = buildSuggestionTranscript(state, {
    maxMessages: MAX_TRANSCRIPT_MESSAGES,
    maxChars: MAX_TRANSCRIPT_CHARS,
  });
  if (!transcript.trim()) {
    note("abstain", "Nothing to continue from", "the transcript is empty");
    return;
  }

  // 1. Fresh session, or reply in place? Only `always` spends the extra call.
  let complete = false;
  if (settings.continuity.newSession === "always" && !opts.afterPr) {
    const verdict = await taskComplete(transcript, instructions);
    if (verdict) {
      complete = verdict.complete;
      note(
        "note",
        verdict.complete
          ? "Task looks complete — starting a fresh session"
          : "Task is still in progress — continuing here",
        verdict.reason || undefined,
        { trace: verdict.trace },
      );
    }
  }
  const fresh = shouldStartNewSession(settings.continuity.newSession, {
    afterPr: opts.afterPr,
    taskComplete: complete,
  });

  // 2. Write the developer's next message.
  const written = await continuityPrompt(transcript, { instructions, fresh });
  if (!written) {
    note(
      "abstain",
      "Couldn't write the next prompt",
      "the LLM endpoint is unavailable or returned nothing usable",
    );
    return;
  }

  // 3. Enough plan allowance left to SEND it? Deliberately checked *after* the
  //    write: composing costs a local inference call, which is near-free, and a
  //    held-back prompt is still worth having — it goes into the composer, where
  //    `ChatState.draft` persists it, so the developer can just press Send when
  //    the window resets. What we withhold is only the unattended send.
  //
  //    It also stays in the CURRENT session: no fresh-session hop, because
  //    killing the running session while pausing would be a destructive surprise
  //    (a `fresh: true` prompt is self-contained, so it reads fine here too).
  const blocked = usageBlocker(await currentUsage(manager, sessionId));
  if (blocked) {
    manager.chatAction(sessionId, { type: "set-draft", text: written.text });
    const resets = blocked.resetsAt
      ? `Resets at ${new Date(blocked.resetsAt).toLocaleString()}.`
      : null;
    note(
      "deny",
      `Wrote the next prompt but held it back — ${blocked.label} is at ` +
        `${Math.round(blocked.utilization!)}% of the plan limit`,
      "it's waiting in the composer; press Send to run it anyway",
      // No `trace` on purpose: attaching one makes the bubble lead with the
      // verdict word and drop this summary (see the AI-mode note rules).
      { detail: [resets, written.text].filter(Boolean).join("\n\n") },
    );
    return;
  }

  // 4. Pick the session it goes to. Start the replacement BEFORE stopping the
  //    old one, so the folder is never momentarily empty.
  let target = sessionId;
  if (fresh) {
    const info = manager.sessionInfo(sessionId);
    if (!info) return;
    try {
      target = manager.start(info.harnessId, { cwd: ctx.folder }).id;
    } catch (err) {
      note(
        "error",
        `Could not start a fresh ${info.harnessName} session`,
        (err as Error).message,
      );
      return;
    }
    // The whole checklist follows — continuity included — or the loop would end
    // at the hop. (`enabled` is re-derived server-side.)
    manager.chatAction(target, { type: "set-assistant", settings });
    note("note", "Started a fresh session", "continuing there");
    manager.stop(sessionId);
  }

  // 5. Arm it: text into the composer, countdown ring around Send, and a timer
  //    that does the sending. Reading time comes from the ORIGIN session (the
  //    message a human would be reading), even when the reply goes elsewhere.
  const delayMs = autoPromptDelayMs(
    lastReplyChars(manager, sessionId),
    written.text.length,
  );
  const prompt = {
    id: randomUUID(),
    text: written.text,
    delayMs,
    at: Date.now(),
  };
  manager.chatAction(target, { type: "set-draft", text: written.text });
  manager.postAutoPrompt(target, prompt);
  manager.postAssistantTrace(target, {
    requestId: prompt.id,
    kind: "continuity",
    prompt: written.trace.prompt,
    thoughts: written.trace.thoughts,
    response: written.trace.response,
    outcome: "note",
    reason: `sending in ${Math.round(delayMs / 1000)}s`,
    summary: `Wrote the next prompt: ${written.text}`,
    at: Date.now(),
  });
  arm(manager, target, prompt.id, written.text, delayMs);
}

// --- The send timer ---------------------------------------------------------
// Kept keyed by prompt id (a run may arm its prompt on a DIFFERENT session than
// the one it read), with a session→id index so a cancel can still find it after
// the reducer has already dropped `autoPrompt` from the state — which is exactly
// what happens on `user-message`.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const armedOn = new Map<string, string>();

function drop(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  for (const [session, armed] of armedOn)
    if (armed === id) armedOn.delete(session);
}

function arm(
  manager: SessionManager,
  sessionId: string,
  id: string,
  text: string,
  delayMs: number,
): void {
  const t = setTimeout(() => {
    drop(id);
    // A human may have taken over during the window: only fire if this exact
    // prompt is still armed and the session isn't already working.
    const state = manager.chatState(sessionId);
    if (state?.autoPrompt?.id !== id || state.busy) return;
    manager.chatAction(sessionId, { type: "prompt", text });
  }, delayMs);
  t.unref?.();
  timers.set(id, t);
  armedOn.set(sessionId, id);
}

/** Subscribe the auto-prompt canceller to the manager. Returns an unsubscribe.
 * Call once at boot (from index.ts), alongside the turn router. */
export function attachContinuity(manager: SessionManager): () => void {
  /** Whatever is armed on this session is no longer wanted. */
  const cancel = (sessionId: string) => {
    const id = armedOn.get(sessionId);
    if (!id) return;
    drop(id);
    manager.clearAutoPrompt(sessionId, id);
  };

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit(sessionId) {
      cancel(sessionId);
    },
    onRemoved(sessionId) {
      cancel(sessionId);
    },
    onChatEvent(sessionId, event) {
      // The user withdrew it (`cancel-auto-prompt`), or it just fired.
      if (event.type === "auto-prompt-cleared") {
        drop(event.id);
        return;
      }
      // A prompt landed first (ours or a human's), or the agent started working
      // again — either way the armed text is stale.
      if (event.type === "user-message" || (event.type === "busy" && event.busy))
        cancel(sessionId);
    },
  });
}
