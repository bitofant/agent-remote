import { describe, it, expect } from "vitest";
import {
  ALLOW_EVERYTHING,
  applyChatEvent,
  assistantNeedsLlm,
  deriveAssistantEnabled,
  emptyChatState,
  isAllowEverything,
  promptParts,
} from "./chat.js";
import type { AssistantSettings, ChatEvent, ChatState } from "./protocol.js";

// Fold a list of events over an initial state — how the reducer is used for real
// (server replay + live client updates), so tests read as a script of events.
function reduce(events: ChatEvent[], initial: ChatState = emptyChatState()) {
  return events.reduce(applyChatEvent, initial);
}

describe("applyChatEvent", () => {
  it("streams an assistant turn into a finished message", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", delta: "Hello" },
      { type: "part-delta", delta: ", world" },
      { type: "assistant-end" },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "Hello, world" }],
    });
  });

  it("echoes a user message into history", () => {
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: 0,
        },
      },
    ]);
    expect(state.messages).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
    ]);
  });

  it("drops a content-less thinking part once the next part starts", () => {
    // claude emits an empty thinking part as a live 'Thinking…' indicator; it
    // carries nothing by the time real content arrives, so it's stripped.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" }, // never gets a delta
      { type: "part-start", kind: "text" },
      { type: "part-delta", delta: "answer" },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([{ type: "text", text: "answer" }]);
  });

  it("appends no message when a turn finalizes with only an empty thinking part", () => {
    // An assistant turn that reduces to nothing must not leave a blank bubble.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" }, // never gets a delta
      { type: "assistant-end" },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it("drops an empty text part and appends no message when it's the only one", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", delta: "   " },
      { type: "assistant-end" },
    ]);
    expect(state.messages).toEqual([]);
  });

  it("still finalizes a turn with real text (guard against over-dropping)", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" }, // empty, dropped
      { type: "part-start", kind: "text" },
      { type: "part-delta", delta: "hi" },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("appends no message when an idle flush leaves only empty parts", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" },
      { type: "busy", busy: false },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it("keeps a thinking part that has text (pi streams reasoning)", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "thinking" },
      { type: "part-delta", delta: "let me think" },
      { type: "assistant-end" },
    ]);
    expect(state.messages[0].parts).toEqual([
      { type: "thinking", text: "let me think" },
    ]);
  });

  it("flushes a half-streamed message when going idle (abort safety)", () => {
    // An abort can skip assistant-end; busy:false must not lose the partial turn.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", delta: "partial" },
      { type: "busy", busy: false },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.messages[0].parts).toEqual([{ type: "text", text: "partial" }]);
  });

  it("attaches tool output and status via tool-end", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Bash", args: { command: "ls" } },
      { type: "assistant-end" },
      { type: "tool-end", toolId: "t1", output: "file.txt", isError: false },
    ]);
    const part = state.messages[0].parts[0];
    expect(part).toMatchObject({
      type: "tool",
      toolId: "t1",
      output: "file.txt",
      status: "done",
    });
  });

  it("marks an errored tool result", () => {
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Bash", args: { command: "boom" } },
      { type: "assistant-end" },
      { type: "tool-end", toolId: "t1", output: "nope", isError: true },
    ]);
    expect(state.messages[0].parts[0]).toMatchObject({ status: "error" });
  });

  it("caps tool output at 20k characters (keeps the tail)", () => {
    const big = "x".repeat(25_000);
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Bash", args: {} },
      { type: "assistant-end" },
      { type: "tool-end", toolId: "t1", output: big, isError: false },
    ]);
    const part = state.messages[0].parts[0] as { output: string };
    expect(part.output).toHaveLength(20_000);
    expect(part.output.endsWith("x")).toBe(true);
  });

  it("caps notices at 20 (keeps the most recent)", () => {
    const events: ChatEvent[] = Array.from({ length: 25 }, (_, i) => ({
      type: "notice",
      level: "info",
      text: `notice ${i}`,
    }));
    const state = reduce(events);
    expect(state.notices).toHaveLength(20);
    expect(state.notices[state.notices.length - 1].text).toBe("notice 24");
  });

  it("adds, de-duplicates, and clears ui-requests", () => {
    const req = {
      id: "r1",
      kind: "confirm" as const,
      title: "Allow?",
    };
    let state = reduce([
      { type: "ui-request", request: req },
      { type: "ui-request", request: { ...req, title: "Allow? (again)" } },
    ]);
    // Same id → replaced, not duplicated.
    expect(state.pendingRequests).toHaveLength(1);
    expect(state.pendingRequests[0].title).toBe("Allow? (again)");

    state = applyChatEvent(state, { type: "ui-request-done", requestId: "r1" });
    expect(state.pendingRequests).toEqual([]);
  });

  it("tracks model and mode selection", () => {
    const state = reduce([
      {
        type: "models",
        models: [{ id: "opus", label: "Opus" }],
        current: "opus",
      },
      { type: "model-changed", current: "sonnet" },
    ]);
    expect(state.models).toEqual([{ id: "opus", label: "Opus" }]);
    expect(state.currentModel).toBe("sonnet");
  });

  it("anchors an AI-mode trace to the streaming turn, surviving finalization", () => {
    // Trace fires mid-turn (while the assistant message with the tool is
    // streaming); it must anchor to that message id and keep it after the turn
    // finalizes — so the UI renders it inline beside that turn in both phases.
    let state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "tool-call", toolId: "t1", name: "Edit", args: {} },
      {
        type: "assistant-trace",
        trace: {
          requestId: "r1",
          kind: "select",
          prompt: "SYSTEM:\n…\n\nUSER:\n…",
          response: '{"allow":true}',
          outcome: "allow",
          summary: "Allowed",
          at: 123,
        },
      },
    ]);
    expect(state.assistantTraces).toHaveLength(1);
    expect(state.assistantTraces[0].anchorMessageId).toBe("m1");
    // Finalize the turn: the message keeps id m1, so the anchor still matches.
    state = applyChatEvent(state, { type: "assistant-end" });
    state = applyChatEvent(state, {
      type: "tool-end",
      toolId: "t1",
      output: "ok",
      isError: false,
    });
    expect(state.messages[0].id).toBe("m1");
    expect(state.assistantTraces[0].anchorMessageId).toBe("m1");
  });

  it("caps AI-mode traces at 20 (keeps the most recent)", () => {
    const events: ChatEvent[] = Array.from({ length: 25 }, (_, i) => ({
      type: "assistant-trace",
      trace: {
        requestId: `r${i}`,
        kind: "confirm",
        prompt: "p",
        response: "x",
        outcome: "allow",
        summary: `s${i}`,
        at: i,
      },
    }));
    const state = reduce(events);
    expect(state.assistantTraces).toHaveLength(20);
    expect(state.assistantTraces[state.assistantTraces.length - 1].summary).toBe(
      "s24",
    );
  });

  it("folds a usage snapshot into ChatState.usage (replacing any prior)", () => {
    const first = reduce([
      {
        type: "usage",
        usage: {
          available: false,
          subscriptionType: null,
          windows: [],
          sessionCostUsd: 0.5,
          at: 1,
        },
      },
    ]);
    expect(first.usage?.available).toBe(false);
    expect(first.usage?.sessionCostUsd).toBe(0.5);

    // A newer snapshot replaces the old one wholesale.
    const second = applyChatEvent(first, {
      type: "usage",
      usage: {
        available: true,
        subscriptionType: "max",
        windows: [
          { key: "seven_day", label: "Week — all models", utilization: 16, resetsAt: "2026-07-31T15:59:00Z" },
        ],
        sessionCostUsd: 1.25,
        at: 2,
      },
    });
    expect(second.usage?.available).toBe(true);
    expect(second.usage?.subscriptionType).toBe("max");
    expect(second.usage?.windows).toHaveLength(1);
    expect(second.usage?.windows[0].utilization).toBe(16);
  });

  it("folds next-prompt suggestions and clears them on the next prompt", () => {
    // A prompt_suggestion arrives after a turn → held for the composer hints.
    const withSuggestion = reduce([
      {
        type: "prompt-suggestion",
        suggestions: ["Add a test for that", "Refactor the helper"],
      },
    ]);
    expect(withSuggestion.promptSuggestions).toEqual([
      "Add a test for that",
      "Refactor the helper",
    ]);

    // Sending a new prompt makes the prior suggestions stale — drop them.
    const afterPrompt = applyChatEvent(withSuggestion, {
      type: "user-message",
      message: {
        id: "u9",
        role: "user",
        parts: [{ type: "text", text: "different idea" }],
        createdAt: 0,
      },
    });
    expect(afterPrompt.promptSuggestions).toEqual([]);
  });

  it("starts with no prompt suggestions", () => {
    expect(emptyChatState().promptSuggestions).toEqual([]);
  });

  it("folds the unsent composer draft, and keeps it across a rewind", () => {
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "first" }],
          createdAt: 0,
        },
      },
      { type: "draft", text: "half-written th" },
    ]);
    expect(state.draft).toBe("half-written th");
    // A rewind prefills the composer, so it must not wipe the stored draft.
    const rewound = applyChatEvent(state, {
      type: "rewind",
      messageId: state.messages[0].id,
    });
    expect(rewound.draft).toBe("half-written th");
    expect(applyChatEvent(rewound, { type: "draft", text: "" }).draft).toBe("");
  });

  it("returns the same state when the draft is unchanged", () => {
    const state = reduce([{ type: "draft", text: "x" }]);
    expect(applyChatEvent(state, { type: "draft", text: "x" })).toBe(state);
  });

  it("leaves state untouched for an unknown/newer event (deploy-skew safety)", () => {
    const before = reduce([{ type: "busy", busy: true }]);
    // Simulate a server ahead of this client emitting an event type it doesn't
    // know: the reducer must return the same state, never undefined.
    const after = applyChatEvent(before, {
      type: "some-future-event",
    } as unknown as ChatEvent);
    expect(after).toBe(before);
  });

  it("ignores stream events with no active streaming message", () => {
    // part-delta / tool-call before assistant-start are no-ops, not throws.
    const before = emptyChatState();
    const after = reduce([
      { type: "part-delta", delta: "orphan" },
      { type: "tool-call", toolId: "t1", name: "X" },
    ]);
    expect(after).toEqual(before);
  });
});

describe("promptParts", () => {
  it("returns a single text part when there are no images", () => {
    expect(promptParts("hi")).toEqual([{ type: "text", text: "hi" }]);
  });

  it("appends an image part per attached image with the serve url", () => {
    const parts = promptParts("look", [
      { id: "a", mediaType: "image/png", name: "shot.png" },
    ]);
    expect(parts).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        id: "a",
        mediaType: "image/png",
        name: "shot.png",
        url: "/api/upload/a",
      },
    ]);
  });

  it("omits the text part for an image-only prompt", () => {
    const parts = promptParts("", [{ id: "b", mediaType: "image/jpeg" }]);
    expect(parts).toEqual([
      {
        type: "image",
        id: "b",
        mediaType: "image/jpeg",
        name: undefined,
        url: "/api/upload/b",
      },
    ]);
  });
});

describe("applyChatEvent user image message", () => {
  it("stores image parts on a user message verbatim", () => {
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: promptParts("hi", [{ id: "a", mediaType: "image/png" }]),
          createdAt: 0,
        },
      },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].parts).toContainEqual({
      type: "image",
      id: "a",
      mediaType: "image/png",
      name: undefined,
      url: "/api/upload/a",
    });
  });
});

describe("applyChatEvent rewind", () => {
  const user = (id: string, text: string): ChatEvent => ({
    type: "user-message",
    message: { id, role: "user", parts: [{ type: "text", text }], createdAt: 0 },
  });
  const turn = (id: string, text: string): ChatEvent[] => [
    { type: "assistant-start", messageId: id },
    { type: "part-start", kind: "text" },
    { type: "part-delta", delta: text },
    { type: "assistant-end" },
  ];
  // Two full exchanges: u1/a1 then u2/a2.
  const conversation = (): ChatState =>
    reduce([user("u1", "first"), ...turn("a1", "ok"), user("u2", "second"), ...turn("a2", "done")]);

  it("drops the target user message and everything after it", () => {
    const state = reduce([{ type: "rewind", messageId: "u2" }], conversation());
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("clears in-flight state so the session is idle afterwards", () => {
    const before = reduce(
      [
        user("u1", "first"),
        user("u2", "second"),
        { type: "busy", busy: true },
        { type: "assistant-start", messageId: "a2" },
        { type: "part-start", kind: "text" },
        { type: "part-delta", delta: "half…" },
        { type: "queue", queued: ["later"] },
        {
          type: "ui-request",
          request: { id: "r1", kind: "confirm", title: "Run it?" },
        },
        { type: "prompt-suggestion", suggestions: ["next?"] },
        {
          type: "assistant-decision",
          decision: { requestId: "r1", action: "confirm", delayMs: 2000 },
        },
        {
          type: "auto-prompt",
          prompt: { id: "p1", text: "carry on", delayMs: 8000, at: 0 },
        },
      ],
    );
    expect(before.streaming).not.toBeNull();

    const state = applyChatEvent(before, { type: "rewind", messageId: "u2" });
    expect(state.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(state.streaming).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.queued).toEqual([]);
    expect(state.pendingRequests).toEqual([]);
    expect(state.promptSuggestions).toEqual([]);
    expect(state.autoDecisions).toEqual({});
    expect(state.autoPrompt).toBeNull();
    expect(state.rewindPreview).toBeNull();
  });

  it("prunes traces anchored to dropped turns but keeps the rest", () => {
    const trace = {
      requestId: "",
      kind: "confirm" as const,
      prompt: "p",
      response: "r",
      outcome: "allow" as const,
      summary: "",
      at: 0,
    };
    const before = reduce(
      [
        {
          type: "assistant-trace",
          trace: { ...trace, requestId: "r1", summary: "kept", anchorMessageId: "a1" },
        },
        {
          type: "assistant-trace",
          trace: { ...trace, requestId: "r2", summary: "dropped", anchorMessageId: "a2" },
        },
        // An AI-mode note (no LLM detail) prunes on the same rule.
        {
          type: "assistant-trace",
          trace: {
            requestId: "auto-pr:1",
            kind: "auto-pr",
            outcome: "note",
            summary: "dropped note",
            at: 0,
            anchorMessageId: "a2",
          },
        },
      ],
      conversation(),
    );
    const state = applyChatEvent(before, { type: "rewind", messageId: "u2" });
    expect(state.assistantTraces.map((t) => t.summary)).toEqual(["kept"]);
  });

  it("keeps session-level state (models, modes, commands, capabilities)", () => {
    const before = reduce(
      [
        { type: "models", models: [{ id: "opus", name: "Opus" }], current: "opus" },
        { type: "commands", commands: [{ name: "compact" }] },
        { type: "capabilities", capabilities: { rewind: true, rewindFiles: true } },
      ],
      conversation(),
    );
    const state = applyChatEvent(before, { type: "rewind", messageId: "u2" });
    expect(state.currentModel).toBe("opus");
    expect(state.commands).toHaveLength(1);
    expect(state.capabilities).toEqual({ rewind: true, rewindFiles: true });
  });

  it("ignores a rewind to an unknown message", () => {
    const before = conversation();
    expect(applyChatEvent(before, { type: "rewind", messageId: "nope" })).toBe(before);
  });

  it("folds capabilities and rewind previews", () => {
    const state = reduce([
      { type: "capabilities", capabilities: { rewind: true } },
      {
        type: "rewind-preview",
        preview: { messageId: "u2", canRewind: true, filesChanged: ["a.ts"], insertions: 3, deletions: 1 },
      },
    ]);
    expect(state.capabilities).toEqual({ rewind: true });
    expect(state.rewindPreview).toMatchObject({ messageId: "u2", canRewind: true });
    expect(applyChatEvent(state, { type: "rewind-preview", preview: null }).rewindPreview).toBeNull();
  });
});

describe("applyChatEvent auto-prompt", () => {
  const prompt = (id: string, text: string): ChatEvent => ({
    type: "auto-prompt",
    prompt: { id, text, delayMs: 8_000, at: 1_000 },
  });

  it("arms a composed prompt for the composer countdown", () => {
    const state = reduce([prompt("p1", "carry on")]);
    expect(state.autoPrompt).toEqual({
      id: "p1",
      text: "carry on",
      delayMs: 8_000,
      at: 1_000,
    });
  });

  it("clears it when the matching id is withdrawn", () => {
    const state = reduce([
      prompt("p1", "carry on"),
      { type: "auto-prompt-cleared", id: "p1" },
    ]);
    expect(state.autoPrompt).toBeNull();
  });

  it("ignores a stale clear, so it can't kill a fresher prompt", () => {
    const state = reduce([
      prompt("p1", "carry on"),
      prompt("p2", "no, do this instead"),
      { type: "auto-prompt-cleared", id: "p1" },
    ]);
    expect(state.autoPrompt?.id).toBe("p2");
  });

  it("is spent by any prompt actually being sent", () => {
    const state = reduce([
      prompt("p1", "carry on"),
      {
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "carry on" }],
          createdAt: 0,
        },
      },
    ]);
    expect(state.autoPrompt).toBeNull();
  });
});

describe("isAllowEverything", () => {
  it("matches the sentinel regardless of case, spacing or trailing punctuation", () => {
    for (const s of ["allow everything", "  Allow Everything ", "ALLOW EVERYTHING."])
      expect(isAllowEverything(s)).toBe(true);
  });

  it("does not match empty, absent or merely-similar instructions", () => {
    for (const s of [undefined, "", "allow everything in /tmp", "allow all"])
      expect(isAllowEverything(s)).toBe(false);
  });
});

describe("assistant settings", () => {
  /** A settings object with only the named capabilities enabled. */
  function settings(patch: Partial<AssistantSettings> = {}): AssistantSettings {
    return { ...emptyChatState().assistant, ...patch };
  }

  it("starts with every capability off, so the derived master is off", () => {
    const s = emptyChatState().assistant;
    expect(s).toEqual({
      enabled: false,
      permissions: { enabled: false, instructions: ALLOW_EVERYTHING },
      questions: { enabled: false, instructions: "", onlyIfSure: false },
      autoPr: { enabled: false, instructions: "", autoMerge: true },
      continuity: { enabled: false, instructions: "", newSession: "after-pr" },
    });
    expect(deriveAssistantEnabled(s)).toBe(false);
  });

  it("pre-sets the sub-options, but they stay inert until ticked", () => {
    // Blanket-accept and auto-merge are what a user ticking a capability
    // almost always wants; neither does anything while its capability is off.
    const s = emptyChatState().assistant;
    expect(isAllowEverything(s.permissions.instructions)).toBe(true);
    expect(s.autoPr.autoMerge).toBe(true);
    expect(s.continuity.newSession).toBe("after-pr");
    expect(deriveAssistantEnabled(s)).toBe(false);
    // Pre-set blanket-accept must not make an off assistant claim it needs
    // (or doesn't need) an endpoint on someone else's behalf.
    expect(assistantNeedsLlm(s)).toBe(false);
  });

  it("derives the master switch from any single enabled capability", () => {
    expect(
      deriveAssistantEnabled(
        settings({ permissions: { enabled: true, instructions: "" } }),
      ),
    ).toBe(true);
    expect(
      deriveAssistantEnabled(
        settings({
          questions: { enabled: true, instructions: "", onlyIfSure: false },
        }),
      ),
    ).toBe(true);
    expect(
      deriveAssistantEnabled(
        settings({ autoPr: { enabled: true, instructions: "", autoMerge: false } }),
      ),
    ).toBe(true);
    expect(
      deriveAssistantEnabled(
        settings({
          continuity: { enabled: true, instructions: "", newSession: "never" },
        }),
      ),
    ).toBe(true);
  });

  it("needs the LLM for continuity — it has no prompt to send without one", () => {
    expect(
      assistantNeedsLlm(
        settings({
          continuity: { enabled: true, instructions: "", newSession: "never" },
        }),
      ),
    ).toBe(true);
  });

  it("needs the LLM only for capabilities that actually consult it", () => {
    // Questions always do.
    expect(
      assistantNeedsLlm(
        settings({
          questions: { enabled: true, instructions: "", onlyIfSure: false },
        }),
      ),
    ).toBe(true);
    // Permissions do, unless blanket-accept bypasses the endpoint.
    expect(
      assistantNeedsLlm(
        settings({ permissions: { enabled: true, instructions: "only git" } }),
      ),
    ).toBe(true);
    expect(
      assistantNeedsLlm(
        settings({
          permissions: { enabled: true, instructions: "allow everything" },
        }),
      ),
    ).toBe(false);
    // Auto-PR never does, and neither does an all-off config.
    expect(
      assistantNeedsLlm(
        settings({ autoPr: { enabled: true, instructions: "", autoMerge: false } }),
      ),
    ).toBe(false);
    expect(assistantNeedsLlm(settings())).toBe(false);
  });

  it("folds an AI-mode note with no LLM detail, anchored to the last turn", () => {
    // Auto-PR fires on busy:false, when nothing is streaming — the note must
    // land on the just-finalized turn, and carry no prompt/response (no LLM was
    // consulted), which is what makes its bubble non-expandable.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", delta: "done" },
      { type: "assistant-end" },
      {
        type: "assistant-trace",
        trace: {
          requestId: "auto-pr:1",
          kind: "auto-pr",
          outcome: "note",
          reason: "running…",
          summary: "Running auto PR",
          at: 1,
        },
      },
    ]);
    expect(state.streaming).toBeNull();
    expect(state.assistantTraces).toHaveLength(1);
    const trace = state.assistantTraces[0];
    expect(trace.anchorMessageId).toBe("m1");
    expect(trace.prompt).toBeUndefined();
    expect(trace.response).toBeUndefined();
  });

  it("honours a pinned anchor while its turn is in the transcript", () => {
    // Auto-PR pins the turn that started the run, so notes posted minutes later
    // stay with it instead of trailing whatever the developer has since sent.
    const state = reduce([
      { type: "assistant-start", messageId: "m1" },
      { type: "part-start", kind: "text" },
      { type: "part-delta", delta: "done" },
      { type: "assistant-end" },
      {
        type: "user-message",
        message: {
          id: "m2",
          role: "user",
          parts: [{ type: "text", text: "next" }],
          createdAt: 2,
        },
      },
      {
        type: "assistant-trace",
        trace: {
          requestId: "auto-pr:1",
          kind: "auto-pr",
          outcome: "note",
          summary: "Pushed joran/x to origin",
          at: 3,
          anchorMessageId: "m1",
        },
      },
    ]);
    expect(state.assistantTraces[0].anchorMessageId).toBe("m1");
  });

  it("re-anchors a trace whose pinned turn is gone to the latest message", () => {
    // A stale pin (its turn rewound or capped out of history) must not leave the
    // trace dangling: the UI renders nothing after the last message, so a
    // dangling trace would vanish — or, if parked at the end, would sit below
    // every message sent after it.
    const state = reduce([
      {
        type: "user-message",
        message: {
          id: "m9",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: 1,
        },
      },
      {
        type: "assistant-trace",
        trace: {
          requestId: "auto-pr:1",
          kind: "auto-pr",
          outcome: "note",
          summary: "Opened PR #1",
          at: 2,
          anchorMessageId: "long-gone",
        },
      },
    ]);
    expect(state.assistantTraces[0].anchorMessageId).toBe("m9");
  });
});
