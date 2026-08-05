// Live end-to-end test for `/rewind`: jumping a chat session back to an earlier
// USER prompt, dropping it and everything after from both the transcript and the
// model's context. Runs against claude-local (Claude SDK → local vLLM), so zero
// Claude tokens.
//
// What's pinned here (deterministic, our contract):
//   - the adapter emits a `rewind` event and the shared reducer truncates to
//     just before the target prompt;
//   - the session re-keys (forkSession → new SDK session id), so the pre-rewind
//     conversation survives as a resumable branch;
//   - rewinding TWICE in one session works — after a fork every transcript uuid
//     is remapped, so the second rewind exercises the positional fallback;
//   - `rewind-preview` answers with a dry run and changes nothing on disk;
//   - `restoreFiles` puts a file the model edited back the way it was.
// Plus a softer model-behaviour check: after rewinding, the model still knows
// the codeword from the kept turn but not the one from the dropped turn.
//
// Excluded from the fast gate; run via `npm run test:e2e`. Self-skips unless
// claude-local is enabled and its endpoint answers.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import type { ChatEvent, ChatState } from "../../shared/protocol.js";
import { claudeLocal, endpointUp, ChatDriver, settle } from "./claude-local.testkit.js";

const KEPT = "PLATYPUS";
const DROPPED = "ZEBRA";

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

function fold(events: ChatEvent[]): ChatState {
  return events.reduce(applyChatEvent, emptyChatState());
}

function messageText(parts: { type: string; text?: string }[]): string {
  return parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

/** Ids of the user prompts in a folded transcript, in order. */
function promptIds(state: ChatState): string[] {
  return state.messages.filter((m) => m.role === "user").map((m) => m.id);
}

describe.skipIf(!local || !up)("claude-local: rewind a chat session", () => {
  it("truncates the conversation and the model's context, and re-keys the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-remote-rewind-"));
    const s = new ChatDriver(local!.create(dir)).start();

    await s.prompt(`Remember this codeword: ${KEPT}. Reply with just: OK`);
    await s.prompt(`Also remember this second codeword: ${DROPPED}. Reply with just: OK`);
    await s.prompt("Reply with just: OK");

    const before = fold(s.events);
    const ids = promptIds(before);
    expect(ids, "expected three user prompts before rewinding").toHaveLength(3);
    expect(before.capabilities.rewind, "adapter did not report rewind support").toBe(true);
    const keyBefore = s.resumeKey;

    // --- Rewind to the third prompt: it and everything after it should go. ---
    s.act({ type: "rewind", messageId: ids[2] });
    await s.waitFor(
      () => s.events.some((e) => e.type === "rewind"),
      60_000,
      "no rewind event",
    );
    const after = fold(s.events);
    expect(promptIds(after), "transcript was not truncated at the target prompt").toEqual(
      ids.slice(0, 2),
    );
    expect(after.busy).toBe(false);
    expect(after.streaming).toBeNull();
    // Forked, so the pre-rewind branch is still on disk under its own key.
    expect(s.resumeKey, "session kept its old key (no fork?)").not.toBe(keyBefore);

    // --- Rewind again, to the second prompt. The first fork remapped every
    // transcript uuid, so this one can only resolve via positional lookup. ---
    const keyAfterFirst = s.resumeKey;
    s.act({ type: "rewind", messageId: ids[1] });
    await s.waitFor(
      () => s.events.filter((e) => e.type === "rewind").length === 2,
      60_000,
      "second rewind produced no event",
    );
    expect(promptIds(fold(s.events)), "second rewind truncated at the wrong point").toEqual([
      ids[0],
    ]);
    expect(s.resumeKey, "second rewind did not fork").not.toBe(keyAfterFirst);

    // Softer: the kept turn is still in context, the dropped one isn't.
    await s.prompt("List every codeword I have told you so far, separated by spaces.");
    const recalled = messageText(
      [...fold(s.events).messages].reverse().find((m) => m.role === "assistant")?.parts ?? [],
    ).toUpperCase();
    expect(recalled, "model lost the context it should have kept").toContain(KEPT);
    expect(recalled, "model still knows a codeword from a rewound-away turn").not.toContain(DROPPED);

    s.close();
  }, 300_000);

  it("previews a rewind without touching the working tree, then restores files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-remote-rewind-files-"));
    const file = join(dir, "notes.txt");
    writeFileSync(file, "ORIGINAL\n");

    const s = new ChatDriver(local!.create(dir)).start();
    await s.prompt("Reply with just: ready");
    await s.prompt(
      "Use the Write tool to replace the entire contents of notes.txt with the single word CHANGED.",
    );
    expect(readFileSync(file, "utf8"), "model never edited the file").toContain("CHANGED");

    const ids = promptIds(fold(s.events));
    expect(ids.length, "expected two user prompts").toBeGreaterThanOrEqual(2);
    const target = ids[1];

    // Dry run: reports what it would do, changes nothing.
    s.act({ type: "rewind-preview", messageId: target });
    await s.waitFor(
      () => s.events.some((e) => e.type === "rewind-preview"),
      60_000,
      "no rewind-preview event",
    );
    const preview = fold(s.events).rewindPreview;
    expect(preview?.messageId).toBe(target);
    expect(preview?.canRewind, `preview refused: ${preview?.error}`).toBe(true);
    expect(readFileSync(file, "utf8"), "dry run modified the working tree").toContain("CHANGED");

    // Real rewind with file restore: the edit is undone.
    s.act({ type: "rewind", messageId: target, restoreFiles: true });
    await s.waitFor(
      () => s.events.some((e) => e.type === "rewind"),
      60_000,
      "no rewind event",
    );
    expect(readFileSync(file, "utf8"), "file was not restored").toContain("ORIGINAL");

    s.close();
  }, 300_000);
});
