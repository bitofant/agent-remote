import { describe, expect, it } from "vitest";
import { emptyChatState } from "../shared/chat.js";
import type { ChatMessage, ChatState } from "../shared/protocol.js";
import { shouldRunAutoPr } from "./autopr.js";

function msg(role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: `${role}-${text.slice(0, 8)}`,
    role,
    parts: [{ type: "text", text }],
    createdAt: 0,
  };
}

/** A settled state with auto-PR on and one real exchange — the baseline case. */
function settled(): ChatState {
  const base = emptyChatState();
  return {
    ...base,
    assistant: {
      ...base.assistant,
      enabled: true,
      autoPr: { enabled: true, instructions: "", autoMerge: false },
    },
    messages: [msg("user", "add a helper"), msg("assistant", "Done, added it.")],
  };
}

describe("shouldRunAutoPr", () => {
  it("runs after a completed exchange while idle", () => {
    expect(shouldRunAutoPr(settled())).toBe(true);
  });

  it("does not run when the capability is off", () => {
    const state = settled();
    expect(
      shouldRunAutoPr({
        ...state,
        assistant: {
          ...state.assistant,
          autoPr: { ...state.assistant.autoPr, enabled: false },
        },
      }),
    ).toBe(false);
  });

  it("does not run while busy", () => {
    expect(shouldRunAutoPr({ ...settled(), busy: true })).toBe(false);
  });

  it("does not run with a pending card", () => {
    const state: ChatState = {
      ...settled(),
      pendingRequests: [{ id: "r1", kind: "confirm", title: "?" }],
    };
    expect(shouldRunAutoPr(state)).toBe(false);
  });

  it("does not run when prompts are already queued", () => {
    expect(shouldRunAutoPr({ ...settled(), queued: ["next"] })).toBe(false);
  });

  it("does not run without an assistant reply", () => {
    const state: ChatState = {
      ...settled(),
      messages: [msg("user", "add a helper")],
    };
    expect(shouldRunAutoPr(state)).toBe(false);
  });
});
