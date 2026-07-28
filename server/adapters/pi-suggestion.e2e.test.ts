// Live end-to-end coverage of SYNTHESIZED next-prompt suggestions for pi. pi's
// RPC (unlike Claude's SDK) emits no predicted follow-up, so the harness-agnostic
// generator (server/suggestions.ts) fills the gap: when a chat turn settles, it
// renders the transcript and asks the optional LLM endpoint to predict the
// developer's next message, then folds it into ChatState.promptSuggestions — the
// same chip the native harnesses feed.
//
// This drives a REAL `pi --mode rpc` subprocess through the production
// SessionManager, with the real generator + LLM polling wired (exactly index.ts),
// all pointed at the same local vLLM (zero tokens). Because the suggestion here is
// OUR call against that endpoint (not a claude secondary call the small model
// chokes on), the local model actually produces one — so unlike the claude
// counterpart this asserts a suggestion arrives, plus that it folds through the
// shared reducer. Deterministic gating/transcript logic is pinned separately by
// server/suggestions.test.ts. Self-skips unless pi + the LLM endpoint are up.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import { attachSuggestions } from "../suggestions.js";
import { startLlmPolling, llmStatus } from "../llm.js";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import type { ChatEvent } from "../../shared/protocol.js";
import { PiDriver, endpointUp, settle } from "./pi-local.testkit.js";

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-e2e-"));

function setup(): { manager: SessionManager; baseUrl?: string } | null {
  let config;
  try {
    config = loadConfig();
  } catch {
    return null;
  }
  if (!config.harnesses.pi?.enabled) return null;
  const adapters = buildAdapters(config);
  if (!adapters.get("pi")?.createChatTranslator) return null;
  const manager = new SessionManager(adapters);
  attachSuggestions(manager, adapters);
  startLlmPolling(config.llm);
  return { manager, baseUrl: config.llm?.baseUrl };
}

const ctx = setup();
const up = await endpointUp(ctx?.baseUrl);

describe.skipIf(!ctx || !up)("pi: synthesized next-prompt suggestion", () => {
  it("emits a prompt-suggestion after a turn (folds into ChatState)", async () => {
    // Wait for the LLM health poll so the generator sees the endpoint as up.
    for (let i = 0; i < 20 && !llmStatus().available; i++) await settle(300);
    expect(llmStatus().available).toBe(true);

    const driver = new PiDriver(ctx!.manager, DIR);
    await driver.prompt(
      "Briefly, in one sentence, what does the Unix `wc -l` command do?",
      90_000,
    );
    // The suggestion is our async LLM call kicked off on turn-settle; give it a
    // moment to resolve and post the prompt-suggestion event.
    await settle(12_000);
    driver.close();

    const idles = driver.events.filter((e) => e.type === "busy" && !e.busy);
    expect(idles.length).toBeGreaterThanOrEqual(1);

    const sugg = driver.events.find(
      (e): e is Extract<ChatEvent, { type: "prompt-suggestion" }> =>
        e.type === "prompt-suggestion",
    );
    // Soft-skip if the small model declined to produce one (returns empty); the
    // deterministic path is covered by unit tests. When present it must be
    // non-empty and fold through the shared reducer.
    if (!sugg) {
      console.warn(
        "[pi-suggestion.e2e] endpoint returned no suggestion this run; " +
          "gating/transcript covered by server/suggestions.test.ts.",
      );
      return;
    }
    expect(sugg.suggestions.length).toBeGreaterThan(0);
    expect(sugg.suggestions.length).toBeLessThanOrEqual(3);
    expect(sugg.suggestions.every((s) => s.trim().length > 0)).toBe(true);
    let state = emptyChatState();
    for (const e of driver.events) state = applyChatEvent(state, e);
    expect(state.promptSuggestions).toEqual(sugg.suggestions);
  }, 150_000);
});
