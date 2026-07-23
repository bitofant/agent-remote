// Live end-to-end test that resuming a chat session restores the PRIOR
// conversation rather than starting fresh (see the resume notes in CLAUDE.md).
// Runs against claude-local (Claude SDK → local vLLM), so zero Claude tokens.
//
// Two independent proofs it isn't a fresh session:
//   (a) Structural — on resume the adapter's replayHistory() rebuilds the prior
//       turn from the on-disk JSONL (the SDK does NOT stream it back), so the
//       original prompt reappears in the transcript ahead of the follow-up.
//   (b) Semantic — resume also restores the MODEL's context, so it can answer a
//       follow-up about a codeword it was only told in the first session.
//
// Excluded from the fast gate; run via `npm run test:e2e`. Self-skips unless
// claude-local is enabled and its endpoint answers. Can flake if the small
// local model won't recall the codeword — inherent to a live model call.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import { claudeLocal, endpointUp, ChatDriver, settle } from "./claude-local.testkit.js";

const CODEWORD = "PLATYPUS";
const DIR = mkdtempSync(join(tmpdir(), "agent-remote-resume-"));

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

// Join a message's text parts.
function messageText(parts: { type: string; text?: string }[]): string {
  return parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

describe.skipIf(!local || !up)("claude-local: resume a chat session", () => {
  it("resumes with prior context instead of starting fresh", async () => {
    // --- Session 1: plant a fact the model can only know from this turn. ---
    const s1 = new ChatDriver(local!.create(DIR)).start();
    await s1.prompt(`Remember this codeword: ${CODEWORD}. Reply with just: OK`);
    const key = s1.resumeKey;
    expect(key, "session 1 never reported a resume key").toBeTruthy();
    s1.close();

    // Let the CLI flush the session transcript to disk before resuming it.
    await settle(1000);

    // --- Session 2: resume by key. Give replayHistory time to rebuild the
    // prior transcript from disk first, so message order is deterministic. ---
    const s2 = new ChatDriver(local!.create(DIR, key)).start();
    await settle(1500);
    const replayedEvents = s2.events.length;
    expect(replayedEvents, "resume replayed no history (started fresh?)").toBeGreaterThan(0);

    // Then ask it to recall the fact from the restored context.
    await s2.prompt(
      "What was the codeword I asked you to remember? Reply with just the codeword.",
    );
    s2.close();

    // Fold the resumed session's events through the shared reducer (as the
    // server/client do) to reconstruct the transcript.
    let state = emptyChatState();
    for (const e of s2.events) state = applyChatEvent(state, e);

    // (a) Structural: the rebuilt transcript contains the original prompt (with
    // the codeword) as well as the follow-up — i.e. the prior turn was restored.
    const userTexts = state.messages
      .filter((m) => m.role === "user")
      .map((m) => messageText(m.parts));
    expect(userTexts.length, "resumed transcript is missing the prior turn").toBeGreaterThanOrEqual(2);
    expect(
      userTexts.some((t) => t.includes(CODEWORD)),
      "the original codeword prompt was not replayed",
    ).toBe(true);

    // (b) Semantic: the model recalls the codeword from the restored context —
    // impossible for a fresh session that never saw it.
    const lastAssistant = [...state.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const reply = messageText(lastAssistant?.parts ?? []);
    expect(
      reply.toUpperCase(),
      "resumed model did not recall the codeword",
    ).toContain(CODEWORD);
  }, 170_000);
});
