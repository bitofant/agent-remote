// Live end-to-end test that resuming a pi chat session restores the PRIOR
// conversation rather than starting fresh (see the resume notes in CLAUDE.md).
// Drives the real `pi --mode rpc` subprocess through the production
// SessionManager, with pi pointed at a local vLLM endpoint (zero tokens).
//
// Two independent proofs it isn't a fresh session:
//   (a) Structural — pi's RPC stream does NOT replay history on `--session-id`
//       reload, so the pi adapter rebuilds the prior turn from its on-disk
//       session JSONL (replayHistory). The original prompt reappears in the
//       transcript ahead of the follow-up.
//   (b) Semantic — resume also restores the MODEL's context, so it can answer a
//       follow-up about a codeword it was only told in the first session.
//
// Excluded from the fast gate; run via `npm run test:e2e`. Self-skips unless pi
// is enabled and its endpoint answers. Can flake if the small local model won't
// recall the codeword — inherent to a live model call.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import { piLocal, endpointUp, settle } from "./pi-local.testkit.js";

const CODEWORD = "PLATYPUS";
const DIR = mkdtempSync(join(tmpdir(), "agent-remote-pi-resume-"));

const local = piLocal();
const up = await endpointUp(local?.baseUrl);

// Join a message's text parts.
function messageText(parts: { type: string; text?: string }[]): string {
  return parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

// Join ALL of a message's textual parts (reasoning included). The small local
// model often interleaves its final answer ("PLAT codeword.YPUS"), so recall is
// asserted across the whole reply — the reasoning ("the codeword was PLATYPUS")
// is itself proof the restored context was read.
function messageAllText(parts: { type: string; text?: string }[]): string {
  return parts
    .map((p) => (p.type === "text" || p.type === "thinking" ? (p.text ?? "") : ""))
    .join(" ");
}

describe.skipIf(!local || !up)("pi: resume a chat session", () => {
  it("resumes with prior context instead of starting fresh", async () => {
    // --- Session 1: plant a fact the model can only know from this turn. ---
    const s1 = local!.create(DIR);
    await s1.prompt(`Remember this codeword: ${CODEWORD}. Reply with just: OK`);
    const key = s1.resumeKey;
    expect(key, "session 1 never reported a resume key").toBeTruthy();
    // The key must be reported only AFTER the session is registered, or the DB
    // persister (index.ts) can't resolve its info/folder and drops it — which is
    // what keeps `/resume` from ever appearing for pi.
    expect(
      s1.persistable,
      "onResumable fired before the session was registered (key would be dropped)",
    ).toBe(true);
    s1.close();

    // Let pi flush the session transcript to disk before resuming it.
    await settle(1000);

    // --- Session 2: resume by key. The manager calls the pi adapter's
    // replayHistory to rebuild the prior transcript from disk; give it a moment
    // so message order is deterministic before the follow-up. ---
    const s2 = local!.create(DIR, key);
    await settle(1500);
    expect(
      s2.resumeKey,
      "resumed session should carry the same resume key",
    ).toBe(key);
    expect(
      s2.events.length,
      "resume replayed no history (adapter replayHistory failed?)",
    ).toBeGreaterThan(0);

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
    expect(
      userTexts.length,
      "resumed transcript is missing the prior turn",
    ).toBeGreaterThanOrEqual(2);
    expect(
      userTexts.some((t) => t.includes(CODEWORD)),
      "the original codeword prompt was not replayed",
    ).toBe(true);

    // (b) Semantic: the model recalls the codeword from the restored context —
    // impossible for a fresh session that never saw it.
    const lastAssistant = [...state.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const reply = messageAllText(lastAssistant?.parts ?? []);
    expect(
      reply.toUpperCase(),
      "resumed model did not recall the codeword",
    ).toContain(CODEWORD);
  }, 180_000);
});
