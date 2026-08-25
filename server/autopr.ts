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
  openPrForBranch,
  sanitizeBranchName,
  sanitizeCommitMessage,
  stagedDiff,
  stagedFileCount,
  workingDiff,
} from "./git.js";
import {
  llmStatus,
  shouldOpenPr,
  suggestBranchName,
  suggestCommitMessage,
} from "./llm.js";
import { messageText } from "./suggestions.js";
import { runPrSession } from "./prAgent.js";

/** How many commit-message attempts before falling back to a generic subject. */
const COMMIT_ATTEMPTS = 3;

/** How much of each side of the exchange the turn gate sees (chars, from the
 * end — the agent's verdict is in its closing lines, not its opening ones). */
const MAX_DIGEST_CHARS = 2_000;

function tail(text: string): string {
  return text.length > MAX_DIGEST_CHARS ? text.slice(-MAX_DIGEST_CHARS) : text;
}

/** How much of a failure's first line fits on a note's single line. */
const MAX_REASON_CHARS = 160;

/** First non-empty line of a command's output, for the inline reason (the whole
 * output goes in the note's expandable `detail`). Exported for testing. */
export function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > MAX_REASON_CHARS
    ? `${line.slice(0, MAX_REASON_CHARS - 1)}…`
    : line;
}

/** Render what the turn gate judges: the developer's last request and the
 * agent's final message. `null` when the transcript doesn't end in an assistant
 * message with content — the agent never actually replied (an interrupt before
 * the first token, say), so there is no finished turn to open a PR for and no
 * point asking the LLM. Exported for testing. */
export function buildTurnDigest(state: ChatState): string | null {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  const reply = messageText(last).trim();
  if (!reply) return null;
  const asked = [...state.messages]
    .reverse()
    .find((m) => m.role === "user");
  const request = asked ? messageText(asked).trim() : "";
  return [
    `The developer asked:\n${tail(request) || "(no prompt on record)"}`,
    `The agent's final message of the turn:\n${tail(reply)}`,
  ].join("\n\n");
}

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

  // The turn each in-flight run belongs to. A run takes minutes (LLM gate, git,
  // a whole PR session) and the developer keeps chatting meanwhile, so without
  // this every note would anchor to whatever message happened to be last when
  // it was posted — the notes would trail the live conversation instead of
  // staying with the turn that triggered them. Pinned once, at run start.
  const anchors = new Map<string, string | undefined>();

  /** Post one AI-mode note into the session's transcript. Usually no
   * prompt/response — no LLM was consulted — so the bubble shows `summary` as
   * its line: write each one as a self-contained sentence ("Pushed x to
   * origin"), with `reason` a trailing detail and never the substance. `detail`
   * expands behind the disclosure; the turn gate passes its trace instead, so
   * its verdict reads like any other deliberation. */
  const note = (
    sessionId: string,
    outcome: "note" | "error" | "allow" | "deny" | "abstain",
    summary: string,
    reason?: string,
    extra?: {
      detail?: string;
      trace?: { prompt: string; thoughts?: string; response: string };
    },
  ) => {
    manager.postAssistantTrace(sessionId, {
      requestId: `auto-pr:${Date.now()}`,
      kind: "auto-pr",
      outcome,
      reason,
      summary,
      detail: extra?.detail,
      at: Date.now(),
      anchorMessageId: anchors.get(sessionId),
      ...extra?.trace,
    });
  };

  /** A failed git/gh step: one red line, the command's whole stderr behind the
   * disclosure — the first line alone regularly omits the actual cause. */
  const failed = (
    sessionId: string,
    summary: string,
    result: { stderr: string },
  ) => {
    const stderr = result.stderr.trim();
    note(sessionId, "error", summary, firstLine(stderr), {
      detail: stderr || undefined,
    });
  };

  /** Ask the LLM whether the turn that just settled actually finished, so an
   * interrupted / errored / question-ending turn doesn't get a PR. Only the
   * automatic path is gated — "Run now" is the developer saying it themselves.
   * Fail-open: an unavailable endpoint or an unusable reply proceeds (auto-PR
   * has never required the endpoint), but says so in the transcript. */
  async function turnFinished(sessionId: string): Promise<boolean> {
    const state = manager.chatState(sessionId);
    const digest = state ? buildTurnDigest(state) : null;
    if (!digest) {
      note(
        sessionId,
        "deny",
        "Skipping the PR",
        "the agent never replied to the last prompt",
      );
      return false;
    }
    if (!llmStatus().available) {
      note(
        sessionId,
        "abstain",
        "Couldn't verify the turn finished",
        "LLM endpoint unavailable — continuing anyway",
      );
      return true;
    }
    const verdict = await shouldOpenPr(digest, state?.assistant.autoPr.instructions);
    if (!verdict) {
      note(
        sessionId,
        "abstain",
        "Couldn't verify the turn finished",
        "no usable verdict — continuing anyway",
      );
      return true;
    }
    note(
      sessionId,
      verdict.open ? "allow" : "deny",
      verdict.open ? "Turn looks finished" : "Skipping the PR",
      verdict.reason || undefined,
      { trace: verdict.trace },
    );
    return verdict.open;
  }

  const run = (sessionId: string, gate: boolean) => {
    if (running.has(sessionId)) return;
    running.add(sessionId);
    const state = manager.chatState(sessionId);
    anchors.set(
      sessionId,
      state?.streaming?.id ?? state?.messages[state.messages.length - 1]?.id,
    );
    // The gate runs inside the single-flight (see flow) so a second settle
    // can't slip a run past it while the verdict is still in flight.
    void flow(sessionId, gate)
      .catch((err: unknown) => {
        const e = err as Error;
        note(sessionId, "error", "Auto PR failed", firstLine(e?.message ?? ""), {
          detail: e?.stack ?? String(err),
        });
      })
      .finally(() => {
        running.delete(sessionId);
        anchors.delete(sessionId);
      });
  };

  async function flow(sessionId: string, gate: boolean): Promise<void> {
    const folder = manager.sessionFolder(sessionId);
    if (!folder) return;
    const settings = manager.chatState(sessionId)?.assistant.autoPr;
    const instructions = settings?.instructions;
    const autoMerge = settings?.autoMerge ?? false;

    if (!(await isRepo(folder))) {
      note(sessionId, "error", "Not a git repository", folder);
      return;
    }

    // Before touching git at all: did this turn actually finish? A stopped,
    // errored or question-ending turn shouldn't even fetch, let alone push.
    if (gate && !(await turnFinished(sessionId))) return;

    const base = await mainBranch(folder);
    // Best-effort refresh so the base comparison and the later pull are honest.
    await git(folder, ["fetch", "origin", base], 60_000);
    const branch = await currentBranch(folder);
    const onMain = branch === base || branch === null;
    const dirty = await isDirty(folder);
    const diffVsBase = await hasDiffVsBase(folder, `origin/${base}`);

    const plan = decideFlow({ dirty, onMain, diffVsBase });
    if (plan === "nothing") {
      note(sessionId, "note", "Nothing to open a PR for", "the tree is clean");
      await returnToBase(sessionId, folder, base);
      return;
    }

    // --- 1. branch ---------------------------------------------------------
    let working = branch;
    if (onMain) {
      working = await cutBranch(sessionId, folder, base, instructions);
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
      failed(sessionId, "Push failed", push);
      return;
    }
    note(sessionId, "note", `Pushed ${working ?? "HEAD"} to origin`);

    // --- 4. PR -------------------------------------------------------------
    // A branch keeps its PR across turns: the push above already updated it, so
    // opening another would be a duplicate (and `/pr` would likely just fail).
    const existing = working ? await openPrForBranch(folder, working) : null;
    let pr: { prNumber: number | null; prUrl: string | null };
    if (existing) {
      pr = { prNumber: existing.number, prUrl: existing.url };
      note(
        sessionId,
        "note",
        `PR #${existing.number} already open`,
        dirty ? "pushed the new commit to it" : "nothing new to add",
      );
    } else {
      note(
        sessionId,
        "note",
        "Drafting the pull request",
        `in a ${harnessId} ${command} session`,
      );
      const opened = await runPrSession(manager, {
        folder,
        harnessId,
        command,
        instructions,
        report: (summary, detail) => note(sessionId, "error", summary, detail),
      });
      if (!opened) return;
      pr = opened;
      const created = pr.prNumber != null ? `PR #${pr.prNumber}` : "the PR";
      note(sessionId, "note", `Opened ${created}`, pr.prUrl ?? undefined);
    }
    const label = pr.prNumber != null ? `PR #${pr.prNumber}` : "PR";

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
      failed(sessionId, `Merging ${label} failed`, merge);
      return;
    }
    note(sessionId, "note", `Merged ${label}`, "squashed, branch deleted");

    // --- 6. back to main ---------------------------------------------------
    await returnToBase(sessionId, folder, base);
  }

  /** Cut `<prefix>/<slug>` off the current commit, naming it via the LLM with a
   * deterministic fallback. Returns the new branch, or null if checkout failed. */
  async function cutBranch(
    sessionId: string,
    folder: string,
    base: string,
    instructions?: string,
  ): Promise<string | null> {
    const prefix = await branchPrefix(folder);
    const suggested = await suggestBranchName(await workingDiff(folder), instructions);
    const slug = sanitizeBranchName(suggested) ?? fallbackSlug();
    let name = `${prefix}/${slug}`;
    for (let n = 2; await branchExists(folder, name); n++) name = `${prefix}/${slug}-${n}`;

    const checkout = await git(folder, ["checkout", "-b", name]);
    if (!checkout.ok) {
      failed(sessionId, `Could not create branch ${name}`, checkout);
      return null;
    }
    note(sessionId, "note", `Created branch ${name}`, `off ${base}`);
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
      failed(sessionId, "Could not stage the changes", add);
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
      failed(sessionId, "Commit failed", commit);
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
      failed(sessionId, `Could not check out ${base}`, checkout);
      return;
    }
    const pull = await git(folder, ["pull", "--ff-only", "origin", base], 120_000);
    if (!pull.ok) {
      failed(sessionId, `Could not update ${base}`, pull);
      return;
    }
    note(sessionId, "note", `Back on ${base}`, `fast-forwarded to origin/${base}`);
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
      // On demand — deliberately ignores the checkbox, and the turn gate: the
      // developer asking for a PR outranks any verdict about how the turn ended.
      if (action.type === "run-auto-pr") run(sessionId, false);
    },
    onChatEvent(sessionId, event) {
      if (event.type !== "busy" || event.busy) return;
      const state = manager.chatState(sessionId);
      if (state && shouldRunAutoPr(state)) run(sessionId, true);
    },
  });
}
