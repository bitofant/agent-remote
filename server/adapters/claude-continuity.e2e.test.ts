// Live end-to-end test of Continuity Mode (server/turnRouter.ts +
// server/continuity.ts) over the claude-local harness, driven through the real
// SessionManager — the production path. It proves the backend, with NO browser
// attached, notices a turn that ended without finishing, writes the developer's
// next message itself, and sends it after the grace window.
//
// The deterministic contract is the event surfacing: a `continuity` trace, an
// `auto-prompt` armed with a sane delay, and the prompt actually landing as a
// `user-message`. Prompt *quality* is a soft, model-dependent check.
//
// Zero Claude tokens (everything hits the local vLLM endpoint, which also backs
// the LLM router/writer) but IS a live model call, so it's excluded from
// `npm test` (run via `npm run test:e2e`) and self-skips unless claude-local is
// enabled, its endpoint answers, and the LLM health poll comes up.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { buildAdapters } from "./registry.js";
import { SessionManager } from "../sessions/manager.js";
import { attachTurnRouter } from "../turnRouter.js";
import { attachContinuity, runContinuity } from "../continuity.js";
import { attachAssistant } from "../assistant.js";
import { startLlmPolling, llmStatus } from "../llm.js";
import type { AssistantSettings, ChatEvent } from "../../shared/protocol.js";
import { ALLOW_EVERYTHING } from "../../shared/chat.js";
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

// Prime the backend LLM health poll (both the router and the writer gate on it).
let llmUp = false;
if (config && enabled && up) {
  startLlmPolling(config.llm);
  for (let i = 0; i < 30 && !llmStatus().available; i++) await settle(500);
  llmUp = llmStatus().available;
}

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-continuity-e2e-"));
writeFileSync(join(DIR, "notes.md"), "# Notes\n\n- nothing yet\n");

/** Continuity on, staying in this session, with the two card-answering
 * capabilities on so the agent's turn can actually settle unattended: the small
 * local model reaches for Bash/Read whatever it's told, and routinely asks via
 * the AskUserQuestion tool rather than in prose. Auto-PR stays off, so the
 * router only ever has continuity to choose. */
function continuitySettings(
  newSession: AssistantSettings["continuity"]["newSession"] = "never",
): AssistantSettings {
  return {
    enabled: true,
    permissions: { enabled: true, instructions: ALLOW_EVERYTHING },
    questions: {
      enabled: true,
      instructions: "Pick whichever option moves the work forward.",
      onlyIfSure: false,
    },
    autoPr: { enabled: false, instructions: "", autoMerge: false },
    continuity: {
      enabled: true,
      instructions:
        "Keep the work moving: answer whatever the agent asked, pick an option " +
        "if it offered several, and never ask it a question back.",
      newSession,
    },
  };
}

/** A turn that ends wanting a decision from the developer. */
const ASK_BACK =
  "Read notes.md. Then propose exactly two different things we could add to " +
  "it. Do NOT add anything yet. Finish your reply by asking me which of the " +
  "two I want.";

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      t.unref();
    }),
  ]);
}

/** Drive one session with continuity attached, collecting every chat event.
 * `router: false` leaves the settle hook off, so a test can call
 * `runContinuity` itself and be the only thing arming a prompt. */
function harness(
  opts: {
    router?: boolean;
    newSession?: AssistantSettings["continuity"]["newSession"];
  } = {},
) {
  const manager = new SessionManager(buildAdapters(config!));
  // The card decider is what lets the agent's turn finish with nobody watching.
  const detachAssistant = attachAssistant(manager);
  const detachRouter =
    opts.router === false ? () => {} : attachTurnRouter(manager, config!.autoPr);
  const detachContinuity = attachContinuity(manager);
  const events: ChatEvent[] = [];
  let sessionId = "";
  const waiters: Array<{ ok: () => boolean; resolve: () => void }> = [];

  const flush = () => {
    for (let i = waiters.length - 1; i >= 0; i--)
      if (waiters[i].ok()) waiters.splice(i, 1)[0].resolve();
  };

  const unsub = manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit() {
      flush();
    },
    onChatEvent(id, event) {
      if (id !== sessionId) return;
      events.push(event);
      flush();
    },
  });

  sessionId = manager.start("claude-local", { cwd: DIR }).id;
  manager.chatAction(sessionId, {
    type: "set-assistant",
    settings: continuitySettings(opts.newSession),
  });

  return {
    manager,
    events,
    get sessionId() {
      return sessionId;
    },
    waitFor(ok: () => boolean, ms: number, message: string) {
      if (ok()) return Promise.resolve();
      return withTimeout(
        new Promise<void>((resolve) => waiters.push({ ok, resolve })),
        ms,
        message,
      );
    },
    stop() {
      // Everything in the folder: a fresh-session test leaves a second one.
      for (const s of manager.list()) manager.stop(s.id);
      unsub();
      detachContinuity();
      detachRouter();
      detachAssistant();
    },
  };
}

const armed = (events: ChatEvent[]) =>
  events.find(
    (e): e is Extract<ChatEvent, { type: "auto-prompt" }> =>
      e.type === "auto-prompt",
  );

describe.skipIf(!config || !enabled || !up || !llmUp)(
  "claude-local: Continuity Mode",
  () => {
    it("writes and sends the next prompt with no frontend attached", async () => {
      const h = harness();
      try {
        h.manager.chatAction(h.sessionId, { type: "prompt", text: ASK_BACK });

        // (a) The backend routed the settled turn to continuity and armed a
        // composed prompt. No listener of ours answered anything.
        await h.waitFor(
          () => !!armed(h.events),
          160_000,
          "the backend never armed a continuity prompt",
        );
        const prompt = armed(h.events)!.prompt;
        expect(prompt.text.trim().length).toBeGreaterThan(0);

        // (b) The grace window is human-scaled and inside the clamp.
        expect(prompt.delayMs).toBeGreaterThanOrEqual(4_000);
        expect(prompt.delayMs).toBeLessThanOrEqual(30_000);

        // (c) Both deliberations are auditable in the transcript: the routing
        // verdict, and the note keyed to this prompt showing how it was written.
        const traces = h.events
          .filter(
            (e): e is Extract<ChatEvent, { type: "assistant-trace" }> =>
              e.type === "assistant-trace" && e.trace.kind === "continuity",
          )
          .map((e) => e.trace);
        expect(traces.length, "no continuity trace was posted").toBeGreaterThan(0);
        const written = traces.find((t) => t.requestId === prompt.id);
        expect(written, "the composed prompt was not traced").toBeDefined();
        expect(written!.prompt).toContain("USER:");
        expect(written!.summary).toContain(prompt.text.slice(0, 20));

        // (d) The composer draft carries the text, so a client that connects
        // mid-countdown sees what is about to be sent.
        expect(h.manager.chatState(h.sessionId)?.draft).toBe(prompt.text);

        // (e) When the window closes the BACKEND sends it — the whole point.
        await h.waitFor(
          () =>
            h.events.some(
              (e) =>
                e.type === "user-message" &&
                e.message.parts.some(
                  (p) => p.type === "text" && p.text === prompt.text,
                ),
            ),
          prompt.delayMs + 30_000,
          "the armed prompt was never sent",
        );
        // Spent, not re-armed: the loop may already be composing the next one.
        expect(h.manager.chatState(h.sessionId)?.autoPrompt?.id).not.toBe(
          prompt.id,
        );
      } finally {
        h.stop();
      }
    }, 240_000);

    it("withdraws the prompt when a human intervenes", async () => {
      const h = harness();
      try {
        h.manager.chatAction(h.sessionId, { type: "prompt", text: ASK_BACK });
        await h.waitFor(
          () => !!armed(h.events),
          160_000,
          "the backend never armed a continuity prompt",
        );
        const prompt = armed(h.events)!.prompt;

        // What ChatView sends the instant the user touches the composer.
        h.manager.chatAction(h.sessionId, {
          type: "cancel-auto-prompt",
          id: prompt.id,
        });
        expect(h.manager.chatState(h.sessionId)?.autoPrompt).toBeNull();

        // Well past the window: nothing was sent, and the text is still there
        // to edit.
        await settle(prompt.delayMs + 3_000);
        const sent = h.events.filter(
          (e) =>
            e.type === "user-message" &&
            e.message.parts.some(
              (p) => p.type === "text" && p.text === prompt.text,
            ),
        );
        expect(sent, "a withdrawn prompt was sent anyway").toHaveLength(0);
        expect(h.manager.chatState(h.sessionId)?.draft).toBe(prompt.text);
      } finally {
        h.stop();
      }
    }, 240_000);

    // The `after-pr` hop, which is otherwise unreachable in a test: it normally
    // follows a real `gh pr merge`. Calling runContinuity directly with
    // `afterPr: true` makes `shouldStartNewSession` fire deterministically (no
    // `taskComplete` verdict involved), leaving the LLM responsible only for
    // writing the prompt — so this pins the SESSION HOP, not a model opinion.
    it("carries the loop into a fresh session and closes the old one", async () => {
      const h = harness({ router: false, newSession: "after-pr" });
      const notes: string[] = [];
      try {
        // One real exchange, so there's a transcript to continue from. (No race:
        // `events` accumulates and the predicate is re-checked per event.)
        h.manager.chatAction(h.sessionId, {
          type: "prompt",
          text: "Read notes.md and summarise it in one sentence.",
        });
        await h.waitFor(
          () =>
            h.events.some((e) => e.type === "busy" && !e.busy) &&
            h.events.some((e) => e.type === "assistant-end"),
          160_000,
          "the first turn never completed",
        );

        const origin = h.sessionId;
        const before = h.manager.list().map((s) => s.id);


        await runContinuity(
          {
            manager: h.manager,
            sessionId: origin,
            folder: DIR,
            note: (_outcome, summary) => notes.push(summary),
            failed: (summary) => notes.push(summary),
          },
          { afterPr: true },
        );

        // (a) A second session was started in the same folder, on the same
        // harness, and it is the one now running.
        const fresh = h.manager.list().find((s) => !before.includes(s.id));
        expect(
          fresh,
          `no fresh session was started; notes: ${notes.join(" | ")}`,
        ).toBeDefined();
        expect(fresh!.folder).toBe(DIR);
        expect(fresh!.harnessId).toBe("claude-local");
        expect(fresh!.status).toBe("running");

        // (b) The old one was deliberately closed — `stopped`, so the UI says
        // "closed" rather than reporting a SIGTERM exit code as a crash.
        expect(h.manager.sessionInfo(origin)?.stopped).toBe(true);

        // (c) The WHOLE checklist came along, or the loop would end at the hop.
        const carried = h.manager.chatState(fresh!.id)?.assistant;
        expect(carried?.continuity.enabled).toBe(true);
        expect(carried?.continuity.newSession).toBe("after-pr");
        expect(carried?.permissions.enabled).toBe(true);
        expect(carried?.enabled, "derived master switch").toBe(true);

        // (d) The prompt is armed on the NEW session, not the dead one.
        const state = h.manager.chatState(fresh!.id);
        expect(state?.autoPrompt, "nothing armed on the fresh session").toBeTruthy();
        expect(state!.autoPrompt!.text.trim().length).toBeGreaterThan(0);
        expect(state!.draft).toBe(state!.autoPrompt!.text);
        expect(h.manager.chatState(origin)?.autoPrompt).toBeNull();

        // (e) The hop is narrated, so the transcript explains the new tab.
        expect(notes.join(" | ")).toContain("fresh session");
      } finally {
        h.stop();
      }
    }, 240_000);
  },
);
