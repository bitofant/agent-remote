// The harness adapter abstraction — agent-remote's core extension point.
// An adapter only describes HOW to invoke an agent CLI; all process mechanics
// (PTY, streaming, lifecycle) live in the harness-agnostic session layer. New
// agent = new adapter here, nothing else. Keep harness specifics in this dir.

import type {
  ChatAction,
  ChatEvent,
  SessionEvent,
} from "../../shared/protocol.js";

export interface SessionOptions {
  /** Working directory the agent should run in. */
  cwd: string;
  /** Opaque harness-native handle for resuming a prior session; absent for a
   * fresh one. Adapters without resume support ignore it. */
  resume?: string;
}

/** Fed raw PTY output chunks: extracts structured session events (e.g. from
 * shell-integration escapes) and returns the output with those sequences
 * stripped. Buffers across chunk boundaries internally. */
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

/** Bidirectional protocol translator for chat-UI harnesses. The session layer
 * spawns piped stdio (no PTY), feeds utf8 stdout through `push()`, and writes
 * `encode()`'s bytes to stdin. All wire format (framing, RPC) stays inside;
 * only normalized chat events/actions cross it. */
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
  /** The session learned its resume key (persist it). May fire more than once
   * (idempotent — the key is stable). */
  onResumable?(key: string): void;
}

/** A richer chat integration than ChatTranslator: the adapter owns the agent
 * process/SDK and exposes control ops (prompt/abort/permissions/model). Used
 * when a translator over manager-owned stdio isn't enough — e.g. the Claude
 * adapter driving the Agent SDK. The manager only drives this interface. */
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
