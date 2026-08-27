// Coverage for Continuity Mode's plan-rate-limit gate, driven through the real
// SessionManager with a FAKE chat adapter (the manager-exit.e2e.test.ts trick):
// the fake answers a `usage` request with whatever utilization the test wants,
// so the over-limit branch — unreachable against a real harness without actually
// burning a plan to 90% — gets pinned properly. Real reducer, real `chatAction`,
// real draft path; only the harness is fake.
//
// It does need the LLM endpoint, because the gate deliberately runs AFTER the
// prompt is written (composing is near-free locally, and a held-back prompt is
// still worth parking in the composer). Hence e2e, not the pure gate — which
// `usageBlocker`'s own tests in continuity.test.ts cover exhaustively.
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { SessionManager } from "./sessions/manager.js";
import { runContinuity } from "./continuity.js";
import { loadConfig } from "./config.js";
import { llmStatus, startLlmPolling } from "./llm.js";
import type { HarnessAdapter, ChatSession } from "./adapters/types.js";
import type {
  AssistantTrace,
  ChatEvent,
  ChatUsage,
  ChatUsageWindow,
} from "../shared/protocol.js";
import type { RunContext } from "./turnRouter.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let llmUp = false;
try {
  startLlmPolling(loadConfig().llm);
  for (let i = 0; i < 20 && !llmStatus().available; i++) await sleep(300);
  llmUp = llmStatus().available;
} catch {
  // No config.json — the suite skips.
}

function snapshot(windows: ChatUsageWindow[]): ChatUsage {
  return {
    available: true,
    subscriptionType: "max",
    windows,
    sessionCostUsd: 0,
    at: Date.now(),
  };
}

const window = (key: string, utilization: number): ChatUsageWindow => ({
  key,
  label: key,
  utilization,
  resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A chat harness that reports the given usage and echoes prompts, nothing more. */
function fakeAdapter(usage: ChatUsage): Map<string, HarnessAdapter> {
  let emit: ((e: ChatEvent) => void) | null = null;
  const session: ChatSession = {
    start(handlers) {
      emit = handlers.onEvent;
      // A minimal finished exchange, so there's a transcript to continue from.
      emit({
        type: "user-message",
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Add a scope line to notes.md." }],
          createdAt: Date.now(),
        },
      });
      emit({ type: "assistant-start", messageId: "a1" });
      emit({ type: "part-start", kind: "text" });
      emit({
        type: "part-delta",
        delta: "Done — added the scope line. Want me to add a Decisions section next?",
      });
      emit({ type: "assistant-end" });
    },
    action(a) {
      // The only thing the gate asks of a harness.
      if (a.type === "usage") emit?.({ type: "usage", usage });
    },
    close() {},
  };

  return new Map([
    [
      "fake",
      {
        id: "fake",
        name: "Fake",
        invocation: () => ({ command: process.execPath, args: ["-e", ""] }),
        createChatSession: () => session,
      } as HarnessAdapter,
    ],
  ]);
}

/** Start a fake session with continuity on, and run one continuation over it. */
async function continueOver(usage: ChatUsage) {
  const manager = new SessionManager(fakeAdapter(usage));
  const id = manager.start("fake", { cwd: tmpdir() }).id;
  manager.chatAction(id, {
    type: "set-assistant",
    settings: {
      enabled: true,
      permissions: { enabled: false, instructions: "" },
      questions: { enabled: false, instructions: "", onlyIfSure: false },
      autoPr: { enabled: false, instructions: "", autoMerge: false },
      continuity: {
        enabled: true,
        // `after-pr` + afterPr:true below would hop; `never` keeps it in place so
        // the two branches differ only in the usage snapshot.
        instructions: "Keep the work moving; never ask the agent a question back.",
        newSession: "never",
      },
    },
  });

  const notes: AssistantTrace[] = [];
  const ctx: RunContext = {
    manager,
    sessionId: id,
    folder: tmpdir(),
    note: (outcome, summary, reason, extra) =>
      notes.push({
        requestId: "",
        kind: "continuity",
        outcome,
        summary,
        reason,
        detail: extra?.detail,
        at: Date.now(),
      }),
    failed: () => {},
  };
  await runContinuity(ctx, { afterPr: false });
  return { manager, id, notes, sessions: () => manager.list() };
}

describe.skipIf(!llmUp)("Continuity Mode: plan rate-limit gate", () => {
  it("arms the prompt when every window is under the limit", async () => {
    const { manager, id } = await continueOver(
      snapshot([window("five_hour", 40), window("seven_day", 12)]),
    );
    const state = manager.chatState(id);
    expect(state?.autoPrompt, "nothing was armed below the limit").toBeTruthy();
    expect(state!.draft).toBe(state!.autoPrompt!.text);
    manager.stop(id);
  }, 120_000);

  it("writes the prompt but withholds the send when weekly is over", async () => {
    const { manager, id, notes } = await continueOver(
      snapshot([window("five_hour", 20), window("seven_day", 93)]),
    );
    const state = manager.chatState(id);

    // Not armed — no unattended send.
    expect(state?.autoPrompt, "armed a prompt while over the limit").toBeNull();
    // But the work isn't thrown away: it's in the composer, and ChatState.draft
    // persists it, so the developer can just press Send later.
    expect(state!.draft.trim().length).toBeGreaterThan(0);

    const held = notes.find((n) => n.summary.includes("held it back"));
    expect(held, `no hold-back note; got ${notes.map((n) => n.summary)}`).toBeDefined();
    expect(held!.outcome).toBe("deny");
    expect(held!.summary).toContain("93%");
    expect(held!.reason).toContain("press Send");
    // The prompt text and the reset time expand behind the disclosure.
    expect(held!.detail).toContain(state!.draft);
    // No trace: a deliberation bubble would lead with the verdict word and drop
    // the summary that carries the whole message here.
    expect(held!.prompt).toBeUndefined();
    manager.stop(id);
  }, 120_000);

  it("blocks on the session window too, and never hops sessions", async () => {
    const { manager, id, sessions } = await continueOver(
      snapshot([window("five_hour", 96), window("seven_day", 5)]),
    );
    expect(manager.chatState(id)?.autoPrompt).toBeNull();
    // Pausing must not kill the running session or spawn a replacement.
    expect(sessions()).toHaveLength(1);
    expect(manager.sessionInfo(id)?.stopped).toBeFalsy();
    manager.stop(id);
  }, 120_000);
});
