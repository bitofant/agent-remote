import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  FolderInfo,
  HarnessInfo,
  ResumableSession,
  SessionInfo,
} from "../shared/protocol";
import { Client, type CtrlMode } from "./client";
import { TerminalView } from "./TerminalView";
// Lazy-loaded: pulls in CodeMirror + language packs only once a file-edit tab
// is opened, keeping the initial (terminal-first) bundle small.
const FileEditor = lazy(() =>
  import("./FileEditor").then((m) => ({ default: m.FileEditor })),
);
// Lazy-loaded: pulls in the markdown renderer only once a chat session exists.
const ChatView = lazy(() =>
  import("./ChatView").then((m) => ({ default: m.ChatView })),
);
import { CommandBuilder } from "./CommandBuilder";
import { Login } from "./Login";
import { fetchMe, logout } from "./auth";

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// Client-only "file edit" tab: lives alongside PTY sessions but is backed by
// /api/files, not a harness — tracked here in the UI, never by the manager.
interface EditorTab {
  id: string;
  folder: string;
  /** Base name of the currently open file, for the tab subtitle; null in the
   * file-picker step. */
  file: string | null;
}

// Tracks the on-screen keyboard via the visual viewport. `height` is the
// visible height the app is pinned to while the keyboard is up. `open` stays
// false on desktop, so keyboard-gated UI never shows there.
function useKeyboard(): { open: boolean; height: number } {
  const [state, setState] = useState({ open: false, height: 0 });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Largest height seen = no-keyboard height; works whether the keyboard
    // shrinks the visual or the layout viewport.
    let maxHeight = Math.max(vv.height, window.innerHeight);
    const onChange = () => {
      maxHeight = Math.max(maxHeight, vv.height);
      const open = maxHeight - vv.height > 120;
      setState({ open, height: Math.round(vv.height) });
    };
    onChange();
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);
  return state;
}

// Material Design `keyboard_arrow_*` icon paths (24x24 viewBox). Drawn with
// `currentColor` so they inherit the button's text/accent color.
const ARROW_PATHS = {
  up: "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  down: "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  left: "M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z",
  right: "M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z",
} as const;

// Material icons used on the group toggle: a d-pad (positional keys) and a
// keyboard (everything else).
const NAV_ICON =
  "M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H8l5 5 5-5h-3v-3z";
const KEYBOARD_ICON =
  "M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z";
// Material `select_all` (dashed marquee): toggles touch text-selection mode.
const SELECT_ICON =
  "M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2z";
const EDIT_ICON =
  "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z";
// Terminal prompt chevron + underline bar.
const TERMINAL_ICON = "M6.4 16L5 14.6l3.6-3.6L5 7.4 6.4 6l5 5-5 5zM13 16v-2h6v2h-6z";
// Sparkles — stands in for an AI coding agent.
const SPARKLE_ICON =
  "M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z";
// The Greek letter π (bar + two legs).
const PI_ICON = "M4 5h16v3H4zM6.5 8h3v11h-3zM14.5 8h3v11h-3z";

// Per-harness glyphs, keyed by adapter id. Unknown harnesses fall back to a
// first-letter badge, so new adapters still render without a UI change.
const HARNESS_ICONS: Record<string, string> = {
  claude: SPARKLE_ICON,
  pi: PI_ICON,
  terminal: TERMINAL_ICON,
};

// The one harness pulled out as a direct button on mobile (rest fold into [+]).
const QUICK_HARNESS_ID = "terminal";

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d={path} />
    </svg>
  );
}

function Arrow({ dir }: { dir: keyof typeof ARROW_PATHS }) {
  return <Icon path={ARROW_PATHS[dir]} />;
}

// Compact "time since" label for the resume list (e.g. "3m", "2h", "5d").
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// A harness's icon, or a first-letter badge when it has no registered glyph.
function HarnessGlyph({ id, name }: { id: string; name: string }) {
  const path = HARNESS_ICONS[id];
  return path ? (
    <Icon path={path} />
  ) : (
    <span className="harness-letter">{name[0]}</span>
  );
}

// Keys a mobile keyboard lacks but terminals need, split into two groups
// (arrows / everything else). Plain key sends `seq`; `toggle` (Ctrl) arms a
// sticky modifier applied to the next keystroke.
type KeyDef = { label: ReactNode; aria: string; seq?: string; toggle?: boolean };

type KeyGroup = "keys" | "arrows";

const KEY_GROUPS: Record<KeyGroup, KeyDef[]> = {
  keys: [
    { label: "Esc", aria: "Escape", seq: "\x1b" },
    { label: "Tab", aria: "Tab", seq: "\t" },
    { label: "Ctrl", aria: "Control", toggle: true },
    { label: "⏎", aria: "Newline", seq: "\n" },
    { label: "/", aria: "Slash", seq: "/" },
    { label: "`", aria: "Backtick", seq: "`" },
  ],
  arrows: [
    { label: <Arrow dir="up" />, aria: "Up arrow", seq: "\x1b[A" },
    { label: <Arrow dir="down" />, aria: "Down arrow", seq: "\x1b[B" },
    { label: <Arrow dir="left" />, aria: "Left arrow", seq: "\x1b[D" },
    { label: <Arrow dir="right" />, aria: "Right arrow", seq: "\x1b[C" },
    { label: "Home", aria: "Home", seq: "\x1b[H" },
    { label: "End", aria: "End", seq: "\x1b[F" },
  ],
};

// Shift+Tab (CSI Z, "back-tab") — mode/permission cycle in Claude & pi. Shown
// after Tab only while an agent is running (meaningless at a shell prompt).
const SHIFT_TAB_KEY: KeyDef = { label: "⇧Tab", aria: "Shift Tab", seq: "\x1b[Z" };

// AI coding-agent harnesses; their sessions always want Shift+Tab even when idle.
const AGENT_HARNESS_IDS = new Set(["claude", "pi"]);

// True when a live command line is an agent CLI (e.g. `claude`/`pi` launched
// from a Terminal session, where only the running command reveals the agent).
function isAgentCommand(command: string | null): boolean {
  if (!command) return false;
  const bin = command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  return AGENT_HARNESS_IDS.has(bin);
}

export function App() {
  // Auth gate: undefined = still checking, null = logged out, string = username.
  const [user, setUser] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    fetchMe().then(setUser);
  }, []);

  if (user === undefined) return <div className="app loading" />;
  if (user === null) {
    return <Login onAuthed={() => fetchMe().then(setUser)} />;
  }
  return <Workspace username={user} onLogout={() => setUser(null)} />;
}

function Workspace({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => void;
}) {
  const client = useMemo(() => new Client(), []);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Client-only file-editor tabs (see EditorTab).
  const [editors, setEditors] = useState<EditorTab[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  // Which session is shown for each folder.
  const [activeSession, setActiveSession] = useState<Record<string, string>>({});
  // Resumable (closed) chat sessions for the active folder, from /api/resumable.
  const [resumable, setResumable] = useState<ResumableSession[]>([]);
  // Resume-session picker dialog (opened from the chat header's Resume button).
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Narrow viewport: collapse the inline new-session buttons into the [+] menu.
  const [isNarrow, setIsNarrow] = useState(
    () => window.matchMedia("(max-width: 640px)").matches
  );
  // Off-canvas sidebar drawer (mobile only; ignored on desktop via CSS).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const keyboard = useKeyboard();
  const [ctrlMode, setCtrlMode] = useState<CtrlMode>("off");
  const [keyGroup, setKeyGroup] = useState<KeyGroup>("keys");
  // Touch text-selection mode, applied to the active terminal.
  const [selectMode, setSelectMode] = useState(false);
  // Command-builder dialog (opened from the ./ key-bar button).
  const [builderOpen, setBuilderOpen] = useState(false);
  const knownIds = useRef<Set<string>>(new Set());
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    client.connect();
    fetch("/api/harnesses")
      .then((r) => r.json())
      .then(setHarnesses)
      .catch(() => setHarnesses([]));
    const offSessions = client.onSessions(setSessions);
    const offFolders = client.onFolders(setFolders);
    const offCtrl = client.onCtrl(setCtrlMode);
    return () => {
      offSessions();
      offFolders();
      offCtrl();
      client.disconnect();
    };
  }, [client]);

  // Auto-select newly created sessions: focus their folder and make them active.
  useEffect(() => {
    let created: SessionInfo | null = null;
    for (const s of sessions) {
      if (!knownIds.current.has(s.id)) {
        knownIds.current.add(s.id);
        created = s;
      }
    }
    if (created) {
      const folder = created.cwd;
      setActiveFolder(folder);
      setActiveSession((prev) => ({ ...prev, [folder]: created!.id }));
    }
  }, [sessions]);

  // Drop active-tab pins whose tab no longer exists (a session was closed, or an
  // editor tab was closed), so the per-folder fallback can pick another tab.
  useEffect(() => {
    setActiveSession((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [folder, id] of Object.entries(prev)) {
        if (sessions.some((s) => s.id === id) || editors.some((e) => e.id === id))
          next[folder] = id;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions, editors]);

  // Default to the most-recent folder once folders arrive.
  useEffect(() => {
    if (activeFolder === null && folders.length > 0) {
      setActiveFolder(folders[0].path);
    }
  }, [folders, activeFolder]);

  // Refetched on folder change and when the live session set changes (closing a
  // session makes it resumable, resuming one hides it).
  const refreshResumable = useCallback(() => {
    if (activeFolder === null) {
      setResumable([]);
      return;
    }
    fetch(`/api/resumable?cwd=${encodeURIComponent(activeFolder)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setResumable)
      .catch(() => setResumable([]));
  }, [activeFolder]);
  useEffect(() => {
    refreshResumable();
  }, [refreshResumable, sessions]);
  // A folder switch invalidates the (per-folder) resume list; close the dialog.
  useEffect(() => {
    setResumeDialogOpen(false);
  }, [activeFolder]);

  const forgetResumable = (key: string) => {
    void fetch(`/api/resumable?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    }).finally(refreshResumable);
  };

  // Close the add-session dropdown on an outside click.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  // Track the 640px breakpoint (matches the CSS media queries) to switch the
  // new-session buttons between inline (wide) and the [+] menu (narrow).
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const openFolder = (path: string) => {
    // Viewing doesn't reorder the list — recency is driven by input activity
    // (server bumps the folder on keystrokes).
    setActiveFolder(path);
    setSelectorOpen(false);
    setSidebarOpen(false);
  };

  const submitNewFolder = () => {
    const path = newFolder.trim();
    if (!path) return;
    client.addFolder(path);
    setActiveFolder(path);
    setNewFolder("");
    setSidebarOpen(false);
  };

  const removeFolderAt = (path: string) => {
    client.removeFolder(path);
    // If we just removed the open folder, fall back to another one so the
    // main pane doesn't point at a folder that's no longer listed.
    setActiveFolder((cur) =>
      cur === path
        ? (folders.find((f) => f.path !== path)?.path ?? null)
        : cur,
    );
  };

  const handleLogout = async () => {
    await logout();
    client.disconnect();
    onLogout();
  };

  const sessionsInFolder = sessions.filter((s) => s.cwd === activeFolder);
  const editorsInFolder = editors.filter((e) => e.folder === activeFolder);
  const tabCount = sessionsInFolder.length + editorsInFolder.length;
  const activeSessionId =
    activeFolder !== null
      ? (activeSession[activeFolder] ??
        editorsInFolder[editorsInFolder.length - 1]?.id ??
        sessionsInFolder[sessionsInFolder.length - 1]?.id ??
        null)
      : null;
  const activeSessionObj = sessionsInFolder.find((s) => s.id === activeSessionId);
  const activeExited = activeSessionObj?.status === "exited";
  const activeIsEditor = editorsInFolder.some((e) => e.id === activeSessionId);
  // Chat sessions have their own composer; terminal-only UI (key-bar, select
  // mode, command builder) is gated off for them.
  const activeIsChat = activeSessionObj?.ui === "chat";
  // Show the Shift+Tab key when the active session is an agent — either a
  // claude/pi harness, or a Terminal session currently running one of them.
  const agentRunning =
    !!activeSessionObj &&
    (AGENT_HARNESS_IDS.has(activeSessionObj.harnessId) ||
      isAgentCommand(activeSessionObj.currentCommand));

  // Open a new file-editor tab in the active folder and focus it.
  const openEditor = () => {
    if (activeFolder === null) return;
    const id =
      crypto.randomUUID?.() ?? `editor-${Date.now()}-${Math.random()}`;
    setEditors((prev) => [...prev, { id, folder: activeFolder, file: null }]);
    setActiveSession((prev) => ({ ...prev, [activeFolder]: id }));
    setAddMenuOpen(false);
  };

  const closeEditor = (id: string) => {
    setEditors((prev) => prev.filter((e) => e.id !== id));
  };

  // Idempotent so FileEditor calling it every render can't loop re-renders.
  const setEditorFile = useCallback((id: string, file: string | null) => {
    setEditors((prev) => {
      const cur = prev.find((e) => e.id === id);
      if (!cur || cur.file === file) return prev;
      return prev.map((e) => (e.id === id ? { ...e, file } : e));
    });
  }, []);

  // Selection mode is per active terminal; reset it when the active one changes.
  useEffect(() => {
    setSelectMode(false);
    setBuilderOpen(false);
  }, [activeSessionId]);

  return (
    <div
      className="app"
      // Pin to the visual-viewport height while the keyboard is up so content
      // can't pan under it (dvh alone doesn't shrink for the keyboard).
      style={keyboard.open ? { height: keyboard.height } : undefined}
    >
      <button
        className="menu-toggle"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open menu"
      >
        ☰
      </button>
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <h1>agent-remote</h1>
          <button
            className="logout-button"
            onClick={handleLogout}
            title={`Log out ${username}`}
          >
            Log out
          </button>
        </div>

        <section>
          <label className="field-label">Add folder</label>
          <input
            className="cwd-input"
            placeholder="/path/to/folder"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitNewFolder()}
          />
        </section>

        <section className="folder-list">
          <label className="field-label">Folders</label>
          {folders.length === 0 && (
            <p className="muted">No folders yet. Add one above.</p>
          )}
          {folders.map((f) => (
            <div
              key={f.path}
              className={`folder-item ${f.path === activeFolder ? "active" : ""}`}
            >
              <button
                className="folder-item-open"
                onClick={() => openFolder(f.path)}
                title={f.path}
              >
                <span className="folder-name">{folderName(f.path)}</span>
                <span className="folder-path">{f.path}</span>
              </button>
              <button
                className="folder-remove"
                onClick={() => removeFolderAt(f.path)}
                title="Remove folder from sidebar"
                aria-label={`Remove ${folderName(f.path)}`}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      </aside>

      <main className="main">
        {activeFolder === null ? (
          <div className="empty-state">
            Add or select a folder to get started.
          </div>
        ) : (
          <>
            <div className="folder-header">
              <span className="folder-header-path" title={activeFolder}>
                {activeFolder}
              </span>
              <div className="header-actions">
                {/* Resume lives in ChatView's `/` slash-command menu as
                    `/resume` (mirrors the CLI), not a header button. */}
                {/* xterm select mode applies to terminal tabs only. */}
                {!activeIsChat && (
                  <button
                    className={`header-icon-button ${selectMode ? "active" : ""}`}
                    onClick={() => setSelectMode((m) => !m)}
                    aria-pressed={selectMode}
                    title="Select text"
                  >
                    <Icon path={SELECT_ICON} />
                  </button>
                )}
                {!isNarrow ? (
                  // Wide: every option inline as an icon button, no [+] menu.
                  <>
                    {harnesses.map((h) => (
                      <button
                        key={h.id}
                        className="header-icon-button"
                        onClick={() => client.start(h.id, activeFolder)}
                        title={`New ${h.name} session`}
                        aria-label={`New ${h.name} session`}
                      >
                        <HarnessGlyph id={h.id} name={h.name} />
                      </button>
                    ))}
                    <button
                      className="header-icon-button"
                      onClick={openEditor}
                      title="File edit"
                      aria-label="File edit"
                    >
                      <Icon path={EDIT_ICON} />
                    </button>
                  </>
                ) : (
                  // Narrow: [+] holds the coding agents + File edit; Terminal is
                  // pulled out as its own direct button (order: [+] then T).
                  <>
                    <div className="add-session" ref={addMenuRef}>
                      <button
                        className="add-session-button"
                        onClick={() => setAddMenuOpen((o) => !o)}
                        title="New session"
                      >
                        +
                      </button>
                      {addMenuOpen && (
                        <div className="add-session-menu">
                          {harnesses.filter((h) => h.id !== QUICK_HARNESS_ID)
                            .length === 0 && (
                            <div className="add-session-empty">
                              No harnesses enabled.
                            </div>
                          )}
                          {harnesses
                            .filter((h) => h.id !== QUICK_HARNESS_ID)
                            .map((h) => (
                              <button
                                key={h.id}
                                className="add-session-option"
                                onClick={() => {
                                  client.start(h.id, activeFolder);
                                  setAddMenuOpen(false);
                                }}
                              >
                                <HarnessGlyph id={h.id} name={h.name} />
                                {h.name}
                              </button>
                            ))}
                          {/* Not a harness: a client-only file-editor tab. */}
                          <button className="add-session-option" onClick={openEditor}>
                            <Icon path={EDIT_ICON} />
                            File edit
                          </button>
                        </div>
                      )}
                    </div>
                    {harnesses
                      .filter((h) => h.id === QUICK_HARNESS_ID)
                      .map((h) => (
                        <button
                          key={h.id}
                          className="header-icon-button"
                          onClick={() => client.start(h.id, activeFolder)}
                          title={`New ${h.name} session`}
                          aria-label={`New ${h.name} session`}
                        >
                          <HarnessGlyph id={h.id} name={h.name} />
                        </button>
                      ))}
                  </>
                )}
              </div>
            </div>

            <div className="session-selector">
              <button
                className="session-selector-header"
                onClick={() => setSelectorOpen((o) => !o)}
              >
                <span className="caret">{selectorOpen ? "▾" : "▸"}</span>
                {tabCount} {tabCount === 1 ? "session" : "sessions"}
              </button>
              {selectorOpen && (
                <div className="session-list">
                  {tabCount === 0 && (
                    <p className="muted">No sessions yet. Use + to add one.</p>
                  )}
                  {sessionsInFolder.map((s) => (
                    <button
                      key={s.id}
                      className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                      onClick={() => {
                        setActiveSession((prev) => ({
                          ...prev,
                          [activeFolder]: s.id,
                        }));
                        setSelectorOpen(false);
                      }}
                    >
                      <span
                        className={`status-dot ${s.status} ${
                          s.currentCommand ? "busy" : ""
                        }`}
                      />
                      <span className="session-name" title={s.harnessName}>
                        <HarnessGlyph id={s.harnessId} name={s.harnessName} />
                      </span>
                      <span className="session-meta" title={s.currentCommand ?? ""}>
                        {s.status === "exited"
                          ? `exited (${s.exitCode ?? "?"})`
                          : (s.currentCommand ?? "running")}
                      </span>
                      <span
                        className="session-close"
                        role="button"
                        aria-label="Close session"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          client.remove(s.id);
                        }}
                      >
                        ×
                      </span>
                    </button>
                  ))}
                  {editorsInFolder.map((e) => (
                    <button
                      key={e.id}
                      className={`session-item ${e.id === activeSessionId ? "active" : ""}`}
                      onClick={() => {
                        setActiveSession((prev) => ({
                          ...prev,
                          [activeFolder]: e.id,
                        }));
                        setSelectorOpen(false);
                      }}
                    >
                      <span className="status-dot editor" />
                      <span className="session-name" title="File edit">
                        <Icon path={EDIT_ICON} />
                      </span>
                      <span className="session-meta" title={e.file ?? ""}>
                        {e.file ?? "no file"}
                      </span>
                      <span
                        className="session-close"
                        role="button"
                        aria-label="Close file editor"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          closeEditor(e.id);
                        }}
                      >
                        ×
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="session-content">
              {tabCount === 0 && (
                <div className="empty-state">
                  No sessions in this folder. Use + to start one.
                </div>
              )}
              {/* All sessions stay mounted for scrollback; only the active is shown. */}
              {sessions
                .filter((s) => s.ui !== "chat")
                .map((s) => (
                  <TerminalView
                    key={s.id}
                    client={client}
                    sessionId={s.id}
                    active={s.id === activeSessionId}
                    selectMode={s.id === activeSessionId && selectMode}
                    onEnterSelect={() => setSelectMode(true)}
                    onExitSelect={() => setSelectMode(false)}
                  />
                ))}
              {sessions.some((s) => s.ui === "chat") && (
                <Suspense fallback={<div className="empty-state">Loading chat…</div>}>
                  {sessions
                    .filter((s) => s.ui === "chat")
                    .map((s) => (
                      <ChatView
                        key={s.id}
                        client={client}
                        sessionId={s.id}
                        active={s.id === activeSessionId}
                        exited={s.status === "exited"}
                        canResume={resumable.length > 0}
                        onResume={() => setResumeDialogOpen(true)}
                      />
                    ))}
                </Suspense>
              )}
              {/* Editor tabs stay mounted so unsaved edits survive tab switches. */}
              {editors.length > 0 && (
                <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
                  {editors.map((e) => (
                    <FileEditor
                      key={e.id}
                      cwd={e.folder}
                      active={e.id === activeSessionId}
                      onOpenFileChange={(name) => setEditorFile(e.id, name)}
                    />
                  ))}
                </Suspense>
              )}
            </div>

            {/* Exited sessions can't take input: swap the key-bar for a close control. */}
            {activeExited && (
              <div className="close-session-bar">
                <button
                  className="close-session-button"
                  onClick={() => client.remove(activeSessionId!)}
                >
                  Close session
                </button>
              </div>
            )}

            {activeSessionId !== null &&
              keyboard.open &&
              !activeExited &&
              !activeIsEditor &&
              !activeIsChat && (
              <div className="key-bar">
                <button
                  className="key-button key-bar-toggle"
                  aria-label={
                    keyGroup === "keys" ? "Show arrow keys" : "Show other keys"
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setKeyGroup((g) => (g === "keys" ? "arrows" : "keys"))
                  }
                >
                  <Icon path={keyGroup === "keys" ? NAV_ICON : KEYBOARD_ICON} />
                </button>
                <button
                  className="key-button key-bar-toggle"
                  aria-label="Build a command"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setBuilderOpen(true)}
                >
                  ./
                </button>
                <div className="key-group">
                  {(keyGroup === "keys" && agentRunning
                    ? KEY_GROUPS.keys.flatMap((k) =>
                        k.aria === "Tab" ? [k, SHIFT_TAB_KEY] : [k],
                      )
                    : KEY_GROUPS[keyGroup]
                  ).map((k) => (
                    <button
                      key={k.aria}
                      className={`key-button ${
                        k.toggle && ctrlMode !== "off" ? `armed ${ctrlMode}` : ""
                      }`}
                      aria-label={k.aria}
                      aria-pressed={k.toggle ? ctrlMode !== "off" : undefined}
                      // Keep focus on the terminal so the mobile keyboard stays up.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() =>
                        k.toggle
                          ? client.cycleCtrl()
                          : client.input(activeSessionId, k.seq!)
                      }
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {builderOpen && activeSessionId !== null && (
              <CommandBuilder
                client={client}
                sessionId={activeSessionId}
                cwd={activeFolder}
                onClose={() => setBuilderOpen(false)}
              />
            )}

            {resumeDialogOpen && activeFolder !== null && (
              <div
                className="resume-overlay"
                onClick={() => setResumeDialogOpen(false)}
              >
                <div
                  className="resume-dialog"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="resume-dialog-head">
                    <span>Resume session</span>
                    <button
                      className="resume-dialog-close"
                      aria-label="Close"
                      onClick={() => setResumeDialogOpen(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="resume-dialog-body">
                    {resumable.length === 0 ? (
                      <div className="resume-empty">
                        No sessions to resume in this folder.
                      </div>
                    ) : (
                      resumable.map((r) => (
                        <div key={r.resumeKey} className="resume-item">
                          <button
                            className="resume-item-open"
                            title={`Resume ${r.harnessName} session`}
                            onClick={() => {
                              client.start(
                                r.harnessId,
                                activeFolder,
                                r.resumeKey,
                              );
                              setResumeDialogOpen(false);
                            }}
                          >
                            <HarnessGlyph
                              id={r.harnessId}
                              name={r.harnessName}
                            />
                            <span className="resume-item-title">
                              {r.title || r.harnessName}
                            </span>
                            <span className="resume-item-time">
                              {relativeTime(r.updatedAt)}
                            </span>
                          </button>
                          <span
                            className="session-close"
                            role="button"
                            aria-label="Forget session"
                            title="Forget this session"
                            onClick={() => forgetResumable(r.resumeKey)}
                          >
                            ×
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
