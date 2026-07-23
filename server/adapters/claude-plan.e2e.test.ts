// Live end-to-end test of plan-mode acceptance on the claude-local harness
// (Claude SDK → local vLLM), so zero Claude tokens. In plan mode Claude drafts a
// plan and calls the ExitPlanMode tool instead of executing. The backend should
// present that as a distinct `plan` request offering two paths:
//   (1) refine — send instructions; the harness stays in plan mode and revises;
//   (2) accept — allow ExitPlanMode (exits plan mode) AND switch to acceptEdits
//       so subsequent edits are auto-accepted.
//
// Asserts the observable backend contract:
//   (a) a plan request (kind "plan") carrying the plan text is emitted;
//   (b) refining keeps the session in plan mode (no acceptEdits switch) and
//       produces a revised plan;
//   (c) accepting switches the permission mode to acceptEdits.
//
// Excluded from the fast gate; run via `npm run test:e2e`. Self-skips unless
// claude-local is enabled and its endpoint answers. Model-dependent (the small
// local model must actually call ExitPlanMode), so it can flake — inherent to e2e.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { claudeLocal, endpointUp, ChatDriver } from "./claude-local.testkit.js";

// Response labels the backend offers on a plan card (kept in sync with claude.ts).
const ACCEPT_PLAN = "Accept plan";
const KEEP_PLANNING = "Keep planning";

const DIR = mkdtempSync(join(tmpdir(), "agent-remote-plan-"));

const local = claudeLocal();
const up = await endpointUp(local?.baseUrl);

describe.skipIf(!local || !up)("claude-local: accept a plan", () => {
  it("refines then accepts, exiting plan mode into acceptEdits", async () => {
    const d = new ChatDriver(local!.create(DIR)).start();

    // Views over the collected events.
    const plans = () =>
      d.events.flatMap((e) =>
        e.type === "ui-request" && e.request.kind === "plan" ? [e.request] : [],
      );
    const modeSwitches = () =>
      d.events.flatMap((e) => (e.type === "mode-changed" ? [e.current] : []));

    // Enter plan mode, then ask for a plan (no execution — just a proposal).
    d.act({ type: "set-mode", mode: "plan" });
    d.send(
      "Plan how to create two small text files (greeting.txt and notes.txt) " +
        "in this folder. Do not create them yet — present a plan for my approval.",
    );

    // (a) A plan request with the plan text is surfaced.
    await d.waitFor(() => plans().length >= 1, 90_000, "no plan was proposed");
    const first = plans()[0];
    expect(first.kind).toBe("plan");
    // The adapter carries the model's plan text through as `message` (the plan
    // card renders it). We assert it's present as a string — its verbosity is
    // the model's business, not our contract, and a small model can be terse.
    expect(typeof first.message).toBe("string");
    expect(first.options).toContain(ACCEPT_PLAN);
    expect(first.options).toContain(KEEP_PLANNING);

    // (b) Refine with instructions → still in plan mode, and a revised plan comes.
    expect(modeSwitches()).not.toContain("acceptEdits");
    d.act({
      type: "ui-response",
      requestId: first.id,
      value: KEEP_PLANNING,
      note: "Also make notes.txt contain the word 'world'.",
    });
    await d.waitFor(() => plans().length >= 2, 90_000, "no revised plan after refine");
    expect(modeSwitches(), "refine must not switch to acceptEdits").not.toContain(
      "acceptEdits",
    );

    // (c) Accept the revised plan → exit plan mode into acceptEdits.
    d.act({ type: "ui-response", requestId: plans()[1].id, value: ACCEPT_PLAN });
    await d.waitFor(
      () => modeSwitches().includes("acceptEdits"),
      30_000,
      "accepting the plan did not switch to acceptEdits",
    );
    d.close();
  }, 200_000);
});
