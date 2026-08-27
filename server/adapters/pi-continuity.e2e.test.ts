// Live end-to-end coverage of Continuity Mode over **pi** — the other adapter
// shape. The claude counterpart (claude-continuity.e2e.test.ts) exercises a
// `createChatSession` harness; pi is a `createChatTranslator` one, driven by the
// manager over a piped `pi --mode rpc` subprocess. Continuity is supposed to be
// harness-agnostic, and this is what proves it: neither turnRouter.ts nor
// continuity.ts knows which harness it is talking to.
//
// It also pins "one prompt in, one prompt out" on the harness that emits
// `busy:false` MORE THAN ONCE per turn (agent_end, then settled). Note what that
// assertion does and does not catch: `shouldRouteTurn` (armed auto-prompt) and
// the router's single-flight already absorb a stray settle that lands while the
// first route is in flight, so it does NOT fail against a naive `busy:false`
// match — verified by mutation. It guards the invariant, not the arming rule.
// The arming rule itself (`user-message`, not a `busy:true` → `busy:false`
// transition) is load-bearing on the CLAUDE side, where a local endpoint streams
// no `message_start` and so never emits `busy:true` at all: mutating the router
// to a transition latch makes claude-continuity.e2e.test.ts fail outright.
//
// Zero tokens: pi is pointed at the same local vLLM that backs the router/writer.
// Self-skips unless pi is enabled and the endpoint answers.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import { attachTurnRouter } from "../turnRouter.js";
import { attachContinuity } from "../continuity.js";
import { startLlmPolling, llmStatus } from "../llm.js";
import type { AssistantSettings, ChatEvent } from "../../shared/protocol.js";
import { PiDriver, endpointUp, settle } from "./pi-local.testkit.js";

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-pi-continuity-e2e-"));
writeFileSync(join(DIR, "notes.md"), "# Notes\n\n- nothing yet\n");

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
  attachTurnRouter(manager, config.autoPr);
  attachContinuity(manager);
  startLlmPolling(config.llm);
  return { manager, baseUrl: config.llm?.baseUrl };
}

/** Continuity only: auto-PR off, so the router has just the one route to pick,
 * and `never` so the reply stays in this session (the hop is covered by the
 * claude test). PiDriver answers permission cards itself. */
function continuitySettings(): AssistantSettings {
  return {
    enabled: true,
    permissions: { enabled: false, instructions: "" },
    questions: { enabled: false, instructions: "", onlyIfSure: false },
    autoPr: { enabled: false, instructions: "", autoMerge: false },
    continuity: {
      enabled: true,
      instructions:
        "Keep the work moving: answer whatever the agent asked, decide for it " +
        "if it offered options, and never ask it a question back.",
      newSession: "never",
    },
  };
}

const ctx = setup();
const up = await endpointUp(ctx?.baseUrl);

/** Poll until `ok()` holds; continuity's work is async and off the event loop. */
async function until(ok: () => boolean, ms: number, message: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await settle(500);
  }
  throw new Error(message);
}

describe.skipIf(!ctx || !up)("pi: Continuity Mode", () => {
  it("routes a pi turn to continuity and sends the composed prompt", async () => {
    for (let i = 0; i < 20 && !llmStatus().available; i++) await settle(300);
    expect(llmStatus().available).toBe(true);

    const driver = new PiDriver(ctx!.manager, DIR);
    try {
      ctx!.manager.chatAction(driver.sessionId, {
        type: "set-assistant",
        settings: continuitySettings(),
      });

      await driver.prompt(
        "Propose exactly two different things we could add to notes.md. Do " +
          "not change any files. Finish by asking me which of the two I want.",
        120_000,
      );

      const armedEvents = () =>
        driver.events.filter(
          (e): e is Extract<ChatEvent, { type: "auto-prompt" }> =>
            e.type === "auto-prompt",
        );

      // (a) The backend composed and armed a prompt — over a translator harness,
      // with no harness-specific code involved anywhere in the path.
      await until(
        () => armedEvents().length > 0,
        120_000,
        "the backend never armed a continuity prompt for pi",
      );
      const prompt = armedEvents()[0].prompt;
      expect(prompt.text.trim().length).toBeGreaterThan(0);
      expect(prompt.delayMs).toBeGreaterThanOrEqual(4_000);
      expect(prompt.delayMs).toBeLessThanOrEqual(30_000);

      // (b) One prompt in, one prompt out — pi's repeated busy:false must not
      // arm twice. (See the header: shouldRouteTurn + the single-flight also
      // enforce this, so it is an invariant check, not the arming regression.)
      expect(
        armedEvents(),
        "pi's repeated busy:false armed the turn more than once",
      ).toHaveLength(1);

      // (c) It went through the ordinary draft path, so a browser would show it.
      expect(ctx!.manager.chatState(driver.sessionId)?.draft).toBe(prompt.text);

      // (d) The backend sends it when the window closes.
      await until(
        () =>
          driver.events.some(
            (e) =>
              e.type === "user-message" &&
              e.message.parts.some(
                (p) => p.type === "text" && p.text === prompt.text,
              ),
          ),
        prompt.delayMs + 60_000,
        "the armed prompt was never sent to pi",
      );
      expect(
        ctx!.manager.chatState(driver.sessionId)?.autoPrompt?.id,
      ).not.toBe(prompt.id);
    } finally {
      driver.close();
    }
  }, 300_000);
});
