// Live end-to-end test of the claude-local `usage` action (the data behind the
// `/usage` command). It drives the backend's observable contract:
//   (a) a `usage` action makes the adapter emit exactly one `usage` ChatEvent,
//   (b) the snapshot is normalized (ChatUsage): `available` reflects whether
//       plan rate limits apply, `windows` are utilization/reset pairs, and
//       `sessionCostUsd` is a number, and
//   (c) it folds through the shared reducer into ChatState.usage.
//
// On claude-local the CLI runs against a local vLLM endpoint under a dummy API
// key, so plan rate limits do NOT apply: `available` is false and `windows` is
// empty — a fully deterministic assertion. The real utilization numbers only
// exist on a genuine subscription `claude` session and aren't exercised here.
//
// Zero Claude tokens (everything hits the local endpoint) but a live call, so
// it's excluded from `npm test` (run via `npm run test:e2e`) and self-skips
// unless claude-local is enabled and its endpoint answers.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { emptyChatState, applyChatEvent } from "../../shared/chat.js";
import type { ChatEvent } from "../../shared/protocol.js";
import { claudeLocal, endpointUp, ChatDriver } from "./claude-local.testkit.js";

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-usage-e2e-"));

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

describe.skipIf(!local || !up)("claude-local: usage snapshot", () => {
  it("emits a normalized usage snapshot on the usage action", async () => {
    const driver = new ChatDriver(local!.create(DIR)).start();
    // No prompt needed: the control channel is up right after start (same as
    // supportedModels/supportedCommands), so usage resolves without a turn.
    driver.act({ type: "usage" });
    await driver.waitFor(
      () => driver.events.some((e) => e.type === "usage"),
      40_000,
      "no usage event was emitted",
    );
    driver.close();

    // (a) Exactly one usage event was surfaced.
    const usageEvents = driver.events.filter(
      (e): e is Extract<ChatEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usageEvents.length).toBe(1);
    const u = usageEvents[0].usage;

    // (b) Normalized shape. claude-local is an API-key session → plan limits
    // don't apply, so available is false and there are no windows to chart.
    expect(u.available).toBe(false);
    expect(u.windows).toEqual([]);
    expect(typeof u.sessionCostUsd).toBe("number");
    expect(typeof u.at).toBe("number");

    // (c) Folds through the shared reducer into ChatState.usage.
    let state = emptyChatState();
    for (const e of driver.events) state = applyChatEvent(state, e);
    expect(state.usage).not.toBeNull();
    expect(state.usage!.available).toBe(false);
  }, 60_000);
});
