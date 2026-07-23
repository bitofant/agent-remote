// Live end-to-end test of context compaction on the claude-local harness
// (Claude SDK → local vLLM), so zero Claude tokens. Compaction replaces the
// running history with a model-generated summary when the context fills (auto)
// or on demand (/compact). This drives a manual /compact and checks:
//   (a) Deterministic — the adapter surfaces the SDK's compact_boundary system
//       message as a `notice` ChatEvent (the handling we added), so the UI
//       marks the boundary instead of silently dropping history. This asserts
//       OUR code and doesn't depend on the model.
//   (b) Softer/secondary — the model still recalls a fact planted before the
//       compaction, proving the summary carried context forward. This depends
//       on a lossy, model-generated summary, so it can flake on a small local
//       model (accepted as a best-effort check).
//
// Excluded from the fast gate; run via `npm run test:e2e`. Self-skips unless
// claude-local is enabled and its endpoint answers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import { claudeLocal, endpointUp, ChatDriver } from "./claude-local.testkit.js";

const CODEWORD = "PLATYPUS";
const DIR = mkdtempSync(join(tmpdir(), "agent-remote-compact-"));

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

// Join a message's text parts.
function messageText(parts: { type: string; text?: string }[]): string {
  return parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

// Reconstruct ChatState from a driver's events, as the server/client do.
function fold(events: ReadonlyArray<Parameters<typeof applyChatEvent>[1]>) {
  let state = emptyChatState();
  for (const e of events) state = applyChatEvent(state, e);
  return state;
}

describe.skipIf(!local || !up)("claude-local: compact a chat session", () => {
  it("surfaces the compaction boundary and keeps prior context", async () => {
    const d = new ChatDriver(local!.create(DIR)).start();

    // Plant a fact + a filler turn so there's real history to compact.
    await d.prompt(`Remember this codeword: ${CODEWORD}. Reply with just: OK`);
    await d.prompt("Reply with just: OK");

    // Trigger manual compaction: /compact runs and returns (busy:false), and
    // the SDK's compact_boundary becomes a notice via the adapter.
    await d.prompt("/compact", 90_000);

    // (a) Deterministic: the backend surfaced the compaction boundary as a
    // notice — the adapter behaviour we added, independent of the model.
    const compactNotice = d.events.find(
      (e) => e.type === "notice" && e.text.startsWith("Compacted context"),
    );
    expect(compactNotice, "no compaction notice was emitted").toBeDefined();
    // ...and it lands in the folded ChatState.notices the UI renders.
    expect(
      fold(d.events).notices.some((n) => n.text.startsWith("Compacted context")),
      "compaction notice missing from ChatState",
    ).toBe(true);

    // (b) Softer/secondary: after compaction the running history is a lossy,
    // model-generated summary — assert the model still recalls the planted
    // codeword from it (may flake on a small local model).
    await d.prompt(
      "What was the codeword I asked you to remember? Reply with just the codeword.",
    );
    d.close();

    const lastAssistant = [...fold(d.events).messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const reply = messageText(lastAssistant?.parts ?? []);
    expect(
      reply.toUpperCase(),
      "model did not recall the codeword after compaction",
    ).toContain(CODEWORD);
  }, 170_000);
});
