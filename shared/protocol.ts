// WebSocket protocol shared by the Node backend and the React frontend.
// This is intentionally harness-agnostic: it describes sessions and terminal
// I/O, never anything specific to Claude Code, pi, or any other agent.

/** A harness the backend is configured to expose. */
export interface HarnessInfo {
  id: string;
  name: string;
}

/** A live or finished agent session. */
export interface SessionInfo {
  id: string;
  harnessId: string;
  harnessName: string;
  cwd: string;
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

/** Messages the browser sends to the backend. */
export type ClientMessage =
  | { type: "start"; harnessId: string; cwd?: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "stop"; sessionId: string }
  | { type: "remove"; sessionId: string }
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
  | { type: "folders"; folders: FolderInfo[] }
  | { type: "error"; message: string; sessionId?: string };
