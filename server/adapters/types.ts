// The harness adapter abstraction — the core extension point of agent-remote.
//
// An adapter's only job is to describe HOW to invoke a given agent CLI. All
// process mechanics (PTY, streaming, lifecycle) live in the harness-agnostic
// session layer, so adding a new agent means writing a new adapter here and
// nothing else. Keep harness-specific logic confined to this directory.

import type { SessionEvent } from "../../shared/protocol.js";

export interface SessionOptions {
  /** Working directory the agent should run in. */
  cwd: string;
}

/** A stateful parser fed raw PTY output chunks. It extracts structured session
 * events (e.g. from shell-integration escape sequences) and returns the output
 * with any of those sequences stripped, so they never reach the browser's
 * terminal or the replay buffer. Buffers across chunk boundaries internally. */
export interface SessionEventParser {
  push(chunk: string): { output: string; events: SessionEvent[] };
}

/** A concrete command line to spawn for a session. */
export interface HarnessInvocation {
  command: string;
  args: string[];
  /** Extra environment, merged over the server's own environment. */
  env?: Record<string, string>;
}

export interface HarnessAdapter {
  /** Stable identifier, e.g. "claude" or "pi". */
  readonly id: string;
  /** Human-readable label for the UI. */
  readonly name: string;
  /** Build the CLI invocation for a new session. */
  invocation(opts: SessionOptions): HarnessInvocation;
  /** Optional: create a parser that extracts session events from this harness's
   * output (e.g. shell-integration markers). Adapters without it stream raw. */
  createEventParser?(): SessionEventParser;
}
