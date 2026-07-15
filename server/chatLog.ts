// Server-side chat render log. Watches each chat session's normalized ChatState
// and persists, per finalized message, both the original data (the ChatMessage)
// and what the UI renders (via shared/render.ts's renderMessage) so we can
// review and improve how each message type is displayed. Harness-agnostic: it
// sees only the shared chat schema, same as the browser.

import type { ChatState } from "../shared/protocol.js";
import { renderMessage } from "../shared/render.js";
import { logChatRender } from "./db.js";

// Per-session signature of every message we've already logged, so we only write
// when a message's content actually changes (late tool results refresh the row;
// unchanged messages are skipped). Cleared when the session goes away.
const logged = new Map<string, Map<string, string>>();

/** Persist any new-or-changed finalized messages of a chat session. Cheap to
 * call on every (non-streaming) chat event: unchanged messages are skipped via
 * a JSON signature before any markdown is rendered. */
export function recordChatRenders(
  sessionId: string,
  state: ChatState,
  meta: { harnessId?: string; cwd?: string } = {},
): void {
  let seen = logged.get(sessionId);
  if (!seen) logged.set(sessionId, (seen = new Map()));
  for (const message of state.messages) {
    const original = JSON.stringify(message);
    if (seen.get(message.id) === original) continue;
    seen.set(message.id, original);
    logChatRender({
      sessionId,
      messageId: message.id,
      role: message.role,
      harnessId: meta.harnessId ?? null,
      cwd: meta.cwd ?? null,
      original,
      rendered: JSON.stringify(renderMessage(message)),
    });
  }
}

/** Drop a finished session's dedupe state. */
export function forgetChatRenders(sessionId: string): void {
  logged.delete(sessionId);
}
