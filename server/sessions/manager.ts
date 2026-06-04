import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { HarnessAdapter, SessionOptions } from "../adapters/types.js";
import type { SessionInfo } from "../../shared/protocol.js";

// Per-session scrollback retained so a (re)connecting browser can be brought
// up to date. Bounded to keep memory in check on long-running sessions.
const MAX_BUFFER = 200_000;

interface Session {
  info: SessionInfo;
  pty: IPty;
  buffer: string;
}

/** Notified of session lifecycle and output. One listener per WS connection. */
export interface SessionListener {
  onStarted(info: SessionInfo): void;
  onOutput(sessionId: string, data: string): void;
  onExit(sessionId: string, exitCode: number | null): void;
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
    const session: Session = { info, pty: child, buffer: "" };
    this.sessions.set(info.id, session);

    child.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      for (const l of this.listeners) l.onOutput(info.id, data);
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
}
