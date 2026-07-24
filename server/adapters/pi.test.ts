import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../shared/protocol.js";
import type { ChatTranslator } from "./types.js";
import { createPiAdapter } from "./pi.js";

// Pure translator tests: drive pi RPC lines through `push()` and assert the
// normalized ChatEvents, with no process/tokens. Covers the retry/settle
// message types (auto_retry_end, agent_settled) and how agent_end interacts
// with a pending automatic retry.

function translator(): ChatTranslator {
  const adapter = createPiAdapter({ enabled: true, command: "pi" });
  return adapter.createChatTranslator!();
}

/** Feed one pi RPC event as a JSONL line and return the emitted ChatEvents. */
function feed(t: ChatTranslator, line: unknown): ChatEvent[] {
  return t.push(`${JSON.stringify(line)}\n`);
}

describe("pi retry / settle events", () => {
  it("surfaces a successful auto-retry as an info notice", () => {
    const t = translator();
    expect(feed(t, { type: "auto_retry_end", success: true, attempt: 2 })).toEqual([
      { type: "notice", level: "info", text: expect.stringContaining("Recovered") },
    ]);
  });

  it("surfaces a failed auto-retry as an error notice with the final error", () => {
    const t = translator();
    const events = feed(t, {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 overloaded_error: Overloaded",
    });
    expect(events).toEqual([
      {
        type: "notice",
        level: "error",
        text: expect.stringContaining("529 overloaded_error: Overloaded"),
      },
    ]);
  });

  it("clears busy on agent_settled", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    expect(feed(t, { type: "agent_settled" })).toContainEqual({
      type: "busy",
      busy: false,
    });
  });

  it("keeps busy on agent_end when a retry is pending (no idle flicker)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    const events = feed(t, { type: "agent_end", willRetry: true, messages: [] });
    expect(events).not.toContainEqual({ type: "busy", busy: false });
  });

  it("clears busy on a final agent_end (no retry pending)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    expect(feed(t, { type: "agent_end", messages: [] })).toContainEqual({
      type: "busy",
      busy: false,
    });
  });

  it("steers a prompt sent during the retry gap (busy still held)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    feed(t, { type: "agent_end", willRetry: true, messages: [] });
    const { data } = t.encode({ type: "prompt", text: "hi" });
    expect(data).toContain('"streamingBehavior":"steer"');
  });

  it("sends a plain prompt once the run has settled", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    feed(t, { type: "agent_end", willRetry: true, messages: [] });
    feed(t, { type: "agent_settled" });
    const { data } = t.encode({ type: "prompt", text: "hi" });
    expect(data).not.toContain("streamingBehavior");
  });
});
