import { randomUUID } from "node:crypto";
import {
  spawn as spawnPiped,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { spawn, type IPty } from "node-pty";
import type {
  ChatSession,
  ChatTranslator,
  HarnessAdapter,
  SessionEventParser,
  SessionOptions,
} from "../adapters/types.js";
import type {
  ChatAction,
  ChatEvent,
  ChatState,
  SessionEvent,
  SessionInfo,
  SessionUi,
} from "../../shared/protocol.js";
import { applyChatEvent, emptyChatState } from "../../shared/chat.js";

// Per-session scrollback retained so a (re)connecting browser can be brought
// up to date. Bounded to keep memory in check on long-running sessions.
const MAX_BUFFER = 200_000;

// Tail of a chat child's stderr, surfaced as an error notice if it dies.
const MAX_STDERR_TAIL = 2_000;

interface Session {
  info: SessionInfo;
  /** The cwd the session was launched in. Unlike `info.cwd` (which drifts as
   * shell integration reports `cd`s), this stays fixed — it's the folder the
   * session belongs to, used to bump folder recency on input. */
  folder: string;
  // --- terminal flavor (ui: "terminal") ---
  pty?: IPty;
  buffer: string;
  /** Present only for harnesses with shell integration; extracts events and
   * strips the integration markers from the output stream. */
  parser?: SessionEventParser;
  // --- chat flavor (ui: "chat") ---
  /** Translator-based chat (manager owns the piped child), e.g. pi. */
  child?: ChildProcessWithoutNullStreams;
  translator?: ChatTranslator;
  /** Session-based chat (adapter owns the process/SDK), e.g. claude. */
  chatSession?: ChatSession;
  chat?: ChatState;
  stderrTail?: string;
  /** Opaque harness-native handle for resuming this conversation later, once the
   * adapter has reported it (chat harnesses that support resume only). */
  resumeKey?: string;
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
  /** A normalized chat event from a chat session (ui: "chat" only). */
  onChatEvent?(sessionId: string, event: ChatEvent): void;
  /** The session reported its resume key (persist it so it can be resumed). */
  onResumable?(sessionId: string, key: string): void;
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

  /** The folder the session was launched in (fixed for the session's life),
   * for ordering folders by which one most recently received input. */
  sessionFolder(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.folder;
  }

  /** How the session renders in the browser ("terminal" or "chat"). */
  sessionUi(sessionId: string): SessionUi | undefined {
    return this.sessions.get(sessionId)?.info.ui;
  }

  /** Full info for a session, for consumers that persist harness metadata. */
  sessionInfo(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  /** The session's resume key, once the adapter has reported one. */
  resumeKey(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.resumeKey;
  }

  /** Resume keys of currently-running sessions — so the resume list can hide
   * conversations that are already open. */
  liveResumeKeys(): Set<string> {
    const keys = new Set<string>();
    for (const s of this.sessions.values())
      if (s.resumeKey && s.info.status === "running") keys.add(s.resumeKey);
    return keys;
  }

  /** Current chat state of a chat session, for replay on connect. */
  chatState(sessionId: string): ChatState | undefined {
    return this.sessions.get(sessionId)?.chat;
  }

  start(harnessId: string, opts: SessionOptions): SessionInfo {
    const adapter = this.adapters.get(harnessId);
    if (!adapter) throw new Error(`Unknown harness: ${harnessId}`);

    const isChat = !!(adapter.createChatSession || adapter.createChatTranslator);
    const info: SessionInfo = {
      id: randomUUID(),
      harnessId: adapter.id,
      harnessName: adapter.name,
      cwd: opts.cwd,
      ui: isChat ? "chat" : "terminal",
      status: "running",
      exitCode: null,
      createdAt: Date.now(),
      currentCommand: null,
    };

    const session = adapter.createChatSession
      ? this.startChatSession(adapter, opts, info)
      : adapter.createChatTranslator
        ? this.startChat(adapter, opts, info)
        : this.startTerminal(adapter, opts, info);
    this.sessions.set(info.id, session);

    for (const l of this.listeners) l.onStarted(info);
    return info;
  }

  /** Session-based chat: the adapter owns the process/SDK and we drive it via
   * the ChatSession interface, folding its events into ChatState like any other
   * chat flavor. */
  private startChatSession(
    adapter: HarnessAdapter,
    opts: SessionOptions,
    info: SessionInfo,
  ): Session {
    const chatSession = adapter.createChatSession!(opts);
    const session: Session = {
      info,
      buffer: "",
      folder: opts.cwd,
      chatSession,
      chat: emptyChatState(),
    };
    chatSession.start({
      onEvent: (event) => this.applyChat(session, event),
      onResumable: (key) => {
        session.resumeKey = key;
        for (const l of this.listeners) l.onResumable?.(info.id, key);
      },
      onExit: (exitCode) => {
        if (info.status === "exited") return;
        info.status = "exited";
        info.exitCode = exitCode;
        info.currentCommand = null;
        for (const l of this.listeners) l.onExit(info.id, exitCode);
      },
    });
    return session;
  }

  private startTerminal(
    adapter: HarnessAdapter,
    opts: SessionOptions,
    info: SessionInfo,
  ): Session {
    const invocation = adapter.invocation(opts);
    const child = spawn(invocation.command, invocation.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: { ...process.env, ...invocation.env } as Record<string, string>,
    });

    const session: Session = {
      info,
      pty: child,
      buffer: "",
      folder: opts.cwd,
      parser: adapter.createEventParser?.(),
    };

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
        // Reflect live state on the session itself: cwd, and the command
        // currently running (set while one executes, cleared back at the prompt).
        if (event.type === "cwd") info.cwd = event.cwd;
        else if (event.type === "command-start")
          info.currentCommand = event.command.trim() || null;
        else if (event.type === "command-end") info.currentCommand = null;
        for (const l of this.listeners) l.onEvent?.(info.id, event);
      }
    });
    child.onExit(({ exitCode }) => {
      info.status = "exited";
      info.exitCode = exitCode;
      for (const l of this.listeners) l.onExit(info.id, exitCode);
    });

    return session;
  }

  private startChat(
    adapter: HarnessAdapter,
    opts: SessionOptions,
    info: SessionInfo,
  ): Session {
    const invocation = adapter.invocation(opts);
    const child = spawnPiped(invocation.command, invocation.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...invocation.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: Session = {
      info,
      buffer: "",
      folder: opts.cwd,
      child,
      translator: adapter.createChatTranslator!(),
      chat: emptyChatState(),
    };

    // setEncoding makes Node decode utf8 across chunk boundaries for us, so
    // the translator only ever deals in whole characters.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const event of session.translator!.push(chunk))
        this.applyChat(session, event);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderrTail = ((session.stderrTail ?? "") + chunk).slice(
        -MAX_STDERR_TAIL,
      );
    });

    const finish = (exitCode: number | null) => {
      if (info.status === "exited") return;
      if (exitCode !== 0 && session.stderrTail?.trim()) {
        this.applyChat(session, {
          type: "notice",
          level: "error",
          text: session.stderrTail.trim(),
        });
      }
      info.status = "exited";
      info.exitCode = exitCode;
      info.currentCommand = null;
      for (const l of this.listeners) l.onExit(info.id, exitCode);
    };
    child.on("exit", (code) => finish(code));
    // Spawn failure (e.g. binary missing): no "exit" will follow.
    child.on("error", (err) => {
      session.stderrTail = err.message;
      finish(-1);
    });

    return session;
  }

  /** Fold a normalized chat event into the session's state and fan it out.
   * Also mirrors busy/idle into `currentCommand` so the existing session-list
   * UI (pulsing dot + subtitle) works for chat sessions unchanged. */
  private applyChat(session: Session, event: ChatEvent): void {
    session.chat = applyChatEvent(session.chat ?? emptyChatState(), event);
    const info = session.info;
    if (event.type === "busy") {
      const command = event.busy ? lastPromptLine(session.chat) : null;
      info.currentCommand = command;
      const mirrored: SessionEvent = command
        ? { type: "command-start", command, at: Date.now() }
        : { type: "command-end", exitCode: 0, at: Date.now() };
      for (const l of this.listeners) l.onEvent?.(info.id, mirrored);
    }
    for (const l of this.listeners) l.onChatEvent?.(info.id, event);
  }

  /** Perform a chat action. For a session-based chat the adapter's ChatSession
   * handles it (and emits any resulting events through onEvent); for a
   * translator-based chat we encode to stdin and apply synthetic events (e.g.
   * the user-message echo) ourselves. */
  chatAction(sessionId: string, action: ChatAction): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== "running") return;
    if (session.chatSession) {
      session.chatSession.action(action);
      return;
    }
    if (!session.translator || !session.child) return;
    const { data, events } = session.translator.encode(action);
    if (data) session.child.stdin.write(data);
    for (const event of events) this.applyChat(session, event);
  }

  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) return;
    try {
      session.pty.resize(cols, rows);
    } catch {
      // PTY may have exited between resize events; ignore.
    }
  }

  stop(sessionId: string): void {
    this.kill(this.sessions.get(sessionId));
  }

  /** Drop a session from the manager. Intended for finished sessions; if one is
   * still running it is killed first. After this the session is gone from
   * `list()` and its scrollback is released. */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.info.status !== "exited") this.kill(session);
    this.sessions.delete(sessionId);
    for (const l of this.listeners) l.onRemoved?.(sessionId);
  }

  private kill(session: Session | undefined): void {
    if (!session) return;
    if (session.pty) session.pty.kill();
    else if (session.chatSession) session.chatSession.close();
    else session.child?.kill("SIGTERM");
  }
}

/** First line of the most recent user prompt, truncated for the session list. */
function lastPromptLine(chat: ChatState): string {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const msg = chat.messages[i];
    if (msg.role !== "user") continue;
    const text = msg.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim()
      .split("\n", 1)[0];
    if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  return "working";
}
