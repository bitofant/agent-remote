import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type {
  HarnessAdapter,
  SessionEventParser,
  SessionOptions,
} from "../adapters/types.js";
import type { SessionEvent, SessionInfo } from "../../shared/protocol.js";

// Per-session scrollback retained so a (re)connecting browser can be brought
// up to date. Bounded to keep memory in check on long-running sessions.
const MAX_BUFFER = 200_000;

interface Session {
  info: SessionInfo;
  pty: IPty;
  buffer: string;
  /** Present only for harnesses with shell integration; extracts events and
   * strips the integration markers from the output stream. */
  parser?: SessionEventParser;
}

/** Notified of session lifecycle and output. One listener per WS connection,
 * plus server-global listeners (e.g. the command recorder). */
export interface SessionListener {
  onStarted(info: SessionInfo): void;
  onOutput(sessionId: string, data: string): void;
  onExit(sessionId: string, exitCode: number | null): void;
  /** A session was removed from the manager entirely (e.g. user closed an
   * exited session); it should be dropped from the UI. */
  onRemoved?(sessionId: string): void;
  /** A structured event observed inside the session (shell integration only). */
  onEvent?(sessionId: string, event: SessionEvent): void;
}

// Owns the lifecycle of agent subprocesses. This layer is harness-agnostic:
// it asks an adapter only for the command line, then handles the PTY, output
// fan-out, and teardown itself.
export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<SessionListener>();

  constructor(private adapters: Map<string, HarnessAdapter>) {}

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  /** Retained scrollback for a session, for replay on connect. */
  buffer(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.buffer;
  }

  /** The session's current working directory (kept live by shell integration),
   * for consumers that record what ran where. */
  sessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.info.cwd;
  }

  start(harnessId: string, opts: SessionOptions): SessionInfo {
    const adapter = this.adapters.get(harnessId);
    if (!adapter) throw new Error(`Unknown harness: ${harnessId}`);

    const invocation = adapter.invocation(opts);
    const child = spawn(invocation.command, invocation.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: { ...process.env, ...invocation.env } as Record<string, string>,
    });

    const info: SessionInfo = {
      id: randomUUID(),
      harnessId: adapter.id,
      harnessName: adapter.name,
      cwd: opts.cwd,
      status: "running",
      exitCode: null,
      createdAt: Date.now(),
    };
    const session: Session = {
      info,
      pty: child,
      buffer: "",
      parser: adapter.createEventParser?.(),
    };
    this.sessions.set(info.id, session);

    child.onData((data) => {
      // With shell integration, run output through the parser: it strips the
      // integration markers (so they never reach the terminal or buffer) and
      // yields structured events. Without a parser, the data passes through.
      const { output, events } = session.parser
        ? session.parser.push(data)
        : { output: data, events: [] };
      if (output) {
        session.buffer = (session.buffer + output).slice(-MAX_BUFFER);
        for (const l of this.listeners) l.onOutput(info.id, output);
      }
      for (const event of events) {
        // cwd changes are reflected on the session itself, live.
        if (event.type === "cwd") info.cwd = event.cwd;
        for (const l of this.listeners) l.onEvent?.(info.id, event);
      }
    });
    child.onExit(({ exitCode }) => {
      info.status = "exited";
      info.exitCode = exitCode;
      for (const l of this.listeners) l.onExit(info.id, exitCode);
    });

    for (const l of this.listeners) l.onStarted(info);
    return info;
  }

  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      session.pty.resize(cols, rows);
    } catch {
      // PTY may have exited between resize events; ignore.
    }
  }

  stop(sessionId: string): void {
    this.sessions.get(sessionId)?.pty.kill();
  }

  /** Drop a session from the manager. Intended for finished sessions; if one is
   * still running it is killed first. After this the session is gone from
   * `list()` and its scrollback is released. */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.info.status !== "exited") session.pty.kill();
    this.sessions.delete(sessionId);
    for (const l of this.listeners) l.onRemoved?.(sessionId);
  }
}
