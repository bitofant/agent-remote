import { describe, expect, it } from "vitest";
import { emptyChatState } from "../shared/chat.js";
import type { ChatMessage, ChatState } from "../shared/protocol.js";
import { buildTurnDigest, firstLine, shouldRouteTurn } from "./turnRouter.js";

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

describe("shouldRouteTurn", () => {
  it("routes after a completed exchange while idle", () => {
    expect(shouldRouteTurn(settled())).toBe(true);
  });

  it("routes when only continuity is on", () => {
    const state = settled();
    expect(
      shouldRouteTurn({
        ...state,
        assistant: {
          ...state.assistant,
          autoPr: { ...state.assistant.autoPr, enabled: false },
          continuity: { ...state.assistant.continuity, enabled: true },
        },
      }),
    ).toBe(true);
  });

  it("does not route when both capabilities are off", () => {
    const state = settled();
    expect(
      shouldRouteTurn({
        ...state,
        assistant: {
          ...state.assistant,
          autoPr: { ...state.assistant.autoPr, enabled: false },
        },
      }),
    ).toBe(false);
  });

  it("does not route while busy", () => {
    expect(shouldRouteTurn({ ...settled(), busy: true })).toBe(false);
  });

  it("does not route with a pending card", () => {
    const state: ChatState = {
      ...settled(),
      pendingRequests: [{ id: "r1", kind: "confirm", title: "?" }],
    };
    expect(shouldRouteTurn(state)).toBe(false);
  });

  it("does not route when prompts are already queued", () => {
    expect(shouldRouteTurn({ ...settled(), queued: ["next"] })).toBe(false);
  });

  it("does not route while a continuity prompt is already counting down", () => {
    const state: ChatState = {
      ...settled(),
      autoPrompt: { id: "p1", text: "carry on", delayMs: 8_000, at: 0 },
    };
    expect(shouldRouteTurn(state)).toBe(false);
  });

  it("does not route without an assistant reply", () => {
    const state: ChatState = {
      ...settled(),
      messages: [msg("user", "add a helper")],
    };
    expect(shouldRouteTurn(state)).toBe(false);
  });
});

describe("buildTurnDigest", () => {
  it("pairs the developer's last request with the agent's final message", () => {
    const digest = buildTurnDigest(settled());
    expect(digest).toContain("add a helper");
    expect(digest).toContain("Done, added it.");
  });

  it("uses the LAST assistant message, not the first", () => {
    const state: ChatState = {
      ...settled(),
      messages: [
        msg("user", "add a helper"),
        msg("assistant", "Working on it."),
        msg("assistant", "Stopped: the tests fail."),
      ],
    };
    const digest = buildTurnDigest(state);
    expect(digest).toContain("Stopped: the tests fail.");
    expect(digest).not.toContain("Working on it.");
  });

  it("declines when the agent never replied to the last prompt", () => {
    const state: ChatState = {
      ...settled(),
      messages: [
        msg("user", "add a helper"),
        msg("assistant", "Done, added it."),
        // Aborted before the first token: a prompt with no reply after it.
        msg("user", "now do the other thing"),
      ],
    };
    expect(buildTurnDigest(state)).toBeNull();
  });

  it("declines an empty final message", () => {
    const state: ChatState = {
      ...settled(),
      messages: [msg("user", "add a helper"), msg("assistant", "  ")],
    };
    expect(buildTurnDigest(state)).toBeNull();
  });

  it("keeps a tool-only final turn judgeable", () => {
    const state: ChatState = {
      ...settled(),
      messages: [
        msg("user", "add a helper"),
        {
          id: "a-tool",
          role: "assistant",
          parts: [{ type: "tool", toolId: "t1", name: "Edit", status: "done" }],
          createdAt: 0,
        },
      ],
    };
    expect(buildTurnDigest(state)).toContain("[used tool: Edit]");
  });

  it("keeps the END of a long final message", () => {
    const state: ChatState = {
      ...settled(),
      messages: [
        msg("user", "add a helper"),
        msg("assistant", `${"x".repeat(5_000)} STOPPED HERE`),
      ],
    };
    const digest = buildTurnDigest(state) ?? "";
    expect(digest).toContain("STOPPED HERE");
    expect(digest.length).toBeLessThan(5_000);
  });
});

describe("firstLine", () => {
  it("skips leading blank lines", () => {
    expect(firstLine("\n\n  fatal: not a branch\nmore\n")).toBe(
      "fatal: not a branch",
    );
  });

  it("is undefined for empty output, so the note shows no reason", () => {
    expect(firstLine("   \n\n")).toBeUndefined();
  });

  it("truncates a line too long for a single note line", () => {
    const line = firstLine("x".repeat(500))!;
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.endsWith("…")).toBe(true);
  });
});
