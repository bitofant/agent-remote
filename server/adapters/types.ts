// The harness adapter abstraction — the core extension point of agent-remote.
//
// An adapter's only job is to describe HOW to invoke a given agent CLI. All
// process mechanics (PTY, streaming, lifecycle) live in the harness-agnostic
// session layer, so adding a new agent means writing a new adapter here and
// nothing else. Keep harness-specific logic confined to this directory.

import type {
  ChatAction,
  ChatEvent,
  SessionEvent,
} from "../../shared/protocol.js";

export interface SessionOptions {
  /** Working directory the agent should run in. */
  cwd: string;
  /** Opaque, harness-native handle for resuming a prior session (restoring its
   * conversation history). Absent for a fresh session; adapters that don't
   * support resume ignore it. */
  resume?: string;
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

/** A stateful bidirectional protocol translator for chat-UI harnesses. The
 * session layer spawns the invocation with *piped* stdio (no PTY), feeds
 * utf8-decoded stdout through `push()`, and writes `encode()`'s bytes to
 * stdin. All harness-specific wire format (framing, RPC vocabulary) lives
 * inside the translator; only normalized chat events/actions cross it. */
export interface ChatTranslator {
  /** Translate raw stdout text into normalized events. Buffers partial lines
   * across chunk boundaries internally. */
  push(chunk: string): ChatEvent[];
  /** Translate a client action into stdin bytes, plus any synthetic events to
   * apply locally (e.g. echoing the user's prompt as a chat message). */
  encode(action: ChatAction): { data: string; events: ChatEvent[] };
}

/** Callbacks a ChatSession uses to surface activity to the session layer. */
export interface ChatSessionHandlers {
  /** A normalized chat event (fold into ChatState + fan out to the browser). */
  onEvent(event: ChatEvent): void;
  /** The underlying agent process/session ended. */
  onExit(exitCode: number | null): void;
  /** The session learned its opaque, harness-native resume key (persist it so
   * the session can be resumed later). Fired for harnesses that support resume;
   * may fire more than once (idempotent — the key is stable). */
  onResumable?(key: string): void;
}

/** A richer chat integration than ChatTranslator: the adapter owns the agent
 * process/SDK itself and exposes control operations (prompt, abort, permission
 * responses, model switching). Used when a translator over manager-owned stdio
 * isn't enough — e.g. the Claude adapter driving the Agent SDK, which owns its
 * own subprocess and offers first-class permission/model/command control. All
 * harness specifics stay inside; the manager only drives this interface. */
export interface ChatSession {
  /** Begin the session; events start flowing to the handlers. */
  start(handlers: ChatSessionHandlers): void;
  /** Perform a client action (prompt/abort/ui-response/set-model). */
  action(action: ChatAction): void;
  /** Terminate the session and release resources. */
  close(): void;
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
  /** Optional: present when this harness runs as a structured chat session
   * (ui: "chat", piped stdio) via a translator over manager-owned stdio. */
  createChatTranslator?(): ChatTranslator;
  /** Optional: present when this harness runs as a chat session but owns its own
   * process/SDK (ui: "chat"). Takes precedence over createChatTranslator. */
  createChatSession?(opts: SessionOptions): ChatSession;
}
