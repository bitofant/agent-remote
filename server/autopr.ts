// Harness-agnostic auto-PR capability of AI-assistant mode. When a session
// enables it, this server-global subscriber runs the PR flow whenever the
// session's turn settles (the same busy:false hook suggestions.ts uses), or on
// demand from the dialog's "Run now" (the `run-auto-pr` action, observed via
// SessionListener.onChatAction). Like assistant.ts it lives in the backend and
// is driven from index.ts, so it runs with no browser open.
//
// The flow, in the session's launch folder:
//   1. branch  — if on the integration branch, cut `<user>/<llm-slug>`
//   2. commit  — `git add -A` + an LLM-written one-line subject
//   3. push    — `git push -u origin <branch>`
//   4. PR      — drive a real `pi /pr` session (server/prAgent.ts)
//   5. merge   — `gh pr merge --squash --delete-branch`   } only when
//   6. main    — checkout + fast-forward the integration branch  } `autoMerge`
// Every step narrates itself into the origin session's transcript as an AI-mode
// note. Everything is best-effort: a failed step reports and stops, never throws.
import type { SessionManager } from "./sessions/manager.js";
import type { ChatState } from "../shared/protocol.js";
import type { AutoPrConfig } from "./config.js";
import {
  branchExists,
  branchPrefix,
  currentBranch,
  fallbackSlug,
  gh,
  git,
  hasDiffVsBase,
  isDirty,
  isRepo,
  mainBranch,
  sanitizeBranchName,
  sanitizeCommitMessage,
  stagedDiff,
  stagedFileCount,
  workingDiff,
} from "./git.js";
import { suggestBranchName, suggestCommitMessage } from "./llm.js";
import { runPrSession } from "./prAgent.js";

/** How many commit-message attempts before falling back to a generic subject. */
const COMMIT_ATTEMPTS = 3;

/** Whether a settled session should auto-open a PR: the capability is on, the
 * session is idle with no pending card or queued prompt, and a real exchange
 * happened. Exported for testing. */
export function shouldRunAutoPr(state: ChatState): boolean {
  if (!state.assistant.autoPr.enabled) return false;
  if (state.busy) return false;
  if (state.pendingRequests.length > 0) return false;
  if (state.queued.length > 0) return false;
  return (
    state.messages.some((m) => m.role === "user") &&
    state.messages.some((m) => m.role === "assistant")
  );
}

/** What the repo state implies for this run. Pure, so the branching is testable:
 * - `nothing`  — clean tree and no divergence from the base: just go back to main
 * - `commit`   — uncommitted work to land before opening a PR
 * - `pr-only`  — nothing to commit, but the branch already differs from the base
 */
export function decideFlow(input: {
  dirty: boolean;
  onMain: boolean;
  diffVsBase: boolean;
}): "nothing" | "commit" | "pr-only" {
  if (input.dirty) return "commit";
  // On the integration branch with a clean tree there is by definition nothing
  // to propose, whatever `diffVsBase` says (it compares the branch to itself).
  if (input.onMain) return "nothing";
  return input.diffVsBase ? "pr-only" : "nothing";
}

/** Subscribe the backend auto-PR runner to the manager. Returns an unsubscribe.
 * Call once at boot (from index.ts). */
export function attachAutoPr(
  manager: SessionManager,
  config?: AutoPrConfig,
): () => void {
  const harnessId = config?.harness ?? "pi";
  const command = config?.command ?? "/pr";

  // Single-flight per session: a turn settling and a "Run now" can land
  // together, and opening two PRs for one turn isn't recoverable. Spans the
  // whole async flow, not just its first tick.
  const running = new Set<string>();

  /** Post one AI-mode note into the session's transcript. No prompt/response —
   * no LLM was consulted about it — so it renders as a one-liner. */
  const note = (
    sessionId: string,
    outcome: "note" | "error",
    summary: string,
    reason?: string,
  ) => {
    manager.postAssistantTrace(sessionId, {
      requestId: `auto-pr:${Date.now()}`,
      kind: "auto-pr",
      outcome,
      reason,
      summary,
      at: Date.now(),
    });
  };

  const run = (sessionId: string) => {
    if (running.has(sessionId)) return;
    running.add(sessionId);
    void flow(sessionId)
      .catch((err: unknown) => {
        note(sessionId, "error", "Auto PR failed", (err as Error).message);
      })
      .finally(() => running.delete(sessionId));
  };

  async function flow(sessionId: string): Promise<void> {
    const folder = manager.sessionFolder(sessionId);
    if (!folder) return;
    const settings = manager.chatState(sessionId)?.assistant.autoPr;
    const instructions = settings?.instructions;
    const autoMerge = settings?.autoMerge ?? false;

    if (!(await isRepo(folder))) {
      note(sessionId, "error", "Not a git repository", folder);
      return;
    }

    const base = await mainBranch(folder);
    // Best-effort refresh so the base comparison and the later pull are honest.
    await git(folder, ["fetch", "origin", base], 60_000);
    const branch = await currentBranch(folder);
    const onMain = branch === base || branch === null;
    const dirty = await isDirty(folder);
    const diffVsBase = await hasDiffVsBase(folder, `origin/${base}`);

    const plan = decideFlow({ dirty, onMain, diffVsBase });
    if (plan === "nothing") {
      note(sessionId, "note", "Nothing to open a PR for", "returning to " + base);
      await returnToBase(sessionId, folder, base);
      return;
    }

    // --- 1. branch ---------------------------------------------------------
    let working = branch;
    if (onMain) {
      working = await cutBranch(sessionId, folder, instructions);
      if (!working) return;
    }

    // --- 2. commit ---------------------------------------------------------
    if (dirty && !(await commitAll(sessionId, folder, instructions))) return;

    // --- 3. push -----------------------------------------------------------
    const push = await git(
      folder,
      ["push", "-u", "origin", working ?? "HEAD"],
      180_000,
    );
    if (!push.ok) {
      note(sessionId, "error", "Push failed", push.stderr.trim().split("\n")[0]);
      return;
    }
    note(sessionId, "note", `Pushed ${working}`, "origin");

    // --- 4. PR -------------------------------------------------------------
    note(sessionId, "note", "Opening the PR", `${harnessId} ${command}`);
    const pr = await runPrSession(manager, {
      folder,
      harnessId,
      command,
      instructions,
      report: (summary, detail) => note(sessionId, "error", summary, detail),
    });
    if (!pr) return;
    const label = pr.prNumber != null ? `PR #${pr.prNumber}` : "PR";
    note(sessionId, "note", `${label} created`, pr.prUrl ?? undefined);

    if (!autoMerge) return;

    // --- 5. merge ----------------------------------------------------------
    const target = pr.prNumber != null ? String(pr.prNumber) : pr.prUrl;
    if (!target) {
      note(sessionId, "error", "Cannot merge", "no PR reference was reported");
      return;
    }
    const merge = await gh(folder, [
      "pr",
      "merge",
      target,
      "--squash",
      "--delete-branch",
    ]);
    if (!merge.ok) {
      note(sessionId, "error", `Merging ${label} failed`, merge.stderr.trim().split("\n")[0]);
      return;
    }
    note(sessionId, "note", `${label} merged`, "squash");

    // --- 6. back to main ---------------------------------------------------
    await returnToBase(sessionId, folder, base);
  }

  /** Cut `<prefix>/<slug>` off the current commit, naming it via the LLM with a
   * deterministic fallback. Returns the new branch, or null if checkout failed. */
  async function cutBranch(
    sessionId: string,
    folder: string,
    instructions?: string,
  ): Promise<string | null> {
    const prefix = await branchPrefix(folder);
    const suggested = await suggestBranchName(await workingDiff(folder), instructions);
    const slug = sanitizeBranchName(suggested) ?? fallbackSlug();
    let name = `${prefix}/${slug}`;
    for (let n = 2; await branchExists(folder, name); n++) name = `${prefix}/${slug}-${n}`;

    const checkout = await git(folder, ["checkout", "-b", name]);
    if (!checkout.ok) {
      note(sessionId, "error", "Could not create branch", checkout.stderr.trim());
      return null;
    }
    note(sessionId, "note", `Branched ${name}`, undefined);
    return name;
  }

  /** Stage everything and commit it with an LLM-written subject. */
  async function commitAll(
    sessionId: string,
    folder: string,
    instructions?: string,
  ): Promise<boolean> {
    const add = await git(folder, ["add", "-A"]);
    if (!add.ok) {
      note(sessionId, "error", "Could not stage changes", add.stderr.trim());
      return false;
    }
    const diff = await stagedDiff(folder);
    const rejected: string[] = [];
    let message: string | null = null;
    for (let i = 0; i < COMMIT_ATTEMPTS && !message; i++) {
      const raw = await suggestCommitMessage(diff, instructions, rejected);
      if (!raw) break; // Endpoint down — retrying won't help.
      message = sanitizeCommitMessage(raw);
      if (!message) rejected.push(raw);
    }
    if (!message) {
      const files = await stagedFileCount(folder);
      message = `auto-pr: update ${files} file${files === 1 ? "" : "s"}`;
    }
    // Signing is interactive (git-helper primes a YubiKey touch for exactly
    // this); headless it would hang forever.
    const commit = await git(folder, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      message,
    ]);
    if (!commit.ok) {
      note(sessionId, "error", "Commit failed", commit.stderr.trim().split("\n")[0]);
      return false;
    }
    note(sessionId, "note", "Committed", message);
    return true;
  }

  /** Check out the integration branch and fast-forward it. */
  async function returnToBase(
    sessionId: string,
    folder: string,
    base: string,
  ): Promise<void> {
    const checkout = await git(folder, ["checkout", base]);
    if (!checkout.ok) {
      note(sessionId, "error", `Could not check out ${base}`, checkout.stderr.trim().split("\n")[0]);
      return;
    }
    const pull = await git(folder, ["pull", "--ff-only", "origin", base], 120_000);
    if (!pull.ok) {
      note(sessionId, "error", `Could not update ${base}`, pull.stderr.trim().split("\n")[0]);
      return;
    }
    note(sessionId, "note", `Back on ${base}`, "up to date");
  }

  return manager.subscribe({
    onStarted() {},
    onOutput() {},
    onExit(sessionId) {
      running.delete(sessionId);
    },
    onRemoved(sessionId) {
      running.delete(sessionId);
    },
    onChatAction(sessionId, action) {
      // On demand — deliberately ignores the checkbox.
      if (action.type === "run-auto-pr") run(sessionId);
    },
    onChatEvent(sessionId, event) {
      if (event.type !== "busy" || event.busy) return;
      const state = manager.chatState(sessionId);
      if (state && shouldRunAutoPr(state)) run(sessionId);
    },
  });
}
