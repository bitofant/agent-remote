// Live end-to-end coverage of the auto-PR git flow (steps 1–3: branch, commit,
// push) against a THROWAWAY LOCAL BARE REMOTE — no GitHub, no `gh` auth, no
// network, no tokens. Until now this half was verified only by hand; the refactor
// that turned `attachAutoPr` into `runAutoPr(ctx, config)` made it directly
// callable, so it can be pinned properly.
//
// Step 4 (open the PR) is steered into its failure path on purpose, by pointing
// `autoPr.harness` at a harness id that doesn't exist: `runPrSession` then fails
// at `manager.start`, reports, and returns null. That covers the PR-agent failure
// path (also previously manual) AND stops the flow deterministically before
// anything would need `gh`. Steps 5–6 stay uncovered — they need a real PR.
//
// It spawns git subprocesses, so it's an e2e (out of `npm test`) even though it
// needs no harness and no endpoint: the branch-name/commit-message generators
// degrade to their deterministic fallbacks when the LLM is unavailable, which is
// itself worth exercising. Self-skips if git is missing.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { SessionManager } from "./sessions/manager.js";
import { runAutoPr } from "./autopr.js";
import { git } from "./git.js";
import { loadConfig } from "./config.js";
import { llmStatus, startLlmPolling } from "./llm.js";
import type { AssistantTrace } from "../shared/protocol.js";
import type { RunContext } from "./turnRouter.js";

const ROOT = mkdtempSync(join(tmpdir(), "agent-remote-autopr-e2e-"));
const ORIGIN = join(ROOT, "origin.git");
const WORK = join(ROOT, "work");

const haveGit = (await git(ROOT, ["--version"])).ok;

/** A repo with a local bare `origin` and one commit on `main`, already pushed. */
async function makeRepo(): Promise<void> {
  await git(ROOT, ["init", "--bare", "-b", "main", ORIGIN]);
  await git(ROOT, ["init", "-b", "main", WORK]);
  await git(WORK, ["config", "user.email", "dev@example.com"]);
  await git(WORK, ["config", "user.name", "Ada Lovelace"]);
  await git(WORK, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(WORK, "README.md"), "# scratch\n");
  await git(WORK, ["add", "-A"]);
  await git(WORK, ["commit", "-m", "initial"]);
  await git(WORK, ["remote", "add", "origin", ORIGIN]);
  await git(WORK, ["push", "-u", "origin", "main"]);
  await git(WORK, ["remote", "set-head", "origin", "main"]);
}

describe.skipIf(!haveGit)("auto-PR: branch, commit, push to a local remote", () => {
  const notes: AssistantTrace["summary"][] = [];
  const outcomes: AssistantTrace["outcome"][] = [];

  beforeAll(async () => {
    // Prefer the real path — the LLM names the branch and writes the subject,
    // and its output has to survive sanitizeBranchName/sanitizeCommitMessage.
    // With no config/endpoint the generators return null and the deterministic
    // fallbacks take over; every assertion below holds either way, on purpose.
    try {
      startLlmPolling(loadConfig().llm);
      for (let i = 0; i < 20 && !llmStatus().available; i++)
        await new Promise((r) => setTimeout(r, 300));
    } catch {
      // No config.json — run the fallback path.
    }
    await makeRepo();
    // The uncommitted work the flow is supposed to land.
    writeFileSync(join(WORK, "feature.txt"), "a small new feature\n");

    const manager = new SessionManager(new Map());
    const ctx: RunContext = {
      manager,
      // No chat session: runAutoPr reads assistant settings defensively, so it
      // proceeds with autoMerge off — which is what keeps this test off `gh`.
      sessionId: "no-session",
      folder: WORK,
      note: (outcome, summary) => {
        outcomes.push(outcome);
        notes.push(summary);
      },
      failed: (summary) => {
        outcomes.push("error");
        notes.push(summary);
      },
    };
    await runAutoPr(ctx, { harness: "no-such-harness", command: "/pr" });
  }, 180_000);

  it("cuts a branch named after the committer, off main", async () => {
    const branch = (await git(WORK, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    expect(branch).not.toBe("main");
    // `derivePrefix` takes the first word of user.name, stripped to [a-z0-9._-].
    expect(branch.startsWith("ada/")).toBe(true);
    expect(notes.join(" | ")).toContain(`Created branch ${branch}`);
  });

  it("commits the working tree with a single-line subject", async () => {
    expect((await git(WORK, ["status", "--porcelain"])).stdout.trim()).toBe("");
    const subject = (await git(WORK, ["log", "-1", "--pretty=%s"])).stdout.trim();
    expect(subject.length).toBeGreaterThan(0);
    expect(subject).not.toContain("\n");
    expect(subject.length).toBeLessThanOrEqual(72);
    // The new file is in that commit, not just in the tree.
    const files = (await git(WORK, ["show", "--name-only", "--pretty=", "HEAD"])).stdout;
    expect(files).toContain("feature.txt");
  });

  it("pushes the branch to origin and says so", async () => {
    const branch = (await git(WORK, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const local = (await git(WORK, ["rev-parse", "HEAD"])).stdout.trim();
    // Read the BARE repo directly — proof it really arrived, not just a local ref.
    const remote = (await git(ORIGIN, ["rev-parse", branch])).stdout.trim();
    expect(remote).toBe(local);
    expect(notes.join(" | ")).toContain(`Pushed ${branch} to origin`);
  });

  it("reports the PR step failing instead of throwing", () => {
    // Step 4 could not start its harness; the flow must stop and narrate it.
    expect(notes.join(" | ")).toContain("Could not start the no-such-harness session");
    expect(outcomes).toContain("error");
    // And with autoMerge off it never reached merge / back-to-main.
    expect(notes.join(" | ")).not.toContain("Merged");
    expect(notes.join(" | ")).not.toContain("Back on main");
  });

  it("leaves main untouched — the work only exists on the branch", async () => {
    const mainFiles = (await git(WORK, ["ls-tree", "--name-only", "main"])).stdout;
    expect(mainFiles).toContain("README.md");
    expect(mainFiles).not.toContain("feature.txt");
  });
});
