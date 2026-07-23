import { describe, it, expect } from "vitest";
import { applyChatEvent, emptyChatState } from "./chat.js";
import type { ChatEvent, ChatState } from "./protocol.js";

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
