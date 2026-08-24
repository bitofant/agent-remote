// Harness-agnostic auto-PR capability of AI-assistant mode. When a session
// enables it, this server-global subscriber runs the PR flow whenever the
// session's turn settles (the same busy:false hook suggestions.ts uses), or on
// demand from the dialog's "Run now" (the `run-auto-pr` action, observed via
// SessionListener.onChatAction). Like assistant.ts it lives in the backend and
// is driven from index.ts, so it runs with no browser open.
//
// STUB: the flow itself is not implemented yet — it posts an AI-mode bubble into
// the transcript and returns. The real work (branch/commit/push/`gh pr create`,
// optional auto-merge) lands behind this same entry point.
import type { SessionManager } from "./sessions/manager.js";
import type { ChatState } from "../shared/protocol.js";

/** Whether a settled session should auto-open a PR: the capability is on, the
 * session is idle with no pending card or queued prompt, and a real exchange
 * happened. Exported for testing. */
export function shouldRunAutoPr(state: ChatState): boolean {
  if (!state.assistant.autoPr.enabled) return false;
  if (state.busy) return false;
  if (state.pendingRequests.length > 0) return false;
  if (state.queued.length > 0) return false;
  return (
    state.messages.some((m) => m.role === "user") &&
    state.messages.some((m) => m.role === "assistant")
  );
}

/** Subscribe the backend auto-PR runner to the manager. Returns an unsubscribe.
 * Call once at boot (from index.ts). */
export function attachAutoPr(manager: SessionManager): () => void {
  // Single-flight per session: a turn settling and a "Run now" can land
  // together, and opening two PRs for one turn isn't recoverable.
  const running = new Set<string>();

  const run = (sessionId: string) => {
    if (running.has(sessionId)) return;
    running.add(sessionId);
    try {
      // STUB: the whole flow. Surfaced as an AI-mode bubble, which the reducer
      // anchors to the turn that triggered it. No prompt/response — no LLM was
      // consulted — so the bubble renders as a non-expandable one-liner.
      manager.postAssistantTrace(sessionId, {
        requestId: `auto-pr:${Date.now()}`,
        kind: "auto-pr",
        outcome: "note",
        // Renders as the verdict word ("Auto PR") + this: "Auto PR running…".
        reason: "running…",
        summary: "Running auto PR",
        at: Date.now(),
      });
    } finally {
      running.delete(sessionId);
    }
  };

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit(sessionId) {
      running.delete(sessionId);
    },
    onRemoved(sessionId) {
      running.delete(sessionId);
    },
    onChatAction(sessionId, action) {
      // On demand — deliberately ignores the checkbox.
      if (action.type === "run-auto-pr") run(sessionId);
    },
    onChatEvent(sessionId, event) {
      if (event.type !== "busy" || event.busy) return;
      const state = manager.chatState(sessionId);
      if (state && shouldRunAutoPr(state)) run(sessionId);
    },
  });
}
