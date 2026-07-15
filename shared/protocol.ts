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
  cwd: string;
  ui: SessionUi;
  status: "running" | "exited";
  exitCode: number | null;
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
    };

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

/** A blocking question from the agent side (permission prompt etc.). The
 * agent may stall until it is answered. */
export interface ChatUiRequest {
  id: string;
  kind: "confirm" | "select" | "input" | "questions";
  title: string;
  message?: string;
  /** Choices, for `select` only. */
  options?: string[];
  /** Placeholder/prefill hint, for `input` only. */
  placeholder?: string;
  /** Structured questions, for `questions` only. */
  questions?: ChatQuestion[];
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
  | { type: "commands"; commands: ChatCommand[] };

/** Actions the browser can take on a chat session. */
export type ChatAction =
  | { type: "prompt"; text: string }
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
  | { type: "set-mode"; mode: string };

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
  | { type: "exit"; sessionId: string; exitCode: number | null }
  | { type: "removed"; sessionId: string }
  | { type: "sessionEvent"; sessionId: string; event: SessionEvent }
  /** Full chat-state snapshot, sent on connect for each chat session (the
   * chat analogue of terminal scrollback replay). */
  | { type: "chatState"; sessionId: string; state: ChatState }
  /** A live incremental chat event; apply with `applyChatEvent`. */
  | { type: "chatEvent"; sessionId: string; event: ChatEvent }
  | { type: "folders"; folders: FolderInfo[] }
  | { type: "error"; message: string; sessionId?: string };
