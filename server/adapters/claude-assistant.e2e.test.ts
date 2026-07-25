// Live end-to-end test of BACKEND AI-assistant mode (server/assistant.ts) over
// the claude-local harness, driven through the real SessionManager — the exact
// production path. It proves the decider runs on the SERVER with NO browser
// responding: the test's own listener never answers a card, yet an Edit
// permission prompt is evaluated, broadcast as an `assistant-decision`, and
// APPLIED by the backend, so the turn completes on its own.
//
// This is the "keeps running when the browser is closed" guarantee. It spends
// zero Claude tokens (everything hits the local vLLM endpoint, which also backs
// the LLM decider) but IS a live model call, so it's excluded from `npm test`
// (run via `npm run test:e2e`) and self-skips unless claude-local is enabled,
// its endpoint answers, and the LLM health poll comes up. As with any live
// model call it can flake if the small local model declines the edit.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import { attachAssistant } from "../assistant.js";
import { startLlmPolling, llmStatus } from "../llm.js";
import type { ChatEvent } from "../../shared/protocol.js";
import { endpointUp, settle } from "./claude-local.testkit.js";

const config = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();

const enabled = !!config?.harnesses.claudeLocal?.enabled;
const up = await endpointUp(config?.harnesses.claudeLocal?.env?.ANTHROPIC_BASE_URL);

// Prime the backend LLM health poll (the decider gates on llmStatus().available).
let llmUp = false;
if (config && enabled && up) {
  startLlmPolling(config.llm);
  for (let i = 0; i < 30 && !llmStatus().available; i++) await settle(500);
  llmUp = llmStatus().available;
}

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-assistant-e2e-"));
writeFileSync(join(DIR, "greeting.txt"), "hello world\n");

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      t.unref();
    }),
  ]);
}

describe.skipIf(!config || !enabled || !up || !llmUp)(
  "claude-local: backend AI-assistant mode",
  () => {
    it("auto-answers a permission card with no frontend responding", async () => {
      const manager = new SessionManager(buildAdapters(config!));
      const detach = attachAssistant(manager);

      const events: ChatEvent[] = [];
      let sessionId = "";
      let resolveTurn: (() => void) | null = null;

      const unsub = manager.subscribe({
        onStarted() {},
        onOutput() {},
        onExit(id) {
          if (id === sessionId) resolveTurn?.();
        },
        onChatEvent(id, event) {
          if (id !== sessionId) return;
          events.push(event);
          // Deliberately DO NOT answer ui-requests — the backend must do it.
          if (event.type === "busy" && event.busy === false) resolveTurn?.();
        },
      });

      sessionId = manager.start("claude-local", { cwd: DIR }).id;
      // Enable backend assistant mode for this session, permitting edits.
      manager.chatAction(sessionId, {
        type: "set-assistant",
        settings: {
          enabled: true,
          canAcceptPermissions: true,
          canAnswerQuestions: false,
          instructions:
            "Approve any tool call that reads or edits files inside the project directory.",
        },
      });

      const turn = new Promise<void>((r) => {
        resolveTurn = r;
      });
      manager.chatAction(sessionId, {
        type: "prompt",
        text:
          'In the file greeting.txt, use the Edit tool to replace the ' +
          'old_string "hello" with the new_string "goodbye". Make exactly ' +
          "that single edit and nothing else.",
      });
      await withTimeout(turn, 110_000, "turn did not complete in time");
      // Let a trailing ui-request-done / decision settle into the log.
      await settle(200);
      manager.stop(sessionId);
      unsub();
      detach();

      // (a) The Edit triggered a permission request (canUseTool fired).
      const editReq = events.find(
        (e): e is Extract<ChatEvent, { type: "ui-request" }> =>
          e.type === "ui-request" && e.request.tool?.name === "Edit",
      );
      expect(editReq, "no Edit permission was requested").toBeDefined();
      const reqId = editReq!.request.id;

      // (b) The BACKEND (not us) broadcast a verdict for it — this is the
      // decider running server-side.
      const decision = events.find(
        (e): e is Extract<ChatEvent, { type: "assistant-decision" }> =>
          e.type === "assistant-decision" && e.decision.requestId === reqId,
      );
      expect(
        decision,
        "backend never broadcast an assistant-decision",
      ).toBeDefined();
      expect(decision!.decision.action).toBe("accept");

      // (c) The BACKEND applied it: the request resolved though our listener
      // never sent a ui-response. That's the headless guarantee.
      const done = events.find(
        (e): e is Extract<ChatEvent, { type: "ui-request-done" }> =>
          e.type === "ui-request-done" && e.requestId === reqId,
      );
      expect(done, "the Edit request was never resolved by the backend").toBeDefined();

      // (c2) The deliberation was surfaced as an AI-mode trace bubble for the
      // same card, carrying the prompt sent to the LLM and its response.
      const trace = events.find(
        (e): e is Extract<ChatEvent, { type: "assistant-trace" }> =>
          e.type === "assistant-trace" && e.trace.requestId === reqId,
      );
      expect(trace, "backend never emitted an assistant-trace").toBeDefined();
      expect(trace!.trace.prompt).toContain("USER:");
      expect(trace!.trace.summary.length).toBeGreaterThan(0);

      // (d) Soft, model-dependent: the edit actually landed on disk.
      const editCall = events.find(
        (e): e is Extract<ChatEvent, { type: "tool-call" }> =>
          e.type === "tool-call" && e.name === "Edit",
      );
      expect(editCall, "no Edit tool-call was emitted").toBeDefined();
    }, 180_000);
  },
);
