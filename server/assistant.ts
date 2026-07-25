// Backend AI-assistant mode. When a chat session has assistant mode enabled
// (ChatState.assistant, toggled from the UI via `set-assistant`), the SERVER is
// the sole decider for its permission/question cards: it evaluates each via the
// optional LLM, BROADCASTS the verdict (so every client renders the same
// countdown ring it always has), and — after the grace window — APPLIES it.
// Because the decider lives here (driven from index.ts), not in the frontend,
// it keeps running with no browser open, so an unattended session doesn't stall.
//
// A connected user still intervenes exactly as before: interacting with the card
// sends `cancel-assistant` (→ an `assistant-decision-cleared` event this module
// observes) which cancels the pending auto-response; answering the card manually
// resolves it (→ `ui-request-done`) and likewise cancels. `deny` never auto-acts
// — it's surfaced for a human to confirm, matching the prior UX.
//
// Harness-agnostic: it only reads ChatState and drives the manager, like a UI.
import type { SessionManager } from "./sessions/manager.js";
import type {
  AssistantDecision,
  AssistantTrace,
  ChatUiRequest,
} from "../shared/protocol.js";
import { evaluate, llmStatus } from "./llm.js";

// Same grace-delay curve the UI used: 2s (trivial card) … 10s (a screenful),
// scaled by how much there is to review — the window in which a connected human
// can still take over before the assistant applies its verdict.
const AUTO_ACTION_REF_CHARS = 681;

function autoActionDelayMs(chars: number): number {
  const ratio = Math.min(1, chars / AUTO_ACTION_REF_CHARS);
  return Math.round((2 + 8 * ratio) * 1000);
}

function requestContentChars(req: ChatUiRequest): number {
  if (req.kind === "questions") return JSON.stringify(req.questions ?? []).length;
  const toolChars = req.tool ? JSON.stringify(req.tool).length : 0;
  return toolChars || (req.message ?? req.title ?? "").length;
}

/** Is this request still awaiting an answer? (A client may have answered it, or
 * cancelled the auto-action, meanwhile.) */
function stillPending(
  manager: SessionManager,
  sessionId: string,
  requestId: string,
): boolean {
  return !!manager
    .chatState(sessionId)
    ?.pendingRequests.some((r) => r.id === requestId);
}

/** Apply an auto-acting verdict to the session, exactly as a browser would. */
function apply(
  manager: SessionManager,
  sessionId: string,
  req: ChatUiRequest,
  decision: AssistantDecision,
): void {
  if (decision.action === "confirm") {
    manager.chatAction(sessionId, {
      type: "ui-response",
      requestId: req.id,
      confirmed: true,
    });
  } else if (decision.action === "accept" && decision.value != null) {
    manager.chatAction(sessionId, {
      type: "ui-response",
      requestId: req.id,
      value: decision.value,
    });
  } else if (decision.action === "answer" && decision.answers) {
    manager.chatAction(sessionId, {
      type: "ui-response",
      requestId: req.id,
      answers: decision.answers,
    });
  }
}

/** Subscribe the backend auto-decider to the manager. Returns an unsubscribe.
 * Call once at boot (from index.ts). */
export function attachAssistant(manager: SessionManager): () => void {
  // Grace timers per pending request; `handled` dedupes evaluation per id. A
  // request is dropped from both when it resolves or its verdict is cleared.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const handled = new Set<string>();

  const drop = (requestId: string) => {
    const t = timers.get(requestId);
    if (t) clearTimeout(t);
    timers.delete(requestId);
    handled.delete(requestId);
  };

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit() {},
    onChatEvent(sessionId, event) {
      // A resolved request, or a user-cancelled verdict, cancels our timer.
      if (
        event.type === "ui-request-done" ||
        event.type === "assistant-decision-cleared"
      ) {
        drop(event.requestId);
        return;
      }
      if (event.type !== "ui-request") return;
      const req = event.request;
      if (handled.has(req.id)) return;

      const settings = manager.chatState(sessionId)?.assistant;
      if (!settings?.enabled || !llmStatus().available) return;

      const isPermission = req.kind === "select" || req.kind === "confirm";
      const isQuestions = req.kind === "questions";
      // Plan acceptance stays human-driven (see CLAUDE.md); `input` too.
      const want =
        (isPermission && settings.canAcceptPermissions) ||
        (isQuestions && settings.canAnswerQuestions);
      if (!want) return;

      handled.add(req.id);
      const delayMs = autoActionDelayMs(requestContentChars(req));

      void evaluate({
        kind: req.kind as "confirm" | "select" | "questions",
        tool: req.tool,
        options: req.options,
        questions: req.questions,
        instructions: settings.instructions,
        workspace: manager.sessionFolder(sessionId),
        capabilities: {
          permissions: settings.canAcceptPermissions,
          questions: settings.canAnswerQuestions,
        },
      })
        .then((verdict) => {
          // Whenever the LLM was actually queried, surface what it saw and said
          // as a collapsible AI-mode bubble — visible with or without a browser.
          if (verdict.trace) {
            manager.postAssistantTrace(sessionId, {
              requestId: req.id,
              kind: req.kind as "confirm" | "select" | "questions",
              prompt: verdict.trace.prompt,
              thoughts: verdict.trace.thoughts,
              response: verdict.trace.response,
              outcome: outcomeOf(verdict),
              reason: verdict.reason,
              summary: summarizeVerdict(verdict),
              at: Date.now(),
            });
          }
          if (!verdict.available || !verdict.action || verdict.action === "none") {
            handled.delete(req.id);
            return;
          }
          // Gone already? (a client answered or cancelled during evaluation)
          if (!stillPending(manager, sessionId, req.id) || !handled.has(req.id)) {
            drop(req.id);
            return;
          }

          const decision = toDecision(req, verdict, delayMs);
          if (!decision) {
            handled.delete(req.id);
            return;
          }
          // Broadcast so every client shows the countdown (or the deny hint).
          manager.postAssistantDecision(sessionId, decision);

          // `deny` never auto-acts — a human confirms it (matches prior UX).
          if (decision.action === "deny") {
            handled.delete(req.id);
            return;
          }
          const t = setTimeout(() => {
            timers.delete(req.id);
            handled.delete(req.id);
            // A connected human may have taken over during the grace window.
            if (stillPending(manager, sessionId, req.id))
              apply(manager, sessionId, req, decision);
          }, delayMs);
          t.unref?.();
          timers.set(req.id, t);
        })
        .catch(() => {
          handled.delete(req.id);
        });
    },
  });
}

/** Structured outcome for the trace bubble's colored verdict word. */
function outcomeOf(verdict: {
  available: boolean;
  action?: string;
}): AssistantTrace["outcome"] {
  if (!verdict.available) return "error";
  switch (verdict.action) {
    case "allow":
      return "allow";
    case "deny":
      return "deny";
    case "answer":
      return "answer";
    default:
      return "abstain";
  }
}

/** One-line outcome summary for the AI-mode trace bubble header. */
function summarizeVerdict(verdict: {
  available: boolean;
  action?: string;
  reason?: string;
  answers?: Record<string, string>;
}): string {
  if (!verdict.available) return "No response from endpoint";
  switch (verdict.action) {
    case "allow":
      return verdict.reason ? `Allowed — ${verdict.reason}` : "Allowed";
    case "deny":
      return verdict.reason ? `Denied — ${verdict.reason}` : "Denied";
    case "answer":
      return "Answered";
    default:
      return "Abstained (left for you)";
  }
}

/** Map the LLM verdict to a broadcastable decision, or null if inapplicable. */
function toDecision(
  req: ChatUiRequest,
  verdict: { action?: string; reason?: string; answers?: Record<string, string> },
  delayMs: number,
): AssistantDecision | null {
  if (verdict.action === "allow") {
    if (req.kind === "confirm")
      return { requestId: req.id, action: "confirm", delayMs };
    // First option that isn't a rejection is the "accept" choice.
    const accept = (req.options ?? []).find(
      (o) => o !== "Deny" && o !== "Cancel",
    );
    if (!accept) return null;
    return { requestId: req.id, action: "accept", value: accept, delayMs };
  }
  if (verdict.action === "deny")
    return { requestId: req.id, action: "deny", reason: verdict.reason ?? "", delayMs };
  if (verdict.action === "answer" && verdict.answers)
    return {
      requestId: req.id,
      action: "answer",
      answers: verdict.answers,
      delayMs,
    };
  return null;
}
