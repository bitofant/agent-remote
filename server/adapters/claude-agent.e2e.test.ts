// Live end-to-end coverage of nested sub-agent transcripts. With
// `forwardSubagentText:true` on query(), the CLI forwards a sub-agent's whole
// conversation tagged with `parent_tool_use_id`; the adapter routes those into
// `agent-start`/`agent-event`/`agent-done` events that fold into
// `ChatState.agents[toolId]` — the nested chat session ChatView renders.
//
// HARD gate (our surface, deterministic): whenever a sub-agent is announced, the
// events must fold into a run with a real transcript whose LAST bubble is the
// tool's own result — that's what the UI promises.
// SOFT gate (model behaviour): that the small local model reaches for the Agent
// tool at all. It often won't, so a run-free turn warns rather than fails; the
// routing itself is pinned by the pure `claude-subagent.test.ts` +
// `shared/chat.test.ts`.
//
// Spends zero Claude tokens (hits the local vLLM endpoint), excluded from
// `npm test` (run via `npm run test:e2e`), self-skips unless claude-local is
// enabled and its endpoint answers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import type { ChatEvent, ChatMessage } from "../../shared/protocol.js";
import { claudeLocal, endpointUp, ChatDriver, settle } from "./claude-local.testkit.js";

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-e2e-"));

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

const textOf = (m: ChatMessage): string =>
  m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe.skipIf(!local || !up)("claude-local: sub-agent transcripts", () => {
  it("folds a sub-agent's conversation into a nested transcript ending in its report", async () => {
    const driver = new ChatDriver(local!.create(DIR)).start();
    await driver.prompt(
      "Use the Explore subagent (the Agent/Task tool) to answer this: " +
        "what is the capital of France? Delegate it — do not answer yourself.",
      100_000,
    );
    // Sub-agent text arrives alongside the parent turn; give it a beat to drain.
    await settle(3_000);
    driver.close();

    let state = emptyChatState();
    for (const e of driver.events) state = applyChatEvent(state, e);

    // Enabling forwardSubagentText must never wedge the main turn.
    expect(driver.events.some((e) => e.type === "busy" && !e.busy)).toBe(true);

    const starts = driver.events.filter(
      (e): e is Extract<ChatEvent, { type: "agent-start" }> =>
        e.type === "agent-start",
    );
    if (starts.length === 0) {
      console.warn(
        "[claude-agent.e2e] local model never called the Agent tool — routing is " +
          "covered by claude-subagent.test.ts + shared/chat.test.ts.",
      );
      return;
    }

    let transcripts = 0;
    for (const start of starts) {
      const run = state.agents[start.toolId];
      expect(run, `run for ${start.toolId}`).toBeDefined();
      // A finished run never claims to still be loading.
      expect(run.loading).toBeFalsy();
      // Nested runs live flat on the root, so a nested state never grows its own.
      expect(run.state.agents).toEqual({});
      // The spawning tool part exists in the main transcript — that's the join
      // the UI renders on.
      const parent = state.messages
        .flatMap((m) => m.parts)
        .find((p) => p.type === "tool" && p.toolId === start.toolId);
      expect(parent, "spawning tool part").toBeDefined();

      if (run.state.messages.length === 0) continue; // empty run → plain tool view
      transcripts++;
      // The sub-agent's conversation never leaks into the main transcript.
      expect(state.messages.some((m) => run.state.messages.includes(m))).toBe(false);
      // It ends with the sub-agent talking, i.e. its answer — never with the
      // Agent tool's own "launched successfully" stub (which is NOT a report).
      const last = run.state.messages[run.state.messages.length - 1];
      expect(last.role).toBe("assistant");
      expect(textOf(last)).not.toContain("Async agent launched");
      expect(run.state.messages.every((m) => !textOf(m).includes("Async agent launched"))).toBe(
        true,
      );
    }
    expect(transcripts, "at least one nested transcript").toBeGreaterThan(0);
  }, 210_000);
});
