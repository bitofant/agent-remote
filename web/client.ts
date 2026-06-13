import type {
  ClientMessage,
  FolderInfo,
  ServerMessage,
  SessionInfo,
} from "../shared/protocol";

type SessionsListener = (sessions: SessionInfo[]) => void;
type FoldersListener = (folders: FolderInfo[]) => void;
type OutputListener = (data: string) => void;
type ResetListener = () => void;
// Ctrl modifier state: off, armed for one keystroke, or locked (caps-lock
// style) until turned off.
export type CtrlMode = "off" | "once" | "lock";
type CtrlListener = (mode: CtrlMode) => void;

// Fold a Ctrl modifier into a key's byte sequence, so a sticky on-screen Ctrl
// can combine with the next keystroke (from the keyboard or an on-screen key).
function applyCtrl(data: string): string {
  // Ctrl+<letter/@[\]^_> -> the corresponding C0 control code (e.g. c -> 0x03).
  if (data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
    return data;
  }
  // Ctrl+arrow -> CSI with the Ctrl modifier (1;5A..D).
  const arrow = /^\x1b\[([ABCD])$/.exec(data);
  if (arrow) return `\x1b[1;5${arrow[1]}`;
  return data;
}

interface OutputSubscriber {
  onData: OutputListener;
  onReset: ResetListener;
}

// Single WebSocket connection multiplexing every session. Output is buffered
// per session so a terminal mounting late (e.g. after switching tabs, or on
// reconnect) can be replayed without losing or duplicating bytes.
export class Client {
  private ws?: WebSocket;
  private shouldReconnect = false;
  private sessions: SessionInfo[] = [];
  private folders: FolderInfo[] = [];
  private buffers = new Map<string, string>();
  private sessionsListeners = new Set<SessionsListener>();
  private foldersListeners = new Set<FoldersListener>();
  private outputListeners = new Map<string, Set<OutputSubscriber>>();
  // Sticky Ctrl: armed by the on-screen Ctrl key, applied to subsequent input.
  private ctrlMode: CtrlMode = "off";
  private ctrlListeners = new Set<CtrlListener>();

  connect(): void {
    this.shouldReconnect = true;
    // Idempotent: never run a second socket alongside an existing one (e.g.
    // React StrictMode invoking the connect effect twice), or the same messages
    // get handled twice and terminals duplicate every byte.
    if (this.ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      // Ignore a stale socket's close once a newer one has superseded it.
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.shouldReconnect) setTimeout(() => this.connect(), 1000);
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "sessions":
        // Fresh connection (incl. reconnect): drop stale client buffers and
        // reset mounted terminals before the server replays scrollback, so the
        // replay rebuilds each terminal rather than duplicating its contents.
        this.buffers.clear();
        for (const set of this.outputListeners.values())
          set.forEach((sub) => sub.onReset());
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
        this.outputListeners
          .get(msg.sessionId)
          ?.forEach((sub) => sub.onData(msg.data));
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
      case "folders":
        this.folders = msg.folders;
        this.emitFolders();
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
    if (this.ctrlMode !== "off") {
      data = applyCtrl(data);
      // One-shot consumes itself; lock stays armed for the next key.
      if (this.ctrlMode === "once") this.setCtrl("off");
    }
    this.send({ type: "input", sessionId, data });
  }
  // Cycle the Ctrl modifier: off -> one-shot -> locked -> off.
  cycleCtrl(): void {
    this.setCtrl(
      this.ctrlMode === "off" ? "once" : this.ctrlMode === "once" ? "lock" : "off",
    );
  }
  private setCtrl(mode: CtrlMode): void {
    if (this.ctrlMode === mode) return;
    this.ctrlMode = mode;
    for (const cb of this.ctrlListeners) cb(mode);
  }
  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: "resize", sessionId, cols, rows });
  }
  stop(sessionId: string): void {
    this.send({ type: "stop", sessionId });
  }
  addFolder(path: string): void {
    this.send({ type: "addFolder", path });
  }
  removeFolder(path: string): void {
    this.send({ type: "removeFolder", path });
  }

  // --- subscriptions -------------------------------------------------------

  onSessions(cb: SessionsListener): () => void {
    this.sessionsListeners.add(cb);
    cb(this.sessions);
    return () => this.sessionsListeners.delete(cb);
  }

  onFolders(cb: FoldersListener): () => void {
    this.foldersListeners.add(cb);
    cb(this.folders);
    return () => this.foldersListeners.delete(cb);
  }

  onCtrl(cb: CtrlListener): () => void {
    this.ctrlListeners.add(cb);
    cb(this.ctrlMode);
    return () => this.ctrlListeners.delete(cb);
  }

  /**
   * Subscribe to a session's output. Returns the buffered scrollback so far
   * plus an unsubscribe; reading the buffer and registering the listener
   * happens synchronously, so no bytes are dropped or doubled in between.
   * `onReset` fires when the server is about to replay scrollback (on
   * reconnect) and the terminal should clear itself first.
   */
  subscribeOutput(
    sessionId: string,
    onData: OutputListener,
    onReset: ResetListener,
  ): { initial: string; unsubscribe: () => void } {
    const initial = this.buffers.get(sessionId) ?? "";
    let set = this.outputListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.outputListeners.set(sessionId, set);
    }
    const sub: OutputSubscriber = { onData, onReset };
    set.add(sub);
    return {
      initial,
      unsubscribe: () => set!.delete(sub),
    };
  }

  private emitSessions(): void {
    for (const cb of this.sessionsListeners) cb(this.sessions);
  }

  private emitFolders(): void {
    for (const cb of this.foldersListeners) cb(this.folders);
  }
}
