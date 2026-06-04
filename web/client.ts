import type {
  ClientMessage,
  ServerMessage,
  SessionInfo,
} from "../shared/protocol";

type SessionsListener = (sessions: SessionInfo[]) => void;
type OutputListener = (data: string) => void;

// Single WebSocket connection multiplexing every session. Output is buffered
// per session so a terminal mounting late (e.g. after switching tabs, or on
// reconnect) can be replayed without losing or duplicating bytes.
export class Client {
  private ws?: WebSocket;
  private sessions: SessionInfo[] = [];
  private buffers = new Map<string, string>();
  private sessionsListeners = new Set<SessionsListener>();
  private outputListeners = new Map<string, Set<OutputListener>>();

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      this.ws = undefined;
      setTimeout(() => this.connect(), 1000);
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "sessions":
        // Fresh connection: drop stale client buffers, server will replay.
        this.buffers.clear();
        this.sessions = msg.sessions;
        this.emitSessions();
        break;
      case "started":
        if (!this.sessions.some((s) => s.id === msg.session.id)) {
          this.sessions = [...this.sessions, msg.session];
          this.emitSessions();
        }
        break;
      case "output": {
        const prev = this.buffers.get(msg.sessionId) ?? "";
        this.buffers.set(msg.sessionId, prev + msg.data);
        this.outputListeners.get(msg.sessionId)?.forEach((cb) => cb(msg.data));
        break;
      }
      case "exit":
        this.sessions = this.sessions.map((s) =>
          s.id === msg.sessionId
            ? { ...s, status: "exited", exitCode: msg.exitCode }
            : s,
        );
        this.emitSessions();
        break;
      case "error":
        console.error("agent-remote backend error:", msg.message);
        break;
    }
  }

  // --- outgoing ------------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  start(harnessId: string, cwd?: string): void {
    this.send({ type: "start", harnessId, cwd });
  }
  input(sessionId: string, data: string): void {
    this.send({ type: "input", sessionId, data });
  }
  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: "resize", sessionId, cols, rows });
  }
  stop(sessionId: string): void {
    this.send({ type: "stop", sessionId });
  }

  // --- subscriptions -------------------------------------------------------

  onSessions(cb: SessionsListener): () => void {
    this.sessionsListeners.add(cb);
    cb(this.sessions);
    return () => this.sessionsListeners.delete(cb);
  }

  /**
   * Subscribe to a session's output. Returns the buffered scrollback so far
   * plus an unsubscribe; reading the buffer and registering the listener
   * happens synchronously, so no bytes are dropped or doubled in between.
   */
  subscribeOutput(
    sessionId: string,
    cb: OutputListener,
  ): { initial: string; unsubscribe: () => void } {
    const initial = this.buffers.get(sessionId) ?? "";
    let set = this.outputListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.outputListeners.set(sessionId, set);
    }
    set.add(cb);
    return {
      initial,
      unsubscribe: () => set!.delete(cb),
    };
  }

  private emitSessions(): void {
    for (const cb of this.sessionsListeners) cb(this.sessions);
  }
}
