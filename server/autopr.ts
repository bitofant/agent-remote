// Harness-agnostic auto-PR capability of AI-assistant mode: the runner
// server/turnRouter.ts calls when a settled turn looks finished (or when the
// dialog's "Run now" asks outright). The router owns the hook, the single-flight
// and the note channel; this file owns the git/PR flow itself. Like assistant.ts
// it lives in the backend, so it runs with no browser open.
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
// A merge that lands hands straight back to Continuity Mode, when it's on.
import type { AutoPrConfig } from "./config.js";
import type { RunContext } from "./turnRouter.js";
import { runContinuity } from "./continuity.js";
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
  openPrForBranch,
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

/**
 * Land the session's work: branch, commit, push, open a PR, and — with
 * `autoMerge` — merge it and hand back to Continuity Mode. Called by
 * server/turnRouter.ts, which owns the settle hook, the single-flight and the
 * note channel.
 *
 * Best-effort: a failed step reports itself into the transcript and stops.
 */
export async function runAutoPr(
  ctx: RunContext,
  config?: AutoPrConfig,
): Promise<void> {
  const harnessId = config?.harness ?? "pi";
  const command = config?.command ?? "/pr";
  const { manager, sessionId, folder, note, failed } = ctx;

  const settings = manager.chatState(sessionId)?.assistant.autoPr;
  const instructions = settings?.instructions;
  const autoMerge = settings?.autoMerge ?? false;

  if (!(await isRepo(folder))) {
    note("error", "Not a git repository", folder);
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
    note("note", "Nothing to open a PR for", "the tree is clean");
    await returnToBase(ctx, base);
    return;
  }

  // --- 1. branch -----------------------------------------------------------
  let working = branch;
  if (onMain) {
    working = await cutBranch(ctx, base, instructions);
    if (!working) return;
  }

  // --- 2. commit -----------------------------------------------------------
  if (dirty && !(await commitAll(ctx, instructions))) return;

  // --- 3. push -------------------------------------------------------------
  const push = await git(
    folder,
    ["push", "-u", "origin", working ?? "HEAD"],
    180_000,
  );
  if (!push.ok) {
    failed("Push failed", push);
    return;
  }
  note("note", `Pushed ${working ?? "HEAD"} to origin`);

  // --- 4. PR ---------------------------------------------------------------
  // A branch keeps its PR across turns: the push above already updated it, so
  // opening another would be a duplicate (and `/pr` would likely just fail).
  const existing = working ? await openPrForBranch(folder, working) : null;
  let pr: { prNumber: number | null; prUrl: string | null };
  if (existing) {
    pr = { prNumber: existing.number, prUrl: existing.url };
    note(
      "note",
      `PR #${existing.number} already open`,
      dirty ? "pushed the new commit to it" : "nothing new to add",
    );
  } else {
    // The session id exists only once it's started, so the "drafting" note is
    // posted from the callback — a beat later, but carrying a link to its tab.
    // The failure notes want it most: a run that hits a bound deliberately
    // LEAVES that session open for a human, who otherwise has to find it by eye.
    let prSession: string | undefined;
    const opened = await runPrSession(manager, {
      folder,
      harnessId,
      command,
      instructions,
      onSession: (id) => {
        prSession = id;
        note(
          "note",
          "Drafting the pull request",
          `in a ${harnessId} ${command} session`,
          { session: id },
        );
      },
      report: (summary, detail) => note("error", summary, detail, { session: prSession }),
    });
    if (!opened) return;
    pr = opened;
    const created = pr.prNumber != null ? `PR #${pr.prNumber}` : "the PR";
    note("note", `Opened ${created}`, pr.prUrl ?? undefined);
  }
  const label = pr.prNumber != null ? `PR #${pr.prNumber}` : "PR";

  if (!autoMerge) return;

  // --- 5. merge ------------------------------------------------------------
  const target = pr.prNumber != null ? String(pr.prNumber) : pr.prUrl;
  if (!target) {
    note("error", "Cannot merge", "no PR reference was reported");
    return;
  }
  const merge = await gh(folder, ["pr", "merge", target, "--squash", "--delete-branch"]);
  if (!merge.ok) {
    failed(`Merging ${label} failed`, merge);
    return;
  }
  note("note", `Merged ${label}`, "squashed, branch deleted");

  // --- 6. back to main -----------------------------------------------------
  await returnToBase(ctx, base);

  // --- 7. keep going -------------------------------------------------------
  // The work landed, so this is the `after-pr` moment: hand to Continuity Mode
  // (a no-op when it's off). Still inside the router's single-flight, with the
  // anchor pinned, so it can't race a settle of its own.
  await runContinuity(ctx, { afterPr: true });
}

/** Cut `<prefix>/<slug>` off the current commit, naming it via the LLM with a
 * deterministic fallback. Returns the new branch, or null if checkout failed. */
async function cutBranch(
  ctx: RunContext,
  base: string,
  instructions?: string,
): Promise<string | null> {
  const { folder, note, failed } = ctx;
  const prefix = await branchPrefix(folder);
  const suggested = await suggestBranchName(await workingDiff(folder), instructions);
  const slug = sanitizeBranchName(suggested) ?? fallbackSlug();
  let name = `${prefix}/${slug}`;
  for (let n = 2; await branchExists(folder, name); n++) name = `${prefix}/${slug}-${n}`;

  const checkout = await git(folder, ["checkout", "-b", name]);
  if (!checkout.ok) {
    failed(`Could not create branch ${name}`, checkout);
    return null;
  }
  note("note", `Created branch ${name}`, `off ${base}`);
  return name;
}

/** Stage everything and commit it with an LLM-written subject. */
async function commitAll(
  ctx: RunContext,
  instructions?: string,
): Promise<boolean> {
  const { folder, note, failed } = ctx;
  const add = await git(folder, ["add", "-A"]);
  if (!add.ok) {
    failed("Could not stage the changes", add);
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
    failed("Commit failed", commit);
    return false;
  }
  note("note", "Committed", message);
  return true;
}

/** Check out the integration branch and fast-forward it. */
async function returnToBase(ctx: RunContext, base: string): Promise<void> {
  const { folder, note, failed } = ctx;
  const checkout = await git(folder, ["checkout", base]);
  if (!checkout.ok) {
    failed(`Could not check out ${base}`, checkout);
    return;
  }
  const pull = await git(folder, ["pull", "--ff-only", "origin", base], 120_000);
  if (!pull.ok) {
    failed(`Could not update ${base}`, pull);
    return;
  }
  note("note", `Back on ${base}`, `fast-forwarded to origin/${base}`);
}
