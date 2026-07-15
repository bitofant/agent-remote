// Server-side chat render log (diagnostics): per finalized message, persists the
// original ChatMessage and its rendered form (shared/render.ts's renderMessage)
// so we can review how each message type is displayed.

import type { ChatState } from "../shared/protocol.js";
import { renderMessage } from "../shared/render.js";
import { logChatRender } from "./db.js";

// Per-session signature of each already-logged message, so we only write on
// change (late tool results refresh; unchanged skipped). Cleared on session end.
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
