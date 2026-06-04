// The harness adapter abstraction — the core extension point of agent-remote.
//
// An adapter's only job is to describe HOW to invoke a given agent CLI. All
// process mechanics (PTY, streaming, lifecycle) live in the harness-agnostic
// session layer, so adding a new agent means writing a new adapter here and
// nothing else. Keep harness-specific logic confined to this directory.

export interface SessionOptions {
  /** Working directory the agent should run in. */
  cwd: string;
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
}
