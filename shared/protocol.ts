// WebSocket protocol shared by the Node backend and the React frontend.
// This is intentionally harness-agnostic: it describes sessions and terminal
// I/O, never anything specific to Claude Code, pi, or any other agent.

/** A harness the backend is configured to expose. */
export interface HarnessInfo {
  id: string;
  name: string;
}

/** How the browser renders a session: a raw terminal (xterm) or a chat-bubble
 * conversation. Declared by the harness adapter, not chosen by the UI. */
export type SessionUi = "terminal" | "chat";

/** A live or finished agent session. */
export interface SessionInfo {
  id: string;
  harnessId: string;
  harnessName: string;
  /** The folder this session belongs to: its launch cwd, fixed for its whole
   * life. This — never `cwd` — is what the UI groups sessions by. */
  folder: string;
  /** Live working directory, kept in sync by shell integration: it drifts with
   * every `cd`, so it's display/logging only (see `folder`). */
  cwd: string;
  ui: SessionUi;
  status: "running" | "exited";
  exitCode: number | null;
  /** We terminated it (Stop/Close, or a backend flow like auto-PR finishing)
   * rather than the harness dying on its own — so the UI can say "closed"
   * instead of reporting SIGTERM's non-zero exit code as a failure. */
  stopped?: boolean;
  createdAt: number;
  /** Command line currently executing in the session, or null when idle at the
   * prompt. Kept live by shell integration; always null for harnesses without
   * it (and while at the shell prompt). */
  currentCommand: string | null;
}

/** A working directory the user has launched sessions in, remembered across
 * restarts and ordered by most recent use. */
export interface FolderInfo {
  path: string;
  lastUsedAt: number;
}

/** Which folder/tab a user was last looking at, persisted per user so a fresh
 * page load on another device opens the same view (`GET/PUT /api/view`).
 * Restored on load only — never live-synced, so two open browsers don't yank
 * each other's view around. */
export interface ViewState {
  folder: string | null;
  /** Live session id, or null. Editor tabs are client-only, so an id that no
   * longer exists just falls back to the folder's default tab. */
  sessionId: string | null;
}

/** A previously-run chat session that can be resumed. Persisted per folder and
 * surfaced by `GET /api/resumable?cwd=…`; `resumeKey` is the opaque,
 * harness-native handle passed back on a resuming `start`. */
export interface ResumableSession {
  resumeKey: string;
  harnessId: string;
  harnessName: string;
  /** First user prompt (first line), or "" if the session never got one. */
  title: string;
  updatedAt: number;
}

/** Executables/commands available for the command builder, for a given cwd.
 * Returned by `GET /api/commands?cwd=…`. Purely filesystem-derived: the static
 * argument catalog for well-known commands lives client-side. */
export interface CommandListing {
  /** Executable files in the cwd itself (names without a leading `./`). */
  local: string[];
  /** Executables found on `$PATH` (deduped, sorted). */
  path: string[];
  /** Shell aliases, read from the user's interactive shell. */
  aliases: { name: string; value: string }[];
  /** Most-recently-run commands (deduped, newest first), from shell history. */
  recent: string[];
  /** Most-frequently-run commands (by count, descending), from shell history. */
  frequent: string[];
}

/** One entry in a directory listing for the file editor. `type` is "dir" for a
 * subfolder (expandable) or "file" for an openable file. Paths are always
 * relative to the folder root the listing was requested for. */
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** A directory listing under a folder root, returned by `GET /api/files`. */
export interface DirListing {
  /** Path (relative to the root) of the listed directory; "" for the root. */
  path: string;
  entries: FileEntry[];
}

/** A file's text content, returned by `GET /api/file`. Binary or oversized
 * files are refused server-side rather than returned. */
export interface FileContent {
  path: string;
  content: string;
}

/** Subdirectories of one directory, returned by `GET /api/browse?path=` for the
 * add-folder picker. Paths are absolute and canonical (trailing slash), so the
 * client can key its tree by them and send one straight back as a folder. */
export interface BrowseListing {
  path: string;
  /** Parent directory, or null at the filesystem root. */
  parent: string | null;
  entries: { name: string; path: string }[];
  /** Set when the directory had more subfolders than the server returns. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Optional LLM assist (best-effort). An OpenAI-compatible endpoint (default
// local vLLM) can judge permission prompts / answer questions on the user's
// behalf. Entirely additive: any failure degrades to the normal manual UI.
// These are REST-only payloads (no WS/reducer involvement).
// ---------------------------------------------------------------------------

/** Health of the configured LLM endpoint, returned by `GET /api/llm-status`.
 * `available` is false whenever the endpoint is unreachable or reports no
 * models; the UI treats that as "assist unavailable" and never errors. */
export interface LlmStatus {
  available: boolean;
  /** Resolved model id in use (first from /v1/models when configured
   * "default"), or null when unavailable. */
  model: string | null;
}

/** Request body for `POST /api/llm-evaluate`. Mirrors a pending
 * `ChatUiRequest` plus the session's assistant-mode instructions/capabilities.
 * Harness-agnostic. */
export interface LlmEvaluateRequest {
  kind: "confirm" | "select" | "input" | "questions";
  /** The tool a permission prompt is about, if any. */
  tool?: { name: string; args?: unknown };
  /** Choices for a `select` permission prompt. */
  options?: ChatUiOption[];
  /** Structured questions for a `questions` prompt. */
  questions?: ChatQuestion[];
  /** Free-text user instructions (may be empty → default safety rubric). */
  instructions: string;
  /** The session's workspace root (its launch folder). Lets the default rubric
   * auto-allow file edits/writes whose target path is inside it or a subfolder. */
  workspace?: string;
  /** For `questions`: abstain unless the right option is unambiguous. */
  onlyIfSure?: boolean;
  capabilities: { permissions: boolean; questions: boolean };
}

/** Normalized LLM decision, returned by `POST /api/llm-evaluate`. `available`
 * is false when the endpoint couldn't be used; otherwise `action` says what the
 * UI should do. `none` = abstain (leave for the user). */
export interface LlmDecision {
  available: boolean;
  action?: "allow" | "deny" | "answer" | "none";
  /** Terse reason (shown when denying). */
  reason?: string;
  /** Answers for a `questions` prompt: question text → chosen label(s). */
  answers?: Record<string, string>;
  /** Diagnostic trace of the deliberation: the prompt sent to the LLM, its
   * surfaced reasoning, and the raw response. Present whenever the endpoint was
   * actually queried (even on abstain/error), so the UI can show what AI-mode
   * did. */
  trace?: { prompt: string; thoughts?: string; response: string };
}

/** A dynamically-resolved argument suggestion (e.g. a live container name).
 * Returned by `GET /api/resolve?id=…&cwd=…`. */
export interface CommandArgSuggestion {
  value: string;
  detail?: string;
}

/** Result of running a named argument resolver. `error` is set (with an empty
 * `suggestions`) when the underlying command failed (e.g. docker daemon down) —
 * the builder still allows free-text in that case. */
export interface CommandResolveResult {
  suggestions: CommandArgSuggestion[];
  error?: string;
}

/** A structured event observed inside a session by shell integration: a command
 * starting, a command finishing, or the working directory changing. Produced by
 * harnesses that support it (currently the shell); harness-agnostic in shape. */
export type SessionEvent =
  | { type: "command-start"; command: string; at: number }
  | { type: "command-end"; exitCode: number; at: number }
  | { type: "cwd"; cwd: string; at: number };

// ---------------------------------------------------------------------------
// Chat sessions. Harnesses whose adapter speaks a structured protocol render
// as chat bubbles instead of a terminal. Everything here is normalized and
// harness-agnostic: the adapter translates its agent's wire format into these
// shapes, so the UI and session layer never see harness specifics.
// ---------------------------------------------------------------------------

/** One block of a chat message. Tool parts are updated in place as the agent
 * streams execution output (cumulative, capped). */
export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      toolId: string;
      name: string;
      /** Harness-provided arguments, opaque JSON. */
      args?: unknown;
      /** Cumulative textual output so far (replaced on each update). */
      output: string;
      status: "pending" | "running" | "done" | "error";
    }
  /** An image the user attached to a prompt. Carries only a lightweight
   * reference (never base64) so ChatState snapshots stay small; `url` points at
   * the auth-gated `GET /api/upload/<id>` serve route. */
  | {
      type: "image";
      id: string;
      mediaType: string;
      name?: string;
      url: string;
    };

/** A reference to a user-uploaded image, produced by `POST /api/upload`. The
 * client sends `{ id, mediaType, name }` on a prompt; the server injects `data`
 * (base64) at send time from the upload store — `data` is server-only and is
 * never sent by the client, persisted, or broadcast. */
export interface ChatImageRef {
  id: string;
  mediaType: string;
  name?: string;
  /** Base64 image bytes. Server-populated at send time; never client-sent. */
  data?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
  createdAt: number;
}

/** One structured multiple-choice question (the `questions` request kind —
 * e.g. Claude's AskUserQuestion tool). Each option carries a human label and
 * an explanatory description. */
export interface ChatQuestion {
  /** The question text (also the key the answer is reported under). */
  question: string;
  /** Short chip label for the question (e.g. "Auth method"). */
  header?: string;
  /** Whether more than one option may be chosen. */
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** One choice on a `select`/`plan` card. `value` is the stable id round-tripped
 * in `ui-response.value`; `label` is display-only (so a harness can enrich the
 * button text without breaking the decode); `intent` carries the semantics so
 * clients/AI-mode never pattern-match on label text. */
export interface ChatUiOption {
  /** Stable id sent back as `ui-response.value`. Never displayed. */
  value: string;
  /** Button text. */
  label: string;
  /** Second line under the label — e.g. the rule an "always" installs. */
  detail?: string;
  /** `accept` = plain approval (AI-mode picks this); `always` = approval +
   * rule/mode change; `reject` = refusal, UI requires a typed reason;
   * `cancel` = back out, no reason. */
  intent?: "accept" | "always" | "reject" | "cancel";
}

/** A blocking question from the agent side (permission prompt etc.). The
 * agent may stall until it is answered. */
export interface ChatUiRequest {
  id: string;
  kind: "confirm" | "select" | "input" | "questions" | "plan";
  title: string;
  /** For `plan`: the proposed plan (markdown). Also the generic prompt body. */
  message?: string;
  /** Choices, for `select`; also the accept/keep-planning options for `plan`. */
  options?: ChatUiOption[];
  /** Placeholder/prefill hint, for `input` only. */
  placeholder?: string;
  /** Structured questions, for `questions` only. */
  questions?: ChatQuestion[];
  /** The tool a permission `select` is about, so the card can render the same
   * rich view (diff/code/path/…) the transcript uses instead of raw arg JSON.
   * Harness-agnostic — the client folds `{ name, args }` through `toolView`. */
  tool?: { name: string; args?: unknown };
}

/** A model the session can switch to. */
export interface ChatModel {
  id: string;
  label: string;
  description?: string;
}

/** A permission/behaviour mode the session can switch between at runtime
 * (e.g. Claude's default / plan / accept-edits / auto). Harness-defined. */
export interface ChatMode {
  id: string;
  label: string;
  description?: string;
}

/** A slash command the session exposes (invoked by sending its text as a
 * prompt beginning with `/`). */
export interface ChatCommand {
  name: string;
  description?: string;
}

/** One rate-limit window's utilization, rendered as a progress bar in the
 * usage indicator. */
export interface ChatUsageWindow {
  /** Stable key (e.g. "five_hour", "seven_day", "seven_day_opus"). */
  key: string;
  /** Human label ("5-hour", "Week — all models", "Week — Opus"). */
  label: string;
  /** Percent of the window used, 0–100, or null if unknown. */
  utilization: number | null;
  /** ISO 8601 timestamp when the window resets, or null. */
  resetsAt: string | null;
}

/** Normalized `/usage` snapshot: plan rate-limit utilization plus session cost.
 * Emitted by harnesses that expose it (claude); harnesses that don't never emit
 * a `usage` event, so `ChatState.usage` stays null. `available` is false for
 * API-key / local / 3rd-party sessions where plan limits don't apply — the UI
 * then shows "not available" instead of bars. Harness-agnostic. */
export interface ChatUsage {
  /** Whether plan rate limits apply (false → no `windows`, show a notice). */
  available: boolean;
  /** Subscription tier ('pro' | 'max' | 'team' | 'enterprise') or null. */
  subscriptionType: string | null;
  /** Rate-limit windows to chart (only populated when `available`). */
  windows: ChatUsageWindow[];
  /** Cost accrued by the current session, USD. */
  sessionCostUsd: number;
  /** Capture time (ms since epoch). */
  at: number;
}

/** Per-chat-session AI-assistant mode. Lives in `ChatState` (owned by the
 * backend, replayed on connect, synced to every client) so the SERVER can
 * auto-answer permission/question cards via the optional LLM even when no
 * browser is connected. Toggled from the UI via the `set-assistant` action. */
export interface AssistantSettings {
  /** DERIVED master switch: true iff some capability below is enabled.
   * Recomputed by the manager on every `set-assistant`, never trusted from a
   * client, so it can't drift from the checklist. */
  enabled: boolean;
  /** Auto-answer tool permission prompts (`select`/`confirm`). */
  permissions: AssistantCapability;
  /** Auto-answer AskUserQuestion dialogs (`questions`). */
  questions: AssistantCapability & {
    /** Abstain unless the right option is unambiguous. */
    onlyIfSure: boolean;
  };
  /** Open a PR for the session's work when its turn settles. */
  autoPr: AssistantCapability & { autoMerge: boolean };
  /** Keep the agent working: when a settled turn didn't finish the job, write
   * the developer's next message from the transcript and send it. */
  continuity: AssistantCapability & { newSession: ContinuityNewSession };
}

/** When Continuity Mode clears the context and starts a fresh session instead
 * of replying in the current one:
 * - `never`    — always continue in place
 * - `after-pr` — only once auto-PR has merged the work (the default)
 * - `always`   — that, plus whenever the LLM judges the task complete */
export type ContinuityNewSession = "never" | "after-pr" | "always";

/** One capability of AI-assistant mode: on/off plus its own free-text
 * instructions, so the capabilities don't fight over one shared box. */
export interface AssistantCapability {
  enabled: boolean;
  /** Free-text user instructions (empty → the capability's default rubric). */
  instructions: string;
}

/** The backend AI-assistant's verdict on a pending card, broadcast to every
 * client so they render the SAME countdown UI they always have. Auto-acting
 * verdicts (accept/confirm/answer) show a ring for `delayMs`, then the BACKEND
 * applies them — so it happens with or without a browser open. `deny` never
 * auto-acts: it highlights Deny + prefills the reason for a human to confirm. */
export interface AssistantDecision {
  requestId: string;
  action: "accept" | "confirm" | "answer" | "deny";
  /** For `accept`: the option label the countdown will choose. */
  value?: string;
  /** For `answer`: question text → chosen label(s). */
  answers?: Record<string, string>;
  /** For `deny`: terse reason, prefilled into the note field. */
  reason?: string;
  /** Grace window (ms) before an auto-acting verdict is applied. */
  delayMs: number;
}

/** A prompt Continuity Mode composed on the developer's behalf and is about to
 * send. Same split as AssistantDecision: the text sits in the composer behind a
 * countdown ring on Send, but the BACKEND owns the timer and sends it — so the
 * loop continues with no browser open. Cleared when it fires or a human
 * intervenes (typing, or `cancel-auto-prompt`). */
export interface AutoPrompt {
  id: string;
  text: string;
  /** Grace window (ms) before it is sent — scaled to how long a human would
   * take to read the agent's last message and type this reply. */
  delayMs: number;
  /** When the countdown started, so a client joining mid-sweep renders the
   * remaining slice instead of restarting the animation. */
  at: number;
}

/** A record of one AI-assistant deliberation over a pending card: the prompt
 * sent to the LLM, the model's surfaced reasoning/response, and a one-line
 * summary of the resulting decision. Surfaced in the transcript as a
 * collapsible AI-mode bubble so the user can see what AI-mode did and why.
 * Transient/diagnostic — capped in ChatState, not persisted across restarts. */
export interface AssistantTrace {
  /** Id of the card this deliberation was about, or a synthetic id
   * (`auto-pr:<at>`) for AI-mode notes that aren't about a card. */
  requestId: string;
  /** Which dialog kind was judged, or the backend capability that ran. */
  kind: "confirm" | "select" | "questions" | "auto-pr" | "continuity";
  /** The full prompt sent to the LLM (system + user), when one was sent. */
  prompt?: string;
  /** The model's surfaced reasoning, if any (e.g. `reasoning_content`). */
  thoughts?: string;
  /** The raw model response text, when an LLM was called. */
  response?: string;
  /** Structured outcome for the trace bubble's colored verdict word:
   * allow (green) / deny (red) / answer / abstain / error / note (neutral). */
  outcome: "allow" | "deny" | "answer" | "abstain" | "error" | "note";
  /** Terse reason for the outcome, shown inline after the verdict/summary. */
  reason?: string;
  /** Long-form detail a note expands into (e.g. a git step's full stderr), for
   * notes that consulted no LLM and so have no prompt/response to show. */
  detail?: string;
  /** One-line outcome summary (e.g. "Allowed", "Denied — …", "Pushed x to
   * origin"). For a deliberation the bubble shows the verdict word instead (the
   * LLM's answer is the point); for a note it IS the line, so write it as a
   * self-contained sentence — the reason is only ever a trailing detail. */
  summary: string;
  at: number;
  /** Id of the assistant message this deliberation belongs to (the turn whose
   * tool call the card was about), so the UI can render it inline right after
   * that turn instead of pinned at the bottom. Assigned by the reducer when the
   * trace is folded in. */
  anchorMessageId?: string;
}

/** Optional features a chat harness supports, reported once at session start.
 * Absent flags mean "unsupported" — the UI gates its affordances on these so a
 * harness without them (pi) never shows a control it can't honour. */
export interface ChatCapabilities {
  /** Can rewind the conversation to an earlier user prompt (`rewind` action). */
  rewind?: boolean;
  /** Rewinding can additionally restore files changed since that prompt. */
  rewindFiles?: boolean;
}

/** Dry-run answer to "what would rewinding to this prompt do to my files?" —
 * requested via the `rewind-preview` action, shown in the confirm dialog. */
export interface RewindPreview {
  /** The user message the preview is about. */
  messageId: string;
  canRewind: boolean;
  /** Why not, when `canRewind` is false. */
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/** Full renderable state of a chat session. The server snapshots this on
 * (re)connect; both sides keep it current via `applyChatEvent`. */
export interface ChatState {
  messages: ChatMessage[];
  /** Assistant message currently streaming, or null when idle. */
  streaming: ChatMessage | null;
  busy: boolean;
  pendingRequests: ChatUiRequest[];
  /** Steering/follow-up text queued behind the current run. */
  queued: string[];
  /** Transient notices (errors, retries); capped. */
  notices: { level: "info" | "warning" | "error"; text: string; at: number }[];
  /** Models the session can switch between (empty if the harness doesn't
   * report any). */
  models: ChatModel[];
  /** Id of the currently selected model, or null if unknown/unsupported. */
  currentModel: string | null;
  /** Permission/behaviour modes the session can switch between (empty if the
   * harness doesn't report any). */
  modes: ChatMode[];
  /** Id of the current mode, or null if unknown/unsupported. */
  currentMode: string | null;
  /** Slash commands the session exposes (empty if none/unsupported). */
  commands: ChatCommand[];
  /** Latest `/usage` snapshot for the usage indicator, or null until fetched /
   * for harnesses that don't report usage. */
  usage: ChatUsage | null;
  /** Predicted next user prompts (the follow-ups the TUI suggests), 0–3 and
   * substantially distinct. Set by a `prompt-suggestion` event after a turn;
   * cleared on the next prompt. Empty for harnesses that report none. Native
   * harnesses (Claude) contribute a single one; the synthesized generator may
   * offer several. */
  promptSuggestions: string[];
  /** Backend-owned AI-assistant mode for this session (see AssistantSettings).
   * The server auto-answers cards when `enabled`; synced to all clients. */
  assistant: AssistantSettings;
  /** Pending AI-assistant verdicts keyed by request id — what the backend is
   * about to do (drives the countdown ring in each card). Cleared when the
   * request resolves or a user intervenes. */
  autoDecisions: Record<string, AssistantDecision>;
  /** Recent AI-assistant deliberations (prompt/thoughts/response), oldest
   * first, capped. Rendered as collapsible AI-mode bubbles for visibility into
   * what the assistant did. */
  assistantTraces: AssistantTrace[];
  /** Optional features this harness supports (empty = none reported). */
  capabilities: ChatCapabilities;
  /** Latest rewind dry-run result, or null when no dialog is pending. */
  rewindPreview: RewindPreview | null;
  /** The composer's unsent text, kept server-side so a reload/navigation doesn't
   * lose what was being typed (the chat analogue of a terminal's unsubmitted
   * line living in the PTY). Cleared when the prompt is actually sent. */
  draft: string;
  /** Continuity Mode's composed prompt awaiting its grace window, or null.
   * Drives the countdown ring around Send; the backend does the sending. */
  autoPrompt: AutoPrompt | null;
}

/** Normalized streaming events a chat adapter emits. */
export type ChatEvent =
  | { type: "user-message"; message: ChatMessage }
  | { type: "busy"; busy: boolean }
  | { type: "assistant-start"; messageId: string }
  | { type: "part-start"; kind: "text" | "thinking" }
  /** Appends to the last open text/thinking part of the streaming message. */
  | { type: "part-delta"; delta: string }
  | { type: "tool-call"; toolId: string; name: string; args?: unknown }
  | { type: "assistant-end" }
  /** Cumulative output replace; also marks the tool as running. */
  | { type: "tool-update"; toolId: string; output: string }
  | { type: "tool-end"; toolId: string; output: string; isError: boolean }
  | { type: "queue"; queued: string[] }
  | { type: "ui-request"; request: ChatUiRequest }
  | { type: "ui-request-done"; requestId: string }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  /** Available models + the current one (sent on session init). */
  | { type: "models"; models: ChatModel[]; current: string | null }
  /** The current model changed (e.g. via `set-model` or a fallback). */
  | { type: "model-changed"; current: string }
  /** Available permission modes + the current one (sent on session init). */
  | { type: "modes"; modes: ChatMode[]; current: string | null }
  /** The current permission mode changed (e.g. via `set-mode`). */
  | { type: "mode-changed"; current: string }
  /** Available slash commands (sent on init; may be re-sent if they change). */
  | { type: "commands"; commands: ChatCommand[] }
  /** A refreshed `/usage` snapshot (in response to a `usage` action). */
  | { type: "usage"; usage: ChatUsage }
  /** Predicted next user prompts for the composer hints (emitted after a turn;
   * 0–3, substantially distinct). Replaces any prior suggestions. */
  | { type: "prompt-suggestion"; suggestions: string[] }
  /** AI-assistant mode changed (toggle/config). Server-authoritative; folded
   * into ChatState and fanned out to every client. */
  | { type: "assistant-config"; settings: AssistantSettings }
  /** The backend AI-assistant decided how to answer a pending card; clients show
   * the countdown. The backend applies it (or a user intervenes first). */
  | { type: "assistant-decision"; decision: AssistantDecision }
  /** A pending AI-assistant verdict was withdrawn (user intervened, or the
   * request resolved) — clients drop its countdown. */
  | { type: "assistant-decision-cleared"; requestId: string }
  /** The backend AI-assistant deliberated over a card (whenever the LLM was
   * queried). Folded into ChatState as a collapsible AI-mode bubble. */
  | { type: "assistant-trace"; trace: AssistantTrace }
  /** Optional features this harness supports (sent on session init). */
  | { type: "capabilities"; capabilities: ChatCapabilities }
  /** The conversation was rewound to just before this user message: drop it and
   * everything after it, and reset in-flight state. Emitted only once the
   * harness has actually truncated its own context. */
  | { type: "rewind"; messageId: string }
  /** Result of a rewind dry-run (or null to clear it). */
  | { type: "rewind-preview"; preview: RewindPreview | null }
  /** The session's unsent composer text changed (typed, or cleared on send).
   * Server-authoritative so every client/reload sees the same draft. */
  | { type: "draft"; text: string }
  /** Continuity Mode armed a prompt: clients show it in the composer with a
   * countdown ring on Send. The backend sends it when the window closes. */
  | { type: "auto-prompt"; prompt: AutoPrompt }
  /** That armed prompt was withdrawn (sent, or a human intervened). Ignored
   * unless the id matches, so a stale clear can't kill a fresher prompt. */
  | { type: "auto-prompt-cleared"; id: string };

/** Actions the browser can take on a chat session. */
export type ChatAction =
  | { type: "prompt"; text: string; images?: ChatImageRef[] }
  | { type: "abort" }
  | {
      type: "ui-response";
      requestId: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
      /** Answers for a `questions` request: question text → chosen label(s)
       * (multi-select joined with ", "). */
      answers?: Record<string, string>;
      /** Free-text reasoning attached to a rejection (Deny/No/Cancel). Fed back
       * to the model as the deny message — the TUI's "No, <why>" flow. */
      note?: string;
    }
  | { type: "set-model"; model: string }
  | { type: "set-mode"; mode: string }
  /** Fetch a fresh `/usage` snapshot; the adapter replies with a `usage` event.
   * No-op for harnesses that don't report usage. */
  | { type: "usage" }
  /** Toggle/configure backend AI-assistant mode for this session. Handled by
   * the manager itself (not the adapter) — harness-agnostic. */
  | { type: "set-assistant"; settings: AssistantSettings }
  /** User intervened on a card the AI-assistant was about to auto-answer: cancel
   * its pending verdict so only a manual response resolves it. Harness-agnostic. */
  | { type: "cancel-assistant"; requestId: string }
  /** Run the auto-PR flow now, regardless of its checkbox ("Run now"). Carries
   * no state — observed by `server/turnRouter.ts` via
   * `SessionListener.onChatAction` and never forwarded to the adapter.
   * Harness-agnostic. */
  | { type: "run-auto-pr" }
  /** Rewind the conversation to just before this user prompt: interrupt the
   * agent, truncate its context and the transcript, optionally restoring files
   * changed since. The adapter replies with a `rewind` event on success.
   * No-op for harnesses without `capabilities.rewind`. */
  | { type: "rewind"; messageId: string; restoreFiles?: boolean }
  /** Ask what a rewind to this prompt would change on disk (dry run); the
   * adapter replies with a `rewind-preview` event. */
  | { type: "rewind-preview"; messageId: string }
  /** Stash the composer's unsent text so it survives a reload. Handled by the
   * manager itself (not the adapter) — harness-agnostic. */
  | { type: "set-draft"; text: string }
  /** User intervened on a Continuity Mode prompt the backend was about to send:
   * withdraw it (the text stays in the composer to edit). Handled by the manager
   * itself (not the adapter) — harness-agnostic. */
  | { type: "cancel-auto-prompt"; id: string };

/** Messages the browser sends to the backend. */
export type ClientMessage =
  | { type: "start"; harnessId: string; cwd?: string; resume?: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "stop"; sessionId: string }
  | { type: "remove"; sessionId: string }
  | { type: "chatAction"; sessionId: string; action: ChatAction }
  | { type: "addFolder"; path: string }
  | { type: "removeFolder"; path: string };

/** Messages the backend sends to the browser. */
export type ServerMessage =
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "started"; session: SessionInfo }
  | { type: "output"; sessionId: string; data: string }
  /** `stopped` mirrors `SessionInfo.stopped` (we killed it, it didn't die). */
  | {
      type: "exit";
      sessionId: string;
      exitCode: number | null;
      stopped?: boolean;
    }
  | { type: "removed"; sessionId: string }
  | { type: "sessionEvent"; sessionId: string; event: SessionEvent }
  /** Full chat-state snapshot, sent on connect for each chat session (the
   * chat analogue of terminal scrollback replay). */
  | { type: "chatState"; sessionId: string; state: ChatState }
  /** A live incremental chat event; apply with `applyChatEvent`. */
  | { type: "chatEvent"; sessionId: string; event: ChatEvent }
  /** `home` rides along so the client can display paths home-relative (`~/x`);
   * stored paths stay absolute — this is display only. */
  | { type: "folders"; folders: FolderInfo[]; home: string }
  | { type: "error"; message: string; sessionId?: string };
