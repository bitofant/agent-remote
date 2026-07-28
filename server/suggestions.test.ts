import { describe, expect, it } from "vitest";
import { emptyChatState } from "../shared/chat.js";
import type { ChatMessage, ChatState } from "../shared/protocol.js";
import { buildSuggestionTranscript, shouldSuggest } from "./suggestions.js";

function msg(role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: `${role}-${text.slice(0, 8)}`,
    role,
    parts: [{ type: "text", text }],
    createdAt: 0,
  };
}

/** A settled state with one real exchange — the baseline "suggest" case. */
function exchange(): ChatState {
  return {
    ...emptyChatState(),
    messages: [msg("user", "add a helper"), msg("assistant", "Done, added it.")],
  };
}

describe("shouldSuggest", () => {
  it("suggests after a completed exchange while idle", () => {
    expect(shouldSuggest(exchange())).toBe(true);
  });

  it("does not suggest while busy", () => {
    expect(shouldSuggest({ ...exchange(), busy: true })).toBe(false);
  });

  it("does not suggest with a pending card", () => {
    const state: ChatState = {
      ...exchange(),
      pendingRequests: [{ id: "r1", kind: "confirm", title: "?" }],
    };
    expect(shouldSuggest(state)).toBe(false);
  });

  it("does not suggest when prompts are already queued", () => {
    expect(shouldSuggest({ ...exchange(), queued: ["next thing"] })).toBe(false);
  });

  it("does not overwrite existing suggestions", () => {
    expect(
      shouldSuggest({ ...exchange(), promptSuggestions: ["already here"] }),
    ).toBe(false);
  });

  it("does not suggest before any assistant reply", () => {
    const state: ChatState = { ...emptyChatState(), messages: [msg("user", "hi")] };
    expect(shouldSuggest(state)).toBe(false);
  });

  it("ignores an empty assistant turn (no visible text)", () => {
    const state: ChatState = {
      ...emptyChatState(),
      messages: [
        msg("user", "hi"),
        { id: "a", role: "assistant", parts: [], createdAt: 0 },
      ],
    };
    expect(shouldSuggest(state)).toBe(false);
  });
});

describe("buildSuggestionTranscript", () => {
  it("renders a User/Assistant script", () => {
    const t = buildSuggestionTranscript(exchange());
    expect(t).toContain("User: add a helper");
    expect(t).toContain("Assistant: Done, added it.");
  });

  it("marks tool calls tersely and skips empty messages", () => {
    const state: ChatState = {
      ...emptyChatState(),
      messages: [
        msg("user", "run it"),
        {
          id: "a",
          role: "assistant",
          parts: [
            { type: "thinking", text: "hmm" },
            {
              type: "tool",
              toolId: "t1",
              name: "Bash",
              output: "",
              status: "done",
            },
            { type: "text", text: "All green." },
          ],
          createdAt: 0,
        },
      ],
    };
    const t = buildSuggestionTranscript(state);
    expect(t).toContain("[used tool: Bash]");
    expect(t).toContain("All green.");
    // Thinking is not surfaced to the predictor.
    expect(t).not.toContain("hmm");
  });

  it("bounds the transcript to the most recent messages", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) messages.push(msg("user", `m${i}`));
    const t = buildSuggestionTranscript({ ...emptyChatState(), messages });
    expect(t).toContain("m29");
    expect(t).not.toContain("m0:"); // early messages dropped
  });
});
